-- Add `source` to events: which Smarticket tenant minted the row.
--
-- Why now:
--   We discovered the Ramat-Gan municipality runs TWO disjoint
--   Smarticket calendars on different subdomains:
--     - mbe-rg.smarticket.co.il   (community centers / matnasim)
--     - ramat-gan.smarticket.co.il (libraries, workshops, LGBTQ
--                                   community department, etc.)
--   The two tenants share zero IDs today (mbe-rg uses 10K-22K,
--   ramat-gan uses 300-3600). We're not yet scraping the second
--   feed — but we want every existing row tagged with its source
--   *now*, so when we DO turn on the second feed (or a future
--   third one) we already have the answer to "where did this row
--   come from?" written down on every row, including historical
--   ones.
--
-- Trade-off acknowledged:
--   We're keeping `events.id` as the single-column PK. ID
--   collisions across tenants are POSSIBLE in theory (no schema
--   constraint prevents them today). They are NOT happening now,
--   and we'll address the collision question if/when we light up
--   another feed. This migration just gives us the source label;
--   it does not change the PK model.
--
-- Default chosen: 'mbe-rg' (the only feed running today). The
-- column is NOT NULL so future writers have to be explicit; that
-- makes "I forgot to set source" a loud insert error instead of a
-- silent NULL haunting reports later.

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'mbe-rg';

-- Cheap index — we'll filter and group by source as soon as a
-- second feed is added. Pay the index cost once now rather than
-- needing an ALTER under load later.
CREATE INDEX IF NOT EXISTS idx_events_source ON public.events (source);

NOTIFY pgrst, 'reload schema';
