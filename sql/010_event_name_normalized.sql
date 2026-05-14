-- Generated, lowercased, quote-stripped column used for fuzzy ILIKE search.
-- The transformation MUST stay in sync with lib/textNormalize.js.
--
-- Stripped characters (in order, see Unicode codepoints):
--   ' " ` ´ ׳ ״ “ ” ‘ ’ . , ; : ! ?
-- Collapsed runs of whitespace → single space, then lowercased and trimmed.

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS name_normalized TEXT
  GENERATED ALWAYS AS (
    btrim(
      regexp_replace(
        regexp_replace(
          lower(name),
          '[' || E'\u0027\u0022\u0060\u00B4\u05F3\u05F4\u2018\u2019\u201C\u201D' || '.,;:!?]+',
          '',
          'g'
        ),
        E'\\s+',
        ' ',
        'g'
      )
    )
  ) STORED;

-- Best-effort fast lookup. pg_trgm gives us indexed `ILIKE %x%` which is what
-- the bot uses. Falls back to a plain functional btree if the extension is
-- already enabled at the project level (Supabase: Database → Extensions).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_events_name_normalized_trgm ' ||
            'ON public.events USING GIN (name_normalized gin_trgm_ops)';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
