-- Add a `city` column to locations.
--
-- Why:
--   Geocoders (Google Places, Nominatim, our LLM normalizer) are
--   ambiguous when handed bare venue text. "מרכז קהילתי אורות" can
--   plausibly resolve to a community center in Ramat Gan OR a street
--   named "אורים" in Tel Aviv. Without locality context, Google
--   silently picks the latter — which it did, until we noticed.
--
--   Storing the city alongside every venue lets us append it to the
--   geocoder query ("מרכז קהילתי אורות, רמת גן") so the geocoder
--   either finds the right place or returns null. Never a confidently-
--   wrong neighbouring city.
--
--   It also makes future multi-city expansion a one-column-write
--   instead of a refactor: when we start scraping a feed for, say,
--   Givatayim, the rows just get city='גבעתיים' and the rest of the
--   pipeline already knows what to do.
--
-- The column is NOT NULL with default 'רמת גן' — every existing row
-- gets backfilled automatically. The default mirrors the JS-side
-- `DEFAULT_GEOCODE_CITY` env var; keep them in sync if you change one.

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS city TEXT NOT NULL DEFAULT 'רמת גן';

NOTIFY pgrst, 'reload schema';
