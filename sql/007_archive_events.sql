-- 1) Add a real `archived` flag to events (replaces the `location='__archived__'` sentinel).
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;

-- 2) Backfill: anything previously sentinel-archived in api/enrich.js → archived = true.
UPDATE public.events
   SET archived = TRUE
 WHERE location = '__archived__';

UPDATE public.events
   SET location = NULL
 WHERE location = '__archived__';

-- 3) Auto-archive everything already in the past at migration time.
UPDATE public.events
   SET archived = TRUE
 WHERE date IS NOT NULL
   AND date < CURRENT_DATE;

-- 4) Targeted cleanup: stale admin entry that is NOT a real event.
DELETE FROM public.events
 WHERE name ILIKE '%השלמת תשלום%';

-- 5) Helpful index for the hot search path.
CREATE INDEX IF NOT EXISTS idx_events_active_future
  ON public.events (date)
  WHERE archived = FALSE;

NOTIFY pgrst, 'reload schema';
