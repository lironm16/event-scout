-- Per-label event counter.
--
-- Adds `labels.events_count` — a denormalised tally of how many ACTIVE
-- events currently reference each tag via `events.tag_ids[]`. Maintained
-- by a trigger on `events` so it stays accurate without any application
-- code changes; backfilled from current data on migration apply.
--
-- Why:
--   The bot's analytics + UI surfaces (interest picker, /interests
--   command, the agent's tag-resolution path in resolveTagNamesToIds)
--   benefit from a "how popular is this tag" signal. Without the
--   counter every UI that wants ranking has to:
--     SELECT t, COUNT(*)
--     FROM events, unnest(tag_ids) AS t
--     WHERE archived = false
--     GROUP BY t
--   …which is fine once but stops scaling when the picker wants to
--   sort live, or when we want a "least-used labels to clean up" view.
--
-- Counting scope: ACTIVE events only (archived = false). Including
-- archived would conflate "tag was used a year ago and the event is
-- now expired" with "tag is actively relevant" — the metric is most
-- useful as a representation of CURRENT distribution. Sold-out events
-- are still counted (they're not archived); we want "events the user
-- can be told about", and a sold-out event is still on the catalog
-- until the cleanup job archives it (sql/007).
--
-- Maintenance strategy:
--   - Per-row AFTER trigger on events (INSERT / DELETE / UPDATE of
--     tag_ids OR archived). Recomputes counts only for the labels
--     whose membership could have changed (union of OLD.tag_ids +
--     NEW.tag_ids). Bulk scrape upserts (100s of rows at once) fire
--     the trigger 100s of times — each firing is a single targeted
--     UPDATE on a few labels, so total cost is sub-second on the
--     expected catalog size (~few hundred tags × few thousand events).
--   - Manual refresh function `refresh_label_counts(label_ids INT[])`
--     for backfills and operator interventions. Passing NULL refreshes
--     every label in one aggregate query — preferred path after a
--     batch operation that fires no triggers (e.g. raw COPY).

ALTER TABLE public.labels
  ADD COLUMN IF NOT EXISTS events_count INTEGER NOT NULL DEFAULT 0;

-- Ranking index — "show me top-N most-used tags" via
-- `ORDER BY events_count DESC LIMIT N`. Partial index on count > 0
-- keeps it tight: labels with zero usage don't pollute the leaf nodes,
-- and the DESC order matches the typical query shape.
CREATE INDEX IF NOT EXISTS idx_labels_events_count
  ON public.labels (events_count DESC)
  WHERE events_count > 0;

-- ────────────────────────────────────────────────────────────────────
-- refresh_label_counts(label_ids)
--
-- When label_ids IS NULL → refresh every label in a single pass (the
--   fast path; one aggregate query + one bulk UPDATE).
-- When label_ids is given → recompute only those rows (the trigger
--   path; minimises write amplification on bulk inserts/updates).
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refresh_label_counts(label_ids INTEGER[] DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF label_ids IS NULL THEN
    -- Full refresh. LEFT JOIN against the aggregate so labels with
    -- ZERO matches still get zeroed (the COUNT(*) GROUP BY misses
    -- labels that aren't referenced anywhere).
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
    -- Per-label refresh. We rebuild via a CTE so a label that lost its
    -- only event lands at 0 instead of being left untouched.
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
  END IF;
END;
$$;

-- ────────────────────────────────────────────────────────────────────
-- Trigger: keep the counter in sync as events change.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_label_counts_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected INTEGER[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    affected := COALESCE(NEW.tag_ids, ARRAY[]::INTEGER[]);
  ELSIF TG_OP = 'DELETE' THEN
    affected := COALESCE(OLD.tag_ids, ARRAY[]::INTEGER[]);
  ELSE
    -- UPDATE: union of both arrays so labels added AND removed are
    -- both recomputed. Postgres array || tolerates NULLs after the
    -- COALESCE above; cardinality() of an empty array is 0.
    affected := COALESCE(OLD.tag_ids, ARRAY[]::INTEGER[])
              || COALESCE(NEW.tag_ids, ARRAY[]::INTEGER[]);
  END IF;

  IF affected IS NULL OR cardinality(affected) = 0 THEN
    RETURN NULL;
  END IF;

  -- Dedupe before forwarding — same label appearing in both OLD and
  -- NEW would otherwise cause a double-update. Postgres handles
  -- duplicates in the array fine, but the function does extra work.
  PERFORM public.refresh_label_counts(
    ARRAY(SELECT DISTINCT a FROM unnest(affected) AS a)
  );
  RETURN NULL;
END;
$$;

-- Drop-and-recreate so re-running the migration picks up any function
-- changes. CREATE OR REPLACE TRIGGER doesn't exist before Postgres 14
-- and we want to stay portable.
DROP TRIGGER IF EXISTS trg_label_counts ON public.events;

CREATE TRIGGER trg_label_counts
AFTER INSERT OR DELETE OR UPDATE OF tag_ids, archived
ON public.events
FOR EACH ROW
EXECUTE FUNCTION public.trg_label_counts_fn();

-- Backfill from current state — single pass over all events into the
-- counts column. Subsequent updates flow through the trigger above.
SELECT public.refresh_label_counts();

-- PostgREST cache reload so the new column shows up in the schema cache.
NOTIFY pgrst, 'reload schema';
