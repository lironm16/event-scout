-- Add `access` dimension to events: who is this event for, scope-wise?
--
-- Why:
--   The existing schema captures WHEN (date), WHERE (location_key),
--   WHO age-wise (audience), and WHAT topic (tag_ids / category) for
--   every event. None of these answer: "is this event for the
--   general public, or only for members of a specific community?".
--   That gap caused real UX harm — a parent searching the bot for
--   "kids events Saturday" would see "סדנת בשרים לנבחרת הנוער"
--   (chef workshop for the youth team of the dept. for kids with
--   disabilities) because audience='נוער' matched, even though the
--   event is restricted to that specific population. The tag
--   "ילדים ובוגרים עם מוגבלות" was visible on the card but it's
--   easy to miss in a list.
--
--   This column lets us filter at the query layer instead of
--   hoping the user reads tags carefully.
--
-- Closed-set ENUM, not free-text:
--   Same reasoning as `audience_t` / `category_t` (sql/032) and
--   `source_t` (sql/035) — the set of community scopes is finite,
--   slowly-changing, and DB-level rejection of typos is cheaper
--   than catching them at query time. Adding a new value later is
--   `ALTER TYPE access_t ADD VALUE 'new-scope';` — same lockstep
--   pain we already live with elsewhere.
--
-- Initial values:
--   'open'                    — anyone can attend. The default.
--   'community-disabilities'  — events run by/for the disability
--                                community (city's category:
--                                "ילדים ובוגרים עם מוגבלות").
--   'community-lgbtq'         — events from "מחלקת הקהילה הגאה" /
--                                המרכז הגאה. The city's category
--                                "הקהילה הגאה" is the strongest
--                                signal.
--   'community-seniors'       — 60+ ONLY events (vs 60+ inclusive
--                                ones). Not classified yet for any
--                                source; declared for forward
--                                compatibility.
--   More values can be added later without code changes elsewhere.
--
-- DEFAULT = 'open':
--   Backfill-free migration. Every existing row is presumed open
--   (and that's correct for ~99% of them — only city-feed rows
--   matching specific category names need to be reclassified, and
--   the city scraper does that on its next run via `mapAccess` in
--   lib/cityApi.js).
--
-- NOT NULL:
--   Same rationale as `source` (sql/034). A NULL access value
--   would be ambiguous — "open or unknown?" — and every query
--   site would have to handle that ambiguity. Requiring a value
--   keeps the filtering rule simple: `WHERE access = 'open'`.

BEGIN;

CREATE TYPE public.access_t AS ENUM (
  'open',
  'community-disabilities',
  'community-lgbtq',
  'community-seniors'
);

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS access public.access_t NOT NULL DEFAULT 'open';

-- B-tree index. Cardinality is tiny (4 values today) but the
-- WHERE access = 'open' filter runs on every search query — make
-- the planner's life easy.
CREATE INDEX IF NOT EXISTS idx_events_access ON public.events (access);

COMMIT;

NOTIFY pgrst, 'reload schema';
