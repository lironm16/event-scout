// Detection helpers for the Ramat Gan municipal events API
// (`api-m.ramat-gan.muni.il`). This module deliberately does NOT
// touch Supabase, the `events` table, or anything else — it only
// answers: "given an event from the city feed, is it new, or do we
// already have it via the existing Smarticket scrape?".
//
// Why a separate detection layer (not just bolted into the scraper):
//   The municipal feed mixes three populations:
//     1. Genuine city-only events (free entry, no registration) — the
//        whole reason we want this source.
//     2. Smarticket-backed events tagged with `eventSource.sourceId`
//        and a recognizable URL prefix — already in our DB.
//     3. Umbrella parents (e.g. `baby-debuts-2026`) that LOOK city-
//        only but expand into 6 Smarticket sub-events we already
//        track. Visible only after fetching the detail JSON.
//   Skipping (2) and (3) is what keeps duplicates out. Adding (1) is
//   the actual integration work — handled elsewhere when we're ready.
//
// See plan: city-api duplicate detection (in `.cursor/plans/`).

const axios = require("axios");
const { isPlaceholderAddress } = require("./locationStore");

// ─────────────────────────────────────────────────────────────────
// Endpoints
// ─────────────────────────────────────────────────────────────────
const LOBBY_URL =
  "https://api-m.ramat-gan.muni.il/api/EventLobby/he/event-lobby";
const DETAIL_URL_BASE =
  "https://api-m.ramat-gan.muni.il/api/Event/events/";

// City API → our `source_t` ENUM. The names exposed on
// `eventSource.value` ("עיריית רמת גן" / "בית עמנואל") map cleanly to
// the two Smarticket tenants we already scrape via `lib/sourceUrls`.
// IDs are integers in the JSON response.
const SOURCE_BY_CITY_ID = Object.freeze({
  1: "ramat-gan", // "עיריית רמת גן"
  2: "mbe-rg", //   "בית עמנואל"
});

// Same mapping but keyed by URL prefix. The lobby JSON's
// `detailsLink.url` for Smarticket-backed events takes one of two
// shapes: `/events/rg-events/web-site-event-{N}/` or
// `/events/mbe-rg-events/web-site-event-{N}/`. Either prefix lets us
// recover the tenant *and* the integer event id (= our `events.id`).
const SOURCE_BY_URL_PREFIX = Object.freeze({
  "rg-events": "ramat-gan",
  "mbe-rg-events": "mbe-rg",
});

// ─────────────────────────────────────────────────────────────────
// HTTP fetchers
// ─────────────────────────────────────────────────────────────────
const HTTP_TIMEOUT_MS = 15000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchLobby() {
  const { data } = await axios.get(LOBBY_URL, {
    timeout: HTTP_TIMEOUT_MS,
    headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
  });
  return data;
}

async function fetchEventDetail(slug) {
  if (!slug) throw new Error("fetchEventDetail: slug required");
  const url = DETAIL_URL_BASE + encodeURIComponent(slug);
  const { data } = await axios.get(url, {
    timeout: HTTP_TIMEOUT_MS,
    headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
  });
  return data;
}

// ─────────────────────────────────────────────────────────────────
// URL parsing
// ─────────────────────────────────────────────────────────────────

// Extract the trailing slug segment from a `detailsLink.url` like:
//   "/events/jerusalem-day/"                       -> "jerusalem-day"
//   "/events/rg-events/web-site-event-3580/"       -> "web-site-event-3580"
//   "/events/mbe-rg-events/web-site-event-22323/"  -> "web-site-event-22323"
// Returns null when the URL doesn't look like a detail page.
function extractSlug(url) {
  if (typeof url !== "string" || !url) return null;
  const cleaned = url.replace(/\/+$/, "");
  const idx = cleaned.lastIndexOf("/");
  if (idx < 0) return null;
  const tail = cleaned.slice(idx + 1).trim();
  return tail || null;
}

// Match Smarticket-prefixed URLs. Returns `{ source, smarticketId }`
// or null. The `web-site-event-{N}` segment is well-formed across
// the entire feed we've inspected (~100 events), so we don't try to
// handle edge cases that haven't been observed.
const SMARTICKET_URL_RE =
  /\/events\/(rg-events|mbe-rg-events)\/web-site-event-(\d+)\/?/i;

function parseSmarticketUrl(url) {
  if (typeof url !== "string" || !url) return null;
  const m = url.match(SMARTICKET_URL_RE);
  if (!m) return null;
  const source = SOURCE_BY_URL_PREFIX[m[1]];
  const smarticketId = parseInt(m[2], 10);
  if (!source || !Number.isFinite(smarticketId)) return null;
  return { source, smarticketId };
}

// ─────────────────────────────────────────────────────────────────
// Lobby event collection
//
// The lobby payload has events nested under several arrays:
//   - content.sliderEvents[]
//   - content.closeEvents[]
//   - content.eventLobbyCategories[].events[]
// The same event may appear in multiple sections — we dedupe by
// `detailsLink.url`. A node is "event-shaped" when it has both a
// `detailsLink.url` and a `title`; this avoids picking up
// navigation widgets that happen to live alongside events.
//
// The closeEvents shape is the richest (eventLocation, audienceType,
// category, cluster); slider entries are barer. When the same slug
// shows up in both, prefer the richer one — we keep that policy
// inside the collector so callers don't have to think about it.
// ─────────────────────────────────────────────────────────────────

function collectLobbyEvents(lobby) {
  const events = [];
  const byUrl = new Map();

  function score(node) {
    let s = 0;
    if (node.eventLocation) s += 4;
    if (Array.isArray(node.audienceType) && node.audienceType.length) s += 2;
    if (node.category?.name) s += 2;
    if (Array.isArray(node.cluster) && node.cluster.length) s += 1;
    return s;
  }

  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node.detailsLink?.url && typeof node.title === "string") {
      const url = node.detailsLink.url;
      const prev = byUrl.get(url);
      if (!prev || score(node) > score(prev)) {
        byUrl.set(url, node);
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "detailsLink") continue;
      visit(node[key]);
    }
  }

  visit(lobby);
  for (const e of byUrl.values()) events.push(e);
  return events;
}

// ─────────────────────────────────────────────────────────────────
// Layer 1: classify a single lobby event using JSON-only signals
//
// This costs nothing beyond the lobby fetch we already paid for.
// The decision tree:
//
//   1. eventSource.sourceId is present
//        → smarticket-backed; use the city-supplied source name and
//          recover the integer id from the URL when possible.
//   2. URL looks like /events/{rg-events,mbe-rg-events}/web-site-event-N/
//        → also smarticket-backed; the URL is the authoritative
//          source even if `eventSource` was null (rare belt-and-
//          suspenders case observed in old/imported events).
//   3. Otherwise: city-candidate. Layer 2 (detail fetch) decides.
//
// Returns one of:
//   { kind: "smarticket", source, smarticketId | null, slug }
//   { kind: "city-candidate", slug }
// ─────────────────────────────────────────────────────────────────
function classifyLobbyEvent(event) {
  if (!event || typeof event !== "object") {
    throw new Error("classifyLobbyEvent: event required");
  }
  const url = event.detailsLink?.url || null;
  const slug = extractSlug(url);

  // Signal A: explicit `eventSource` on the lobby entry.
  const cityId = event.eventSource?.sourceId;
  if (cityId != null) {
    const source = SOURCE_BY_CITY_ID[cityId];
    if (!source) {
      // City introduced a new tenant (sourceId 3+) before our code
      // was updated. Treat as smarticket-backed but with unknown
      // mapping so the caller can SKIP without crashing.
      return {
        kind: "smarticket",
        source: null,
        smarticketId: null,
        slug,
        unknownSourceId: cityId,
      };
    }
    // The URL usually still embeds the integer id — capture it.
    const fromUrl = parseSmarticketUrl(url);
    return {
      kind: "smarticket",
      source,
      smarticketId: fromUrl?.smarticketId ?? null,
      slug,
    };
  }

  // Signal B: URL pattern alone (covers cases where eventSource is
  // null but the URL still betrays the Smarticket origin).
  const fromUrl = parseSmarticketUrl(url);
  if (fromUrl) {
    return {
      kind: "smarticket",
      source: fromUrl.source,
      smarticketId: fromUrl.smarticketId,
      slug,
    };
  }

  // Layer 1 says: candidate for ADD. Layer 2 (detail fetch) must
  // confirm before we trust it.
  return { kind: "city-candidate", slug };
}

// ─────────────────────────────────────────────────────────────────
// Layer 2: detail-level umbrella check
//
// A small minority of city-only-looking events are actually parents
// over a list of Smarticket sub-events — see `baby-debuts-2026` in
// the plan. Detection: walk `components[].content.schedule[]` and
// look for any registerLink pointing at a Smarticket host.
// ─────────────────────────────────────────────────────────────────

const SMARTICKET_HOST_RE = /https?:\/\/[^/]*\.smarticket\.co\.il\b/i;

function looksLikeSmarticketLink(link) {
  return typeof link === "string" && SMARTICKET_HOST_RE.test(link);
}

// Matches Zoom, Google Meet, and Microsoft Teams join URLs.
// These are stored in `online_url` (not `external_url`) so the
// "🔗 פרטים" button always goes to the city page, while a
// separate "📹 הצטרף למפגש" button surfaces the meeting link.
const ONLINE_JOIN_RE =
  /zoom\.us\/j\/|meet\.google\.com\/|teams\.microsoft\.com\/l\/meetup/i;

function isOnlineJoinLink(url) {
  return typeof url === "string" && ONLINE_JOIN_RE.test(url);
}

function detailRegisterLink(detailJson) {
  return detailJson?.content?.registerLink ?? null;
}

function detailScheduleLinks(detailJson) {
  const out = [];
  for (const comp of detailJson?.components || []) {
    const schedule = comp?.content?.schedule;
    if (!Array.isArray(schedule)) continue;
    for (const occ of schedule) {
      if (occ?.registerLink) out.push(occ.registerLink);
    }
  }
  return out;
}

// True if the parent itself, OR any of its scheduled occurrences,
// links into Smarticket. False = the event has no Smarticket footprint
// at all and is genuinely city-only.
function detailHasSmarticketFootprint(detailJson) {
  if (looksLikeSmarticketLink(detailRegisterLink(detailJson))) return true;
  return detailScheduleLinks(detailJson).some(looksLikeSmarticketLink);
}

function classifyDetail(detailJson) {
  const reasons = [];
  if (looksLikeSmarticketLink(detailRegisterLink(detailJson))) {
    reasons.push("registerLink");
  }
  const scheduleHits = detailScheduleLinks(detailJson).filter(
    looksLikeSmarticketLink,
  );
  if (scheduleHits.length) {
    reasons.push(`umbrella(${scheduleHits.length})`);
  }
  return {
    cityOnly: reasons.length === 0,
    reasons,
    scheduleSize: detailScheduleLinks(detailJson).length,
  };
}

// ─────────────────────────────────────────────────────────────────
// City-only umbrella detection (fan-out)
//
// A subset of "city-only" events are actually parent rows over N
// scheduled sessions — see `active-garden-2026` (one parent, 11
// sessions across different city parks, each with its own date,
// hour, location and `eventInfo`). The parent's own `content.date`
// and `content.location` carry placeholder/default values; the
// real per-session data lives in `components[].content.schedule[]`.
//
// `classifyDetail` above already covers the Smarticket-linked
// umbrella case (parent over Smarticket children — skip, the
// tenant scrapers handle them). This helper covers the
// complementary case: parent over CITY-ONLY children, where we
// want to FAN OUT into one event row per session sharing the
// parent's title.
//
// Returns:
//   null   — no `schedule[]` at all → treat as a single event
//            (use `buildCityEventRow` on the parent payload).
//   []     — `schedule[]` existed but every entry has a
//            Smarticket registerLink → already handled by
//            `classifyDetail.umbrella()`; nothing for us to do.
//   [...]  — N ≥ 1 city-only sessions. Caller should build one
//            child row per element (see `buildCityChildEventRow`)
//            and archive the parent slug.
//
// Smarticket-linked entries are filtered out so a mixed schedule
// (rare but possible) doesn't duplicate the Smarticket events
// that the tenant scrapers already cover.
// ─────────────────────────────────────────────────────────────────
function extractCitySchedule(detailJson) {
  let scheduleFound = false;
  const cityOnly = [];
  for (const comp of detailJson?.components || []) {
    const schedule = comp?.content?.schedule;
    if (!Array.isArray(schedule)) continue;
    scheduleFound = true;
    for (const occ of schedule) {
      if (looksLikeSmarticketLink(occ?.registerLink)) continue;
      cityOnly.push(occ);
    }
  }
  return scheduleFound ? cityOnly : null;
}

// ─────────────────────────────────────────────────────────────────
// Slug → INT id (deterministic hash)
//
// Why we hash instead of using a sequence:
//   `events.id` is an INT4 primary key with FKs to it from
//   `watchers`, `ticket_history`, and saved-search match logs. A
//   separate table for city events would fork all of those join
//   paths. A sequence would force a `SELECT … WHERE external_slug
//   = ?` (or its INSERT … RETURNING equivalent) on every upsert,
//   doubling the round-trips and introducing race conditions when
//   two scrape passes hit the same slug concurrently. A hash gives
//   us a deterministic, idempotent id with zero extra queries.
//
// Why FNV-1a 32-bit: no dependency, fast, decent distribution for
//   short ASCII slugs (the city's slugs are slug-cased English/
//   transliteration). Cryptographic strength is not needed.
//
// Range: [50_000_000, 99_999_999] = 50M slots.
//   Smarticket ids today live in [300, 22_400] on both tenants.
//   Reserving 50M..99M leaves headroom on both sides — Smarticket
//   could grow 2000x before colliding, and we still have the
//   100M+ range for any future external source. Birthday
//   collisions in 50M slots: 1 expected per √(2·50M) ≈ 10K rows.
//   At ~30 city-only events at any given time and bounded annual
//   churn, the practical risk is essentially zero. The
//   `(source, external_slug)` UNIQUE index in sql/038 catches a
//   collision at insert time anyway, so we'd notice (and could
//   add a salt fallback) before any silent corruption.
// ─────────────────────────────────────────────────────────────────

const HASH_RANGE_START = 50_000_000;
const HASH_RANGE_SIZE = 50_000_000;

function slugToEventId(slug) {
  if (typeof slug !== "string" || !slug) {
    throw new Error("slugToEventId: non-empty slug required");
  }
  // FNV-1a 32-bit. `Math.imul` is the documented way to do 32-bit
  // multiplication in JS without losing the upper bits to the
  // double-precision mantissa.
  let hash = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    hash ^= slug.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // `hash` may be negative due to two's-complement; normalise
  // before modulo so the result is always in the target range.
  const positive = hash >>> 0;
  return HASH_RANGE_START + (positive % HASH_RANGE_SIZE);
}

// ─────────────────────────────────────────────────────────────────
// Audience / category mapping (city vocab → our ENUMs)
//
// The city CMS uses a richer-but-incompatible vocabulary. We only
// have one strong signal per dimension (`audience_t`, `category_t`),
// so we map best-effort and leave NULL on misses. The existing
// partial-state self-healer in `lib/eventEnricher.js` would NOT
// pick city events up since they have no description_hash, but we
// can safely backfill by re-scraping — slugs are stable, so the
// upsert is idempotent.
//
// Audience: city sends a LIST of audienceType[] entries. We collapse
// to a single value via priority order (the youngest applicable
// bucket wins, matching how the bot already filters — a "ילדים"
// event with extra "מבוגרים" tag is still a kids event). On no
// match we pick the most common shared bucket if any; otherwise
// NULL.
//
// Category: ENUM is small (סדנה, הצגה, הופעה, הפעלה, הרצאה,
// משחקייה, סיור, ספורט, אחר). The city's category names are
// thematic ("שבועות 2026", "הקהילה הגאה") rather than format-
// based. Most map to NULL → 'אחר' fallback or just leave NULL.
// We surface the city's category.name as a TAG below either way,
// so no information is lost.
// ─────────────────────────────────────────────────────────────────

// Priority order: explicit "לכל המשפחה" tag wins first — it's the
// city's strongest "this is for everyone" signal. After that,
// younger buckets win (a "ילדים (4-11)" + "נוער" event is a kids
// event with optional teens). When the array lists every age
// bucket (e.g. campaign umbrellas like shavuot-2026 with all 7
// audiences listed), the "לכל המשפחה" entry is always included,
// so the family rule still fires first.
//
// IMPORTANT: We cannot use \b word boundaries here. JavaScript
// regex `\b` is the ASCII word/non-word transition, which means
// every Hebrew character is a non-word character and `\bנוער\b`
// matches NOTHING in "נוער (12-18)" — the bug that motivated this
// comment. Plain substring matches are fine because the city CMS
// terms are themselves single Hebrew words; partial false matches
// (e.g. embedded inside a longer word) don't actually occur in the
// fixed vocabulary the API uses.
const CITY_AUDIENCE_PRIORITY = [
  { match: /משפח/, audience: "לכל המשפחה" },
  { match: /גיל\s*הרך|תינוק|פעוט|ינוקא|0[\s\-–]?3/, audience: "תינוקות" },
  { match: /ילדים/, audience: "ילדים" },
  { match: /נוער/, audience: "נוער" },
  // "הורים" before "מבוגרים" — a parents-only event is more specific
  // than a generic adult event.
  { match: /הורים/, audience: "הורים" },
  { match: /צעירים|מבוגרים|הגיל השלישי|18[\s\-–+]/, audience: "מבוגרים" },
];

// Threshold: if the audienceType array names ≥ this many distinct
// age buckets (kids, teens, adults, seniors, babies, family), it's
// a "tagged everyone" umbrella. Without an explicit "לכל המשפחה"
// entry — which the priority list above already prefers — we still
// want to avoid pinning such umbrellas to the youngest bucket.
const ALL_AGES_BUCKET_THRESHOLD = 4;

function countDistinctAgeBuckets(names) {
  const seen = new Set();
  for (const n of names) {
    for (const rule of CITY_AUDIENCE_PRIORITY) {
      if (rule.match.test(n)) seen.add(rule.audience);
    }
  }
  return seen.size;
}

function mapAudience(audienceTypeArray) {
  if (!Array.isArray(audienceTypeArray) || !audienceTypeArray.length) return null;
  const names = audienceTypeArray.map((a) => a?.name || "").filter(Boolean);
  if (!names.length) return null;
  // Tagged-everyone safeguard: if the entry lists most/all distinct
  // age buckets but somehow lacks the explicit "לכל המשפחה" name,
  // treat it as a family event. Without this, the youngest matching
  // rule (תינוקות) would win and a shavuot-style city festival
  // would surface as "babies-only" in search.
  if (countDistinctAgeBuckets(names) >= ALL_AGES_BUCKET_THRESHOLD) {
    return "לכל המשפחה";
  }
  for (const rule of CITY_AUDIENCE_PRIORITY) {
    if (names.some((n) => rule.match.test(n))) return rule.audience;
  }
  return null;
}

// Direct lookup table — anything not listed maps to NULL. Keeping
// this conservative is intentional: a wrong category is worse than
// a missing one for search/match. The Gemini self-heal pass can be
// extended later to fill these in if desired (out of scope for this
// integration).
const CITY_CATEGORY_MAP = Object.freeze({
  "סדנה": "סדנה",
  "סדנת": "סדנה",
  "הצגה": "הצגה",
  "הופעה": "הופעה",
  "מופע": "הופעה",
  "הפעלה": "הפעלה",
  "הרצאה": "הרצאה",
  "משחקייה": "משחקייה",
  "מסיבה": "מסיבה",
  "מסיבת": "מסיבה",
  // sql/042 added 'ארוחה' (meal-centred gathering) and 'מפגש'
  // (gathering without a meal). The city's CMS often labels Friday
  // community dinners as "ארוחת שישי" / "ארוחה קהילתית" and
  // social meetups as "מפגש" / "ערב חברתי" — map them directly so
  // we don't need to round-trip through Gemini for the easy cases.
  "ארוחה": "ארוחה",
  "ארוחת": "ארוחה",
  "מפגש": "מפגש",
  "סיור": "סיור",
  "טיול": "סיור",
  "ספורט": "ספורט",
});

// `eventName` is an optional fallback signal — used when the CMS hands
// us a COMBINED section header ("סדנאות והרצאות"). We pass the event
// title to `deriveCategoryByName` to recover the specific category
// (workshop vs lecture, etc.) since the combined header by definition
// can't map to a single `category_t` value.
function mapCategory(cityCategoryName, eventName) {
  if (!cityCategoryName) return null;
  const name = String(cityCategoryName).trim();
  if (!name) return null;
  // Combined nav section: defer to name-based heuristic, which routes
  // to a per-cluster matcher in COMBINED_NAV_DERIVERS. Returning NULL
  // on heuristic failure keeps the event in the "needs Gemini" bucket
  // rather than locking it to a wrong category.
  if (COMBINED_NAV_CLUSTERS.has(name)) {
    return deriveCategoryByName(eventName, name);
  }
  // Exact match first, then word-prefix (handles "סדנת בישול ...").
  if (CITY_CATEGORY_MAP[name]) return CITY_CATEGORY_MAP[name];
  for (const [needle, mapped] of Object.entries(CITY_CATEGORY_MAP)) {
    if (name.startsWith(needle)) return mapped;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────
// Access classification (community scope)
//
// Maps the city's `category.name` and `cluster[].name` to one of
// the `access_t` ENUM values (sql/039):
//
//   'open'                   — default; anyone can attend.
//   'community-disabilities' — events run by/for the disability
//                              community. The city signals this
//                              consistently via category =
//                              "ילדים ובוגרים עם מוגבלות".
//   'community-lgbtq'        — events from "מחלקת הקהילה הגאה".
//                              Category = "הקהילה הגאה" is the
//                              cleanest signal, and the venue
//                              "המרכז הגאה" is a strong fallback
//                              when category is missing.
//   'community-seniors'      — declared for forward compatibility;
//                              the city categorises 60+ events
//                              through audienceType, not category,
//                              so this branch rarely fires today.
//
// Returns 'open' on every non-match — i.e. unless we have a
// POSITIVE signal that the event is community-restricted, we
// surface it normally. Better to over-include than to silently
// hide events from people who can attend.
//
// Why not also restrict by `audienceType` membership ("הגיל
// השלישי" alone): audienceType can list MULTIPLE entries (e.g.
// "מבוגרים (35-60)" AND "הגיל השלישי (60+)") for events open to
// both age groups. Filtering on audienceType would over-restrict.
// The category field, by contrast, is a single hard label that
// the city editor chose deliberately.
// ─────────────────────────────────────────────────────────────────

// Rule list + matcher live in `lib/access.js` so both the city
// scraper (here) and the Smarticket scraper (`api/check.js`) share
// one source of truth. Adding a new community now means editing
// one file in one place — see the 2026-05 `community-miluim`
// rollout (sql/057) for the precedent. ACCESS_RULES is pulled in
// alongside the matcher so the module's `module.exports` block can
// continue to re-export it on the cityApi surface for backwards
// compatibility with callers/tests that import from here.
const { classifyAllAccessFromText, classifyAccessFromText, ACCESS_RULES } = require("./access");

function mapAccess(lobbyEntry, detailJson, opts = {}) {
  // Collect ALL matching community scopes from every signal source,
  // then return them as an array. Events can belong to more than one
  // community (e.g. an LGBTQ event in Russian gets both tags). We
  // use a Set to dedup across sources.
  //
  // Priority ordering (strongest → weakest) is preserved by the
  // order we probe sources, but since we no longer STOP at the first
  // hit the practical effect is that a stronger source's result
  // takes its natural place in the array while weaker sources can
  // add additional scopes — not override.
  const scopes = new Set();

  const addAll = (text) => {
    for (const s of classifyAllAccessFromText(text) || []) scopes.add(s);
  };

  // Strongest signal: city category (single hard label from CMS).
  addAll(lobbyEntry?.category?.name);

  // Fallback: cluster names.
  for (const c of lobbyEntry?.cluster || []) addAll(c?.name);
  for (const c of detailJson?.content?.cluster || []) addAll(c?.name);

  // Venue name heuristic. For umbrella children the CALLER passes
  // `opts.venueName` explicitly (the child's own venue) to avoid
  // inheriting a misleading parent venue. When `opts.venueName` is
  // null the heuristic is skipped for that row.
  let venueName;
  if (Object.prototype.hasOwnProperty.call(opts, "venueName")) {
    venueName = opts.venueName;
  } else {
    venueName =
      lobbyEntry?.eventLocation?.name ||
      detailJson?.content?.location?.name ||
      lobbyEntry?.location ||
      null;
  }
  if (venueName) addAll(venueName);

  // Umbrella editorial intent — last fallback. Checked AFTER local
  // signals so "child wins" policy is respected: a child at
  // "המרכז הגאה" under a seniors umbrella stays community-lgbtq
  // (already in scopes from the venue step); the umbrella adds
  // community-seniors on top if the slug matches.
  const umbrellaSlug = extractSlug(lobbyEntry?.detailsLink?.url) || null;
  const umbrellaText =
    [umbrellaSlug, lobbyEntry?.title].filter(Boolean).join(" ").trim();
  if (umbrellaText) addAll(umbrellaText);

  return scopes.size > 0 ? Array.from(scopes) : ["open"];
}

// ─────────────────────────────────────────────────────────────────
// Date / time normalisation
//
// The city API is inconsistent across endpoints:
//
//   Lobby JSON:
//     date: "2026-05-14T00:00:00Z"
//     hour: "2026-05-07T17:00:00Z"   ← only the TIME portion (17:00)
//                                      is meaningful; the date in
//                                      this field is the publish
//                                      date or similar metadata.
//
//   Detail JSON:
//     date: "2026-05-11T00:00:00Z"
//     hour: "16:30"                   ← plain HH:MM string.
//
// Both timestamps lack a real timezone offset (the `Z` is
// cosmetic — the values are local Israel time). We extract the
// literal calendar fields without any TZ math: anything else
// risks shifting events by ±2-3 hours when DST flips.
// ─────────────────────────────────────────────────────────────────

function extractDate(dateValue) {
  if (!dateValue) return null;
  const s = String(dateValue);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function extractTime(hourValue) {
  if (!hourValue) return null;
  const s = String(hourValue).trim();
  // Plain "HH:MM" (detail JSON shape).
  const plain = s.match(/^(\d{1,2}):(\d{2})/);
  if (plain) return `${plain[1].padStart(2, "0")}:${plain[2]}`;
  // ISO-ish "...T17:00:00..." (lobby JSON shape).
  const iso = s.match(/T(\d{2}):(\d{2})/);
  if (iso) return `${iso[1]}:${iso[2]}`;
  return null;
}

// ─────────────────────────────────────────────────────────────────
// Duration → minutes
//
// City detail JSON exposes a free-text `content.eventDuration` field
// in Hebrew, e.g. `"1 שעות"`, `"90 דקות"`, `"5 שעות"`. The CMS uses
// the plural form unconditionally (even for "1") so we parse purely
// by leading number + unit. `"0"` and `""` are sentinel values
// meaning "not recorded" — return null and let `end_time` stay NULL.
//
// Accepted shapes (case-insensitive, whitespace-tolerant):
//   "1 שעות"      → 60
//   "1 שעה"       → 60
//   "1.5 שעות"    → 90  (defensive — current feed only has integers)
//   "90 דקות"     → 90
//   "45 דקה"      → 45
//   "2h"          → 120 (defensive)
//   "30 min"      → 30  (defensive)
//   "0", "0 ", "" → null
//   anything else → null
// ─────────────────────────────────────────────────────────────────

function parseEventDurationMinutes(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;

  // Leading number (integer or decimal with `.` or `,`).
  const m = s.match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (!m) return null;

  const n = parseFloat(m[1].replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;

  const unit = m[2] || "";
  // Hebrew hour forms: שעה / שעות. Bare "h" / "hr" / "hours" as a
  // belt-and-braces guard for any future English-leaking field.
  if (/שע/.test(unit) || /\bh(?:r|rs|our|ours)?\b/i.test(unit)) {
    return Math.round(n * 60);
  }
  // Hebrew minute forms: דקה / דקות. Bare "m" / "min" / "minutes".
  if (/דק/.test(unit) || /\bm(?:in|ins|inute|inutes)?\b/i.test(unit)) {
    return Math.round(n);
  }
  // Unit missing or unrecognised — refuse to guess. The CMS has
  // shipped `"0 "` (number then trailing space, no unit) as the
  // "not set" sentinel; treating that as anything other than null
  // would invent fake end times.
  return null;
}

// Compose `end_time` ("HH:MM") from a start time and a duration in
// minutes. Returns null if either input is missing. Wraps modulo
// 24h for events that legitimately cross midnight — `events.end_time`
// is a time-only field (no date component), so wrap is the closest
// truthful representation we can store. (`date` still pins the start
// day; consumers reading "starts 23:00, ends 00:30" can infer the
// next-day rollover themselves.)
function computeEndTime(startTime, durationMinutes) {
  if (!startTime || !durationMinutes) return null;
  const m = String(startTime).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const startMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  if (!Number.isFinite(startMin)) return null;
  const endMin = ((startMin + durationMinutes) % (24 * 60) + 24 * 60) % (24 * 60);
  const hh = Math.floor(endMin / 60);
  const mm = endMin % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────────
// Description-based end_time fallback.
//
// Umbrella children inherit the parent's `content.eventDuration`,
// which is usually "0" (the CMS sentinel for "not set"). When that
// happens `computeEndTime` returns null and the card renders just a
// start time. But the prose description very often spells out the
// range: "יתקיים בין השעות 10:00-14:00" / "מ-19:00 עד 22:30" /
// "08:00–17:00". Parsing it gives us a useful end_time without
// guessing at durations.
//
// Match rules:
//   - We look for a pair "HH:MM<sep>HH:MM" where <sep> is hyphen,
//     en-dash, em-dash, or the Hebrew "עד".
//   - One of the two times MUST equal the row's `start_time`
//     exactly. The OTHER is then the end. This anchor is essential:
//     the city CMS routinely flips the order (a 10:00→14:00 event
//     ships as "14:00-10:00" — bytes are stored end-first, not just
//     RTL-rendered) so we can't naively call the right side the end.
//   - If neither time matches `start_time`, return null. The
//     description might be mentioning unrelated times (registration
//     window, partial schedule, last bus, …) and we'd rather show
//     no end_time than the wrong one.
//
// Returns the normalised "HH:MM" string, or null.
const TIME_RANGE_RE =
  /(\d{1,2}):(\d{2})\s*(?:[-–—]|עד)\s*(\d{1,2}):(\d{2})/g;

function normaliseHHMM(h, m) {
  const hh = String(parseInt(h, 10)).padStart(2, "0");
  return `${hh}:${m}`;
}

function extractEndTimeFromDescription(description, startTime) {
  if (typeof description !== "string" || !description.trim()) return null;
  if (typeof startTime !== "string" || !/^\d{1,2}:\d{2}$/.test(startTime)) {
    return null;
  }
  const start = normaliseHHMM(...startTime.split(":"));
  TIME_RANGE_RE.lastIndex = 0;
  let m;
  while ((m = TIME_RANGE_RE.exec(description)) !== null) {
    const a = normaliseHHMM(m[1], m[2]);
    const b = normaliseHHMM(m[3], m[4]);
    if (a === start && b !== start) return b;
    if (b === start && a !== start) return a;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────
// Image path: city media is published under
// https://www.ramat-gan.muni.il/media/<path>. Lobby/detail JSON
// returns a relative `/media/...` path on `eventBackground.link`.
//
// Storage convention: we persist the RELATIVE path (e.g.
// `/media/abcd/poster.jpg`). The render layer
// (`lib/imageUrl.js#normalizeImageUrl`) joins the right host per
// `events.source` at read time, so the bot's photo dispatcher and
// the saved-search notifier work without further tweaks. This
// matches the post-fix Smarticket storage shape — see
// `api/check.js#pickImagePath` and `api/enrich.js#extractEventData`.
// ─────────────────────────────────────────────────────────────────

function resolveImageUrl(rel) {
  if (!rel) return null;
  const s = String(rel).trim();
  if (!s) return null;
  if (s.startsWith("http://") || s.startsWith("https://")) {
    // Defensive: strip host if the upstream feed inlined one.
    try {
      return new URL(s).pathname;
    } catch {
      return null;
    }
  }
  return s.startsWith("/") ? s : `/${s}`;
}

// ─────────────────────────────────────────────────────────────────
// Tag extraction
//
// City events come pre-categorised by a human editor — that's
// strictly better than Gemini guessing. We pass two TOPIC sources
// through `labelStore.resolveMany` (deduplicates against the
// existing tag dictionary):
//
//   - cluster[].name        — explicit "themes" attached by the CMS.
//   - category.name         — the high-level bucket. Even when it
//                             doesn't map to `category_t`, it's a
//                             useful topic tag (e.g. "שבועות 2026").
//
// NOTE: `audienceType[].name` is DELIBERATELY excluded.
// The municipality's CMS lets editors tick every demographic an
// event "could appeal to". For events like the Jerusalem Day march
// the editor ticked four buckets at once: לכל המשפחה + צעירים
// (18-35) + מבוגרים (60-35) + הגיל השלישי (60+). Storing all four
// as tags produces contradictory rows ("for everyone" AND "60+
// only" simultaneously) and clutters the card's tag line with
// noise that duplicates the dedicated `audience` ENUM column.
// The `audienceType[]` payload still flows through `mapAudience`
// below — it just doesn't double as a tag. Age-range queries hit
// `min_months` / `max_months`, not tag text, so search isn't
// degraded by this exclusion.
//
// Returning the names — not the ids — keeps this module pure.
// `lib/cityApiScraper.js` does the labels-table round-trip.
// ─────────────────────────────────────────────────────────────────

// CMS "combined section headers" — labels the municipality uses as
// NAVIGATION strips that bundle multiple content kinds under one
// name (e.g. "Workshops AND Lectures", "Theater Art Music Sport").
// Storing them verbatim as tags is harmful:
//   • Substring-search false positives. User asks for "הרצאה" and
//     keyword-matches the "סדנאות והרצאות" cluster, surfacing a
//     workshop. The user reported this in May 2026: "ביקשתי הרצאה
//     וקיבלתי סדנא". Same shape for "ספורט" matching theater plays
//     filed under "תיאטרון אמנות מוזיקה וספורט".
//   • Tag-line clutter that duplicates `category_t` once the event
//     IS properly categorised.
//
// We drop these from the tag list entirely; the proper signal is
// `category` (set per event by `deriveCategoryByName` below, or by
// Gemini if/when city events get enriched).
//
// Each entry is { clusterName → nameHeuristic(name) → category|null }.
// Different clusters get different defaults because their ambiguity
// profiles differ — see per-entry comments.
//
// NOTE: regexes use `(?=\s|$)` instead of `\b` because `\b` is defined
// over [a-zA-Z0-9_] and never fires between Hebrew chars or between
// Hebrew and whitespace.
const COMBINED_NAV_DERIVERS = Object.freeze({
  // Workshops + lectures. CMS editors are very disciplined about
  // prefixing workshop titles with "סדנה" / "סדנת" — anything in
  // this section without that prefix is, in practice, a lecture or
  // info session ("פרישה באושר ובעושר", "המעבר לכיתה א'", …).
  // Defaulting the OTHER way would re-create the original false-
  // positive ("ביקשתי הרצאה וקיבלתי סדנא").
  "סדנאות והרצאות": (name) => {
    if (/^סדנ[הת](?=\s|$)/.test(name)) return "סדנה";
    if (/^הרצא[הת](?=\s|$)/.test(name)) return "הרצאה";
    return "הרצאה";
  },
  // Theater + art + music + sport. The four sub-genres are too
  // unrelated to share a default, AND the section sometimes contains
  // civic events that don't fit any of them ("צעדת יום ירושלים",
  // "שישי ישראלי" — Friday community gatherings). Match the obvious
  // signals; return NULL otherwise so the event stays in the
  // "unclassified, needs Gemini" bucket rather than locking it to
  // a wrong category.
  "תיאטרון אמנות מוזיקה וספורט": (name) => {
    if (/^סדנ[הת](?=\s|$)/.test(name)) return "סדנה";
    if (/תיאטרון|מחזה|הצגת?|מופע תיאטרון/.test(name)) return "הצגה";
    if (/מופע|הופע[הת]|קונצרט|מוזיק|שיר[יו]/.test(name)) return "הופעה";
    if (/ספורט|כדורגל|כדורסל|התעמל|שחי[יה]|יוגה|פילאטיס|אימון|ריצה/.test(name)) return "ספורט";
    return null;
  },
});

const COMBINED_NAV_CLUSTERS = new Set(Object.keys(COMBINED_NAV_DERIVERS));

// Cluster names that LOOK combined (contain " ו..." Hebrew "and") but
// are legitimate single-topic tags. Curated allowlist for the regex
// filter below — currently small because such names are rare. Add
// here when a topical tag gets dropped by accident (check logs for
// "[CityApi] dropped tag candidate").
const KNOWN_LEGITIMATE_HEBREW_AND = new Set([
  "יין וגבינות",     // wine & cheese tasting — niche but real topic
  "רובין וויליאמס",  // Robin Williams (actor) — proper name
  "גן וחומר",        // garden+material crafting workshop concept
  "הורה וילד",       // legit topical use exists too (separately filtered as audience-nav, but keep)
]);

// Hebrew audience-tier words. Used as STANDALONE labels by the
// municipality's CMS to organise its homepage navigation strips —
// they always duplicate the dedicated `audience` ENUM + age-range
// columns, so storing them as tags only clutters cards. Match exact
// strings (with optional gershayim already normalised out).
const AUDIENCE_TIER_WORDS = new Set([
  "תינוקות",
  "צעירים",
  "מבוגרים",
  "ילדים",
  "נוער",
  "הגיל הרך",
  "הגיל השלישי",
  "אזרחים ותיקים",
  "לכל המשפחה",
]);

// Strip Hebrew/Latin gershayim, normalize whitespace. Lightweight
// equivalent of labelStore.normalizeName for filter comparisons.
function _normForFilter(s) {
  return String(s || "")
    .replace(/[\u0027\u0022\u05F3\u05F4\u2018\u2019\u201C\u201D"']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Pattern-based filter for cluster/category NAMES the city CMS emits
// that should NOT become tags. Multi-tier, ordered by confidence:
//
//   Tier 1 — explicit deny-list (`COMBINED_NAV_CLUSTERS`). Short
//            combiners ("X ו-Y") we've manually verified.
//   Tier 2 — audience-nav patterns. These duplicate the audience
//            ENUM + month-range columns and produce contradictory
//            cards ("for everyone" AND "60+ only" on the same row).
//   Tier 3 — long-phrase combiner heuristic: 3+ word phrases with a
//            Hebrew "ו" prefix. Catches new section headers like
//            "תיאטרון אמנות מוזיקה וספורט" without an explicit
//            entry. Short ("Wine & Cheese") false positives are
//            covered by KNOWN_LEGITIMATE_HEBREW_AND below.
//
// Return shape:
//   null         — name is OK, keep as a tag.
//   'curated'    — Tier 1 or 2. Hand-verified that we want to drop;
//                  no operator review needed. Log only on first sight
//                  ever (operationally silent — see extractTagNames).
//   'heuristic'  — Tier 3. The regex caught a long combiner that
//                  wasn't explicitly approved. Worth logging once so
//                  the operator can promote it to Tier 1
//                  (COMBINED_NAV_CLUSTERS) with a deriver, OR
//                  whitelist it in KNOWN_LEGITIMATE_HEBREW_AND.
//
// Why two reasons:
//   Logging EVERY curated drop on bot restart spams the operator's
//   terminal with known-good signals (the 4-line "noise" we used to
//   see — "אזרחים ותיקים", "סדנאות והרצאות" etc.). Those are
//   already-handled; they need zero attention. The heuristic tier is
//   the ONE that needs human-in-loop review when it catches
//   something new.
//
// Backward-compat: callers using `if (shouldFilterClusterName(t))`
// still get truthy values for both 'curated' and 'heuristic', so the
// drop behaviour is unchanged.
function shouldFilterClusterName(name) {
  if (!name) return null;
  const s = _normForFilter(name);
  if (!s) return null;

  // Tier 1: explicit, hand-curated.
  if (COMBINED_NAV_CLUSTERS.has(s)) return "curated";

  // Tier 2a: audience-tier exact match.
  if (AUDIENCE_TIER_WORDS.has(s)) return "curated";
  // Tier 2b: "פעילויות ל..." / "פעילות ל..." — by definition
  // "Activities for [audience]" navigation.
  if (/^פעילו(?:ת|יות)\s+ל/.test(s)) return "curated";
  // Tier 2c: trailing age-range parens, e.g. "ילדים (4-11)" /
  // "הגיל השלישי (60+)" / "(0-3)".
  if (/\(\s*\d+\s*[-+]\s*\d*\s*\)\s*$/.test(s)) return "curated";
  // Tier 2d: school-grade audience descriptor ("נוער בכיתות ז'-יב'").
  if (/כיתות/.test(s)) return "curated";

  // Tier 3: long-phrase combiner. Requires BOTH a Hebrew "ו"
  // conjunction prefix AND ≥3 word total — the word count guard is
  // what protects 2-word legit topics ("יין וגבינות"). Already-
  // approved short combiners are caught in Tier 1.
  const hasHebrewAnd = /\s+ו[\u0590-\u05FF]{2,}/.test(s);
  const wordCount = s.split(/\s+/).filter(Boolean).length;
  if (hasHebrewAnd && wordCount >= 3) {
    if (KNOWN_LEGITIMATE_HEBREW_AND.has(s)) return null;
    return "heuristic";
  }
  // Tier 3b: short " ו..." that's NOT in the legit allowlist AND
  // matches an editorial-conjunction shape. We DON'T auto-drop
  // these — they need a human in the loop. The Tier-1 list
  // catches the known ones; new ones surface in extractTagNames'
  // first-seen log so the operator can decide.
  return null;
}

// Process-level dedupe for the "dropped tag candidate" log line.
//
// Without this, every event in a scrape cycle (hundreds) that
// carries a known-nav cluster like "אזרחים ותיקים" emitted its own
// log line — the operator saw the SAME message repeating in
// a flood. The dedupe was originally per-call (per-event), which
// only collapsed the lobby+detail double-hit; it didn't help across
// events.
//
// We want the log to be a "first-seen" signal: the operator sees
// each new pattern ONCE per process lifetime and can grep for it.
// Subsequent drops of the same string stay silent — the filter is
// known-working at that point.
//
// Bounded growth: capped at LOG_DEDUPE_MAX entries with FIFO
// eviction. A long-running bot can't leak memory if upstream starts
// emitting thousands of unique cluster names.
const _droppedClusterLogSeen = new Set();
const LOG_DEDUPE_MAX = 500;
function _logDroppedClusterOnce(label) {
  if (_droppedClusterLogSeen.has(label)) return;
  _droppedClusterLogSeen.add(label);
  if (_droppedClusterLogSeen.size > LOG_DEDUPE_MAX) {
    // Sets iterate insertion-order; drop the oldest entry.
    const oldest = _droppedClusterLogSeen.values().next().value;
    if (oldest !== undefined) _droppedClusterLogSeen.delete(oldest);
  }
  console.log(`[CityApi] dropped tag candidate (nav/combined): "${label}"`);
}

function extractTagNames(lobbyEntry, detailJson) {
  const out = new Set();
  const push = (s) => {
    if (typeof s !== "string") return;
    const t = s.trim();
    if (!t) return;
    const dropReason = shouldFilterClusterName(t);
    if (dropReason) {
      // Only the heuristic tier is operator-interesting: it means a
      // long combiner snuck through that we haven't manually approved
      // (promote to COMBINED_NAV_CLUSTERS) or rejected (add to
      // KNOWN_LEGITIMATE_HEBREW_AND). Curated tiers are already
      // hand-verified, so logging them on every restart is noise.
      // Console-only by design — no Sentry. Capped per-process.
      if (dropReason === "heuristic") _logDroppedClusterOnce(t);
      return;
    }
    out.add(t);
  };

  for (const c of lobbyEntry?.cluster || []) push(c?.name);
  push(lobbyEntry?.category?.name);

  // Detail JSON occasionally carries its own `cluster` array — pull
  // anything new (the homepage hides clusters when the row is in a
  // theme strip already).
  for (const c of detailJson?.content?.cluster || []) push(c?.name);

  // Audience SUBTYPE tags (May-2026 user request). The bulk of the
  // `audienceType[]` array is intentionally excluded (see the note
  // above the function — CMS editors tick every demographic the
  // event "could appeal to", producing contradictory tags), but
  // FOCUSED subtype signals are useful: a 60+ lecture deserves the
  // `גיל הזהב` tag so the bot can show it to seniors and HIDE it
  // from young adults, both filtered through the same `מבוגרים`
  // audience ENUM. We emit AT MOST one subtype tag — if the entry
  // is tagged-everyone (4+ distinct buckets) we emit none, because
  // those are family events and the subtype carries no signal.
  for (const t of extractAudienceSubtypeTags(
    lobbyEntry?.audienceType,
    // City lobby entries use `.title`, not `.name`.
    lobbyEntry?.title || "",
  )) {
    out.add(t);
  }

  // Name-based tag rules: emit additional tags when the event title signals
  // a specific topic that the city CMS doesn't expose as a structured cluster.
  // Tag names must exactly match a row in the `labels` table so that
  // labelStore.resolveMany can resolve them to IDs; unresolvable names are
  // silently dropped during that step.
  const title = lobbyEntry?.title || "";
  for (const { re, tags } of NAME_TAG_RULES) {
    if (re.test(title)) {
      for (const t of tags) out.add(t);
    }
  }

  return [...out];
}

// Return the audience SUBTYPE tags hidden in the city's
// `audienceType[]` payload — currently `גיל הזהב` (senior) and
// `צעירים` (young adult). Returns an empty array when the payload
// is missing, tagged-everyone, or focused on tiers that don't have
// a subtype distinction (kids / teens / babies).
//
// Why a separate helper from `mapAudience`:
//   - mapAudience collapses the array to a SINGLE primary audience
//     ENUM value (kids/teens/babies/adults/family).
//   - This produces auxiliary TAGS that live INSIDE the `מבוגרים`
//     audience — distinguishing senior-only / young-only events
//     from generic mid-adults content.
//
// Why not also emit a tag for the generic `מבוגרים (35-60)` bucket:
//   That's the implicit default for any `מבוגרים`-audience event,
//   not a distinguishing signal. Search defaults to "no subtype
//   filter" for mid-adults profiles, so no tag is needed.
// PARENTING_RE: event names/topics that indicate the content is for parents/
// parenting skills, NOT for young adults as a demographic. The CMS often ticks
// "צעירים (18-35)" for parenting courses because young parents attend, but
// "צעירים" as a tag implies the event targets young adults specifically (sports,
// clubs, etc.). Suppress the tag whenever the event title signals parenting.
const PARENTING_RE = /הורים|הורות|הריון|לידה|הנקה|תינוק|אמהות|אבהות|הכנה\s*ל/u;

// NAME_TAG_RULES: title-keyword → label-name mappings for topics the city CMS
// doesn't expose as structured clusters.  Tag names must match the `labels`
// table exactly; unresolvable ones are silently dropped by labelStore.resolveMany.
const NAME_TAG_RULES = [
  // Parenting / pregnancy workshops
  { re: PARENTING_RE, tags: ["הורות"] },
  // Outdoor / nature / garden / park events
  { re: /גינה|גינת|פארק|שמורת|יער|טבע|קיימות/u, tags: ["טבע"] },
];

function extractAudienceSubtypeTags(audienceTypeArray, eventName = "") {
  if (!Array.isArray(audienceTypeArray) || !audienceTypeArray.length) return [];
  const names = audienceTypeArray.map((a) => a?.name || "").filter(Boolean);
  if (!names.length) return [];
  // Subtype tags (גיל הזהב / צעירים) only make sense within the
  // `מבוגרים` audience. For kids, family, babies or teens events the
  // subtype is irrelevant — emitting "צעירים" on a children's play or
  // a family garden event is actively wrong. Guard early.
  const primaryAudience = mapAudience(audienceTypeArray);
  // Only emit subtype tags (גיל הזהב / צעירים) within the מבוגרים audience.
  // mapAudience returns Hebrew strings — "adults" was a bug; use "מבוגרים".
  if (primaryAudience !== "מבוגרים") return [];
  // Suppress "צעירים" for parenting / pregnancy / childcare courses.
  // The CMS ticks the young-adult bucket because young parents attend,
  // but the event content is about parenting skills — not young-adult life.
  if (PARENTING_RE.test(eventName)) return [];
  // Tagged-everyone safeguard #1: same threshold as `mapAudience`
  // uses for the family fallback. When the entry lists most/all
  // distinct age buckets, no subtype signal is useful — the event
  // is a family/community event.
  if (countDistinctAgeBuckets(names) >= ALL_AGES_BUCKET_THRESHOLD) return [];
  // Senior signal. Both "הגיל השלישי" (CMS canonical) and the
  // older "אזרחים ותיקים" appear in production; both map to a
  // single user-facing tag.
  const hasSenior = names.some((n) => /הגיל\s*השלישי|אזרחים\s*ותיקים/.test(n));
  // Young-adult signal. Match "צעירים" as a STANDALONE tier word —
  // the (18-35) age qualifier is optional in the CMS string. Anchor
  // to start + trailing boundary so accidental embeds inside longer
  // strings (or other words sharing the prefix) don't fire.
  const hasYoung = names.some((n) => /^צעירים(?:\s|\(|$)/.test(n));
  // Tagged-everyone safeguard #2: if BOTH ends of the adult-age
  // spectrum are ticked (senior AND young), the event is effectively
  // open to all adult tiers. Emitting both tags would cause it to be
  // dropped for BOTH young_adult AND senior users (each filters out
  // the other's tag) — exactly the wrong outcome. Emit nothing and
  // let the event flow through as plain `מבוגרים`.
  if (hasSenior && hasYoung) return [];
  const out = [];
  if (hasSenior) out.push("גיל הזהב");
  if (hasYoung) out.push("צעירים");
  return out;
}

// Extract the body description from a detail JSON response.
//
// The city CMS publishes two text fields for each event:
//
//   1. `content.description` — a short teaser (1-2 sentences), always
//      visible in the lobby listing. Often the ONLY copy the editor
//      bothers to write, but intentionally brief.
//
//   2. `components[i].content.about` (where `content.type === "eventInfo"`)
//      — the rich detail body, only visible on the individual event page.
//      Editors frequently put the actual programme here:
//        "מופע מרכזי של אודי שיגעודי / משחקי ג'לי בול / מופע רקדניות…"
//
// For tagging purposes we want BOTH. The combined text gives Gemini
// enough signal to produce meaningful tags even when `description` is
// just "הכנו לכם אירוע שבועות לכל המשפחה הכי שווה בעיר".
//
// Deduplication: if `about` starts with or contains `description`
// verbatim we skip the short teaser to avoid Gemini seeing it twice.
//
// Returns "" (not null) so callers can hash-and-store consistently.
function extractCityDescription(detailJson) {
  function stripHtml(html) {
    if (typeof html !== "string" || !html) return "";
    return html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
  }

  const teaser = stripHtml(detailJson?.content?.description);

  // Collect all `eventInfo` component `about` blobs.
  const about = (detailJson?.components || [])
    .map((c) => c?.content)
    .filter((c) => c?.type === "eventInfo" && c?.about)
    .map((c) => stripHtml(c.about))
    .filter(Boolean)
    .join(" ");

  if (!teaser && !about) return "";
  if (!teaser) return about;
  if (!about) return teaser;
  // Skip the teaser if it's already contained in the richer `about` text.
  if (about.includes(teaser)) return about;
  return `${teaser} ${about}`;
}

// Resolve an event's category when the CMS gave us a COMBINED section
// header instead of a specific category. Routes to the per-cluster
// heuristic in `COMBINED_NAV_DERIVERS`.
function deriveCategoryByName(eventName, clusterName) {
  const name = String(eventName || "").trim();
  if (!name) return null;
  const fn = COMBINED_NAV_DERIVERS[clusterName];
  return fn ? fn(name) : null;
}

// ─────────────────────────────────────────────────────────────────
// Build the events-row payload for a single city-only event.
//
// Returns the upsert payload; the caller is responsible for:
//   - resolving tag NAMES → label_ids via labelStore
//   - calling ensureLocationKey to materialise the locations row
//   - the actual supabase.from('events').upsert(...) call
//
// This split keeps cityApi.js pure-data — no DB access, no IO
// beyond the fetchers above. Easier to reason about, test, and
// replay.
// ─────────────────────────────────────────────────────────────────

function buildCityEventRow(lobbyEntry, detailJson) {
  const url = lobbyEntry.detailsLink?.url;
  const slug = extractSlug(url);
  if (!slug) {
    throw new Error(
      `buildCityEventRow: cannot extract slug from "${url}"`,
    );
  }

  const id = slugToEventId(slug);
  const date = extractDate(lobbyEntry.date) || extractDate(detailJson?.content?.date);
  const startTime = extractTime(lobbyEntry.hour) || extractTime(detailJson?.content?.hour);
  // Derive end_time from the CMS's free-text duration string
  // (`content.eventDuration`, e.g. "1 שעות" / "90 דקות"). The city
  // payload never carries an explicit end timestamp, so this is the
  // only signal we have. Falls back to null when the field is the
  // "0"/"" sentinel or carries an unrecognised unit — `end_time`
  // remains optional on the row, never invented.
  const durationMinutes = parseEventDurationMinutes(
    detailJson?.content?.eventDuration,
  );
  // Two-tier end_time resolution: structured duration field first
  // (`computeEndTime` above), prose description as a fallback when
  // the CMS shipped the "0"/"" sentinel for eventDuration. Most
  // umbrella children (where eventDuration is inherited from the
  // parent and the parent is "0") and a handful of singles rely on
  // the description fallback to surface a closing time at all.
  const descriptionText = extractCityDescription(detailJson);
  const endTime =
    computeEndTime(startTime, durationMinutes) ||
    extractEndTimeFromDescription(descriptionText, startTime);

  // Sold-out signal: lobby `eventTag` carries `{ text: "אזלו הכרטיסים" }`
  // for events the CMS has marked exhausted. There's no ticket count
  // on city events (they're free / unmetered), so `tickets_left`
  // stays NULL ("don't know / not applicable") rather than 0 to
  // avoid waking up the back-in-stock notifier on what's actually
  // a status flag.
  const isSoldOut = /אזלו|sold[\s\-]?out/i.test(
    lobbyEntry.eventTag?.text || "",
  );

  // Image priority: detail JSON's `media.link` is identical to the
  // lobby's `eventBackground.link` in every sample we've seen, but
  // detail wins on the rare cases the lobby is stale. We store the
  // HI-RES desktop variant (`link`, ~1540×803) so Telegram's
  // server-side thumbnailer has the best source to downscale from
  // per client device. `linkMobile` (~390×576) is kept ONLY as a
  // last-resort fallback for the rare payload that ships a mobile
  // crop without the desktop variant — using it as the primary
  // would force desktop clients to render a tiny pixelated thumb.
  const imagePath =
    detailJson?.content?.media?.link ||
    lobbyEntry.eventBackground?.link ||
    detailJson?.content?.media?.linkMobile ||
    lobbyEntry.eventBackground?.linkMobile;

  // Location: closeEvents/categorised entries carry a structured
  // `eventLocation: { name, address }`. Slider-only entries don't
  // — they have a flat `location` string. Detail JSON also exposes
  // `content.location: { name, address }` consistently, so prefer
  // detail then fall back to lobby variants.
  const detailLoc = detailJson?.content?.location || null;
  const lobbyLoc = lobbyEntry.eventLocation || null;
  const venueName = detailLoc?.name || lobbyLoc?.name || lobbyEntry.location || null;
  const venueAddress = detailLoc?.address || lobbyLoc?.address || "";
  // Compose the human-readable address string we'll feed into
  // ensureLocationKey. When the venue name itself is a placeholder
  // (e.g. "רחבי העיר", "כלל העיר") we set rawAddress to null so the
  // event gets no location_key rather than being geocoded to city-hall.
  const rawAddress = isPlaceholderAddress(venueName)
    ? null
    : venueAddress
      ? `${venueName}, ${venueAddress}`
      : venueName;

  const eventName = lobbyEntry.title || detailJson?.content?.title || slug;
  const audience = mapAudience(lobbyEntry.audienceType);
  // Pass `eventName` so `mapCategory` can fall back to a name-based
  // heuristic when the CMS hands us a COMBINED section header like
  // "סדנאות והרצאות" — see deriveCategoryByName.
  const category = mapCategory(lobbyEntry.category?.name, eventName);
  const access = mapAccess(lobbyEntry, detailJson);

  // Single-event registration / join URL. Smarticket candidates were
  // already filtered out by classifyDetail. For anything remaining:
  //   - Zoom/Meet/Teams links → `online_url` (separate "הצטרף" button)
  //   - Other booking providers (paykal, bina, …) → `external_url`
  //     which sends the user to the registration page instead of city page.
  const rawLink =
    typeof detailJson?.content?.registerLink === "string"
      ? detailJson.content.registerLink.trim()
      : null;
  const externalUrl = rawLink && !isOnlineJoinLink(rawLink) ? rawLink : null;
  const onlineUrl   = rawLink && isOnlineJoinLink(rawLink)  ? rawLink : null;

  return {
    // Core identity — the upsert key is `(source, external_slug)`,
    // not `id`, so a hash collision would be REJECTED by the
    // partial UNIQUE index in sql/038 instead of stomping a row.
    id,
    source: "rg-muni",
    external_slug: slug,
    external_url: externalUrl,
    online_url: onlineUrl,
    name: eventName,
    date,
    start_time: startTime,
    end_time: endTime,
    // Free-event semantics: NULL tickets_left, sold-out comes from
    // the eventTag flag only. The notifier already treats NULL
    // defensively; saved-search match still works (only the
    // back-in-stock detector cares about counts).
    tickets_left: null,
    is_sold_out: isSoldOut,
    archived: false,
    audience,
    category,
    // Access scope (sql/039). 'open' for most rows; community
    // values for events restricted to specific populations.
    // Downstream matchers filter on `access = 'open'` by default.
    access,
    image: resolveImageUrl(imagePath),
    // Persist the prose description ONLY when this event has no
    // external registration link (sql/053). The rule is "store the
    // small city blurb only when it's the ONLY info source we have
    // for the user":
    //   - external_url present (paykal / bina / etc.) → the user's
    //     "פרטים" button takes them off-site to the registration
    //     provider where the real description lives. Storing the
    //     short city blurb on top would be redundant DB weight
    //     (that's why sql/043 dropped this column originally).
    //   - external_url absent → the user has nowhere else to go;
    //     the small city blurb is all we have. Persist so we can
    //     surface it on demand AND feed it to the enricher without
    //     a re-fetch round-trip.
    // Side-effect on enrichment: when external_url is present we
    // skip storing → the enricher's refetch fallback path runs
    // (it can still refetch singles by their real slug). Trade-off
    // is acceptable since smarticket/paykal/bina pages are the
    // canonical source of truth for those events.
    description: externalUrl ? null : (descriptionText || null),
    // The caller will populate `location_key` via ensureLocationKey
    // and `tag_ids` via labelStore.resolveMany — both are async and
    // belong outside this pure helper.
    _rawAddress: rawAddress,
    _tagNames: extractTagNames(lobbyEntry, detailJson),
  };
}

// ─────────────────────────────────────────────────────────────────
// Build a row for ONE child session of a multi-session umbrella.
//
// Used together with `extractCitySchedule`: when the city detail
// payload carries N city-only schedule entries, we fan out into
// N event rows that all share the parent's title. Each child gets
// its own deterministic external_slug and id so re-running the
// scraper is idempotent (no row duplication, no row drift).
//
// Slug shape: `<parentSlug>__<YYYY-MM-DD>__<locationObjectId>__<HHMM>`
//   - Date and hour come from the child (per-session); falling back
//     to "nodate" / "nohour" only on malformed inputs (shouldn't
//     happen in practice — the city CMS validates).
//   - `location.objectId` is the venue's stable integer ID. Using
//     it (instead of `location.id`, the per-session UUID) means two
//     sessions at the same venue on the same day collide on slug —
//     which is what we want, since they ARE the same session.
//   - The hour suffix lets a venue host multiple sessions on the
//     same day (morning + evening) without collision. Across the
//     active-garden-2026 sample (11 sessions) this didn't happen,
//     but a friendlier ingest tolerates it.
//
// Inheritance:
//   The child inherits the parent's title, audience, category,
//   access, image, sold-out flag, and tag set. Per-child date /
//   hour / location overrides.
// ─────────────────────────────────────────────────────────────────
function buildCityChildEventRow(lobbyEntry, detailJson, child, umbrellaId = null) {
  const parentUrl = lobbyEntry.detailsLink?.url;
  const parentSlug = extractSlug(parentUrl);
  if (!parentSlug) {
    throw new Error(
      `buildCityChildEventRow: cannot extract parent slug from "${parentUrl}"`,
    );
  }

  const childDate =
    extractDate(child?.date) ||
    extractDate(lobbyEntry.date) ||
    extractDate(detailJson?.content?.date);
  const childHour =
    extractTime(child?.hour) ||
    extractTime(lobbyEntry.hour) ||
    extractTime(detailJson?.content?.hour);
  // Children inherit the umbrella's duration string. The schedule[]
  // entries surveyed across the live feed (active-garden-2026,
  // shavuot-2026, 2026-zoom-story-time) never carry a per-child
  // duration field, so the parent's `content.eventDuration` is the
  // only signal. When the parent is "0"/"" (most umbrellas), end_time
  // stays NULL on every child — same as before this change.
  const childDurationMinutes = parseEventDurationMinutes(
    detailJson?.content?.eventDuration,
  );
  // Per-child blurb (sql/053 path) is the closest thing we have to
  // a per-session description — the umbrella's structured duration
  // is usually "0" (sentinel) and the schedule[] entries don't
  // carry their own duration field. Falling back to the prose lets
  // us recover ranges spelled out as "בין השעות 10:00-14:00" /
  // "08:00-17:00" inside the eventInfo text.
  const childDescriptionText =
    typeof child?.eventInfo === "string" && child.eventInfo.trim()
      ? child.eventInfo.trim()
      : "";
  const childEndTime =
    computeEndTime(childHour, childDurationMinutes) ||
    extractEndTimeFromDescription(childDescriptionText, childHour);

  // Build a child-unique slug. Keys: date + venue-objectId + hour.
  // Stable across array reorderings (no positional index).
  const childLocObjectId = child?.location?.objectId ?? "noid";
  const hourTag = childHour ? childHour.replace(":", "") : "nohour";
  const childSlug = `${parentSlug}__${childDate || "nodate"}__${childLocObjectId}__${hourTag}`;
  const childId = slugToEventId(childSlug);

  // Name resolution — two cases (sql/056 cleanup):
  //
  //   1. Child has its OWN non-empty title that DIFFERS from the
  //      parent → `name` is the bare child title and `umbrella_title`
  //      carries the parent. Example ("שישי ישראלי" umbrella with
  //      venue-specific occurrences): parent="שישי ישראלי",
  //      child="גינת זהירות" → name="גינת זהירות",
  //      umbrella_title="שישי ישראלי". The card renderer turns the
  //      umbrella + name pair into a two-tier title block.
  //
  //   2. Child has the SAME title as the parent — or no title at all
  //      (active-garden-style umbrellas where the parent title IS the
  //      recurring activity). `name` falls back to the parent title;
  //      `umbrella_title` still points at the parent. With name ==
  //      umbrella_title the renderer skips the secondary line and
  //      shows the title once.
  //
  // The previous chained form ("<parent> - <child>") was dropped
  // along with the `child_title` column (see sql/056) — it created
  // duplicate parent prefixes in every label and search hit.
  const parentTitle =
    lobbyEntry.title || detailJson?.content?.title || parentSlug;
  const rawChildTitle =
    typeof child?.title === "string" ? child.title.trim() : "";
  const childTitleOnly =
    rawChildTitle && rawChildTitle !== parentTitle ? rawChildTitle : null;
  const eventName = childTitleOnly || parentTitle;

  // Sold-out flag lives at the parent level in the city payload.
  const isSoldOut = /אזלו|sold[\s\-]?out/i.test(
    lobbyEntry.eventTag?.text || "",
  );

  // Image: parent's (children don't carry their own). Same priority
  // chain as singles (see buildCityEventRow comment): hi-res `link`
  // first across both detail+lobby, then mobile crop as last resort.
  const imagePath =
    detailJson?.content?.media?.link ||
    lobbyEntry.eventBackground?.link ||
    detailJson?.content?.media?.linkMobile ||
    lobbyEntry.eventBackground?.linkMobile;

  // Location: child-specific. The child's `location.name` /
  // `location.address` is more specific than the parent's
  // "רחבי העיר" placeholder. If the child also has a placeholder
  // venue (or no venue at all), rawAddress stays null so we don't
  // geocode "רחבי העיר" to city-hall.
  const venueName =
    child?.location?.name || lobbyEntry.eventLocation?.name || null;
  const venueAddress = child?.location?.address || "";
  const rawAddress = isPlaceholderAddress(venueName)
    ? null
    : venueAddress
      ? `${venueName}, ${venueAddress}`
      : venueName;

  // Classification: inherits from the parent payload. The lobby
  // entry carries the audience/category/access signals — child
  // sessions of the same umbrella share them by definition. The
  // effective event name (parent title for active-garden-style,
  // child title for shavuot-style) goes to `mapCategory` so the
  // combined-section heuristic (deriveCategoryByName) can resolve
  // workshop vs lecture against the most specific text we have.
  //
  // For `mapAccess` we pass the child's OWN venue. The parent's
  // venueName is unreliable for umbrellas — the city CMS often
  // sets the umbrella's `eventLocation` to a marketing-anchor
  // venue (e.g. shavuot-2026.eventLocation = "המרכז הגאה") even
  // though every child runs at a different community centre.
  // Inheriting the parent's venue would mis-classify all children
  // as community-LGBTQ.
  const audience = mapAudience(lobbyEntry.audienceType);
  const category = mapCategory(lobbyEntry.category?.name, eventName);
  const access = mapAccess(lobbyEntry, detailJson, {
    venueName: child?.location?.name || null,
  });

  // Per-child registration URL. When the city schedule entry
  // points at a non-Smarticket third-party booking provider
  // (paykal.co.il, bina.org.il, …) we surface that URL as the
  // event's booking link via getBookingUrl. NULL falls back to
  // the parent city slug page — the historical default.
  //
  // Smarticket-linked schedule entries never reach this code path
  // (extractCitySchedule filters them upstream — they get their
  // own row via the Smarticket scraper), so we don't need to
  // guard against that case here.
  const rawChildLink =
    typeof child?.registerLink === "string" ? child.registerLink.trim() : null;
  const externalUrl =
    rawChildLink && !isOnlineJoinLink(rawChildLink) ? rawChildLink : null;
  const onlineUrl =
    rawChildLink && isOnlineJoinLink(rawChildLink)  ? rawChildLink : null;

  return {
    id: childId,
    source: "rg-muni",
    external_slug: childSlug,
    external_url: externalUrl,
    online_url: onlineUrl,
    // Track the umbrella relationship. We carry three columns
    // during the Phase 2 transition (sql/058):
    //
    //   - `umbrella_id`   — the canonical FK to `umbrellas(id)`.
    //                       Stamped by the scraper after a successful
    //                       `upsertUmbrellaRow` call. NULL when the
    //                       umbrella upsert failed this cycle; the
    //                       legacy text-join below still works in
    //                       that case until the next scrape repairs
    //                       the link.
    //   - `umbrella_slug` — legacy text join (sql/054), still
    //                       populated for the umb:<slug> bot
    //                       callback and for backward compat with
    //                       any pre-Phase-2 read paths.
    //   - `umbrella_title` — denormalised display string, kept
    //                       until Phase 3 swaps every read to JOIN.
    umbrella_id: umbrellaId,
    umbrella_slug: parentSlug,
    umbrella_title: parentTitle,
    name: eventName,
    date: childDate,
    start_time: childHour,
    end_time: childEndTime,
    tickets_left: null,
    is_sold_out: isSoldOut,
    archived: false,
    audience,
    category,
    access,
    image: resolveImageUrl(imagePath),
    // Child-specific description (sql/053), gated by external_url —
    // same rule as singles (see buildCityEventRow comment): persist
    // ONLY when the child has no external registration link.
    //
    //   - external_url present (paykal / bina / smarticket child) →
    //     the user's "פרטים" button leads to the third-party
    //     registration site where the real description lives. We
    //     don't need to store the short city `eventInfo` blurb.
    //     Trade-off: enrichment for these children falls back to
    //     title-only (their synthetic slug can't be refetched, so
    //     the refetch path returns no useful prose). For shavuot-
    //     style umbrellas this is acceptable — the chained title
    //     "שבועות ברמת גן - <child>" carries enough signal for
    //     Gemini to produce reasonable tags from the title alone.
    //
    //   - external_url absent → the small city blurb is the ONLY
    //     info the user gets in the bot. Persist so the enricher
    //     produces full tags AND so we can surface the prose on
    //     demand. This is the case the May-2026 user report was
    //     about ("מופע תיאטרון בובות 'טיול בישראל'" had registerLink
    //     null, so its description "לכל המשפחה ... סדנת יצירה ..."
    //     never made it to Gemini and the event got only the
    //     parent-inherited "שבועות 2026" tag).
    description: externalUrl ? null : (childDescriptionText || null),
    _rawAddress: rawAddress,
    _tagNames: extractTagNames(lobbyEntry, detailJson),
  };
}

module.exports = {
  // Endpoints (exposed for testing / inspection)
  LOBBY_URL,
  DETAIL_URL_BASE,
  // Mappings
  SOURCE_BY_CITY_ID,
  SOURCE_BY_URL_PREFIX,
  CITY_CATEGORY_MAP,
  // Fetchers
  fetchLobby,
  fetchEventDetail,
  // Lobby walking
  collectLobbyEvents,
  // Layer 1
  extractSlug,
  parseSmarticketUrl,
  classifyLobbyEvent,
  // Layer 2
  looksLikeSmarticketLink,
  detailHasSmarticketFootprint,
  classifyDetail,
  extractCitySchedule,
  // Row builder + helpers
  slugToEventId,
  mapAudience,
  mapCategory,
  mapAccess,
  // Re-exported from `lib/access.js` (the new home for shared
  // access rules). Kept on the `cityApi` surface so consumers /
  // test suites that imported them from here continue to work
  // after the May-2026 refactor.
  classifyAccessFromText,
  ACCESS_RULES,
  extractDate,
  extractTime,
  parseEventDurationMinutes,
  computeEndTime,
  extractEndTimeFromDescription,
  resolveImageUrl,
  extractTagNames,
  extractAudienceSubtypeTags,
  extractCityDescription,
  shouldFilterClusterName,
  buildCityEventRow,
  buildCityChildEventRow,
  // Internals re-exported for the scraper's umbrella upsert
  // (sql/058 — Phase 2). The scraper builds an `umbrellas` row from
  // the same parent payload + detail JSON the children use, and
  // needs the slug extractor + image URL resolver to construct
  // identical values.
  extractSlug,
};
