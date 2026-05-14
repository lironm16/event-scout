-- request_traces — full execution tracing for each user message.
--
-- Every Telegram message that hits the agent (or even a static reply)
-- gets a row here. The `steps` JSONB array is appended to in-flight as
-- the request progresses, so an operator can SELECT the row mid-flight
-- and see exactly where it's stuck.
--
-- We never DELETE traces — this is the audit log we use to debug
-- timeouts and accuracy issues. Cleanup is handled by a TTL cron later
-- (raw size is small: a few KB per trace, so we can keep months easily).
--
-- Indexes are tuned for two access patterns:
--   1. /debug <traceId> command   → primary key lookup, free.
--   2. "show me errors from today" → (created_at, error IS NOT NULL).

CREATE TABLE IF NOT EXISTS public.request_traces (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id  TEXT NOT NULL,
  input_text   TEXT,
  steps        JSONB NOT NULL DEFAULT '[]'::jsonb,
  ai_payload   JSONB,
  output_text  TEXT,
  error        TEXT,
  duration_ms  INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_request_traces_user_recent
  ON public.request_traces (telegram_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_request_traces_errors
  ON public.request_traces (created_at DESC)
  WHERE error IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_request_traces_in_flight
  ON public.request_traces (created_at DESC)
  WHERE finished_at IS NULL;

NOTIFY pgrst, 'reload schema';
