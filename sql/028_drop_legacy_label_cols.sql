-- Drop the legacy label columns that have been fully superseded by the
-- normalized schema (sql/026 + sql/027).
--
-- All three columns served as transitional storage during the path to
-- the normalized labels:
--
--   - events.processed_labels (JSONB)        — sql/025
--       Held the AI-extracted blob with target_audience / age_group /
--       activity_type / etc. Replaced by events.min_months,
--       events.max_months, events.audience_id, events.category_id,
--       events.tag_ids[].
--
--   - events.inferred_audience (TEXT enum)   — sql/021
--       Earlier single-string audience classification, used as the
--       upstream signal for processed_labels.target_audience. Replaced
--       by events.audience_id (FK into the labels dictionary).
--
--   - events.audience_classified_at (TZ)     — sql/021
--       Companion column to inferred_audience, used as a
--       "do-not-retry" marker. With the new pipeline the equivalent
--       marker is `events.description_hash IS NOT NULL` AND
--       `events.category_id IS NOT NULL`.
--
-- Drop the supporting GIN index too — it's pinned to the JSONB
-- column we're removing.

DROP INDEX IF EXISTS public.idx_events_processed_labels_gin;

ALTER TABLE public.events
  DROP COLUMN IF EXISTS processed_labels,
  DROP COLUMN IF EXISTS inferred_audience,
  DROP COLUMN IF EXISTS audience_classified_at;

NOTIFY pgrst, 'reload schema';
