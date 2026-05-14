-- Per-user feedback on events the bot surfaced. Captured via the
-- "❌ לא מתאים" button on event cards. Multiple reason buckets so we can
-- distinguish a real mis-classification (wrong audience) from "I just
-- don't feel like going" — only the former should ever influence the
-- audience tag in `events`.
--
-- Aggregation policies live in `lib/feedbackService.js`. This table is
-- the raw event log; it never gets compacted (we want history for any
-- future ML calibration work).

CREATE TABLE IF NOT EXISTS public.event_feedback (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id      INTEGER NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  telegram_id   TEXT NOT NULL,
  reason        TEXT NOT NULL CHECK (reason IN (
    'wrong_audience',  -- "this isn't for my kids" / "this isn't for adults"
    'too_far',         -- "venue is too far from my home"
    'wrong_time',      -- "time of day doesn't work for me"
    'not_interested',  -- "the topic itself doesn't appeal"
    'already_seen',    -- "already attended / saw earlier suggestion"
    'other'            -- free-form fallback; user picked "אחר"
  )),
  note          TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Same user reporting the same reason on the same event twice in a short
-- window adds no signal. We dedupe at the app layer rather than via a
-- partial unique index, since the timestamp is meaningful for analysis.
CREATE INDEX IF NOT EXISTS idx_event_feedback_event_id ON public.event_feedback (event_id);
CREATE INDEX IF NOT EXISTS idx_event_feedback_user ON public.event_feedback (telegram_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_feedback_reason ON public.event_feedback (reason);

NOTIFY pgrst, 'reload schema';
