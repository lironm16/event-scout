-- User-initiated ticket offers + linking WhatsApp tickets to our event rows.
--
-- Background:
--   sql/003 created `tickets` as a free-text capture of WhatsApp posts:
--   event_title is TEXT, no link to our curated `events` rows. That was
--   fine when the scraper was the ONLY producer and the bot only
--   surfaced tickets via search.
--
--   We're now adding a second producer (a Telegram user offering a
--   ticket through the bot) AND a new fan-out: when a ticket lands
--   that matches a known event, every watcher on that event should
--   be notified. Watchers live on `event_watchers.event_id` — an
--   integer FK to events.id — so we need the same FK on `tickets`
--   to make the fan-out a single indexed JOIN.
--
-- New columns:
--
--   event_id INTEGER NULL REFERENCES events(id) ON DELETE SET NULL
--     The match. Nullable because:
--       (a) WhatsApp ingest can't always match (typos, slang, events
--           outside our DB scope — e.g. Tel Aviv shows we don't track).
--       (b) Old rows pre-migration have no link; back-filling them is
--           best-effort, not blocking.
--     ON DELETE SET NULL: deleting an event row from the curated
--     feed shouldn't cascade-delete the secondary-market tickets that
--     pointed at it. The ticket data has independent value (operator
--     can still read raw_text + seller_phone for the recap).
--
--   source TEXT NOT NULL DEFAULT 'whatsapp'
--     Discriminator. Locked to ('whatsapp', 'telegram_user') via CHECK
--     so a typo at insert time fails loudly. We deliberately don't
--     promote this to an ENUM yet: only two values, and CHECK is
--     trivially loosenable to add a third (e.g. a future Telegram
--     channel scraper) without an ALTER TYPE migration.
--
--   seller_telegram_id TEXT NULL REFERENCES profiles(telegram_id)
--     Filled by the bot when source='telegram_user'. Lets the
--     "watcher taps interested → introduce both sides" handler look
--     up the seller's profile (and DM them). WhatsApp rows keep this
--     null and stay phone-based.
--
-- New index:
--
--   (event_id, status) WHERE event_id IS NOT NULL
--     The watcher fan-out query is
--       WHERE event_id = ? AND status = 'active'
--     which without this index does a Seq Scan on the tickets table
--     every WhatsApp insert. The partial WHERE skips the ~60% of
--     rows that never match an event (unrelated WhatsApp chatter),
--     keeping the index tight.
--
-- Idempotency:
--   All ADD COLUMN / CREATE INDEX use IF NOT EXISTS so re-running
--   the migration is a no-op. The CHECK constraint guard uses a
--   DO block because Postgres lacks `ADD CONSTRAINT IF NOT EXISTS`
--   for table constraints (only for FK constraints in PG 18+).

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS event_id INTEGER
    REFERENCES public.events(id) ON DELETE SET NULL;

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'whatsapp';

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS seller_telegram_id TEXT
    REFERENCES public.profiles(telegram_id) ON DELETE SET NULL;

-- Guard the discriminator with a CHECK. `DO $$ ... $$` lets us skip
-- the ADD CONSTRAINT when it already exists (older Postgres has no
-- IF NOT EXISTS form for table CHECK constraints).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tickets_source_check'
      AND conrelid = 'public.tickets'::regclass
  ) THEN
    ALTER TABLE public.tickets
      ADD CONSTRAINT tickets_source_check
      CHECK (source IN ('whatsapp', 'telegram_user'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_tickets_event_active
  ON public.tickets (event_id, status)
  WHERE event_id IS NOT NULL;

-- A telegram-user offer MUST carry a seller_telegram_id (we know who
-- the user is — they're talking to the bot). A whatsapp ingest MAY
-- carry one, but in practice always leaves it null (seller is anon
-- until they happen to also be a registered profile). Enforce the
-- former so a buggy save_ticket_offer call can't write an orphan row.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tickets_telegram_user_has_seller'
      AND conrelid = 'public.tickets'::regclass
  ) THEN
    ALTER TABLE public.tickets
      ADD CONSTRAINT tickets_telegram_user_has_seller
      CHECK (source <> 'telegram_user' OR seller_telegram_id IS NOT NULL);
  END IF;
END$$;

NOTIFY pgrst, 'reload schema';
