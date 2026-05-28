-- sql/067 — enrichment_failed_at
-- Marks events that Gemini could not classify (e.g. timeout)
-- so the enrichment cron skips them instead of retrying indefinitely.
-- audience / category remain NULL — no automatic fallback values.
-- To retry an event manually: UPDATE events SET enrichment_failed_at = NULL WHERE id = X;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS enrichment_failed_at TIMESTAMPTZ;

COMMENT ON COLUMN events.enrichment_failed_at IS
  'Set when Gemini failed to classify this event (e.g. two timeouts). '
  'The enrichment cron skips rows with a non-null value here. '
  'audience and category are left NULL for manual review. '
  'Reset to NULL to allow a re-enrichment attempt.';

NOTIFY pgrst, 'reload schema';
