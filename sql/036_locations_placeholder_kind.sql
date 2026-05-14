-- Add 'placeholder' as a valid `locations.kind`.
--
-- Background:
--   sql/014 introduced the kind column with the closed set
--   {physical, virtual, unknown}. We now have a fourth real-world
--   case: events whose source explicitly publishes a placeholder
--   "venue" (e.g. ramat-gan's LGBTQ Department uses Hebrew "כללי" =
--   "general" on its sensitive groups, signaling "address given on
--   registration only").
--
--   Previously these rows ended up either:
--     (a) FK'd to a poisoned `locations.כללי` row that Google Places
--         resolved to City Hall — wildly wrong, see today's incident.
--     (b) Force-nulled in events to dodge that — losing the signal
--         that the source DID say something about location.
--
--   Adding the `placeholder` kind lets us preserve the signal
--   without the false geocode: the row exists, FK is intact,
--   geocoder skips it, UI sees `lat IS NULL` and hides the maps
--   button (same as virtual). Distinguishable from "we never tried"
--   (events.location_key IS NULL) and "we tried but source 404'd"
--   (events.location_key IS NULL AND enrichment_last_attempt IS NOT
--   NULL).

BEGIN;

ALTER TABLE public.locations
  DROP CONSTRAINT IF EXISTS locations_kind_check;

ALTER TABLE public.locations
  ADD CONSTRAINT locations_kind_check
    CHECK (kind IN ('physical', 'virtual', 'placeholder', 'unknown'));

COMMIT;

NOTIFY pgrst, 'reload schema';
