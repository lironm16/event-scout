-- Allow `found` to be NULL — that's the "pending" state.
-- Semantics after this migration:
--   found IS NULL  → row was inserted by the scraper but the geocoder hasn't
--                    run yet. The worker should pick this row up.
--   found = TRUE   → resolved successfully; lat/lng are populated.
--   found = FALSE  → tried and failed; do NOT retry.
--
-- Existing rows are unaffected because they all have an explicit TRUE/FALSE.

ALTER TABLE public.locations
  ALTER COLUMN found DROP NOT NULL,
  ALTER COLUMN found DROP DEFAULT;

CREATE INDEX IF NOT EXISTS idx_locations_pending
  ON public.locations (key)
  WHERE found IS NULL;

NOTIFY pgrst, 'reload schema';
