-- 081: enforce events.tag_ids ⊆ live labels at the DB level, and cascade
-- label deletes / renames onto events. Fixes the orphan-tag_ids bug at its
-- root (sql/050 deletes zero-count labels; a stale labelStore name→id cache
-- could re-write a deleted id; archived rows kept dead ids by design) — none
-- of which can survive once the DB itself guarantees the invariant.
--
-- Three guarantees, all in-DB (no app code, cache-proof):
--   1. WRITE-TIME SANITIZE: any insert/update of events.tag_ids drops ids with
--      no matching labels row, then recomputes events.tags.
--   2. LABEL DELETE → remove that id from EVERY event's tag_ids (incl archived).
--   3. LABEL RENAME → resync events.tags for every event referencing it.
--
-- Idempotent / safe to re-run. Requires sql/080 (events.tags column).

-- ── 1) Sanitize + sync (replaces the 080 sync function) ─────────────────────
CREATE OR REPLACE FUNCTION events_sync_tags() RETURNS trigger AS $$
BEGIN
  NEW.tag_ids := ARRAY(
    SELECT id FROM unnest(COALESCE(NEW.tag_ids, '{}'::int[])) AS id
    WHERE id IN (SELECT l.id FROM labels l)
  );
  NEW.tags := ARRAY(
    SELECT l.name FROM unnest(NEW.tag_ids) AS id
    JOIN labels l ON l.id = id
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_sync_tags ON events;
CREATE TRIGGER trg_events_sync_tags
  BEFORE INSERT OR UPDATE OF tag_ids ON events
  FOR EACH ROW EXECUTE FUNCTION events_sync_tags();

-- ── 2) Label DELETE → strip the id from every event ─────────────────────────
CREATE OR REPLACE FUNCTION labels_cascade_delete() RETURNS trigger AS $$
BEGIN
  UPDATE events SET tag_ids = array_remove(tag_ids, OLD.id)
   WHERE tag_ids @> ARRAY[OLD.id];
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_labels_cascade_delete ON labels;
CREATE TRIGGER trg_labels_cascade_delete
  AFTER DELETE ON labels
  FOR EACH ROW EXECUTE FUNCTION labels_cascade_delete();

-- ── 3) Label RENAME → resync events.tags for referencing events ─────────────
CREATE OR REPLACE FUNCTION labels_cascade_rename() RETURNS trigger AS $$
BEGIN
  UPDATE events e SET tags = ARRAY(
    SELECT l.name FROM unnest(e.tag_ids) AS id
    JOIN labels l ON l.id = id
  )
  WHERE e.tag_ids @> ARRAY[NEW.id];
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_labels_cascade_rename ON labels;
CREATE TRIGGER trg_labels_cascade_rename
  AFTER UPDATE OF name ON labels
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION labels_cascade_rename();

-- ── 4) One-time cleanup of the existing orphan backlog ──────────────────────
UPDATE events e
SET tag_ids = ARRAY(
  SELECT id FROM unnest(e.tag_ids) AS id
  WHERE id IN (SELECT l.id FROM labels l)
)
WHERE EXISTS (
  SELECT 1 FROM unnest(e.tag_ids) AS id
  WHERE id NOT IN (SELECT l.id FROM labels l)
);

NOTIFY pgrst, 'reload schema';
