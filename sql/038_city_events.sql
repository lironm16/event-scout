-- Add the third event source: Ramat Gan municipality events API.
--
-- Why this exists:
--   Until now the only events we ingest are paid Smarticket bookings
--   (mbe-rg + ramat-gan tenants — both Smarticket subdomains). The
--   municipality also publishes a JSON feed at
--   `api-m.ramat-gan.muni.il/api/EventLobby/he/event-lobby` containing
--   FREE city events that have no Smarticket counterpart at all
--   (libraries, parades, free workshops, community events). The plan
--   `.cursor/plans/city-api_duplicate_detection_51195506.plan.md`
--   explains how we detect "is this row already in our DB via
--   Smarticket?" — see `lib/cityApi.js`. This migration is the
--   schema half of the integration.
--
-- Two changes, both backward-compatible with existing rows:
--
-- 1. New ENUM value 'rg-muni'.
--    Stays in lockstep with `lib/sourceUrls.js` per the rule
--    documented in sql/035. ENUM ADD VALUE inside a transaction is
--    safe in PG 12+ as long as the new value isn't USED in the same
--    transaction. We don't write any 'rg-muni' rows here, so this
--    works.
--
-- 2. New `external_slug TEXT` column + UNIQUE constraint on
--    (source, external_slug).
--    The municipal API identifies events by string slug (e.g.
--    `jerusalem-day`, `baby-debuts-2026`) but our `events.id` is
--    INT and ~every other table joins on it (watchers,
--    ticket_history, saved-search match logs). Forking into a
--    second table would duplicate that whole graph. Instead we
--    deterministically hash slug→INT in the [50_000_000, 99_999_999]
--    range (see `slugToEventId` in lib/cityApi.js) — non-overlapping
--    with Smarticket's <22K range — and store the canonical slug
--    string in this column for two purposes:
--      a. Primary identity check on upsert: `(source, external_slug)`
--         is unique, so re-scraping is idempotent and any future hash
--         collision would be REJECTED at INSERT time instead of
--         silently overwriting an unrelated row.
--      b. URL construction: `getBookingUrl({source: 'rg-muni',
--         external_slug})` resolves to
--         https://www.ramat-gan.muni.il/events/{slug}/. The numeric
--         id alone wouldn't reach the city site since their URL
--         scheme is slug-based.
--    Why NOT a partial index `WHERE external_slug IS NOT NULL`:
--      Smarticket rows leave external_slug NULL, and a partial
--      unique index isn't matched by PostgREST's `on_conflict=`
--      inference (Postgres requires the predicate to be repeated
--      explicitly in the ON CONFLICT clause, which supabase-js
--      can't emit). So the city scraper's upsert
--      (`onConflict: "source,external_slug"`) would fail at
--      runtime with "no unique constraint matches". A plain
--      non-partial UNIQUE on (source, external_slug) is still
--      correct: under default PG semantics, NULLs in unique
--      columns are DISTINCT, so any number of smarticket rows
--      with `(mbe-rg, NULL)` or `(ramat-gan, NULL)` coexist
--      without violation. The constraint only enforces uniqueness
--      among non-null pairs, which is exactly what we need.

BEGIN;

ALTER TYPE public.source_t ADD VALUE IF NOT EXISTS 'rg-muni';

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS external_slug TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_events_source_external_slug
  ON public.events (source, external_slug);

COMMIT;

NOTIFY pgrst, 'reload schema';
