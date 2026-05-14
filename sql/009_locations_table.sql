-- Persistent geocoding cache. Every address/venue we try to resolve is stored
-- here exactly once, so we never hit a paid/rate-limited map API twice for the
-- same string. "found = false" rows record negative results so we don't keep
-- hammering Nominatim for known-bad input.

CREATE TABLE IF NOT EXISTS public.locations (
  key           TEXT PRIMARY KEY,                -- normalized lookup key (lower, trimmed, single spaces)
  raw_address   TEXT NOT NULL,                   -- original string we tried to geocode
  display_name  TEXT,                            -- canonical name from the geocoder
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  source        TEXT NOT NULL DEFAULT 'nominatim',  -- 'venues' | 'nominatim' | 'manual'
  found         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT now(),
  last_used_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_locations_found ON public.locations (found);

GRANT ALL ON public.locations TO postgres, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
