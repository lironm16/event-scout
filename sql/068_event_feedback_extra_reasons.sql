-- Extend event_feedback.reason CHECK for flows added after sql/022.
ALTER TABLE public.event_feedback
  DROP CONSTRAINT IF EXISTS event_feedback_reason_check;

ALTER TABLE public.event_feedback
  ADD CONSTRAINT event_feedback_reason_check CHECK (reason IN (
    'wrong_audience',
    'too_far',
    'wrong_time',
    'not_interested',
    'already_seen',
    'already_known',
    'other'
  ));

NOTIFY pgrst, 'reload schema';
