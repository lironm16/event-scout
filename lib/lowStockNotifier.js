// Low-stock urgency push — fires immediately (out-of-band from the
// weekly newsletter) when an event drops to ≤9 tickets.
//
// The spec rule (May-2026):
//   "If an event hits the 9-ticket threshold, the system must send
//    an immediate push notification. It does not wait for the weekly
//    newsletter."
//
// We listen at the existing scrape boundary (api/check.js) where we
// already have BEFORE/AFTER snapshots of every Smarticket row. The
// transitions we care about:
//
//   1. tickets_left was > 9 → now ≤ 9  (the user-visible "drop")
//   2. tickets_left was NULL/unknown → now ≤ 9  (event arrived
//      already in the low-stock zone — also urgent because the user
//      hasn't been pinged before)
//
// We DO NOT fire on:
//   - 11 → 12          (stock fluctuation, not a transition)
//   - 5 → 4            (already in the low zone; user was pinged at
//                       the first crossing — see dedup table)
//   - X → 0            (sold-out is a separate UX — handled by the
//                       existing 'אזלו' marker + back-in-stock loop)
//   - NULL → NULL      (free events; no count to alert on)
//
// Dedup: `low_stock_notifications` (sql/047) keys on (event_id,
// telegram_id) so the same user never gets the same low-stock alert
// twice — even if the event's stock fluctuates around the threshold
// across scrape cycles (e.g. 11→8→12→7).
//
// Audience: we DELIBERATELY pick a NARROW set of interested users
// rather than spamming everyone with a matching profile:
//   - per-EVENT watchers (`event_watchers`) — they explicitly opted
//     into this one event
//   - per-TOPIC savers (`saved_searches`) whose tokens fire on
//     event.name OR whose `filters.watch_tag_names` overlap event tags
// Broad-profile-interest matching (e.g. anyone with 'מוזיקה' in
// interests for any music event going low-stock) would be noisy and
// would compete with the weekly newsletter. The newsletter handles
// the broad case; this notifier handles the urgent case.

const supabase = require("./supabase");
const {
  formatHebrewDate,
  formatTimeRange,
  formatAudienceLine,
  getEventIcon,
  rtlLine,
} = require("./eventFormat");
const {
  formatLowStockBadge,
  buildNavButtons,
  navOptsFromProfile,
  LOW_STOCK_THRESHOLD,
} = require("./eventCard");
const { normalizeImageUrl } = require("./imageUrl");
const { getBookingUrl } = require("./sourceUrls");

const THRESHOLD = LOW_STOCK_THRESHOLD;

// ────────────────────────────────────────────────────────────────────
// Pure detection. Caller passes (incoming, stored) using the same
// shape api/check.js already builds for back-in-stock detection.
//
// `incoming` items carry `website_left_tickets_count` (the wire
// field name from Smarticket); `stored` items carry the post-DB
// `tickets_left`. We normalise to a single field here and return
// fully-formed event records ready to feed the notifier.
// ────────────────────────────────────────────────────────────────────
function detectLowStockTransitions(incoming, stored) {
  const transitions = [];
  for (const event of incoming) {
    const after = event.website_left_tickets_count;
    if (after == null) continue;             // free/unmetered — never low-stock
    if (after <= 0) continue;                // sold-out path, not low-stock
    if (after > THRESHOLD) continue;          // still plenty

    const prev = stored.get(event.id);
    const before = prev?.tickets_left;

    // Brand-new event whose first known state is already low-stock
    // → fire (user hasn't been told yet).
    // Existing event that crossed the threshold this cycle → fire.
    // Existing event already in the zone → skip; the earlier cycle
    // pinged whoever was interested, and dedup will catch any
    // candidate we missed.
    const crossed =
      prev == null ||
      before == null ||
      (Number.isFinite(before) && before > THRESHOLD);
    if (!crossed) continue;

    transitions.push({
      id: event.id,
      source: event.source,
      name: event.name,
      date: event.start_date,
      start_time: event.start_time,
      end_time: event.end_time,
      tickets_left: after,
      previous_tickets_left: before ?? null,
      location: event._location || null,
      location_key: event._location_key || null,
      image: event._image || null,
      external_slug: event.external_slug || null,
    });
  }
  return transitions;
}

// ────────────────────────────────────────────────────────────────────
// Find interested users for a SINGLE low-stock event.
//
// Returns a Map<telegram_id, { reason }> where reason describes WHY
// we matched (for the per-card message body — "באירוע שביקשת לעקוב"
// vs "בנושא שאת עוקבת אחריו"). Deduped at the user level — one ping
// per user per event, no matter how many saved searches matched.
// ────────────────────────────────────────────────────────────────────
async function findInterestedUsers(event) {
  const out = new Map();

  // Per-event watchers — explicit opt-in to this exact event.
  // Highest signal; if anyone is in event_watchers for this id we
  // ping them even if their saved_searches don't match.
  const { data: watchers, error: watchersErr } = await supabase
    .from("event_watchers")
    .select("telegram_id")
    .eq("event_id", event.id);
  if (watchersErr) {
    console.warn(`[LowStock] event_watchers read failed: ${watchersErr.message}`);
  } else {
    for (const w of watchers || []) {
      if (w?.telegram_id) {
        out.set(String(w.telegram_id), { reason: "watcher" });
      }
    }
  }

  // Saved-search match — anyone with an ACTIVE saved search whose
  // tokens substring-match the event's name. Cheap O(searches)
  // string check; this runs at most once per scrape cycle and only
  // for events that crossed the threshold this cycle, so the cost
  // is bounded.
  const { data: searches, error: searchErr } = await supabase
    .from("saved_searches")
    .select("telegram_id, query, tokens, filters")
    .eq("archived", false);
  if (searchErr) {
    console.warn(`[LowStock] saved_searches read failed: ${searchErr.message}`);
  } else {
    const eventNameLower = String(event.name || "").toLowerCase();
    for (const s of searches || []) {
      if (!s?.telegram_id) continue;
      // Skip users we already added via the higher-signal watchers
      // bucket so the message reason reflects the strongest match.
      if (out.has(String(s.telegram_id))) continue;
      if (matchesEventByTokens(eventNameLower, s.tokens)) {
        out.set(String(s.telegram_id), { reason: "saved_search", query: s.query });
        continue;
      }
      // Tag-watcher overlap is a useful secondary signal but
      // requires `event.tags` which we DON'T load here (the bare
      // event shape from the scraper doesn't include labels). Skip
      // for v1; the token match covers the common case and the
      // weekly newsletter catches the rest.
    }
  }

  return out;
}

function matchesEventByTokens(eventNameLower, tokens) {
  if (!Array.isArray(tokens) || !tokens.length) return false;
  // tokens are stored lowercased + normalised at save time. The
  // matcher is AND — ALL tokens must substring-match the name.
  for (const t of tokens) {
    const tok = String(t || "").toLowerCase().trim();
    if (!tok) continue;
    if (!eventNameLower.includes(tok)) return false;
  }
  return true;
}

// ────────────────────────────────────────────────────────────────────
// Dedup — already-notified (event_id, telegram_id) pairs. Bulk read
// once per event to amortise the round-trip.
// ────────────────────────────────────────────────────────────────────
async function getAlreadyNotified(eventId) {
  const { data, error } = await supabase
    .from("low_stock_notifications")
    .select("telegram_id")
    .eq("event_id", eventId);
  if (error) {
    if (error.code === "42P01" || error.code === "PGRST205") return new Set();
    console.warn(`[LowStock] dedup read failed: ${error.message}`);
    return new Set();
  }
  return new Set((data || []).map((r) => String(r.telegram_id)));
}

async function markNotified(eventId, telegramId, ticketsLeft) {
  const { error } = await supabase
    .from("low_stock_notifications")
    .upsert(
      {
        event_id: eventId,
        telegram_id: String(telegramId),
        notified_at: new Date().toISOString(),
        tickets_at_notify: ticketsLeft,
      },
      { onConflict: "event_id,telegram_id" },
    );
  if (error) {
    console.warn(
      `[LowStock] markNotified failed event=${eventId} user=${telegramId}: ${error.message}`,
    );
  }
}

// ────────────────────────────────────────────────────────────────────
// Message + keyboard
// ────────────────────────────────────────────────────────────────────
function buildLowStockMessage(event, reason, firstName) {
  const greeting = firstName ? `${firstName}, ` : "";
  const lead =
    reason === "watcher"
      ? `${greeting}באירוע שביקשת לעקוב אחריו נשארו פחות מ‑${THRESHOLD} כרטיסים!`
      : `${greeting}אירוע ${reason === "saved_search" ? `מנושא שאת עוקבת אחריו` : "שיכול לעניין אותך"} עומד להיגמר!`;
  // Headline = "🎫 N כרטיסים אחרונים ❗️" (the helper returns this
  // form post May-2026; the fallback only fires when the count is
  // somehow outside the low-stock window, which shouldn't happen
  // for a low-stock notification but kept as a defensive default).
  const headline =
    formatLowStockBadge(event.tickets_left) ||
    `🎫 נשארו ${event.tickets_left} כרטיסים\u2060\u200f❗️`;
  const lines = [
    headline,
    "",
    lead,
    "",
    `${getEventIcon(event)} ${event.name}`,
  ];
  if (event.date) lines.push(`📅 ${formatHebrewDate(event.date)}`);
  const timeStr = formatTimeRange(event.start_time, event.end_time);
  if (timeStr) lines.push(rtlLine(`🕐 ${timeStr}`));
  const audienceLine = formatAudienceLine(event);
  if (audienceLine) lines.push(audienceLine);
  if (event.location) lines.push(`📍 ${event.location}`);
  // No separate "🎫 N כרטיסים" line — the headline above already
  // states the count + urgency. A duplicate line was the pre-May-2026
  // layout and read as redundant once the warning collapsed into the
  // same ticket-line format.
  return lines.map(rtlLine).join("\n");
}

function buildLowStockKeyboard(event, navOpts = {}) {
  const rows = [];
  const bookingUrl = getBookingUrl(event);
  if (bookingUrl) rows.push([{ text: "🎟️ לרכישה מהירה", url: bookingUrl }]);
  const navRow = buildNavButtons(event, navOpts);
  if (navRow.length) rows.push(navRow);
  // Per-event opt-out so a user can stop low-stock alerts on this
  // specific event without affecting other notifications.
  rows.push([{ text: "❌ לא מעניין", callback_data: `fb:reasons:${event.id}` }]);
  return { inline_keyboard: rows };
}

// ────────────────────────────────────────────────────────────────────
// Main entry point — called from api/check.js after each scrape.
// ────────────────────────────────────────────────────────────────────
async function notifyLowStockMatchesFor(events, telegram) {
  if (!telegram) return { matched: 0, notified: 0 };
  if (!Array.isArray(events) || !events.length) return { matched: 0, notified: 0 };

  let matched = 0;
  let notified = 0;
  for (const event of events) {
    const interestedUsers = await findInterestedUsers(event);
    if (!interestedUsers.size) continue;
    matched += interestedUsers.size;

    const alreadyNotified = await getAlreadyNotified(event.id);

    // Look up first_name for greetings in a single round-trip per event.
    const candidateIds = [...interestedUsers.keys()].filter(
      (id) => !alreadyNotified.has(id),
    );
    if (!candidateIds.length) continue;
    const { data: profiles } = await supabase
      .from("profiles")
      .select("telegram_id, first_name, user_context")
      .in("telegram_id", candidateIds);
    const profileByTg = new Map(
      (profiles || []).map((p) => [p.telegram_id, p]),
    );

    for (const tg of candidateIds) {
      const { reason } = interestedUsers.get(tg);
      const prof = profileByTg.get(tg);
      const text = buildLowStockMessage(event, reason, prof?.first_name);
      const navOpts = navOptsFromProfile(prof, event);
      const reply_markup = buildLowStockKeyboard(event, navOpts);
      const photoUrl = normalizeImageUrl(event.image, event);
      try {
        if (photoUrl && text.length <= 1024) {
          try {
            await telegram.sendPhoto(tg, photoUrl, { caption: text, reply_markup });
          } catch {
            // Photo failed (host blocks UA, 404, …) — fall back to text.
            await telegram.sendMessage(tg, text, { reply_markup });
          }
        } else {
          await telegram.sendMessage(tg, text, { reply_markup });
        }
        await markNotified(event.id, tg, event.tickets_left);
        notified++;
      } catch (err) {
        const code = err?.code || err?.response?.error_code;
        const desc = String(err?.description || err?.message || "").toLowerCase();
        if (code === 403 || desc.includes("bot was blocked") || desc.includes("chat not found")) {
          // User blocked the bot — silently skip, don't burn retries.
          continue;
        }
        console.error(
          `[LowStock] send failed event=${event.id} user=${tg}: ${err.message}`,
        );
      }
    }
  }
  return { matched, notified };
}

module.exports = {
  THRESHOLD,
  detectLowStockTransitions,
  notifyLowStockMatchesFor,
  // Exported for unit testing.
  findInterestedUsers,
  matchesEventByTokens,
};
