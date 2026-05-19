-- sql/052_event_external_url.sql
--
-- Per-event registration URL for city events that link OUT to a
-- third-party booking provider (paykal.co.il, bina.org.il, etc.).
--
-- Background
-- ──────────
-- City events from ramat-gan.muni.il can carry one of three URL
-- shapes in `content.registerLink` (or `schedule[].registerLink`
-- for fan-out children):
--
--   1. A Smarticket URL on the mbe-rg or ramat-gan host. These
--      events are ALREADY ingested by the smarticket scraper as
--      a separate row with source='mbe-rg' / source='ramat-gan';
--      the city scraper filters them out before building city
--      rows (see lib/cityApi.js#extractCitySchedule). For those
--      rows getBookingUrl() returns "<smarticket-origin>/event/<id>".
--      Nothing to change here.
--
--   2. A non-Smarticket third-party booking URL (paykal.co.il,
--      bina.org.il, …). These remain city-row events because
--      the smarticket scraper doesn't know them. Until now the
--      "🔗 פרטים" button pointed at the parent CITY PAGE
--      (`/events/<slug>/`), forcing the user to scroll the
--      schedule list and find the right session manually. We
--      now persist the registration URL in `events.external_url`
--      and use it as the booking link target (see
--      lib/sourceUrls.js#getBookingUrl).
--
--   3. NULL — a genuinely register-link-less city event (free
--      community happening, multi-venue umbrella with no central
--      sign-up). The parent slug URL stays the booking link, as
--      it always was.
--
-- Why a new column instead of overloading `external_slug`
-- ─────────────────────────────────────────────────────────
-- `external_slug` is the UPSERT KEY (sql/038 partial UNIQUE
-- `(source, external_slug) WHERE source IN ('rg-muni',…)`). Two
-- city events that share a parent slug (umbrella + children) would
-- collide on it. The registration URL has the opposite property:
-- distinct per occurrence, never used as an identity. Keeping
-- them separate is the right model.
--
-- Smarticket rows leave this column NULL by convention. Their
-- booking URL is constructed from `event.id` against the tenant's
-- origin — no per-row override is needed.

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS external_url TEXT;

COMMENT ON COLUMN public.events.external_url IS
  'Per-event registration URL for city events whose third-party '
  'booking provider sits outside the smarticket / city-page URL '
  'space (paykal.co.il, bina.org.il, …). NULL when the parent '
  'city slug page is the only known booking entry point. '
  'Smarticket events ignore this column.';
