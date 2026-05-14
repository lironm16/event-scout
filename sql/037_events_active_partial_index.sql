-- Partial index on active events.
--
-- All user-facing queries (matchingService, ticketService, the
-- agent's `search_events` tool) filter `archived = false` AND date
-- forward, then sort by date ascending. The pattern is:
--
--   SELECT ...
--     FROM events
--    WHERE archived = false
--      AND date >= today
--    ORDER BY date ASC;
--
-- A partial index keyed on `date` and scoped `WHERE archived = false`
-- means the optimizer never even visits the archived 20% of the
-- table for these queries. Equivalent to physically separating
-- archived rows into a side table, but with zero schema/code/FK
-- migration cost — the soft-delete `archived` flag stays as the
-- single source of truth, and `ticket_history.event_id` keeps
-- working unchanged.
--
-- Index size scales with the active subset only: today ~483 rows
-- (vs 609 in the table), and shrinks as old events get archived.
-- Postgres also gets us range scans for free since the index is
-- date-ordered.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_events_active_date
  ON public.events (date)
  WHERE archived = false;

COMMIT;

NOTIFY pgrst, 'reload schema';
