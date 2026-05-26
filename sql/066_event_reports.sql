-- Operator-facing bug/quality reports submitted from the Mini App.
-- Distinct from event_feedback (which captures "not interested" signals).
-- These are intentional quality reports ("wrong audience", "bad description")
-- that the operator reviews and acts on manually.

CREATE TABLE IF NOT EXISTS public.event_reports (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id      INTEGER NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  telegram_id   TEXT,                        -- null for unauthenticated web users
  issue_type    TEXT NOT NULL CHECK (issue_type IN (
    'wrong_audience',   -- קהל יעד שגוי
    'wrong_category',   -- סיווג / תגיות שגויים
    'bad_description',  -- תיאור חסר או שגוי
    'duplicate',        -- אירוע כפול
    'wrong_time',       -- שעה / תאריך שגויים
    'other'             -- אחר
  )),
  note          TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_reports_event_id   ON public.event_reports (event_id);
CREATE INDEX IF NOT EXISTS idx_event_reports_created_at ON public.event_reports (created_at DESC);

NOTIFY pgrst, 'reload schema';
