-- 082: developmental-stage targeting on events (structured, LLM-set).
--
-- Some events target a child's DEVELOPMENTAL stage rather than a chronological
-- age — "סדנת גמילה", "מתחילים מוצקים", "לתינוקות שעוד לא הולכים", "טרום-מילולי".
-- The profile already captures each kid's stages (crawl/walk/wean/solids/talk,
-- see kidsWizardUi DEV_STAGES); this gives the EVENT side the same structured
-- vocabulary so matching is reliable instead of regex-scraped from free text.
--
-- Distinct from events.age_range (chronological): dev_stages is a SET of
-- discrete developmental markers, not a numeric range.
--
-- Vocabulary (must match kidsWizardUi DEV_STAGES ids):
--   crawl=זוחל · walk=הולך · wean=גמול · solids=אוכל מוצקים · talk=מדבר
--
-- Empty array = no developmental targeting (the common case). Idempotent.

ALTER TABLE events ADD COLUMN IF NOT EXISTS dev_stages text[] NOT NULL DEFAULT '{}';

-- GIN index for "events targeting stage X" overlap queries.
CREATE INDEX IF NOT EXISTS idx_events_dev_stages ON events USING gin (dev_stages);

NOTIFY pgrst, 'reload schema';
