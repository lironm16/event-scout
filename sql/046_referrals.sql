-- Referral tracking.
--
-- Anyone who's done /start has a deterministic invite deep-link
-- (https://t.me/<bot>?start=ref_<their_telegram_id>). When a new
-- user taps that link, Telegram delivers the `ref_<id>` payload to
-- our /start handler, which writes ONE row here crediting the
-- inviter.
--
-- Schema:
--
--   invitee_telegram_id  PK
--     Each new joiner has AT MOST one referrer — the first link
--     they used. If they later tap a different invite link we keep
--     the original (use the table's natural conflict to ignore the
--     second). This avoids "credit-stealing" by re-shares and keeps
--     the table a clean one-row-per-invitee record.
--
--   inviter_telegram_id  FK → profiles(telegram_id)
--     The user whose link was tapped. We FK to profiles instead of
--     a raw text id so a deleted profile's referrals don't dangle
--     — ON DELETE CASCADE would also nuke the invitee's row, which
--     is what we want (the credit is gone, the invitee themselves
--     still exists in profiles).
--
-- Why no FK on invitee_telegram_id:
--   /start runs BEFORE the agent has built the invitee's profile
--   row — that happens later when they answer the first question.
--   Putting an FK here would force us to create a half-empty
--   profile row at /start time just to satisfy the constraint.
--   Cheaper to leave the column as plain text; if the invitee
--   never finishes onboarding their referral row is harmless
--   debug data.
--
-- Anti-self-referral CHECK:
--   The same person can't credit themselves. The deep-link payload
--   IS the inviter's telegram_id, so a user who taps their OWN
--   link (e.g. testing) would otherwise insert (X, X). We could
--   handle this in the bot too but a DB constraint costs nothing
--   and is the safest place to enforce it.
--
-- Index on (inviter_telegram_id, joined_at):
--   /invite shows the user "you've referred N people" — a
--   sequential count by inviter ordered by recency. The composite
--   covers both filter + sort.

CREATE TABLE IF NOT EXISTS public.referrals (
  invitee_telegram_id TEXT PRIMARY KEY,
  inviter_telegram_id TEXT NOT NULL
    REFERENCES public.profiles(telegram_id) ON DELETE CASCADE,
  joined_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'referrals_no_self_referral'
      AND conrelid = 'public.referrals'::regclass
  ) THEN
    ALTER TABLE public.referrals
      ADD CONSTRAINT referrals_no_self_referral
      CHECK (invitee_telegram_id <> inviter_telegram_id);
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_referrals_inviter_joined
  ON public.referrals (inviter_telegram_id, joined_at DESC);

GRANT ALL ON public.referrals TO postgres, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
