-- sql/072 — enrichment retry/backoff (replaces binary enrichment_failed_at-only flow)
--
-- enrichment_failed_at     = permanent give-up after ENRICHMENT_MAX_FAILS attempts
-- enrichment_fail_count    = consecutive classified failures
-- enrichment_fail_reason   = last failure class (gemini_timeout, input_fetch, …)
-- enrichment_next_retry_at = earliest time the cron may pick the row again
--
-- Reset for manual retry:
--   UPDATE events SET enrichment_failed_at = NULL, enrichment_fail_count = 0,
--     enrichment_fail_reason = NULL, enrichment_next_retry_at = NULL WHERE id = X;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS enrichment_fail_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS enrichment_fail_reason TEXT,
  ADD COLUMN IF NOT EXISTS enrichment_next_retry_at TIMESTAMPTZ;

COMMENT ON COLUMN events.enrichment_fail_count IS
  'Consecutive enrichment failures. Reset to 0 on success. At ENRICHMENT_MAX_FAILS (5) enrichment_failed_at is set.';
COMMENT ON COLUMN events.enrichment_fail_reason IS
  'Last failure class: gemini_timeout | gemini_rate_limit | gemini_daily_limit | gemini_bad_json | gemini_error | input_fetch | input_empty';
COMMENT ON COLUMN events.enrichment_next_retry_at IS
  'Earliest retry time after a transient failure. NULL when no retry is scheduled or after permanent give-up.';

COMMENT ON COLUMN events.enrichment_failed_at IS
  'Permanent give-up after repeated failures. Cron skips these rows. Clear along with fail_count/reason/next_retry_at to retry manually.';

CREATE INDEX IF NOT EXISTS idx_events_enrichment_retry
  ON events (enrichment_next_retry_at)
  WHERE archived = false
    AND enrichment_failed_at IS NULL
    AND enrichment_next_retry_at IS NOT NULL;

NOTIFY pgrst, 'reload schema';
