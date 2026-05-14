-- Remove the structured filter columns we no longer rely on.
-- The bot now hands the raw event list (id, name, date, start_time, location,
-- tickets_left) to Gemini and lets it judge age-appropriateness and semantic
-- name matching. No SQL-side ILIKE on name_normalized; no JS-side age range
-- filter. Less schema, more brain.

DROP INDEX IF EXISTS public.idx_events_age_range;
DROP INDEX IF EXISTS public.idx_events_name_normalized_trgm;

ALTER TABLE public.events
  DROP COLUMN IF EXISTS age_min,
  DROP COLUMN IF EXISTS age_max,
  DROP COLUMN IF EXISTS name_normalized;

NOTIFY pgrst, 'reload schema';
