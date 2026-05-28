-- Add 'community-olim' to the events.access enum.
--
-- Events for new immigrants (עולים / olim) are often tagged "עולים חדשים"
-- in enrichment but were not gated — they stayed `open`. This scope lets
-- users opt in via the community picker and filters like other communities.
--
-- Distinct from `community-russian` ("לעולים מרוסיה" / Cyrillic titles).
-- Classifier order in lib/access.js: Russian phrase wins when both apply.
--
-- Backfill: jobs/backfillAccessOlim.js after this migration.

ALTER TYPE public.access_t ADD VALUE IF NOT EXISTS 'community-olim';

NOTIFY pgrst, 'reload schema';
