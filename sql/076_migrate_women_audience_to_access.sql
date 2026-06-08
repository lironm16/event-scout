-- Data migration: move existing women-only events from the audience axis
-- (audience = 'נשים') onto the access axis (access = ['community-women']).
--
-- Part of the audience/access split: audience is now PURELY age/life-stage,
-- and "women-only" is a hard community/eligibility scope on `access`.
--
-- ORDER: run AFTER sql/075 has COMMITTED — 'community-women' must already exist
-- in the access_t enum (Postgres forbids adding + using an enum value in one
-- transaction). Run sql/075 first, then this file.
--
-- Idempotent: only touches rows not already scoped to community-women.
--
-- NOTE on `audience`: we intentionally LEAVE audience = 'נשים' on these rows
-- for now. The enrichment backfill (fresh Gemini, once quota resets) re-derives
-- the real age tier (מבוגרים / ותיקים / …) from title+description and confirms
-- access = ['community-women']. Until then the row stays visible/valid; the
-- backfill suspect set will include audience = 'נשים'.

UPDATE public.events
SET access = ARRAY['community-women']::public.access_t[]
WHERE audience = 'נשים'
  AND NOT (access @> ARRAY['community-women']::public.access_t[]);

-- Sanity check (run manually to see the affected rows):
--   SELECT id, name, audience, access FROM public.events WHERE audience = 'נשים';
