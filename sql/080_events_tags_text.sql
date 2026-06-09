-- 080: human-readable label NAMES alongside tag_ids on events.
--
-- events.tag_ids (int[] → labels.id) stays the source of truth for matching,
-- dedup, counts and alias-folding. This adds a denormalized events.tags
-- (text[] of label NAMES) so the data is readable ("קהילה גאה" not [157]) and
-- queryable by string. A trigger keeps it in sync on every insert/update of
-- tag_ids — NO application code change is required.
--
-- NOTE: a label RENAME or MERGE on the labels table does not by itself touch
-- events rows, so events.tags would lag until the next write to that event
-- (the merge jobs array_replace tag_ids, which fires the trigger). Renames are
-- rare and there is no live rename flow; run the backfill below to resync if
-- ever needed. Safe to re-run (idempotent).

-- 1) Column
ALTER TABLE events ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

-- 2) Keep tags in sync from tag_ids on write. Preserves tag_ids order and
--    silently drops ids with no matching labels row (orphans).
CREATE OR REPLACE FUNCTION events_sync_tags() RETURNS trigger AS $$
BEGIN
  NEW.tags := COALESCE(
    (
      SELECT array_agg(l.name ORDER BY t.ord)
      FROM unnest(COALESCE(NEW.tag_ids, '{}')) WITH ORDINALITY AS t(id, ord)
      JOIN labels l ON l.id = t.id
    ),
    '{}'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_sync_tags ON events;
CREATE TRIGGER trg_events_sync_tags
  BEFORE INSERT OR UPDATE OF tag_ids ON events
  FOR EACH ROW EXECUTE FUNCTION events_sync_tags();

-- 3) Backfill existing rows.
UPDATE events e SET tags = COALESCE(
  (
    SELECT array_agg(l.name ORDER BY t.ord)
    FROM unnest(COALESCE(e.tag_ids, '{}')) WITH ORDINALITY AS t(id, ord)
    JOIN labels l ON l.id = t.id
  ),
  '{}'
);

-- 4) GIN index for string-tag filtering (mirrors the tag_ids index).
CREATE INDEX IF NOT EXISTS idx_events_tags ON events USING gin (tags);
