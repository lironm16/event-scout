-- Rename events.age → events.age_range. "age" read like a single number; the
-- column is a typed RANGE object ({min,max} with kind/value/inclusive), so
-- age_range is the honest name. The column is empty at this point (added in
-- sql/077, populated only by the upcoming backfill), so the rename is trivial.
--
-- Guarded so it is a no-op when already renamed or on a fresh DB where sql/077
-- never created `age`.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'events' AND column_name = 'age'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'events' AND column_name = 'age_range'
  ) THEN
    ALTER TABLE public.events RENAME COLUMN age TO age_range;
  END IF;
END $$;
