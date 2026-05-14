-- Allow `google_places` as a valid provenance for locations.lat/lng. Same
-- shape as 015 — drop+recreate the CHECK constraint to extend the allow list.

ALTER TABLE public.locations
  DROP CONSTRAINT IF EXISTS locations_source_check;

ALTER TABLE public.locations
  ADD CONSTRAINT locations_source_check
  CHECK (source IN ('pending', 'venues', 'nominatim', 'virtual', 'manual', 'google_places'));

NOTIFY pgrst, 'reload schema';
