-- Add 'community-women' to the events.access enum.
--
-- Context:
--   We are splitting the women-only signal OUT of audience_t — where "נשים"
--   conflated a gender RESTRICTION with an age/life-stage — into the access
--   axis, where it belongs alongside the other community scopes. After this
--   migration a women-only event is access=['community-women'] and its
--   `audience` reflects the actual age tier (מבוגרים / ותיקים / …).
--
--   'community-women' follows the existing 'community-*' convention
--   (sql/039 +). A user sees these events when their profile scopes include
--   'community-women' (the 👩 chip in the profile community picker).
--
-- ORDER: Postgres forbids USING a freshly-added enum value in the SAME
-- transaction that adds it. Run THIS statement on its own first. The data
-- migration that stamps access=['community-women'] on the existing
-- audience='נשים' rows runs separately (a node backfill), AFTER this commits.

ALTER TYPE public.access_t ADD VALUE IF NOT EXISTS 'community-women';
