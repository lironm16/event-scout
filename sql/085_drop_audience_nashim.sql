-- Remove 'נשים' from audience_t.
--
-- Background: sql/074 added 'נשים' as an audience value; sql/075/076 then
-- split the women-only signal OUT of audience onto the access axis
-- (access = ['community-women']). 'נשים' is an IDENTITY/community, not an
-- age/life-stage, so it never belonged in audience_t. All event +
-- umbrella rows have since been migrated off it (verified: 0 rows on
-- events.audience and umbrellas.default_audience).
--
-- Postgres has no DROP VALUE for enums, so we recreate the type without
-- 'נשים' and re-point both dependent columns. The `USING …::text::…`
-- casts double as a guard: if any stray row still held 'נשים' the cast
-- would error and abort the whole migration (run inside one transaction).
--
-- Final value set: תינוקות | ילדים | נוער | מבוגרים | לכל המשפחה | הורים | ותיקים
-- (base sql/032 + הורים sql/065 + ותיקים sql/070, minus נשים).

BEGIN;

ALTER TYPE public.audience_t RENAME TO audience_t_old;

CREATE TYPE public.audience_t AS ENUM (
  'תינוקות', 'ילדים', 'נוער', 'מבוגרים', 'לכל המשפחה', 'הורים', 'ותיקים'
);

ALTER TABLE public.events
  ALTER COLUMN audience TYPE public.audience_t
  USING audience::text::public.audience_t;

ALTER TABLE public.umbrellas
  ALTER COLUMN default_audience TYPE public.audience_t
  USING default_audience::text::public.audience_t;

DROP TYPE public.audience_t_old;

COMMIT;

-- Post-check (optional):
--   SELECT enum_range(NULL::public.audience_t);
