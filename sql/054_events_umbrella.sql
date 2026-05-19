-- Track which umbrella each child event came from, so the bot can offer
-- a "📋 כל אירועי <umbrella_title>" button on the child's card.
--
-- Background:
--   The city-API ingest fans out umbrella pages (e.g. `shavuot-2026`,
--   `active-garden-2026`) into N synthetic child rows, each with its
--   own date / time / venue. After the fan-out we drop the parent
--   relationship — every child shows up to the bot as an independent
--   event. That makes "what else is happening as part of this umbrella?"
--   impossible to answer at render time without a per-name string match,
--   which is fragile (umbrellas like shavuot-2026 have N distinct child
--   titles, sharing only the parent slug).
--
-- What this adds:
--   - `umbrella_slug`  — the parent's city slug (e.g. "shavuot-2026").
--                        Stable join key across siblings.
--   - `umbrella_title` — the parent's display title (e.g. "שבועות
--                        ברמת גן"). Used for the button label and the
--                        list header. Stored alongside the slug so the
--                        button render doesn't need a parent lookup.
--
-- Population:
--   The scraper (`lib/cityApi.js#buildCityChildEventRow`) sets these
--   on every child it fans out. Existing rows fill in on the next
--   re-scrape (upsert by (source, external_slug) → same row, new
--   columns populated). Singles and Smarticket rows leave both NULL.
--
-- Read side:
--   The `umb:<slug>` callback handler queries
--     SELECT * FROM events
--     WHERE umbrella_slug = $1
--       AND archived = false
--       AND date >= today
--     ORDER BY date, start_time;
--   so we need a btree index on umbrella_slug for the lookup. Cardinality
--   is low (~20-50 unique umbrellas at any time), but the query runs on
--   every umbrella button tap.

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS umbrella_slug TEXT,
  ADD COLUMN IF NOT EXISTS umbrella_title TEXT;

CREATE INDEX IF NOT EXISTS events_umbrella_slug_idx
  ON public.events (umbrella_slug)
  WHERE umbrella_slug IS NOT NULL;
