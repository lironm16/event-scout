-- Make tickets.group_id nullable.
--
-- sql/003 defined `group_id TEXT NOT NULL` because the table at that
-- point only served the WhatsApp scraper, where every ticket
-- inherently came from a WhatsApp group chat. The column held the
-- group's serialized id and was always populated.
--
-- sql/044 introduced `source='telegram_user'` rows: a user listing
-- a ticket through the bot wizard. These have no WhatsApp group to
-- attribute, so trying to insert them fails with
--   "null value in column \"group_id\" of relation \"tickets\"
--    violates not-null constraint".
--
-- Rather than write a sentinel string like 'telegram_user' into a
-- column whose semantic is "WhatsApp group id", drop the NOT NULL.
-- The column now means: "WhatsApp group id when source='whatsapp',
-- NULL otherwise". Any consumer that needs to know "is this from a
-- WhatsApp group" can use `source='whatsapp'` (more explicit) or
-- `group_id IS NOT NULL` (equivalent for current usage).
--
-- Lives in its own migration file (not appended to sql/044) because
-- our schema-watcher dedupes by filename: a file marked applied
-- once won't re-run later additions. A fresh filename guarantees
-- the statement actually executes.
--
-- Idempotent: ALTER COLUMN ... DROP NOT NULL is a no-op when the
-- column is already nullable.

ALTER TABLE public.tickets
  ALTER COLUMN group_id DROP NOT NULL;

NOTIFY pgrst, 'reload schema';
