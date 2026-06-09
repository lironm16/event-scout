-- 081: enforce events.tag_ids ⊆ live labels at the DB level, and cascade
-- label deletes / renames onto events. Fixes the orphan-tag_ids bug at its
-- root (sql/050 deletes zero-count labels; a stale labelStore name→id cache
-- could re-write a deleted id; archived rows kept dead ids by design) — none
-- of which can survive once the DB itself guarantees the invariant.
--
-- Three guarantees, all in-DB (no app code, cache-proof):
--   1. WRITE-TIME SANITIZE: any insert/update of events.tag_ids drops ids with
--      no matching labels row, then recomputes events.tags. A stale cached id
--      is stripped the instant it's written.
--   2. LABEL DELETE → remove that id from EVERY event's tag_ids (incl.
--      archived), so a prune/merge never leaves a dangling reference.
--   3. LABEL RENAME → resync events.tags for every event referencing it, so the
--      readable column never lags the label's name.
--
-- Idempotent / safe to re-run.

-- ── 1) Sanitize + sync (replaces the 080 sync function) ─────────────────────
CREATE OR REPLACE FUNCTION events_sync_tags() RETURNS trigger AS $$
BEGIN
  -- Keep only ids that exist in labels (drops orphans / stale-cache writes),
  -- preserving order.
  NEW.tag_ids := COALESCE(
    (
      SELECT array_agg(t.id ORDER BY t.ord)
      FROM unnest(COALESCE(NEW.tag_ids, '{}')) WITH ORDINALITY AS t(id, ord)
      WHERE EXISTS (SELECT 1 FROM labels l WHERE l.id = t.id)
    ),
    '{}'
  );
  -- Readable names, same order.
  NEW.tags := COALESCE(
    (
      SELECT array_agg(l.name ORDER BY t.ord)
      FROM unnest(NEW.tag_ids) WITH ORDINALITY AS t(id, ord)
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

-- ── 2) Label DELETE → strip the id from every event ─────────────────────────
CREATE OR REPLACE FUNCTION labels_cascade_delete() RETURNS trigger AS $$
BEGIN
  -- array_remove changes tag_ids → fires trg_events_sync_tags (re-sync tags).
  UPDATE events
     SET tag_ids = array_remove(tag_ids, OLD.id)
   WHERE tag_ids @> ARRAY[OLD.id];
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_labels_cascade_delete ON labels;
CREATE TRIGGER trg_labels_cascade_delete
  AFTER DELETE ON labels
  FOR EACH ROW EXECUTE FUNCTION labels_cascade_delete();

-- ── 3) Label RENAME → resync events.tags for referencing events ─────────────
-- Updates events.tags directly (NOT tag_ids), so it does not re-fire the sync
-- or label-count triggers — no recursion.
CREATE OR REPLACE FUNCTION labels_cascade_rename() RETURNS trigger AS $$
BEGIN
  UPDATE events e
     SET tags = COALESCE(
       (
         SELECT array_agg(l.name ORDER BY t.ord)
         FROM unnest(e.tag_ids) WITH ORDINALITY AS t(id, ord)
         JOIN labels l ON l.id = t.id
       ),
       '{}'
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
-- Writing tag_ids fires the sanitize trigger, which also fixes tags.
UPDATE events e
   SET tag_ids = (
     SELECT COALESCE(array_agg(t.id ORDER BY t.ord), '{}')
     FROM unnest(e.tag_ids) WITH ORDINALITY AS t(id, ord)
     WHERE EXISTS (SELECT 1 FROM labels l WHERE l.id = t.id)
   )
 WHERE EXISTS (
   SELECT 1 FROM unnest(e.tag_ids) AS x(id)
   WHERE NOT EXISTS (SELECT 1 FROM labels l WHERE l.id = x.id)
 );

NOTIFY pgrst, 'reload schema';
