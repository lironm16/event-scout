// On-demand event refresh.
//
// The regular Smarticket scraper runs every 1-5 minutes (jitter window) so
// at any given moment our `events.tickets_left` is up to ~5 minutes stale
// in the worst case. That's fine for proactive notifications but feels
// laggy when a user is staring at a card and asking "is this still 2?".
// This module gives the bot AND the agent a way to force a same-instant
// refresh of ONE event from Smarticket, with rate limits to keep us
// polite to their API.
//
// Rate limits:
//   - Per-event: 30s debounce. Two requests within 30s share the result.
//   - Per-user:  5 refreshes per minute. Above that we return a clean
//                `rate_limited` error so the caller can tell the user.
//   - Per-process: any concurrent calendar fetch is shared (single
//                  in-flight promise), so 10 simultaneous user clicks
//                  cost ONE Smarticket request.
//
// The HTTP shape mirrors api/check.js's `fetchEvents` so we always read
// the same source of truth as the scheduled scraper.

const axios = require("axios");
const supabase = require("./supabase");
const { getTenant } = require("./sourceUrls");
const { displayLocationText } = require("./locationStore");

const LOOKAHEAD_DAYS = 45;

const PER_EVENT_DEBOUNCE_MS = 30_000;
const PER_USER_LIMIT = { count: 5, window_ms: 60_000 };
const CALENDAR_DEDUPE_MS = 5_000;

// Most-recent refresh per event id (timestamp only — full row stays in DB).
const recentByEvent = new Map();
// Sliding-window timestamps per telegram id.
const userBuckets = new Map();
// One in-flight calendar fetch PER tenant. Concurrent refreshes for two
// events on the same tenant share the same network call; refreshes for
// different tenants run in parallel.
const inflightCalendarBySource = new Map();

function isoToday() {
  return new Date().toISOString().split("T")[0];
}

function isoPlusDays(days) {
  return new Date(Date.now() + days * 86400_000).toISOString().split("T")[0];
}

/**
 * Hit ONE tenant's calendar endpoint for the full lookahead window and
 * return a Map<eventId, rawRow>. Concurrent callers within
 * CALENDAR_DEDUPE_MS reuse the same in-flight promise per tenant so a
 * flurry of button presses doesn't multiply network traffic.
 */
async function fetchCalendarMap(source) {
  const tenant = getTenant(source);
  const cached = inflightCalendarBySource.get(tenant.source);
  if (cached) return cached;

  const url = `${tenant.calendarUrl}?start=${isoToday()}&end=${isoPlusDays(LOOKAHEAD_DAYS)}`;
  const promise = axios
    .get(url, {
      headers: { "User-Agent": "EventScout/1.0", Accept: "application/json" },
      timeout: 20_000,
    })
    .then((res) => {
      // Smarticket flips between array and numeric-keyed-object shapes
      // for `result`; normalise both into a plain array.
      let arr = null;
      if (Array.isArray(res.data?.result)) arr = res.data.result;
      else if (res.data?.result && typeof res.data.result === "object") {
        arr = Object.values(res.data.result);
      }
      if (!arr) throw new Error(`calendar API returned unrecognised result shape (${tenant.source})`);
      return new Map(arr.map((e) => [e.id, e]));
    });

  inflightCalendarBySource.set(tenant.source, promise);
  // Hold the in-flight promise briefly so back-to-back callers reuse it,
  // then clear so subsequent (later) refreshes get fresh data.
  promise.finally(() => {
    setTimeout(() => {
      inflightCalendarBySource.delete(tenant.source);
    }, CALENDAR_DEDUPE_MS).unref?.();
  });
  return promise;
}

function checkUserRateLimit(telegramId) {
  if (telegramId == null) return { ok: true };
  const key = String(telegramId);
  const now = Date.now();
  const cutoff = now - PER_USER_LIMIT.window_ms;
  const bucket = (userBuckets.get(key) || []).filter((t) => t > cutoff);
  if (bucket.length >= PER_USER_LIMIT.count) {
    const retryMs = bucket[0] + PER_USER_LIMIT.window_ms - now;
    return { ok: false, retry_in_seconds: Math.max(1, Math.ceil(retryMs / 1000)) };
  }
  bucket.push(now);
  userBuckets.set(key, bucket);
  return { ok: true };
}

async function readEventRow(eventId) {
  // Pull a row that's "ready to render" — includes the joined human
  // address from `locations` so the bot can rebuild a full card without
  // a second round-trip. The leading underscore on the joined alias
  // matches the conventions used elsewhere (events.js, matchingService).
  //
  // `last_checked` is "the scraper touched this row" (bumps every cycle).
  // `last_changed_at` is "the count actually moved" (sql/029) — the more
  // useful signal for callers that want to reason about volatility. We
  // request both and let callers decide which to surface; a fresh env
  // missing the column reports `null` rather than failing the lookup.
  const { data, error } = await supabase
    .from("events")
    .select(
      "id, source, name, date, start_time, end_time, tickets_left, is_sold_out, image, location_key, last_checked, last_changed_at, archived, locations:location_key(raw_address, kind)",
    )
    .eq("id", eventId)
    .maybeSingle();
  if (error) {
    // If `last_changed_at` doesn't exist yet (sql/029 not applied), retry
    // without it. Other read paths can do the same — see the warning in
    // api/check.js.
    if (/last_changed_at/i.test(error.message || "")) {
      const fallback = await supabase
        .from("events")
        .select(
          "id, source, name, date, start_time, end_time, tickets_left, is_sold_out, image, location_key, last_checked, archived, locations:location_key(raw_address, kind)",
        )
        .eq("id", eventId)
        .maybeSingle();
      if (fallback.error) throw new Error(`events read failed: ${fallback.error.message}`);
      const data2 = fallback.data;
      if (!data2) return null;
      return { ...data2, last_changed_at: null, location: displayLocationText(data2.locations) };
    }
    throw new Error(`events read failed: ${error.message}`);
  }
  if (!data) return null;
  return {
    ...data,
    location: displayLocationText(data.locations),
  };
}

/**
 * Refresh ONE event from Smarticket and write the latest figures back
 * to the DB. Returns one of:
 *
 *   { ok: true, event, changed, previous_tickets_left, new_tickets_left, was_cached }
 *   { ok: false, error: 'rate_limited',  retry_in_seconds }
 *   { ok: false, error: 'not_found' }     // event id unknown to us
 *   { ok: false, error: 'archived' }      // Smarticket no longer lists it
 *   { ok: false, error: 'fetch_failed', detail }
 *
 * `was_cached: true` means we returned the most recent post-refresh row
 * without re-hitting Smarticket because another refresh of the same id
 * happened within PER_EVENT_DEBOUNCE_MS. The row is still fresh by
 * definition, just not freshly *fetched*.
 */
async function refreshEvent(eventId, { telegramId } = {}) {
  if (!Number.isFinite(eventId)) {
    return { ok: false, error: "invalid_event_id" };
  }

  const rl = checkUserRateLimit(telegramId);
  if (!rl.ok) {
    return { ok: false, error: "rate_limited", retry_in_seconds: rl.retry_in_seconds };
  }

  const before = await readEventRow(eventId);
  if (!before) return { ok: false, error: "not_found" };

  // Per-event debounce: if a refresh just landed, surface the existing
  // row instead of refetching. We still count it against the user's
  // rate budget so a stuck loop doesn't drain Smarticket politely.
  const recent = recentByEvent.get(eventId);
  if (recent && Date.now() - recent < PER_EVENT_DEBOUNCE_MS) {
    return {
      ok: true,
      event: before,
      changed: false,
      previous_tickets_left: before.tickets_left,
      new_tickets_left: before.tickets_left,
      was_cached: true,
    };
  }

  let calendarMap;
  try {
    // Refresh against the SAME tenant the row originated from. A
    // ramat-gan event id will not appear in the mbe-rg calendar even
    // when it's perfectly alive; using `before.source` keeps each
    // refresh scoped to the correct feed.
    calendarMap = await fetchCalendarMap(before.source);
  } catch (err) {
    return { ok: false, error: "fetch_failed", detail: err.message };
  }

  const live = calendarMap.get(eventId);
  if (!live) {
    // The event vanished from the calendar response. Most likely it was
    // archived on Smarticket's side. Mark it locally so subsequent
    // queries respect the change.
    await supabase
      .from("events")
      .update({
        archived: true,
        last_checked: new Date().toISOString(),
      })
      .eq("id", eventId);
    return { ok: false, error: "archived" };
  }

  const ticketsLeft = Number.isFinite(live.website_left_tickets_count)
    ? live.website_left_tickets_count
    : before.tickets_left;
  const soldOut = ticketsLeft === 0;
  const nowIso = new Date().toISOString();

  const { error: updErr } = await supabase
    .from("events")
    .update({
      tickets_left: ticketsLeft,
      is_sold_out: soldOut,
      last_checked: nowIso,
      last_updated: nowIso,
    })
    .eq("id", eventId);
  if (updErr) {
    return { ok: false, error: "db_update_failed", detail: updErr.message };
  }

  recentByEvent.set(eventId, Date.now());

  const after = await readEventRow(eventId);
  return {
    ok: true,
    event: after,
    changed: before.tickets_left !== ticketsLeft,
    previous_tickets_left: before.tickets_left,
    new_tickets_left: ticketsLeft,
    was_cached: false,
  };
}

module.exports = {
  refreshEvent,
  // Exported for tests / introspection.
  PER_EVENT_DEBOUNCE_MS,
  PER_USER_LIMIT,
};
