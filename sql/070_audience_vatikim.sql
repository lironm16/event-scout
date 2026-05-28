-- Add 'ותיקים' to audience_t — senior-targeted events (60+ / אזרחים ותיקים).
--
-- Distinct from 'מבוגרים' (general 18+ / young-adult parties). Senior
-- city programming ("מגוון הרצאות לאזרחים ותיקים") should use this value
-- so cards and search filters don't show generic "למבוגרים".
--
-- Backfill: jobs/backfillAudienceVatikim.js after this migration.

ALTER TYPE public.audience_t ADD VALUE IF NOT EXISTS 'ותיקים';

NOTIFY pgrst, 'reload schema';
