-- Lock down `locations.source` to a known set of values, the same way
-- `kind` is constrained. TEXT + CHECK gives us enum-grade data-integrity
-- without the rigidity of a PG ENUM type (no ALTER TYPE dance to add a
-- value, no painful renames, etc.).
--
-- Allowed values:
--   pending    — stub inserted by the scraper, geocoder hasn't run yet.
--   venues     — resolved via the curated lib/venues.js mapping.
--   nominatim  — resolved via OpenStreetMap / Nominatim.
--   virtual    — auto-detected as a non-physical venue (Zoom, online, etc.).
--   manual     — operator-curated entry (e.g. tagged virtual or fixed coords by hand).

ALTER TABLE public.locations
  DROP CONSTRAINT IF EXISTS locations_source_check;

ALTER TABLE public.locations
  ADD CONSTRAINT locations_source_check
  CHECK (source IN ('pending', 'venues', 'nominatim', 'virtual', 'manual'));

NOTIFY pgrst, 'reload schema';
