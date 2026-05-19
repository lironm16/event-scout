-- Newsletter delivery state + low-stock notification dedup +
-- events.first_seen_at (so the digest can identify truly NEW events).
--
-- This migration backs three product features added in the May-2026
-- newsletter redesign:
--
--   1. user_newsletter_state
--      Per-user delivery state. A row exists only for users who have
--      been delivered AT LEAST one newsletter (or asked to be paused).
--      Absence == "default state" == subscribed but never delivered;
--      enqueue treats no-row identically to last_sent_at=epoch so
--      first-time users qualify immediately for the buffer.
--      `last_sent_at` is the cross-cycle dedup pivot for the
--      immediate-with-5-min-buffer delivery model
--      (lib/newsletterScheduler.js): we only ENQUEUE events with
--      `first_seen_at > last_sent_at`, then BUMP it after every
--      flush (single-card or multi-card). The legacy `delivery_dow`
--      / `delivery_hour` columns are kept for backward compatibility
--      with the deprecated weekly cadence but are no longer read.
--      Why a separate table instead of fields on `profiles`:
--        - `profiles` is read on EVERY agent turn (high QPS). Adding
--          newsletter scheduler columns there would hot-path them
--          through every search.
--        - Scheduler queries scan this table in a tight loop; isolating
--          it lets the scheduler keep its own indexes without touching
--          the chatty profile row.
--
--   2. low_stock_notifications
--      Composite-PK dedup table: one row per (event_id, telegram_id)
--      pair that received a "≤10 tickets left" push. Without this, a
--      single event whose stock fluctuates around the threshold would
--      ping the same user repeatedly across check cycles.
--      We intentionally do NOT expire these rows — once a user has
--      been notified about an event's low stock, they're notified
--      forever. If the event sells out and comes back to ≤10 next
--      week, that's not a "new" low-stock event — the user already
--      knows it's running low.
--
--   3. profiles.user_context.disliked_tags / disliked_venues
--      No DDL needed (user_context is JSONB). Documented here so the
--      schema's intent is discoverable in one place. Populated by the
--      bulk "❌ סמני כלא רלוונטי" action on newsletter cards; read by
--      newsletterService to suppress similar future events. Cap at 50
--      entries each (FIFO eviction) — beyond that the signal degrades
--      into "user doesn't like our recommendations" rather than
--      meaningful per-tag/venue feedback.

CREATE TABLE IF NOT EXISTS public.user_newsletter_state (
  telegram_id     TEXT PRIMARY KEY REFERENCES public.profiles(telegram_id) ON DELETE CASCADE,
  -- Last successful delivery. NULL for "never delivered" — the
  -- scheduler treats NULL as "due now" subject to the day-of-week and
  -- hour-of-day windows below. We do NOT update this on failure; a
  -- silent network blip should retry on the next tick, not skip a week.
  last_sent_at    TIMESTAMPTZ,
  -- When the row was created. Useful for analytics ("how many users
  -- opted in this month?") and for an eventual "welcome digest" feature
  -- that wants a different cadence for the first 2-3 deliveries.
  subscribed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Soft-off toggle via /newsletter_off. We keep the row (so the
  -- scheduler can flip it back on without losing last_sent_at) but
  -- skip delivery while true. Paused users still appear in /saved
  -- and still get low-stock pushes — only the weekly digest is
  -- silenced.
  paused          BOOLEAN NOT NULL DEFAULT FALSE,
  -- Day of week (0=Sunday, 6=Saturday) and local-time hour to deliver.
  -- Defaults: Thursday 18:00 Asia/Jerusalem — right before Shabbat,
  -- when weekend plans crystallise. Stored per-user so a future UI
  -- can let users move it.
  delivery_dow    SMALLINT NOT NULL DEFAULT 4 CHECK (delivery_dow BETWEEN 0 AND 6),
  delivery_hour   SMALLINT NOT NULL DEFAULT 18 CHECK (delivery_hour BETWEEN 0 AND 23),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Scheduler-hot index: each tick we want "all unpaused users where
-- last_sent_at is NULL OR < now() - 6 days". A plain btree on
-- last_sent_at lets the planner range-scan that efficiently. We
-- intentionally don't index `paused` separately — it's a low-cardinality
-- boolean that the planner will combine with the time-range scan.
CREATE INDEX IF NOT EXISTS idx_newsletter_state_due
  ON public.user_newsletter_state (last_sent_at NULLS FIRST)
  WHERE paused = FALSE;

GRANT ALL ON public.user_newsletter_state TO postgres, anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.low_stock_notifications (
  event_id     INTEGER NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  telegram_id  TEXT NOT NULL,
  notified_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ticket count at the moment we fired the notification. Diagnostic
  -- only — useful when investigating "why did I get pinged about
  -- event X" support questions, and for future "stock dropped to 1"
  -- escalation logic that wants to upgrade an earlier "≤10" alert.
  tickets_at_notify INTEGER,
  PRIMARY KEY (event_id, telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_low_stock_notif_user
  ON public.low_stock_notifications (telegram_id, notified_at DESC);

GRANT ALL ON public.low_stock_notifications TO postgres, anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────
-- events.first_seen_at
--
-- The newsletter's "new events" filter (spec §1) needs a stable
-- "discovered at" timestamp per event. The existing columns don't
-- carry this:
--   - last_updated  → bumped every upsert cycle (≈ every 1-5 min)
--   - last_checked  → same
--   - last_changed_at → only moves when tickets_left changes; null for
--                       city/free events that never have a count
-- Without first_seen_at we'd be unable to distinguish "an event the
-- scraper saw for the first time today" from "an event we've been
-- tracking for weeks but just re-polled".
--
-- Default of now() means new INSERTs (via upsert) get stamped
-- automatically. For existing rows we backfill from `last_updated` —
-- it's an over-estimate for events first seen long ago, but the
-- alternative (NULL) breaks the "where first_seen_at > last_sent_at"
-- query the newsletter relies on. Over-estimating just means an
-- existing user's FIRST newsletter after this migration may contain
-- some "new since when?" events older than they think — a one-time
-- transient that resolves once we deliver the digest and advance
-- their `last_sent_at`.
-- Split into three statements so existing rows inherit their
-- `last_updated` (a closer approximation of "discovered at" than
-- "now"), while future inserts get the default.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;

UPDATE public.events
   SET first_seen_at = COALESCE(last_updated, last_checked, now())
 WHERE first_seen_at IS NULL;

ALTER TABLE public.events
  ALTER COLUMN first_seen_at SET DEFAULT now(),
  ALTER COLUMN first_seen_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_first_seen
  ON public.events (first_seen_at DESC)
  WHERE archived = FALSE;

NOTIFY pgrst, 'reload schema';
