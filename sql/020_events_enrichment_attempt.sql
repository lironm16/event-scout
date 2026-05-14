-- Track when we last tried to enrich an event from the Smarticket listing
-- HTML. Events whose location/image is genuinely missing on the listing
-- page (small community events, one-offs, etc.) would otherwise loop
-- forever — we'd refetch the listing every scrape cycle, find nothing
-- new, and re-queue them. With this column the enricher can apply a
-- cooldown ("we tried 4h ago — skip") so stubborn events get retried
-- once a day instead of every few minutes.

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS enrichment_last_attempt TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_events_enrichment_last_attempt
  ON public.events (enrichment_last_attempt);

NOTIFY pgrst, 'reload schema';
