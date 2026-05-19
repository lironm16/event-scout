-- Merge year-suffixed label duplicates into their base labels.
--
-- "שבועות 2026" (id=257) is the city cluster name; "שבועות" (id=15)
-- is the semantic tag Gemini produces. normalizeName now strips trailing
-- 4-digit years so both resolve to the same canonical label going
-- forward. This migration retroactively replaces 257 with 15 in all
-- existing event tag arrays and deletes the orphaned row.
--
-- Pattern: for each year-suffixed label, replace its id in
-- events.tag_ids with the base label's id, then delete the duplicate.

-- Step 1: replace label 257 ("שבועות 2026") → 15 ("שבועות") in all events.
UPDATE events
SET tag_ids = array_replace(tag_ids, 257, 15)
WHERE 257 = ANY(tag_ids);

-- Step 2: deduplicate tag_ids in case an event somehow had both
-- (produces no visible change for most rows, harmless to run).
UPDATE events
SET tag_ids = ARRAY(SELECT DISTINCT unnest(tag_ids) ORDER BY 1)
WHERE 15 = ANY(tag_ids);

-- Step 3: delete the orphaned year-suffixed label row.
DELETE FROM labels WHERE id = 257;

NOTIFY pgrst, 'reload schema';
