-- Merge 2-digit year-suffixed label duplicates into their base labels.
--
-- normalizeName now strips trailing 2-digit years (e.g. "שבועות 26" → "שבועות")
-- in addition to 4-digit years. This migration retroactively merges any
-- 2-digit-year-suffixed rows that snuck in before that fix.
--
-- The merge is driven by the same pattern used in 061: find labels whose
-- name matches /\s+\d{2}$/, locate the base label (name without the suffix),
-- replace all tag_ids references, deduplicate, then delete the orphan.
--
-- We do this in a single DO block so the id lookup is dynamic and does not
-- require hard-coded IDs that could differ between environments.

DO $$
DECLARE
  rec        RECORD;
  base_id    INT;
  base_name  TEXT;
BEGIN
  FOR rec IN
    SELECT id, name
    FROM   labels
    WHERE  name ~ '\s+\d{2}$'
  LOOP
    base_name := trim(regexp_replace(rec.name, '\s+\d{2}$', ''));

    SELECT id INTO base_id
    FROM   labels
    WHERE  lower(name) = lower(base_name)
      AND  id <> rec.id
    LIMIT 1;

    IF base_id IS NULL THEN
      -- No base label exists yet — rename this row to the canonical form
      -- so future lookups land on it instead of creating a third variant.
      UPDATE labels SET name = base_name WHERE id = rec.id;
      RAISE NOTICE 'Renamed label % "%" → "%"', rec.id, rec.name, base_name;
      CONTINUE;
    END IF;

    -- Replace the duplicate id with the base id in all event tag arrays.
    UPDATE events
    SET    tag_ids = array_replace(tag_ids, rec.id, base_id)
    WHERE  rec.id = ANY(tag_ids);

    -- Deduplicate in case an event had both ids already.
    UPDATE events
    SET    tag_ids = ARRAY(SELECT DISTINCT unnest(tag_ids) ORDER BY 1)
    WHERE  base_id = ANY(tag_ids);

    DELETE FROM labels WHERE id = rec.id;

    RAISE NOTICE 'Merged label % "%" → % "%"', rec.id, rec.name, base_id, base_name;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
