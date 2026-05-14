-- Replace the free-text `events.location` column with a foreign key into the
-- `locations` cache. After this migration, an event's venue is always one row
-- in `locations`, identified by its normalized `key`. Multiple events that
-- share a venue point at the same row, so the geocoder runs at most once per
-- distinct venue.
--
-- Prereq: 012_locations_pending_state.sql (allows locations.found = NULL).

-- 1) Mirrors lib/locationStore.js#normalizeKey for SQL-side use.
--    Implementation note: this function MUST NOT contain string literals with
--    embedded quote characters (some web SQL editors mis-tokenize them across
--    statement boundaries). We use translate() with chr() codepoints so the
--    only literals are pure ASCII whitespace.
--      chr(1523) = ׳ (Hebrew geresh,    U+05F3)
--      chr(1524) = ״ (Hebrew gershayim, U+05F4)
--      chr(39)   = '  (ASCII apostrophe)
--      chr(34)   = "  (ASCII double quote)
CREATE OR REPLACE FUNCTION public.normalize_location_key(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $body$
  SELECT NULLIF(
    trim(
      regexp_replace(
        translate(
          lower(input),
          chr(1523) || chr(1524),
          chr(39) || chr(34)
        ),
        '\s+', ' ', 'g'
      )
    ),
    ''
  );
$body$;

-- 2) Insert pending stubs for every distinct venue text that doesn't already
--    have a row in `locations`. Stubs have found=NULL and source='pending'.
--    The explicit casts are required: PostgreSQL otherwise infers NULL as
--    `text` in a SELECT and rejects it against the boolean `found` column.
INSERT INTO public.locations (key, raw_address, source, found)
SELECT DISTINCT
  public.normalize_location_key(e.location)::text,
  e.location::text,
  'pending'::text,
  NULL::boolean
FROM public.events e
WHERE e.location IS NOT NULL
  AND length(trim(e.location)) > 0
  AND public.normalize_location_key(e.location) IS NOT NULL
ON CONFLICT (key) DO NOTHING;

-- 3) Add the FK column and backfill from existing events.location text.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS location_key TEXT
    REFERENCES public.locations(key) ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE public.events
   SET location_key = public.normalize_location_key(location)
 WHERE location IS NOT NULL
   AND length(trim(location)) > 0
   AND location_key IS NULL;

-- 4) Index for joins and "events at venue X" lookups.
CREATE INDEX IF NOT EXISTS idx_events_location_key
  ON public.events (location_key);

-- 5) Drop the legacy text column. From now on, the venue text lives in
--    locations.raw_address and is fetched via JOIN.
ALTER TABLE public.events
  DROP COLUMN IF EXISTS location;

NOTIFY pgrst, 'reload schema';
