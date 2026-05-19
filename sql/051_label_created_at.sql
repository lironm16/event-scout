-- Track when each label was first inserted into the dictionary.
-- Used by the semantic-match feature to surface a "🆕 חדש בקטלוג"
-- hint on event cards whose novel label is recent. Existing rows
-- get the migration's run-time as a reasonable "we don't know,
-- treat as old" baseline; nothing in the bot depends on this for
-- correctness, only for the freshness pill in the UI.

ALTER TABLE public.labels
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Cheap index for "labels created in last N days" lookups. The
-- semantic matcher reads created_at on demand per-event-batch, but
-- a few label-store callers may also want to slice the dictionary
-- by recency in the future.
CREATE INDEX IF NOT EXISTS idx_labels_created_at
  ON public.labels (created_at DESC);

NOTIFY pgrst, 'reload schema';
