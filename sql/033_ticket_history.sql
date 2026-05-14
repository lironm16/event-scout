-- Ticket history: a permanent audit log of every `events.tickets_left`
-- transition.
--
-- Why:
--   `events.last_changed_at` (sql/029) tells us WHEN a row's
--   tickets_left last moved, but not FROM-WHAT to-what. After a
--   confusing "🎫 התפנו 40 כרטיסים" notification we had no way to
--   confirm whether the previous value was actually 0 (true sold-out)
--   or 0 was a transient scrape artifact. With this table every
--   transition is preserved and queryable forever.
--
-- How:
--   A Postgres trigger on `events` fires AFTER every INSERT and after
--   any UPDATE that actually changes `tickets_left`. The trigger
--   appends a row to `ticket_history` with the previous + new value.
--   No application-side change is required — the trigger captures
--   updates from `api/check.js` AND any manual UPDATE we run in the
--   SQL editor.
--
-- Performance:
--   Per-row trigger overhead is ~microseconds. The scraper writes a
--   few hundred rows per cycle; even at 100% churn (impossible) we'd
--   add a few KB per scrape. INSERT row count =
--   (rows whose tickets_left moved) which is typically << 10/cycle.
--
-- Retention:
--   Keep forever for now. Volume is bounded by event lifecycles
--   (Smarticket lookahead = 45 days; events get archived/deleted
--   when they pass their date). If we ever notice the table growing
--   unboundedly, we add a periodic `DELETE WHERE changed_at < NOW()
--   - INTERVAL '180 days'` job. Not worth pre-optimising.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ticket_history (
  id                 BIGSERIAL PRIMARY KEY,
  event_id           BIGINT NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  prev_tickets_left  INT,                              -- NULL on the first INSERT
  new_tickets_left   INT,                              -- NULL when an event row's count is cleared
  changed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup-by-event is the dominant query — show the timeline for
-- event #X. DESC index keeps "latest changes first" cheap.
CREATE INDEX IF NOT EXISTS idx_ticket_history_event_changed_at
  ON public.ticket_history (event_id, changed_at DESC);

-- Cross-event "what changed in the last hour?" queries — useful for
-- diagnosing weird notification batches.
CREATE INDEX IF NOT EXISTS idx_ticket_history_changed_at
  ON public.ticket_history (changed_at DESC);

-- Trigger function. AFTER INSERT logs the initial state (prev=NULL,
-- new=NEW.tickets_left) so we can always reconstruct "from when did
-- this row exist with this many tickets". UPDATE logs only when the
-- value actually moved — `IS DISTINCT FROM` handles NULL on either
-- side correctly (a regular `<>` would treat NULL transitions as
-- equal and miss them).
CREATE OR REPLACE FUNCTION public.record_tickets_change()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    INSERT INTO public.ticket_history (event_id, prev_tickets_left, new_tickets_left)
    VALUES (NEW.id, NULL, NEW.tickets_left);
    RETURN NEW;
  END IF;

  IF (TG_OP = 'UPDATE' AND OLD.tickets_left IS DISTINCT FROM NEW.tickets_left) THEN
    INSERT INTO public.ticket_history (event_id, prev_tickets_left, new_tickets_left)
    VALUES (NEW.id, OLD.tickets_left, NEW.tickets_left);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ticket_history ON public.events;

-- AFTER fires post-row-update so triggers don't see an aborted txn,
-- and FOR EACH ROW because we want one history record per affected
-- event. `OF tickets_left` on UPDATE limits the trigger to runs that
-- actually touched the column — a meaningful saving when the bot
-- bumps last_checked / last_updated without changing stock.
CREATE TRIGGER trg_ticket_history
  AFTER INSERT OR UPDATE OF tickets_left ON public.events
  FOR EACH ROW
  EXECUTE FUNCTION public.record_tickets_change();

-- One-time backfill: seed every existing event with a baseline row
-- so the history table isn't empty for events that haven't moved
-- since the trigger was installed. We use `last_changed_at` (sql/029)
-- when available — that's our best estimate of when the current
-- value was set. Fall back to `last_checked`, then NOW().
--
-- The seeded row uses prev=NULL (we don't know the previous value;
-- this is a backfill, not an observation). The trigger guards against
-- duplicate seeds via the NOT EXISTS check.
INSERT INTO public.ticket_history (event_id, prev_tickets_left, new_tickets_left, changed_at)
SELECT
  e.id,
  NULL,
  e.tickets_left,
  COALESCE(e.last_changed_at, e.last_checked, NOW())
FROM public.events e
WHERE NOT EXISTS (
  SELECT 1 FROM public.ticket_history h WHERE h.event_id = e.id
);

COMMIT;

NOTIFY pgrst, 'reload schema';
