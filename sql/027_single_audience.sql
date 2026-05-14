-- Collapse audience from `INT[]` to a single FK column.
--
-- The audience taxonomy is small (5 values) and in practice every
-- event has exactly one primary audience. A survey of 315 active
-- events showed 296 single-valued, 19 multi-valued — and every
-- multi-valued case was better expressed as "לכל המשפחה" (the
-- catch-all) once you account for the fact that the numeric age
-- range columns (min_months / max_months) already carry the precise
-- age. The `audience` column doesn't need to overlap.
--
-- The new shape is symmetric with `category_id`: a single INT FK
-- pointing into `labels(id)`. This gives us referential integrity
-- at the DB level (which array columns can't get in Postgres) and
-- simpler queries.
--
-- This migration:
--   1. Adds audience_id INT REFERENCES labels(id)
--   2. Backfills it from the existing audience_ids array:
--        - 1-element arrays → that element
--        - 2+-element arrays → "לכל המשפחה"
--   3. Drops the GIN index and the audience_ids array column.

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS audience_id INT REFERENCES public.labels(id);

CREATE INDEX IF NOT EXISTS idx_events_audience_id ON public.events (audience_id);

-- Backfill: single-element arrays copy the lone id directly. Postgres
-- arrays are 1-indexed, so audience_ids[1] is the first (and only) id.
UPDATE public.events
SET audience_id = audience_ids[1]
WHERE audience_id IS NULL
  AND array_length(audience_ids, 1) = 1;

-- Multi-element arrays fold to "לכל המשפחה" (the catch-all). We look
-- up the seeded label id by (kind, name) so this stays portable
-- across environments where SERIAL ids might differ.
UPDATE public.events
SET audience_id = (
  SELECT id FROM public.labels
  WHERE kind = 'audience' AND name = 'לכל המשפחה'
)
WHERE audience_id IS NULL
  AND array_length(audience_ids, 1) > 1;

-- Drop the array column and its GIN index. The new audience_id is
-- enough on its own.
DROP INDEX IF EXISTS public.idx_events_audience_ids;
ALTER TABLE public.events DROP COLUMN IF EXISTS audience_ids;

NOTIFY pgrst, 'reload schema';
