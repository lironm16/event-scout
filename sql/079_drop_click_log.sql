-- Drop events click_log — it was write-only (lib/ticketService.logClick inserted
-- into it, nothing ever read it) and had 0 rows. The logClick function + its two
-- call sites in the bot were removed; this drops the now-orphaned table.

DROP TABLE IF EXISTS public.click_log;
