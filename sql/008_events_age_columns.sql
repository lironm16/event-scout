-- Add age range columns so we can do strict server-side age filtering.
-- These are populated by lib/eventParsing.js at scrape time (api/check.js).
-- NULL means "unknown age range" — caller decides whether to include it.

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS age_min SMALLINT,
  ADD COLUMN IF NOT EXISTS age_max SMALLINT;

-- One-time best-effort backfill straight from event names.
-- "לגילאי 4-6" / "גילאי 2-4" / "ages 4-6"
UPDATE public.events
   SET age_min = (substring(name from '(?:גיל(?:אי)?|ages?)\s*(\d+)\s*[\-–]\s*\d+'))::int,
       age_max = (substring(name from '(?:גיל(?:אי)?|ages?)\s*\d+\s*[\-–]\s*(\d+)'))::int
 WHERE age_min IS NULL
   AND name ~* '(?:גיל(?:אי)?|ages?)\s*\d+\s*[\-–]\s*\d+';

-- "מגיל 3" / "מגיל 3+"  → open-ended upper bound
UPDATE public.events
   SET age_min = (substring(name from 'מגיל\s*(\d+)'))::int,
       age_max = 99
 WHERE age_min IS NULL
   AND name ~* 'מגיל\s*\d+';

-- "לכל המשפחה" / "לכל הגילאים"
UPDATE public.events
   SET age_min = 0, age_max = 99
 WHERE age_min IS NULL
   AND name ~* 'לכל\s+(המשפחה|הגילאים)';

CREATE INDEX IF NOT EXISTS idx_events_age_range
  ON public.events (age_min, age_max)
  WHERE archived = FALSE;

NOTIFY pgrst, 'reload schema';
