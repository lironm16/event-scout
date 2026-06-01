const supabase = require("./supabase");
const { evaluateProximity } = require("./geocoding");
const {
  evalWalkMinutesForModes,
  eventPassesLocationModes,
} = require("./locationPrefs");
const {
  formatHebrewDate,
  formatTimeRange,
  formatAudienceLine,
  getEventIcon,
  rtlLine,
} = require("./eventFormat");
const {
  formatTicketsLine,
  formatLowStockBadge,
  buildNavButtons,
  navOptsFromProfile,
} = require("./eventCard");
const {
  listAllActiveSavedSearches,
  getNotifiedMap,
  markNotified,
  getNotifiedTicketMap,
  markTicketNotified,
} = require("./savedSearchService");
const {
  detectActivityTypes,
  activityTypeMatches,
} = require("../bot/matchingService");
const {
  audienceVerdict,
  deriveDefaultAudienceSet,
  shouldExcludeAdultSubtypeEvent,
  ageMatches,
} = require("./categories");
const { STOP_WORDS } = require("./savedSearchStopwords");
const labelStore = require("./labelStore");
const { normalizeImageUrl } = require("./imageUrl");
const { getBookingUrl } = require("./sourceUrls");
const { displayLocationText } = require("./locationStore");

// Saved-search matching is FULLY DETERMINISTIC: token AND-match,
// activity-type guard, date/time/format/venue/proximity filters. All
// normalization happens once at save-time (the brain extracts a clean
// `query`, `tokens`, and structured filters during the confirmation
// dialog) so the per-scrape matcher does cheap O(events × searches)
// substring checks without ever calling Gemini.

// ─────────────────────────────────────────────────────────────────────────
//  Saved-search notifier
//
//  Runs after each scrape. For every event with available stock (newly
//  created OR back from sold-out), match against all active saved searches
//  and notify users whose criteria fit. Deterministic — no Gemini call —
//  so it's fast and cheap to run on every scrape cycle.
// ─────────────────────────────────────────────────────────────────────────

async function getProfileMap(telegramIds) {
  if (!telegramIds.length) return new Map();
  const { data } = await supabase
    .from("profiles")
    .select("telegram_id, first_name, user_context")
    .in("telegram_id", telegramIds);
  return new Map((data || []).map((p) => [p.telegram_id, p]));
}

/**
 * Hydrate the bare event object passed in from the scraper with location
 * details we need for filtering: `kind` (physical/virtual/unknown) and
 * geo coordinates for proximity. We only need this once per event so we
 * fetch the whole batch in a single query.
 */
// Probe whether the labels schema (sql/026 + sql/032) is in place.
// Cached for the life of the process; bot restart re-probes after a
// migration is applied.
const OPTIONAL_NOTIFIER_COLS = [
  { col: "audience", migration: "sql/032_audience_category_enums.sql" },
  { col: "category", migration: "sql/032_audience_category_enums.sql" },
  { col: "tag_ids",  migration: "sql/026_normalized_labels.sql" },
];
let _availableNotifierColsCache = null;

async function getAvailableNotifierCols() {
  if (_availableNotifierColsCache) return _availableNotifierColsCache;
  const present = [];
  for (const { col, migration } of OPTIONAL_NOTIFIER_COLS) {
    const { error } = await supabase.from("events").select(col).limit(1);
    if (!error) {
      present.push(col);
    } else if (error.code === "42703" || /column .* does not exist/i.test(error.message || "")) {
      console.warn(
        `[Notifier] events.${col} column missing — apply ${migration} for smarter matching.`,
      );
    }
  }
  _availableNotifierColsCache = present;
  return present;
}

async function enrichEvents(events) {
  const ids = events.map((e) => e.id).filter(Number.isFinite);
  if (!ids.length) return new Map();
  const extras = await getAvailableNotifierCols();
  const cols = [
    "id",
    // `source` decides which Smarticket tenant's host we render images
    // and booking URLs against. Pre-sql/034 rows lack this column; the
    // DB DEFAULT 'mbe-rg' covers them on read.
    "source",
    "location_key",
    // Age range — needed for the new `filters.ages` predicate. Fetched
    // unconditionally because min_months / max_months are part of the
    // sql/026 baseline schema and should be present on every row.
    "min_months",
    "max_months",
    ...extras,
    "locations:location_key(raw_address, lat, lng, found, kind)",
  ].join(", ");
  const { data } = await supabase.from("events").select(cols).in("id", ids);

  // After sql/032 audience/category are native ENUM strings on the
  // row — only `tag_ids` needs the dict expansion. We collect every
  // referenced tag id once and resolve them in a single round-trip.
  const tagIds = new Set();
  for (const row of data || []) {
    for (const id of row.tag_ids || []) tagIds.add(id);
  }
  const dict = await labelStore.fetchLabelDict([...tagIds]);

  const map = new Map();
  for (const row of data || []) {
    const loc = row.locations || null;
    const expanded = labelStore.expandWithDict(row, dict);
    map.set(row.id, {
      source: row.source || null,
      kind: loc?.kind || (row.location_key ? "unknown" : null),
      coords: loc?.lat != null && loc?.lng != null ? { lat: loc.lat, lng: loc.lng } : null,
      address: displayLocationText(loc),
      location_key: row.location_key || null,
      audience: row.audience || null,
      category: row.category || null,
      // Surfaced on the enriched object in the same key names the
      // shared `ageMatches` helper from lib/categories expects, so
      // `agesMatch` below can call it with the enriched record directly.
      min_months: row.min_months ?? null,
      max_months: row.max_months ?? null,
      tags: expanded.tags,
    });
  }
  return map;
}

// ───── Filter predicates (deterministic) ─────

// Build the set of substring tokens that the event title must satisfy.
//
// SOURCE OF TRUTH: ONLY `savedSearch.tokens`. Pre-May-2026 this also mined
// `savedSearch.query`, which silently turned the display label into an
// AND filter — e.g. a watcher labelled "אירועים בקרבת הבית" ended up
// requiring those substrings on every matched event title, killing all
// real matches. The label is now display-only; if the user wants a text
// filter they put it in `tokens` explicitly (via the editable preview).
//
// We don't re-run the stop-word filter here — tokens went through
// `normalizeTokens` at save time, which already drops filler. Doing it
// again is harmless but duplicate work, and any future drift between
// the two lists would silently affect matching. Single-source
// `lib/savedSearchStopwords.js` is what `normalizeTokens` calls.
function deriveTokens(savedSearch) {
  const fromArray = Array.isArray(savedSearch?.tokens) ? savedSearch.tokens : [];
  const all = fromArray
    .map((t) => String(t || "").toLowerCase().trim())
    .filter((t) => t.length >= 2);
  return [...new Set(all)];
}

// AND-match: every meaningful token must appear in the event name. Empty
// tokens = no title constraint; the other structured filters in the
// predicate chain (audience, ages, tags, proximity, venue, dates) are
// what makes the watcher selective. The new save UX surfaces every
// active filter to the user, so a watcher with truly nothing set would
// never get past the confirmation card in the first place.
function tokensMatch(eventName, savedSearch) {
  const tokens = deriveTokens(savedSearch);
  if (!tokens.length) return true;
  const lower = (eventName || "").toLowerCase();
  return tokens.every((t) => lower.includes(t));
}

// Topic watcher: when the user saved a tag-based subscription
// ("תתריעי לי על אירועי מוזיקה") we match against the event's
// expanded tag NAMES instead of fighting with the title. Names are
// compared case-insensitive and trimmed — robust against minor casing
// differences and the common Hebrew geresh/quote variants.
//
// Returns:
//   - true   if `watch_tag_names` is unset/empty (no topic watcher
//            configured; other matchers decide).
//   - true   if any saved tag name overlaps the event's tags.
//   - false  if the user named topics but the event carries none of
//            them — gracefully reject, don't fall through to tokens
//            (that would defeat the purpose of a topic watcher).
function topicTagsMatch(savedSearch, enriched) {
  const want = savedSearch?.filters?.watch_tag_names;
  if (!Array.isArray(want) || !want.length) return null; // no topic watcher
  const eventTags = (enriched?.tags || []).map((t) =>
    String(t || "").toLowerCase().trim(),
  );
  if (!eventTags.length) return false;
  const wantSet = new Set(
    want.map((t) => String(t || "").toLowerCase().trim()).filter(Boolean),
  );
  return eventTags.some((t) => wantSet.has(t));
}

// Activity-type guard. Reads ONLY from `tokens` (the explicit text-search
// terms the user / agent committed to) — never from `query`, which is
// the cosmetic label. If `tokens` is empty there's no activity-type
// signal and the guard passes through, leaving the rest of the
// predicate chain to do the work.
function typeMatchesSavedSearch(eventName, savedSearch) {
  const tokensText = (savedSearch.tokens || []).join(" ");
  if (!tokensText.trim()) return true;
  const requested = detectActivityTypes(tokensText);
  return activityTypeMatches(eventName, requested);
}

// Age-range filter — when `filters.ages` is set, the event's
// min_months/max_months range must accommodate at least one of the
// listed ages (years). Mirrors interactive search's `ageMatches` from
// lib/categories so the saved-search behaviour is identical to what
// the user would have seen via /search at the moment they hit "שמרי".
//
// Unset / empty `ages` is a no-op (matches everything) — proximity,
// audience and tags do the selective work instead.
function agesMatch(filters, enriched) {
  const ages = filters?.ages;
  if (!Array.isArray(ages) || !ages.length) return true;
  return ageMatches(enriched || {}, ages);
}

// Audience filter for saved-search notifications.
//
// Notifications are PROACTIVE (we ping the user without being asked) so
// the bar for "include" should be higher than in interactive search.
//
// Three modes, mirroring search_events:
//   - `audience === 'all'` → explicit override; everything matches.
//   - explicit audience    → run `audienceVerdict` against the enriched
//     event audience (this is the same path `search_events` uses).
//   - audience UNSET       → fall back to the user's profile-derived
//     default audience set (see `deriveDefaultAudienceSet` in
//     `lib/categories.js`). Without this fallback, "track events for
//     my family" watchers — which CAN'T name a single audience ENUM —
//     would fire on senior-citizen / adult-only events too. The
//     interactive `search_events` already auto-filters this way; the
//     notifier diverged before this fix, surfacing audiences the user
//     would never ask for in search.
function audienceMatchesSavedSearch(eventName, filters, enriched, profile) {
  const want = filters?.audience;
  if (want === "all") return true;
  if (want) {
    const verdict = audienceVerdict(eventName, want, {
      audience: enriched?.audience || null,
    });
    return verdict.decision === "include";
  }
  // No explicit audience filter — use profile-derived defaults. Events
  // with NULL audience (no signal) pass through with low confidence,
  // matching search_events behaviour.
  if (!enriched?.audience) return true;
  const allowed = deriveDefaultAudienceSet(profile);
  if (!allowed.has(enriched.audience)) return false;

  // Adult SUBTYPE narrowing (May-2026). Same logic search_events
  // and the newsletter apply: within `מבוגרים`, exclude rows
  // tagged with the opposite subtype for the user's `age_range`.
  // Skipped when the saved search explicitly pinned an audience
  // (handled above) — the user opted into a tier and second-
  // guessing them with a subtype gate would be over-engineering.
  if (shouldExcludeAdultSubtypeEvent(enriched, profile)) return false;
  return true;
}

function dateMatches(eventDate, filters) {
  if (!filters?.date_from && !filters?.date_to) return true;
  if (!eventDate) return true;
  if (filters.date_from && eventDate < filters.date_from) return false;
  if (filters.date_to && eventDate > filters.date_to) return false;
  return true;
}

function timeMatches(startTime, filters) {
  if (!startTime) return true;
  if (filters?.time_after && startTime < filters.time_after) return false;
  if (filters?.time_before && startTime > filters.time_before) return false;
  return true;
}

function formatMatches(kind, filters) {
  const want = filters?.format;
  if (!want || want === "any") return true;
  // `placeholder` venues (source intentionally hides the address —
  // see sql/036) aren't really physical OR virtual. We treat
  // "physical-only" as "kind === 'physical'" rather than the older
  // "anything not virtual" so placeholder events don't sneak into
  // distance-sensitive saved-search matches.
  if (want === "physical") return kind === "physical";
  if (want === "virtual") return kind === "virtual";
  return true;
}

// Venue filter — two paths:
//
//  (1) `filters.location_key`: the saved search references a specific
//      row in the `locations` table (resolved at save time). Match is a
//      direct equality on the event's location_key — fast, exact, and
//      survives address re-spellings.
//
//  (2) `filters.venue`: free-text fallback used when we couldn't resolve
//      the user's text to a known location_key (e.g. she typed a venue
//      we haven't indexed yet). Substring AND-match against the event's
//      stored address — once the venue gets geocoded into `locations`,
//      she'll start getting precise matches automatically.
function venueMatches(enriched, filters) {
  const wantKey = filters?.location_key;
  if (wantKey) {
    return enriched?.location_key === wantKey;
  }

  const want = filters?.venue;
  if (!want) return true;
  const eventAddress = enriched?.address;
  if (!eventAddress) return false;
  const lower = eventAddress.toLowerCase();
  const wantTokens = String(want)
    .toLowerCase()
    .split(/[\s,.\-_/]+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  if (!wantTokens.length) return true;
  return wantTokens.every((t) => lower.includes(t));
}

// Saved-search proximity is STRICT: an ungeocodable venue is treated as
// "we don't know if it's close, so don't bother her" rather than the
// bot's interactive search default of "be generous and surface it". For
// passive notifications you'd much rather miss a borderline match than
// get pinged about an event that turns out to be 40km away. The walk
// limit is derived per-user from `constraints.max_walking_minutes`
// (default 15) and enforced inside evaluateProximity — same threshold
// uses the same ≤10-min short-drive cap as profile «נסיעה קצרה».
async function proximityMatches(event, enriched, filters, profile) {
  const pref = filters?.proximity;
  if (!pref) return true;

  const home = profile?.user_context?.constraints?.home_coordinates;
  if (!home?.lat || !home?.lng) return true; // no coords on profile = can't filter, allow

  const constraints = profile?.user_context?.constraints || {};
  const locationConstraints =
    pref === "walk"
      ? {
          location_modes: ["walk"],
          max_walking_minutes: constraints.max_walking_minutes,
        }
      : pref === "drive"
        ? { location_modes: ["drive"] }
        : null;
  const evalMin = evalWalkMinutesForModes(locationConstraints?.location_modes || []);

  const result = await evaluateProximity(
    home,
    event.location || null,
    evalMin,
    enriched?.coords || null,
    { useRoutesApi: false },
  );

  // Virtual events: only match when the user explicitly opted into virtual
  // (handled by formatMatches). Here we treat them as "no proximity info"
  // and reject — proximity filter without a physical location can never
  // satisfy "walk" or "drive".
  if (!result?.resolved) {
    if (result?.reason === "virtual") return false;
    // ungeocodable / no_venue / no_home → silent rejection so the user
    // doesn't get pinged about an event we can't geographically verify.
    return false;
  }

  return eventPassesLocationModes(result, locationConstraints);
}

// ───── Notification UX ─────

function buildMatchMessage(event, savedSearch, profileFirstName) {
  const greeting = profileFirstName ? `${profileFirstName}, ` : "";
  const lines = [
    `🎯 ${greeting}מצאתי משהו לחיפוש "${savedSearch.query}"`,
    ``,
    `${getEventIcon(event)} ${event.name}`,
  ];
  if (event.date) lines.push(`📅 ${formatHebrewDate(event.date)}`);
  const timeStr = formatTimeRange(event.start_time, event.end_time);
  if (timeStr) lines.push(rtlLine(`🕐 ${timeStr}`));
  const audienceLine = formatAudienceLine(event);
  if (audienceLine) lines.push(audienceLine);
  if (event.location) lines.push(`📍 ${event.location}`);
  // Shared helper merges the low-stock warning into the same ticket
  // line ("🎫 N כרטיסים אחרונים ❗️") instead of stacking two lines.
  // Saved-search notifications skip the sold-out ("🚫 אזלו") branch
  // because the matcher upstream only delivers events with stock.
  const ticketsLine = formatTicketsLine(event.tickets_left);
  if (ticketsLine) lines.push(ticketsLine);

  const remaining = savedSearch.tickets_remaining;
  const needed = savedSearch.tickets_needed;
  if (needed != null && remaining != null) {
    if (savedSearch.mode === "one_time") {
      lines.push(`📋 חסרים ${remaining}/${needed}`);
    } else {
      lines.push(`📋 ביקשת ${needed}`);
    }
  }

  return lines.join("\n");
}

function buildKeyboard(event, savedSearch, profile) {
  const eventId = event.id;
  const ssId = savedSearch.id;
  const navOpts = navOptsFromProfile(profile, event);
  const rows = [];
  // "🎟️ לרכישה" — top-row URL button. We previously embedded this as
  // an in-text <a href> to skip Telegram's "Open this URL?" dialog,
  // but the dialog fired on the hyperlink too in real Telegram
  // clients, so we reverted to the simpler button (May 2026).
  const bookingUrl = getBookingUrl(event);
  if (bookingUrl) {
    rows.push([{ text: "🎟️ לרכישה", url: bookingUrl }]);
  }

  // Single "🧭 ניווט" button (May-2026 revamp). Same UX as the
  // search-results card — every event surface should let the user
  // jump straight to directions.
  const navRow = buildNavButtons(event, navOpts);
  if (navRow.length) rows.push(navRow);

  // "✅ קניתי N" buttons appear when we know how many the user wants AND
  // there's stock to satisfy at least one. Decrements `tickets_remaining`
  // on the saved search row; one_time mode auto-archives on ANY decrement
  // (see savedSearchService.decrementTicketsRemaining).
  const remaining = savedSearch.tickets_remaining;
  const ticketsLeft = event.tickets_left ?? 0;
  if (remaining != null && remaining > 0 && ticketsLeft > 0) {
    const cap = Math.min(remaining, ticketsLeft, 6);
    const buttons = [];
    for (let n = 1; n <= cap; n++) {
      buttons.push({ text: `✅ קניתי ${n}`, callback_data: `sb:${ssId}:${n}` });
    }
    for (let i = 0; i < buttons.length; i += 3) {
      rows.push(buttons.slice(i, i + 3));
    }
  }

  rows.push([{ text: "🔕 הפסיקי לעקוב", callback_data: `ss:rm:${ssId}` }]);
  return { inline_keyboard: rows };
}

/**
 * Multi-instance card: "סיור עששיות" matched 5 instances in one cycle.
 * One Telegram message lists all of them; one tap on "✅ מצאתי" archives
 * the saved search so the rest of the week stays quiet.
 */
function buildBatchMessage(events, savedSearch, profileFirstName) {
  const greeting = profileFirstName ? `${profileFirstName}, ` : "";
  const lines = [
    `🎯 ${greeting}מצאתי ${events.length} מופעים לחיפוש "${savedSearch.query}"`,
    ``,
  ];
  for (const ev of events) {
    lines.push(`${getEventIcon(ev)} ${ev.name}`);
    if (ev.date) lines.push(`   📅 ${formatHebrewDate(ev.date)}`);
    const timeStr = formatTimeRange(ev.start_time, ev.end_time);
    if (timeStr) lines.push(rtlLine(`   🕐 ${timeStr}`));
    if (ev.location) lines.push(`   📍 ${ev.location}`);
    // Single merged ticket line per the May-2026 UI revamp — see
    // formatTicketsLine in lib/eventCard.js for the full ruleset.
    const evTicketsLine = formatTicketsLine(ev.tickets_left);
    if (evTicketsLine) lines.push(rtlLine(`   ${evTicketsLine}`));
    lines.push(``);
  }
  if (savedSearch.tickets_needed) {
    lines.push(`📋 ביקשת ${savedSearch.tickets_needed} כרטיסים`);
  }
  return lines.join("\n").trimEnd();
}

function buildBatchKeyboard(events, savedSearch) {
  const ssId = savedSearch.id;
  const rows = [];

  // One booking button per event, capped at 6 rows for layout sanity.
  const bookingRow = events.slice(0, 6).map((ev, i) => ({
    text: `🎟️ ${i + 1}`,
    url: getBookingUrl(ev),
  }));
  for (let i = 0; i < bookingRow.length; i += 3) {
    rows.push(bookingRow.slice(i, i + 3));
  }

  // Single "found it" archive button — this is the user's preferred path
  // for batch matches. Decrement-by-N doesn't fit because she may have
  // bought tickets for multiple of the listed events.
  rows.push([
    { text: "✅ מצאתי, סיימי לעקוב", callback_data: `sf:${ssId}` },
  ]);
  rows.push([{ text: "🔕 הפסיקי לעקוב", callback_data: `ss:rm:${ssId}` }]);
  return { inline_keyboard: rows };
}

// ───── Main entry point ─────

async function notifySavedSearchMatchesFor(events, telegram) {
  if (!telegram) return { matched: 0, notified: 0 };
  if (!Array.isArray(events) || !events.length) return { matched: 0, notified: 0 };

  const saved = await listAllActiveSavedSearches();
  if (!saved.length) return { matched: 0, notified: 0 };

  const userIds = [...new Set(saved.map((s) => s.telegram_id))];
  const [profiles, enrichedMap, notifiedMap] = await Promise.all([
    getProfileMap(userIds),
    enrichEvents(events),
    getNotifiedMap(saved.map((s) => s.id)),
  ]);

  // Three-phase pipeline:
  //   Phase 1 — filter events × saved-searches and GROUP by saved search,
  //             so 5 instances of "סיור עששיות" produce one user-facing
  //             notification, not five separate messages.
  //   Phase 2 — DEDUPE per user. When event E matches both
  //             "אירועים בגאולים" AND "אירועי ילדים בגאולים" for the same
  //             user, the user used to get two messages about E. Now we
  //             pick one "carrier" saved search (oldest first — usually
  //             the broader one) and silently mark-notified the rest for
  //             that event, so they never fire on E again.
  //   Phase 3 — claim (markNotified) BEFORE sending so a crash mid-send
  //             can't double-fire on the next scrape, then send.
  const matchesBySearch = new Map(); // ss.id → { ss, profile, events: [enriched event] }

  for (const event of events) {
    if (!event?.id || (event.tickets_left ?? 0) <= 0) continue;
    const enriched = enrichedMap.get(event.id) || null;

    for (const ss of saved) {
      const profile = profiles.get(ss.telegram_id);
      if (!profile) continue;

      const seen = notifiedMap.get(ss.id);
      if (seen && seen.has(event.id)) continue;

      const filters = ss.filters || {};

      // Topic watcher takes precedence over tokens. If the saved search
      // is a tag-based subscription and the event's tags overlap, we
      // bypass the token AND-match (tokens describe the title, tags
      // describe the topic — different signals).
      const topicHit = topicTagsMatch(ss, enriched);
      if (topicHit === false) continue;
      if (topicHit !== true && !tokensMatch(event.name, ss)) continue;
      if (topicHit !== true && !typeMatchesSavedSearch(event.name, ss)) continue;
      if (!audienceMatchesSavedSearch(event.name, filters, enriched, profile)) continue;
      if (!agesMatch(filters, enriched)) continue;
      if (!dateMatches(event.date, filters)) continue;
      if (!timeMatches(event.start_time, filters)) continue;
      if (!formatMatches(enriched?.kind, filters)) continue;
      if (!venueMatches(enriched, filters)) continue;
      if (!(await proximityMatches(event, enriched, filters, profile))) continue;

      if (!matchesBySearch.has(ss.id)) {
        matchesBySearch.set(ss.id, { ss, profile, events: [] });
      }
      // Attach the resolved tag NAMES onto the event so downstream
      // formatters (getEventIcon, future tag chips) don't need a
      // second round-trip. Shallow-clone first — the same `event`
      // reference may be reused across saved searches in this loop.
      matchesBySearch.get(ss.id).events.push({
        ...event,
        tags: enriched?.tags || event.tags || [],
      });
    }
  }

  // Phase 2 — per-user event dedup. We invert the grouping into
  // { telegramId → Map<eventId, [ssId,...]> } and, for any event that
  // shows up under multiple of the same user's saved searches, pick the
  // OLDEST one as the single message carrier. The redundant ones get a
  // silent mark-notified so they don't pop on the next scrape either.
  const byUser = new Map();
  for (const [ssId, group] of matchesBySearch) {
    const tg = group.ss.telegram_id;
    if (!byUser.has(tg)) byUser.set(tg, new Map());
    const userMap = byUser.get(tg);
    for (const ev of group.events) {
      if (!userMap.has(ev.id)) userMap.set(ev.id, []);
      userMap.get(ev.id).push(ssId);
    }
  }

  // Saved-search id → list of event-ids whose notifications we are
  // suppressing for this run because another saved search of the same
  // user is carrying the message. We still need to claim them so the
  // suppressed search treats the event as "handled" forever.
  const silentClaims = new Map();
  let dedupedCount = 0;

  for (const [, userMap] of byUser) {
    for (const [eventId, ssIds] of userMap) {
      if (ssIds.length <= 1) continue;
      // Pick the oldest saved search (typically the broader one the
      // user set up first). We sort by saved-search created_at if
      // available, else by id which is monotonic enough.
      ssIds.sort((a, b) => {
        const aSs = matchesBySearch.get(a)?.ss;
        const bSs = matchesBySearch.get(b)?.ss;
        const aT = aSs?.created_at ? new Date(aSs.created_at).getTime() : 0;
        const bT = bSs?.created_at ? new Date(bSs.created_at).getTime() : 0;
        return aT - bT;
      });
      const carrier = ssIds[0];
      for (const losingSsId of ssIds.slice(1)) {
        const group = matchesBySearch.get(losingSsId);
        group.events = group.events.filter((e) => e.id !== eventId);
        if (!silentClaims.has(losingSsId)) silentClaims.set(losingSsId, []);
        silentClaims.get(losingSsId).push(eventId);
        dedupedCount++;
      }
      console.log(
        `  [SavedSearch] dedup: event ${eventId} matched ${ssIds.length} saved-searches ` +
        `for user — carrying via ss=${carrier}`,
      );
    }
  }
  if (dedupedCount) {
    console.log(`  [SavedSearch] suppressed ${dedupedCount} duplicate notification(s) this cycle`);
  }

  let matched = 0;
  let notified = 0;

  // Claim the suppressed pairs (silent — no Telegram send). Doing this
  // BEFORE the loop ensures even searches that ended up with empty
  // events arrays still record the dedup so they won't re-fire later.
  for (const [ssId, eventIds] of silentClaims) {
    for (const eid of eventIds) {
      try {
        await markNotified(ssId, eid);
      } catch (err) {
        console.error(`  [SavedSearch] silent claim failed for ss=${ssId} event=${eid}: ${err.message}`);
      }
    }
  }

  for (const { ss, profile, events: matches } of matchesBySearch.values()) {
    if (!matches.length) continue; // entirely deduped
    matched += matches.length;
    const matchedTokens = deriveTokens(ss).join(",");

    // Claim first: mark every event-id as notified BEFORE the network
    // call. Even if the Telegram send fails, we won't re-fire next cycle —
    // better to silently miss one notification than spam the user three
    // times in a row when a transient send error keeps re-queueing them.
    await Promise.all(
      matches.map((e) =>
        markNotified(ss.id, e.id).catch((err) =>
          console.error(`  [SavedSearch] claim failed for event=${e.id}: ${err.message}`),
        ),
      ),
    );

    try {
      if (matches.length === 1) {
        const event = matches[0];
        const message = buildMatchMessage(event, ss, profile.first_name);
        const reply_markup = buildKeyboard(event, ss, profile);
        const photoUrl = normalizeImageUrl(event.image_url, event);
        if (photoUrl) {
          try {
            await telegram.sendPhoto(ss.telegram_id, photoUrl, {
              caption: message,
              reply_markup,
            });
          } catch {
            await telegram.sendMessage(ss.telegram_id, message, {
              reply_markup,
            });
          }
        } else {
          await telegram.sendMessage(ss.telegram_id, message, {
            reply_markup,
          });
        }
      } else {
        const message = buildBatchMessage(matches, ss, profile.first_name);
        const reply_markup = buildBatchKeyboard(matches, ss);
        await telegram.sendMessage(ss.telegram_id, message, { reply_markup });
      }
      notified += matches.length;
      console.log(
        `  [SavedSearch] notified ${ss.telegram_id} about ${matches.length} match(es) ` +
        `(saved=${ss.id}, tokens=[${matchedTokens}], query="${ss.query || ""}")`,
      );
    } catch (err) {
      console.error(`  [SavedSearch] send failed (saved=${ss.id}): ${err.message}`);
    }
  }

  return { matched, notified };
}

// ─── 2nd-hand WhatsApp ticket variant ───
//
// When a new (or unsold) ticket arrives via WhatsApp, run the same set of
// deterministic filters against active saved searches and surface it as a
// "כרטיס יד-שנייה" notification. We deliberately reuse the same predicate
// helpers (tokensMatch, dateMatches, …) so the behaviour stays consistent
// between event listings and second-hand offers.

function buildTicketMatchMessage(ticket, savedSearch, profileFirstName) {
  const greeting = profileFirstName ? `${profileFirstName}, ` : "";
  const lines = [
    `🎫 ${greeting}כרטיס יד-שנייה לחיפוש "${savedSearch.query}"`,
    ``,
    `${getEventIcon({ name: ticket.event_title })} ${ticket.event_title}`,
  ];
  if (ticket.event_date) lines.push(`📅 ${formatHebrewDate(ticket.event_date)}`);
  const timeStr = formatTimeRange(ticket.event_time, null);
  if (timeStr) lines.push(rtlLine(`🕐 ${timeStr}`));
  if (ticket.quantity) lines.push(rtlLine(`🎫 ${ticket.quantity} כרטיסים`));
  if (ticket.price) lines.push(rtlLine(`💰 ${ticket.price}`));
  return lines.join("\n");
}

function buildTicketKeyboard(ticket, savedSearch) {
  const rows = [];
  if (ticket.seller_phone) {
    const cleaned = String(ticket.seller_phone).replace(/[^0-9]/g, "");
    if (cleaned) {
      rows.push([
        { text: "💬 פנייה למוכר/ת", url: `https://wa.me/${cleaned}` },
      ]);
    }
  }
  rows.push([{ text: "🔕 הפסיקי לעקוב", callback_data: `ss:rm:${savedSearch.id}` }]);
  return { inline_keyboard: rows };
}

async function notifySavedSearchMatchesForTicket(ticket, telegram) {
  if (!telegram || !ticket?.id) return { matched: 0, notified: 0 };
  if (ticket.status && ticket.status !== "active") return { matched: 0, notified: 0 };

  const saved = await listAllActiveSavedSearches();
  if (!saved.length) return { matched: 0, notified: 0 };

  const userIds = [...new Set(saved.map((s) => s.telegram_id))];
  const [profiles, notifiedMap] = await Promise.all([
    getProfileMap(userIds),
    getNotifiedTicketMap(saved.map((s) => s.id)),
  ]);

  // 2nd-hand listings rarely come with structured location data — we can
  // only realistically filter by tokens/type/date/time. Proximity/format
  // filters are skipped (we don't know where the seller's seat is), which
  // matches the user's intent: "any matching ticket is interesting".
  let matched = 0;
  let notified = 0;

  for (const ss of saved) {
    const profile = profiles.get(ss.telegram_id);
    if (!profile) continue;

    const seen = notifiedMap.get(ss.id);
    if (seen && seen.has(ticket.id)) continue;

    const filters = ss.filters || {};
    if (!tokensMatch(ticket.event_title, ss)) continue;
    if (!typeMatchesSavedSearch(ticket.event_title, ss)) continue;
    if (!dateMatches(ticket.event_date, filters)) continue;
    if (!timeMatches(ticket.event_time, filters)) continue;

    matched++;

    // Claim before send: same rationale as the events flow — we'd rather
    // miss a notification than spam the user about the same ticket on
    // every restart of the WhatsApp scraper.
    try {
      await markTicketNotified(ss.id, ticket.id);
    } catch (err) {
      console.error(`  [SavedSearch] ticket claim failed: ${err.message}`);
    }

    const message = buildTicketMatchMessage(ticket, ss, profile.first_name);
    const reply_markup = buildTicketKeyboard(ticket, ss);
    try {
      // Tickets are 2nd-hand WhatsApp listings; no Smarticket source.
      // Pass `undefined` so normalizeImageUrl falls back to its default
      // tenant — image URLs in this path are typically already absolute
      // (uploaded by the seller), so the fallback is mostly cosmetic.
      const photoUrl = normalizeImageUrl(ticket.image_url);
      if (photoUrl) {
        try {
          await telegram.sendPhoto(ss.telegram_id, photoUrl, {
            caption: message,
            reply_markup,
          });
        } catch {
          await telegram.sendMessage(ss.telegram_id, message, { reply_markup });
        }
      } else {
        await telegram.sendMessage(ss.telegram_id, message, { reply_markup });
      }
      notified++;
      console.log(
        `  [SavedSearch] notified ${ss.telegram_id} about 2nd-hand ticket "${ticket.event_title}" (saved=${ss.id})`,
      );
    } catch (err) {
      console.error(`  [SavedSearch] ticket notify failed: ${err.message}`);
    }
  }

  return { matched, notified };
}

module.exports = {
  notifySavedSearchMatchesFor,
  notifySavedSearchMatchesForTicket,
};
