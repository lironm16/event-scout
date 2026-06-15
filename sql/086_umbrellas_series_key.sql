-- Let `umbrellas` also represent recurring same-name Smarticket SERIES,
-- not just city/Smarticket PROGRAMME umbrellas.
--
-- Background:
--   A recurring show ("ר\"געים משחקיה התפתחותית" running ~daily) lives
--   as N independent `events` rows. They share no `external_slug` (the
--   redirect rarely resolves to one), so `smarticketGroupBySlug`
--   (sql/058 model, keyed on external_slug) never grouped them — and
--   the full ~2KB description is stored DUPLICATED on every one of the
--   ~100+ occurrences. Measured: 35 such series, ~431KB duplicated,
--   two ר"געים series alone accounting for 93%.
--
-- The fix (this column + lib/seriesParentService.js):
--   Promote each recurring series to a "series-parent" umbrella that
--   holds the shared description ONCE. Children link via
--   `events.umbrella_id` (sql/058) and READ the description through it
--   (child.description ?? umbrella.description). The child's own
--   `description` is then NULLed — reclaiming the duplication and
--   side-stepping the historical 2000-char truncation (the parent
--   stores the full blurb).
--
-- Why a `series_key` column rather than reusing `slug`:
--   PROGRAMME umbrellas are keyed by their real city/Smarticket
--   `slug`. SERIES parents have no natural slug — their identity is the
--   `seriesKey` tuple (normalized name + min_months + max_months) from
--   lib/eventSeries.js. Storing that tuple explicitly lets the
--   reconciler find/Upsert the right parent deterministically without
--   overloading `slug` semantics. `slug` still gets a synthetic
--   "series:<hash>" value to satisfy the NOT NULL + (source,slug)
--   uniqueness, but the reconciler matches on `series_key`.
--
-- UI-safety — why children get umbrella_id but NOT umbrella_slug/title:
--   `seriesKey()` returns `umb:<slug>` when a child carries
--   `umbrella_slug`, which would flip the card from the recurring-series
--   treatment ("🔁 כל המופעים") to the programme treatment
--   ("📋 כל אירועי …"). These ARE occurrences of one show, not distinct
--   programme events, so we intentionally leave umbrella_slug/title NULL
--   on series children. They collapse exactly as before (name+age), and
--   the umbrella row is a pure storage detail for the description.
--
-- Idempotency: ADD COLUMN / CREATE INDEX use IF NOT EXISTS.

BEGIN;

ALTER TABLE public.umbrellas
  ADD COLUMN IF NOT EXISTS series_key TEXT;

COMMENT ON COLUMN public.umbrellas.series_key IS
  'For series-parent umbrellas: the lib/eventSeries.js seriesKey tuple (normalized name|min_months|max_months). NULL for real programme umbrellas keyed by slug.';

-- One series-parent per (source, series_key). Partial — programme
-- umbrellas leave series_key NULL and are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS umbrellas_source_series_key_uniq
  ON public.umbrellas (source, series_key)
  WHERE series_key IS NOT NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
