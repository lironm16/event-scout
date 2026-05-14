-- Track whether a location is a real-world physical address, an online /
-- non-physical venue (Zoom, online webinar, etc.), or still unclassified.
-- This drives the user-facing "physical-only / virtual-only / any" search
-- filter and lets us never re-attempt geocoding on virtual entries.

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'unknown'
    CHECK (kind IN ('physical', 'virtual', 'unknown'));

-- Backfill: rows previously tagged virtual via `source='virtual'` keep that
-- status; rows that geocoded successfully are physical; everything else
-- (pending, transiently failed, manual entries without coords) stays unknown.
UPDATE public.locations
   SET kind = 'virtual'
 WHERE source = 'virtual';

UPDATE public.locations
   SET kind = 'physical'
 WHERE kind = 'unknown'
   AND found = TRUE
   AND lat IS NOT NULL
   AND lng IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_locations_kind ON public.locations (kind);

NOTIFY pgrst, 'reload schema';
