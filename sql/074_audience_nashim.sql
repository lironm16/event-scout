-- Add 'נשים' to audience_t — women-only events (סדנאות/מרחבים/קבוצות לנשים,
-- "נשים צעירות"). Distinct from 'מבוגרים' (general 18+) and must NOT be
-- mistaken for 'נוער' (12–18) just because a blurb says "נשים צעירות".
--
-- Run ONCE in the Supabase SQL Editor. Then backfill existing rows:
--   node jobs/backfillAudienceNashim.js
--
-- (ENUM ADD VALUE cannot run inside a transaction with later use of the
--  value, so this stands alone — exactly like sql/070_audience_vatikim.sql.)

ALTER TYPE public.audience_t ADD VALUE IF NOT EXISTS 'נשים';

NOTIFY pgrst, 'reload schema';
