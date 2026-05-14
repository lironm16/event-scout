// Referral / invite flow.
//
// Every user who's done /start has a deterministic invite deep-link
// of the form:
//
//   https://t.me/<bot_username>?start=ref_<telegram_id>
//
// When someone taps it, Telegram opens the bot with the `ref_<id>`
// payload attached to /start. The bot's start handler reads it and
// writes a row to `referrals` crediting the inviter.
//
// This module hides three things:
//
//   1. Bot username discovery — cached lazily via getMe() so we
//      don't hit the Telegram API on every /invite. The token is
//      stable for the bot's lifetime, so a process-level cache is
//      enough.
//
//   2. Link construction — single source of truth so the bot
//      command, the agent tool, and any future surface (web,
//      email) all produce identical links. Important because the
//      INVITER side of the link generates the credit; if two
//      surfaces produced slightly different formats we'd lose
//      attribution.
//
//   3. Referral persistence — the upsert behaviour ("first link
//      wins") is encoded here so callers don't have to know about
//      the PRIMARY KEY conflict semantics.

const supabase = require("./supabase");

const REF_PREFIX = "ref_";

// Lazily-populated. We resolve on the FIRST /invite (rather than at
// startup) so the module is usable without a bot instance (tests,
// scripts that just want to record referrals).
let _botUsernameCache = null;

/**
 * Returns the bot's @username (without the @). Caches the result
 * for the process lifetime. Pass the `telegram` instance from
 * Telegraf (`bot.telegram`).
 */
async function getBotUsername(telegram) {
  if (_botUsernameCache) return _botUsernameCache;
  if (!telegram) {
    throw new Error("getBotUsername: telegram client required for first lookup");
  }
  const me = await telegram.getMe();
  if (!me?.username) {
    throw new Error("getBotUsername: telegram.getMe() returned no username");
  }
  _botUsernameCache = me.username;
  return _botUsernameCache;
}

/**
 * Build the deep-link the user shares with friends. The
 * inviter_telegram_id is encoded into the start payload, NOT the
 * URL itself (Telegram caps start-payload at 64 chars, plenty for
 * our integer ids).
 *
 * Pass the same `telegram` you'd pass to getBotUsername.
 *
 *   await buildInviteLink(bot.telegram, "12345")
 *     → "https://t.me/MyBot?start=ref_12345"
 */
async function buildInviteLink(telegram, inviterTelegramId) {
  const username = await getBotUsername(telegram);
  const safe = encodeURIComponent(String(inviterTelegramId));
  return `https://t.me/${username}?start=${REF_PREFIX}${safe}`;
}

/**
 * Parse a /start payload. Returns the inviter's telegram_id if the
 * payload is a well-formed ref_<digits>, else null.
 *
 * Why strict-digits: encodeURIComponent above only ever produces
 * digits for a real Telegram id, so a non-digit payload is either
 * a malformed link or a probe — we drop it silently.
 */
function parseInviterFromPayload(payload) {
  if (!payload || typeof payload !== "string") return null;
  if (!payload.startsWith(REF_PREFIX)) return null;
  const tail = payload.slice(REF_PREFIX.length);
  if (!/^\d{1,32}$/.test(tail)) return null;
  return tail;
}

/**
 * Record a referral. Implements "first link wins":
 *
 *   - If the invitee has no row yet → insert.
 *   - If the invitee already has a row → keep the existing inviter
 *     (the second link doesn't steal credit).
 *
 * Both branches are non-throwing — the caller treats every outcome
 * as "we tried, move on with onboarding". The return value tells
 * the caller which branch fired so they can log appropriately.
 *
 * Returns:
 *   { ok: true, recorded: true }    new credit landed
 *   { ok: true, recorded: false }   invitee already had a referrer
 *   { ok: false, error: "..." }     DB / FK error (e.g. inviter
 *                                   profile doesn't exist) — we
 *                                   surface the message but the
 *                                   caller should NOT block onboarding.
 */
async function recordReferral({ inviterTelegramId, inviteeTelegramId }) {
  const inviter = String(inviterTelegramId || "");
  const invitee = String(inviteeTelegramId || "");
  if (!inviter || !invitee) {
    return { ok: false, error: "missing_ids" };
  }
  if (inviter === invitee) {
    // Mirrors the DB CHECK but avoids the round-trip for a known
    // bad case (user tested their own link).
    return { ok: false, error: "self_referral" };
  }

  // upsert with ignoreDuplicates so the second-link-wins-nothing
  // semantic is enforced at the PK. We pass `select()` only to
  // detect WHICH branch we took: the row count tells us if the
  // insert actually wrote anything new.
  const { data, error } = await supabase
    .from("referrals")
    .upsert(
      {
        invitee_telegram_id: invitee,
        inviter_telegram_id: inviter,
      },
      { onConflict: "invitee_telegram_id", ignoreDuplicates: true },
    )
    .select("invitee_telegram_id");

  if (error) {
    // FK violation here means the inviter never finished /start
    // (no profile row yet). Surface so the bot can log a debug
    // note, but never throw — onboarding must continue.
    return { ok: false, error: error.message };
  }
  return { ok: true, recorded: Array.isArray(data) && data.length > 0 };
}

/**
 * Returns the inviter for a given invitee, or null. Used by the
 * /invite command's future "you were invited by X" line — not on
 * the hot path yet, but cheap and useful for debugging.
 */
async function getReferrerOf(inviteeTelegramId) {
  const { data, error } = await supabase
    .from("referrals")
    .select("inviter_telegram_id, joined_at")
    .eq("invitee_telegram_id", String(inviteeTelegramId))
    .maybeSingle();
  if (error) {
    console.warn(`[Referrals] getReferrerOf failed: ${error.message}`);
    return null;
  }
  return data || null;
}

/**
 * Returns { count, recent } for the inviter's referrals.
 *   - count: total people they brought in
 *   - recent: up to 5 most recent referrals (objects with
 *             invitee_telegram_id + joined_at) — used in the
 *             /invite reply so the user feels the impact without
 *             us leaking the full list.
 */
async function listReferralsForUser(inviterTelegramId) {
  const { count, error: countErr } = await supabase
    .from("referrals")
    .select("invitee_telegram_id", { count: "exact", head: true })
    .eq("inviter_telegram_id", String(inviterTelegramId));

  if (countErr) {
    console.warn(`[Referrals] count failed: ${countErr.message}`);
    return { count: 0, recent: [] };
  }

  const { data, error } = await supabase
    .from("referrals")
    .select("invitee_telegram_id, joined_at")
    .eq("inviter_telegram_id", String(inviterTelegramId))
    .order("joined_at", { ascending: false })
    .limit(5);

  if (error) {
    console.warn(`[Referrals] recent fetch failed: ${error.message}`);
    return { count: count || 0, recent: [] };
  }
  return { count: count || 0, recent: data || [] };
}

module.exports = {
  getBotUsername,
  buildInviteLink,
  parseInviterFromPayload,
  recordReferral,
  getReferrerOf,
  listReferralsForUser,
  REF_PREFIX,
};
