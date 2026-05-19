-- Auto-prune labels whose `events_count` drops to 0.
--
-- Background:
--   sql/049 added an `events_count` counter on `labels` plus a trigger
--   on `events` that keeps it in sync. The counter scope is ACTIVE
--   events only (`archived = false`), so labels whose last event was
--   archived end up at 0 and stay forever, polluting the dictionary
--   and the resolver's substring/fuzzy matching paths.
--
-- This migration extends the maintenance logic so that whenever the
-- trigger recomputes a per-label count and lands on 0, the row is
-- deleted in the same call.
--
-- Why only the per-label path:
--   refresh_label_counts() has two call shapes.
--     1. Trigger path  → refresh_label_counts(array_of_label_ids)
--     2. Operator path → refresh_label_counts(NULL)  -- full table
--
--   Auto-prune is wired into shape #1 only. The trigger's `affected`
--   set is always `OLD.tag_ids ∪ NEW.tag_ids` of the changed events
--   row, so a freshly-inserted-but-not-yet-attached label is NEVER
--   in scope (no event references it yet). Shape #2 touches every
--   label, including those freshly-inserted ones — so we keep #2
--   count-only and expose a separate `prune_zero_labels()` helper
--   for explicit operator cleanup.
--
-- Race-condition note (NOT solved here — handled in api/check.js):
--   The bot's `lib/labelStore.js` keeps an in-memory cache mapping
--   tag name → label id, populated on first hit per process. If
--   Postgres deletes label 42 between scrapes, the cached "name → 42"
--   becomes stale and a later setEventLabels would write a dangling
--   id into `events.tag_ids`. We mitigate by calling
--   `labelStore._clearCache()` at the top of every scrape cycle so
--   the cache is rebuilt from a fresh table read each run.

CREATE OR REPLACE FUNCTION public.refresh_label_counts(label_ids INTEGER[] DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF label_ids IS NULL THEN
    -- Full refresh — counts only, no auto-prune. LEFT JOIN against
    -- the aggregate so labels with ZERO matches still get zeroed.
    WITH all_counts AS (
      SELECT lb.id AS label_id,
             COALESCE(sub.cnt, 0)::INTEGER AS cnt
        FROM public.labels lb
        LEFT JOIN (
          SELECT t AS label_id, COUNT(*)::INTEGER AS cnt
            FROM public.events,
                 unnest(tag_ids) AS t
           WHERE archived = false
           GROUP BY t
        ) sub ON sub.label_id = lb.id
    )
    UPDATE public.labels l
       SET events_count = ac.cnt
      FROM all_counts ac
     WHERE l.id = ac.label_id
       AND l.events_count IS DISTINCT FROM ac.cnt;
  ELSE
    -- Per-label refresh — recompute then auto-prune anything at 0.
    -- Two statements (not one CTE) so the DELETE sees the post-UPDATE
    -- value of events_count.
    WITH counts AS (
      SELECT lid AS label_id,
             (
               SELECT COUNT(*)::INTEGER
                 FROM public.events e
                WHERE lid = ANY(e.tag_ids)
                  AND e.archived = false
             ) AS cnt
        FROM unnest(label_ids) AS lid
    )
    UPDATE public.labels l
       SET events_count = COALESCE(c.cnt, 0)
      FROM counts c
     WHERE l.id = c.label_id
       AND l.events_count IS DISTINCT FROM COALESCE(c.cnt, 0);

    -- Auto-prune: any label in the affected set that just landed at 0
    -- gets deleted in the same transaction. Archived events may still
    -- carry the deleted id in their `tag_ids[]` — that's intentional;
    -- archived rows aren't surfaced to users, and `fetchLabelDict`
    -- silently drops unknown ids at read time.
    DELETE FROM public.labels
     WHERE id = ANY(label_ids)
       AND events_count = 0;
  END IF;
END;
$$;

-- ────────────────────────────────────────────────────────────────────
-- prune_zero_labels()
--
-- One-shot cleanup helper. Deletes every label currently at 0 and
-- returns the count of deleted rows. Used by this migration to clean
-- up the existing backlog from sql/049's initial backfill, and
-- available for operator-initiated maintenance after that.
--
-- WARNING when calling manually with the bot live: `lib/labelStore.js`
-- caches name→id mappings per-process. Run `labelStore._clearCache()`
-- (or restart the bot, or wait for the next scrape — which clears the
-- cache automatically) before any new scrape, to avoid writing
-- dangling tag ids into freshly-inserted events.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.prune_zero_labels()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  deleted INTEGER;
BEGIN
  DELETE FROM public.labels WHERE events_count = 0;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

-- Clean up the existing pile of zero-count labels accumulated before
-- this migration. Safe to run here because the bot's scrape loop is
-- expected to be off (or to clear its cache on the next tick — see
-- api/check.js change accompanying this migration).
SELECT public.prune_zero_labels();

NOTIFY pgrst, 'reload schema';
