-- Event interests: user marks an event as interesting (⭐).
-- Purpose:
--   1. Send a reminder the evening before the event.
--   2. Learn user taste via interest_signals stored in profiles.user_context.
--
-- Deliberately separate from event_watchers (ticket availability alerts).
-- Interests apply to ALL events — free city events, sold-out shows, anything.

CREATE TABLE IF NOT EXISTS public.event_interests (
  telegram_id     TEXT        NOT NULL,
  event_id        BIGINT      NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reminder_sent_at TIMESTAMPTZ,
  PRIMARY KEY (telegram_id, event_id)
);

-- Index for the nightly reminder job: scan by event date (via JOIN) is
-- the main query pattern; this index covers it on the interests side.
CREATE INDEX IF NOT EXISTS idx_event_interests_telegram
  ON public.event_interests (telegram_id);

NOTIFY pgrst, 'reload schema';
