-- events.last_changed_at — when the volatile inventory (tickets_left)
-- last actually moved.
--
-- Background:
--
-- We already track `last_checked` (when the scraper last touched the
-- row, regardless of value change) and `last_updated` (which used to be
-- the same thing — bumped on every upsert). When debugging a stale-data
-- report, neither tells you "did anything ACTUALLY change?" — they both
-- look fresh after every scrape cycle.
--
-- Adding `last_changed_at` lets us say at a glance: "scraper ran 30s
-- ago, but the count hasn't moved in 4 hours" vs "the count just
-- dropped 12s ago". Two interpretive layers from one extra column.
--
-- Backfill: existing rows get NOW() so the next "did it change?" check
-- has a sensible baseline rather than treating everything as
-- ancient-and-overdue. The scraper logic in api/check.js will start
-- maintaining this column on the next cycle and overwrite for rows
-- whose tickets_left moves.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS last_changed_at TIMESTAMPTZ;

UPDATE events
   SET last_changed_at = COALESCE(last_updated, last_checked, NOW())
 WHERE last_changed_at IS NULL;

-- Quick sanity check: how many rows have it now, and how recent.
SELECT
  COUNT(*) AS total_rows,
  COUNT(last_changed_at) AS with_value,
  MIN(last_changed_at) AS oldest,
  MAX(last_changed_at) AS newest
FROM events;
