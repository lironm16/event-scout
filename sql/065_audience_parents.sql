-- Add 'הורים' as a new value to the audience_t enum.
--
-- Background:
--   Events like "הרצאה מקוונת להורים" or "מפגש הורות" were previously
--   classified as audience='מבוגרים' — technically correct but unhelpful.
--   'הורים' gives parents a meaningful filter ("אירועים להורים") and lets
--   the card display "👪 להורים" instead of the generic "18+".
--
-- Postgres requires ALTER TYPE ... ADD VALUE outside a transaction block
-- (it cannot be rolled back). The value is appended at the end of the
-- enum so it doesn't affect existing comparisons.

ALTER TYPE public.audience_t ADD VALUE IF NOT EXISTS 'הורים';

NOTIFY pgrst, 'reload schema';
