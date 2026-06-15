const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");
const { createClient } = require("@supabase/supabase-js");
const { todayISO, todayHumanEN, isAdminEntry, isEventInPast, currentTimeHHMM } = require("../lib/timeContext");
const {
  formatHebrewDate,
  formatTimeRange,
  formatAudienceLine,
  getEventIcon,
  rtlLine,
} = require("../lib/eventFormat");
const { formatTicketsLine } = require("../lib/eventCard");
const labelStore = require("../lib/labelStore");
const { normalizeImageUrl } = require("../lib/imageUrl");
const { getBookingUrl } = require("../lib/sourceUrls");
const { displayLocationText } = require("../lib/locationStore");

const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MATCH_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    matches: {
      type: SchemaType.ARRAY,
      description: "Events that match the user's profile, ordered by relevance",
      items: {
        type: SchemaType.OBJECT,
        properties: {
          event_id: { type: SchemaType.INTEGER, description: "The event ID" },
          event_name: { type: SchemaType.STRING, description: "The event name" },
          confidence: {
            type: SchemaType.STRING,
            description: "Match confidence: high, medium, or low",
          },
          reason: {
            type: SchemaType.STRING,
            description:
              "Hebrew, max ~6 words. Ex: 'מתאים לתום בן 1', 'משחקייה כמו שחיפשת'. " +
              "Be terse — the user just wants to know WHY this event was returned, " +
              "not a full explanation.",
          },
        },
        required: ["event_id", "event_name", "confidence", "reason"],
      },
    },
  },
  required: ["matches"],
};

function buildSystemPrompt() {
  return `You match family events for an Israeli Telegram bot. Today=${todayISO()} (${todayHumanEN()}), now=${currentTimeHHMM()} Asia/Jerusalem. Hebrew week Sun→Sat.

Inputs per event: { id, name, date, kind?, in_watch_list?, tags? }. Use the event NAME, the optional \`tags\` array (curated Hebrew topic labels), and your Hebrew/Israeli cultural knowledge to judge. Candidates are pre-filtered for date and past-time.

Apply ALL:
1. **Age — HARD FILTER**. Hebrew names often state ranges ("לידה עד גיל שנה", "לגילאי 4-6", "מגיל 3", "גילאי שנה עד שלוש"). Effective range = user's CURRENT QUERY age range if any (overrides profile ages); otherwise each child's current age. An event matches only if ranges OVERLAP — boundary touches DON'T count ("לידה עד גיל שנה" does NOT match query "שנה עד שלוש"). If name has no age but topic fits, allow.
2. **Specific name first**: if user asked for a specific show ("לרגעים","מטילדה"), candidates whose name contains/relates to it rank highest.
3. **Semantic bridging**: "משחקייה"≈"ר״געים"/"פעילון"; "סדנה"≈"יצירה"/"DIY"; "הצגה"≈"מופע"/"תיאטרון". No literal substring required. Use \`tags\` as a stronger signal than the title — an event tagged "מוזיקה" is a music event even if the title doesn't say so.
4. **Interests + tags**: prefer events whose \`tags\` overlap profile.user_context.interests. Tag overlap is the strongest interest signal we have — rank tag-matching events ABOVE same-topic events that lack the tag. Respect interest exclusions.
5. **Activity TYPE is HARD**: סיור≠סדנה≠הצגה≠סרט≠ספורט≠משחקייה. The shared topic word ("עששיות","חנוכה") is NOT enough. Don't substitute one type for another.

REASON FIELD (Hebrew, short, truthful):
- NEVER mention "watchlist"/"רשימת המעקב"/"מעקב" unless event_id is in the watched_event_ids list. If that list is empty, do not use those words at all.
- Real watchlist hit: "באירוע שביקשת לעקוב אחריו". Otherwise phrase by interests/ages/topical match.

Filter out: administrative records ("השלמת תשלום"); past events; events clearly outside the kids' ages.

Output:
- Only "high" or "medium" confidence. Drop "low".
- NEVER pad. If only N events truly satisfy the user's filters, return exactly N (even 0/1/2). No minimum count. Adding marginal matches to look helpful is a HARD VIOLATION.
- "reason" in Hebrew. Empty matches array if nothing fits. Never invent events.`;
}

// ─── Activity-type guard ───
//
// Gemini occasionally bridges semantically-related-but-categorically-distinct
// activities (a "סיור עששיות" search returning "סדנת עששיות" results because
// they share the noun "עששיות"). The system prompt forbids this, but we
// double-check deterministically here so a single Gemini slip doesn't ship
// to the user.
//
// Each "type" is a list of Hebrew surface forms (with common prefixes /
// construct-state suffixes). Mutually exclusive — if the user asked for one
// type and the event clearly belongs to another, drop it.
const ACTIVITY_TYPES = {
  tour:      ["סיור", "סיורים", "סיורי"],
  workshop:  ["סדנה", "סדנת", "סדנאות", "סדנאת"],
  show:      ["הצגה", "הצגת", "הצגות", "מופע", "מופעי", "מופעים"],
  movie:     ["סרט", "סרטון", "סרטי", "סרטים"],
  playspace: ["משחקייה", "משחקיית", "משחקיות"],
  sport:     ["ספורט"],
};

function detectActivityTypes(text) {
  const lower = (text || "").toLowerCase();
  if (!lower) return [];
  const out = [];
  for (const [type, words] of Object.entries(ACTIVITY_TYPES)) {
    if (words.some((w) => lower.includes(w))) out.push(type);
  }
  return out;
}

/**
 * If the user explicitly requested a specific activity type ("סיור עששיות"),
 * the candidate must share AT LEAST ONE of the requested types — and must
 * not belong solely to a different type. Events whose name doesn't reveal
 * any type (e.g. "פעילות עששיות") are allowed through.
 */
function activityTypeMatches(eventName, requestedTypes) {
  if (!requestedTypes.length) return true;
  const eventTypes = detectActivityTypes(eventName);
  if (!eventTypes.length) return true;
  return eventTypes.some((t) => requestedTypes.includes(t));
}

// Phrases include any leading preposition (ל/ב/של/מ) and bridging connector
// so the scrubbed string doesn't end up with a dangling "מתאים ל".
const WATCHLIST_PHRASES = [
  /(?:[-–—,]\s*)?[בלמש]?(?:של\s*)?(?:רשימת\s*המעקב(?:\s*שלך)?|מעקב\s*שלך)\s*/g,
  /(?:[-–—,]\s*)?\b(?:in\s+)?your\s+watch\s*list\b\s*/gi,
  /(?:[-–—,]\s*)?\bwatch\s*list\b/gi,
  /(?:[-–—,]\s*)?\bwatchlist\b/gi,
];

function scrubWatchlistMention(reason, eventId, watchedSet) {
  if (!reason) return reason;
  if (watchedSet.has(eventId)) return reason; // legitimate mention
  let cleaned = reason;
  for (const re of WATCHLIST_PHRASES) cleaned = cleaned.replace(re, " ");
  // Trim dangling Hebrew prepositions left at the end ("מתאים ל" → "מתאים").
  cleaned = cleaned
    .replace(/\s+(?:ל|ב|של|מ)\s*([.,;:!?\)\]]|$)/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.;:•\-—]+|[\s,.;:•\-—]+$/g, "")
    .trim();
  return cleaned.length >= 3 ? cleaned : "התאמה לפרופיל";
}

async function getActiveProfiles() {
  const { data, error } = await supabase
    .from("profiles")
    .select("telegram_id, first_name, user_context, active_watch_list")
    .not("user_context", "eq", "{}");

  if (error) throw new Error(`Profiles fetch failed: ${error.message}`);

  const withWatchList = await supabase
    .from("profiles")
    .select("telegram_id, first_name, user_context, active_watch_list")
    .not("active_watch_list", "eq", "[]");

  if (withWatchList.error)
    throw new Error(`Watch list fetch failed: ${withWatchList.error.message}`);

  const merged = new Map();
  for (const p of [...(data || []), ...(withWatchList.data || [])]) {
    merged.set(p.telegram_id, p);
  }
  return Array.from(merged.values());
}

// The venue text + coords come from the JOINed `locations` row. After
// flattening, downstream code consumes `event.location` (text), `_coords`,
// `_locationFound` and `_locationKind` exactly as if the venue lived on the
// events row.
// Optional columns gated on whether the corresponding migration has been
// applied yet. Without this guard, deploying matching code that references
// a not-yet-applied column blows up every search the moment the bot
// starts. We probe once on the first query and cache the result for the
// life of the process; restart after applying a migration to pick it up.
const OPTIONAL_COLS = [
  { col: "min_months", migration: "sql/026_normalized_labels.sql" },
  { col: "max_months", migration: "sql/026_normalized_labels.sql" },
  { col: "audience",   migration: "sql/032_audience_category_enums.sql" },
  { col: "category",   migration: "sql/032_audience_category_enums.sql" },
  { col: "tag_ids",    migration: "sql/026_normalized_labels.sql" },
  // `access` is community scope (sql/039). When absent, the
  // `.eq("access", "open")` filter below silently drops to a
  // no-op — the matcher behaves exactly like before sql/039,
  // returning every event regardless of community scope.
  { col: "access",     migration: "sql/039_events_access.sql" },
  // Per-event blurb (sql/053). Populated only for city singles +
  // umbrella children without an external_url; absent on smarticket
  // and on city events that route to a third-party registration page.
  // The consolidated newsletter renderer reads this when present so
  // a digest entry can carry a sentence of context.
  { col: "description", migration: "sql/053_events_description.sql" },
  // Typed lossless age range (sql/077). When present, the card shows its
  // original wording ("זחילה עד שלוש"); absent → falls back to min/max_months.
  { col: "age_range", migration: "sql/077_events_age_jsonb.sql" },
  // Developmental-stage targeting (sql/082). Matched against profile kid stages.
  { col: "dev_targets", migration: "sql/084_events_dev_targets.sql" },
  // LLM-chosen content emoji (sql/083). Drives the card icon (getEventIcon).
  { col: "emoji", migration: "sql/083_events_emoji.sql" },
];
let _availableColsCache = null;

async function getAvailableExtraCols() {
  if (_availableColsCache) return _availableColsCache;
  const present = [];
  for (const { col, migration } of OPTIONAL_COLS) {
    const { error } = await supabase.from("events").select(col).limit(1);
    if (!error) {
      present.push(col);
    } else if (error.code === "42703" || /column .* does not exist/i.test(error.message || "")) {
      console.warn(
        `[Matching] events.${col} column missing — feature degraded. Apply ${migration} via Supabase SQL Editor and restart.`,
      );
    } else {
      console.warn(`[Matching] probe for events.${col} failed: ${error.message}`);
    }
  }
  _availableColsCache = present;
  return present;
}

// `source` is required so render paths (image base, booking URL) pick the
// right tenant for each row. Pre-sql/034 rows lack it; the DB DEFAULT
// 'mbe-rg' covers them, but we still SELECT it explicitly so the helper
// layer doesn't have to guess.
//
// `external_slug` (sql/038) is the slug-based identity for the city
// municipal source ('rg-muni'). Smarticket rows leave it NULL. Including
// it here is what lets `getBookingUrl({source: 'rg-muni', external_slug})`
// produce a working https://www.ramat-gan.muni.il/events/<slug>/ URL —
// without it, getBookingUrl throws ("requires event.external_slug") and
// every render of a city event card fails.
const BASE_COLS =
  "id, source, external_slug, external_url, online_url, umbrella_slug, umbrella_title, umbrella_id, name, date, start_time, end_time, image, tickets_left, location_key";
const LOCATION_JOIN =
  "locations:location_key(raw_address, lat, lng, found, kind)";
// Series-parent umbrella (sql/086): recurring same-name series store their
// shared description ONCE on the umbrella row; children carry umbrella_id
// (but NOT umbrella_slug — see sql/086 UI-safety note) and inherit the prose
// when their own `description` is NULL. Embedded so flattenEvent can resolve
// the fallback without a second round-trip. NULL for non-series rows.
const UMBRELLA_JOIN =
  "umbrella_parent:umbrella_id(description, title, image_url)";

async function buildSelect() {
  const extras = await getAvailableExtraCols();
  return [BASE_COLS, ...extras, LOCATION_JOIN, UMBRELLA_JOIN].join(", ");
}

function flattenEvent(row) {
  if (!row) return row;
  const loc = row.locations || null;
  const coords =
    loc && loc.lat != null && loc.lng != null
      ? { lat: loc.lat, lng: loc.lng }
      : null;
  return {
    id: row.id,
    // Preserve `source` and `external_slug` through the flatten step
    // so downstream `getBookingUrl(event)` calls have what they need
    // for both Smarticket tenants AND the city-muni source. Dropping
    // these caused city URLs to throw and Smarticket URLs to silently
    // fall back to the mbe-rg default.
    source: row.source || null,
    external_slug: row.external_slug || null,
    // City events with a third-party registration URL (sql/052)
    // surface that URL in their "🔗 פרטים" button instead of the
    // generic city slug page. NULL on Smarticket rows and on
    // city rows without a captured registerLink.
    external_url: row.external_url || null,
    // Umbrella relationship (sql/054). When set, the card renders a
    // "📋 כל אירועי <umbrella_title>" button INSTEAD of the regular
    // "כל המופעים" series button — these children are siblings of an
    // umbrella, not occurrences of the same recurring show.
    umbrella_slug: row.umbrella_slug || null,
    umbrella_title: row.umbrella_title || null,
    umbrella_id: row.umbrella_id ?? null,
    // Per-event blurb (sql/053). Optional column — pass it through
    // when populated so the consolidated newsletter and umb: handler
    // can surface a one-line context tail without re-fetching.
    // Series-parent fallback (sql/086): a recurring occurrence whose own
    // description was NULLed inherits the shared prose from its umbrella.
    description: row.description || row.umbrella_parent?.description || null,
    name: row.name,
    date: row.date,
    start_time: row.start_time,
    end_time: row.end_time,
    image: row.image,
    tickets_left: row.tickets_left,
    location_key: row.location_key,
    location: displayLocationText(loc),
    // sql/032: audience & category are native ENUM columns (Hebrew
    // strings on the row). Tags still go through the `labels` dict
    // via tag_ids — `expandLabels` resolves those names below.
    min_months: row.min_months ?? null,
    max_months: row.max_months ?? null,
    audience: row.audience || null,
    category: row.category || null,
    tag_ids: row.tag_ids || [],
    access: row.access ?? null,
    age_range: row.age_range ?? null,
    dev_targets: row.dev_targets ?? [],
    emoji: row.emoji ?? null,
    _coords: coords,
    _locationFound: loc?.found ?? null,
    _locationKind: loc?.kind || (row.location_key ? "unknown" : null),
  };
}

// Bulk-attach Hebrew tag names to a list of flattened events. After
// sql/032 audience/category are already strings on each event row —
// only tag_ids need dict expansion. Done in one round-trip across
// every referenced tag id, then each event is mutated in place to add
// `tags: [...names]` alongside its existing `audience` / `category`
// strings.
async function expandLabels(events) {
  if (!events?.length) return events;
  const tagIds = new Set();
  for (const e of events) {
    for (const id of e.tag_ids || []) tagIds.add(id);
  }
  const dict = await labelStore.fetchLabelDict([...tagIds]);
  for (const e of events) {
    const expanded = labelStore.expandWithDict(e, dict);
    e.tags = expanded.tags;
    // expandWithDict also returns audience/category passthrough; we
    // don't reassign them because flattenEvent already put the
    // canonical strings on the event.
  }
  return events;
}

/**
 * Apply the user's physical-vs-virtual format preference.
 *
 *   format = 'physical' → keep events whose venue is physical OR unknown
 *                         (we don't want to silently drop unclassified
 *                         venues, only known-virtual ones).
 *   format = 'virtual'  → keep ONLY explicitly virtual venues.
 *   format = 'any' / null → no filter.
 */
function applyFormatFilter(events, format) {
  if (!format || format === "any") return events;
  if (format === "physical") {
    return events.filter((e) => e._locationKind !== "virtual");
  }
  if (format === "virtual") {
    return events.filter((e) => e._locationKind === "virtual");
  }
  return events;
}

// Community-scope guard. We want to restrict to `access IN (...)` on
// search queries — but only once sql/039 has been applied (otherwise
// the column doesn't exist and the query fails). The OPTIONAL_COLS
// probe above tells us which extras are present.
//
// `scopes` is the list of access values the current user is allowed
// to see — at minimum ['open']. Pass additional community values
// (e.g. ['open', 'community-disabilities']) when the user is a
// member of that community via profile.user_context.communities.
//
// events.access is now access_t[] (sql/060). An event is visible
// when ANY element of events.access appears in `scopes`, i.e. the
// two arrays OVERLAP. PostgREST maps `.overlaps(col, arr)` to the
// Postgres `&&` operator which is supported by the GIN index
// idx_events_access_gin — as efficient as the old btree eq/in.
function withAccessFilter(query, extraCols, scopes) {
  if (!extraCols.includes("access")) return query;
  const list = Array.isArray(scopes) && scopes.length ? scopes : ["open"];
  return query.overlaps("access", list);
}

// ENUM values the app may reference before a migration lands (e.g.
// community-olim in sql/069). Probed once per process; dropped from
// accessScopes so `.overlaps('access', …)` never kills the whole query.
const ACCESS_SCOPES_TO_PROBE = ["community-olim"];
let _unsupportedAccessScopes = null;

async function getUnsupportedAccessScopes() {
  if (_unsupportedAccessScopes) return _unsupportedAccessScopes;
  const extras = await getAvailableExtraCols();
  if (!extras.includes("access")) {
    _unsupportedAccessScopes = new Set();
    return _unsupportedAccessScopes;
  }
  const unsupported = new Set();
  for (const scope of ACCESS_SCOPES_TO_PROBE) {
    const { error } = await supabase
      .from("events")
      .select("id")
      .overlaps("access", [scope])
      .limit(1);
    if (error && /invalid input value for enum/i.test(error.message || "")) {
      unsupported.add(scope);
      console.warn(
        `[Matching] access scope "${scope}" missing from DB enum — ` +
          "apply sql/069_access_olim.sql via Supabase SQL Editor and restart the bot.",
      );
    }
  }
  _unsupportedAccessScopes = unsupported;
  return _unsupportedAccessScopes;
}

async function sanitizeAccessScopes(scopes) {
  const list = Array.isArray(scopes) && scopes.length ? [...scopes] : ["open"];
  const drop = await getUnsupportedAccessScopes();
  if (!drop.size) return list;
  return list.filter((s) => !drop.has(s));
}

async function getAvailableEvents({ accessScopes = ["open"] } = {}) {
  const today = todayISO();
  const select = await buildSelect();
  const extras = await getAvailableExtraCols();
  let query = supabase
    .from("events")
    .select(select)
    .gt("tickets_left", 0)
    .eq("archived", false)
    .gte("date", today)
    .order("date", { ascending: true });
  const safeScopes = await sanitizeAccessScopes(accessScopes);
  query = withAccessFilter(query, extras, safeScopes);
  const { data, error } = await query;

  if (error) throw new Error(`Events fetch failed: ${error.message}`);
  const flattened = (data || [])
    .map(flattenEvent)
    .filter((e) => !isAdminEntry(e.name) && !isEventInPast(e.date, e.start_time, e.end_time));
  return await expandLabels(flattened);
}

/**
 * Fetch events for Gemini to reason over. We intentionally apply ONLY the
 * cheap, deterministic filters that don't require interpreting event names:
 *
 *   - archived = false
 *   - date in [dateFrom, dateTo]   (open-ended when omitted)
 *   - past-time events on today    (filtered in JS)
 *   - administrative junk          (filtered in JS)
 *
 * Everything else — age appropriateness, semantic name matching, etc. —
 * is left to Gemini, which receives the full row including `name`, `date`,
 * `start_time`, `location`.
 *
 * @param {Object} opts
 * @param {boolean} [opts.futureOnly=true]
 * @param {string}  [opts.dateFrom]   YYYY-MM-DD inclusive lower bound.
 * @param {string}  [opts.dateTo]     YYYY-MM-DD inclusive upper bound.
 */
async function getAllEvents({
  futureOnly = true,
  dateFrom = null,
  dateTo = null,
  format = null,
  accessScopes = ["open"],
} = {}) {
  const select = await buildSelect();
  const extras = await getAvailableExtraCols();
  let query = supabase
    .from("events")
    .select(select)
    .eq("archived", false)
    .order("date", { ascending: true });

  const lowerBound = dateFrom || (futureOnly ? todayISO() : null);
  if (lowerBound) query = query.gte("date", lowerBound);
  if (dateTo) query = query.lte("date", dateTo);
  const safeScopes = await sanitizeAccessScopes(accessScopes);
  query = withAccessFilter(query, extras, safeScopes);

  const { data, error } = await query;
  if (error) throw new Error(`Events fetch failed: ${error.message}`);

  const flattened = (data || []).map(flattenEvent).filter((e) => {
    if (isAdminEntry(e.name)) return false;
    if (futureOnly && isEventInPast(e.date, e.start_time, e.end_time)) return false;
    return true;
  });

  const expanded = await expandLabels(flattened);
  return applyFormatFilter(expanded, format);
}

const { isGeminiAllowed } = require("../lib/geminiPolicy");

async function findMatchesForUser(profile, events, options = {}) {
  if (!events.length) return [];

  if (!isGeminiAllowed("matching")) {
    console.log(`[Matching] Gemini disabled — skipping AI match for user ${profile.telegram_id}`);
    const out = [];
    out._failureReason = "gemini_disabled";
    return out;
  }

  const watchedIds = Array.isArray(options.watchedEventIds)
    ? options.watchedEventIds.map((id) => parseInt(id, 10)).filter(Number.isFinite)
    : [];
  const userQuery = (options.userQuery || "").trim();
  const rawMessage = (options.rawMessage || "").trim();
  const userTokens = Array.isArray(options.userTokens) ? options.userTokens.filter(Boolean) : [];

  // Activity-type guard: detect the type(s) the user implicitly named in
  // their query / raw message. Used post-Gemini and in the fallback to drop
  // mismatched types ("סדנה" when the user asked for "סיור" etc.).
  const requestedTypes = detectActivityTypes(`${userQuery} ${rawMessage}`);
  if (requestedTypes.length) {
    console.log(`[Matching] Requested activity types: ${requestedTypes.join(", ")}`);
  }
  const eventsById = new Map(events.map((e) => [e.id, e]));

  // Trimmed payload: only the fields Gemini actually uses to decide a match.
  // start_time / location text / tickets_left are NOT part of the matching
  // decision — they're handled by deterministic filters in the bot. Smaller
  // payload = faster Gemini response and fewer tokens billed.
  //
  // We DO include `tags` because they're the cleanest semantic signal we
  // have for ranking against `profile.user_context.interests` (e.g. an
  // event tagged "מוזיקה" is much stronger evidence of a music event
  // than substring-matching on the title). Cap at 5 tags per event so the
  // payload stays small even on heavily-tagged rows.
  const eventsSummary = events.map((e) => {
    const row = { id: e.id, name: e.name, date: e.date };
    if (e._locationKind && e._locationKind !== "unknown") row.kind = e._locationKind;
    if (watchedIds.includes(e.id)) row.in_watch_list = true;
    if (Array.isArray(e.tags) && e.tags.length) {
      row.tags = e.tags.slice(0, 5);
    }
    return row;
  });

  const userSummary = {
    name: profile.first_name,
    context: profile.user_context,
    active_search_terms: profile.active_watch_list,
  };

  try {
    const model = genai.getGenerativeModel({
      model: require("../lib/geminiModel").GEMINI_MODEL,
      systemInstruction: buildSystemPrompt(),
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: MATCH_SCHEMA,
        temperature: 0.2,
      },
    });

    // Most rules already live in the system prompt. The queryClause carries
    // ONLY the per-call user data + the ground-truth reminder, so we don't
    // pay tokens to repeat the rules on every call.
    const queryClause = userQuery || rawMessage
      ? `\n` +
        (rawMessage ? `Raw user message (GROUND TRUTH for explicit filters like age/date): """${rawMessage}"""\n` : "") +
        (userQuery ? `Brain-normalized query: "${userQuery}"\n` : "") +
        (userTokens.length ? `Semantic hints (not literal): [${userTokens.join(", ")}]\n` : "")
      : "";

    const watchClause = watchedIds.length
      ? `\nUser's actual watch_list event IDs: [${watchedIds.join(", ")}]. Mention "רשימת המעקב" / "watchlist" in a reason ONLY if event_id is in that exact list. Otherwise NEVER use the word "watchlist" / "מעקב" in the reason.\n`
      : `\nUser's watch_list is EMPTY. NEVER mention "watchlist" / "רשימת המעקב" in any reason.\n`;

    const prompt =
      `Today: ${todayISO()}. Candidates are pre-filtered (date+age+past-time). Job: semantic match only.\n` +
      queryClause +
      watchClause +
      `\nUser:\n${JSON.stringify(userSummary)}\n\n` +
      `Events (${eventsSummary.length}):\n${JSON.stringify(eventsSummary)}\n\n` +
      `Return all events that semantically satisfy the user's request (high/medium confidence). Reason in Hebrew.`;

    // Hard timeout — Gemini occasionally stalls on large prompts, and we'd
    // rather degrade to "no matches" than block the Telegraf handler past
    // its 90s ceiling (which would tear down the entire bot process).
    const GEMINI_TIMEOUT_MS = 45000;
    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Gemini matching timeout after ${GEMINI_TIMEOUT_MS}ms (${eventsSummary.length} candidates)`)),
          GEMINI_TIMEOUT_MS
        )
      ),
    ]);
    const text = result.response.text();
    const parsed = JSON.parse(text);

    const validIds = new Set(events.map((e) => e.id));
    const watchedSet = new Set(watchedIds);

    let matches = (parsed.matches || []).filter(
      (m) =>
        validIds.has(m.event_id) &&
        (m.confidence === "high" || m.confidence === "medium")
    );

    // Activity-type guard: even if Gemini was confident, drop matches whose
    // event name belongs to a different activity type than the one the user
    // asked for ("סדנת עששיות" when the user asked for "סיור עששיות").
    if (requestedTypes.length) {
      const before = matches.length;
      matches = matches.filter((m) => {
        const ev = eventsById.get(m.event_id);
        return ev && activityTypeMatches(ev.name, requestedTypes);
      });
      if (matches.length !== before) {
        console.log(
          `[Matching] Activity-type guard dropped ${before - matches.length} mismatched event(s).`,
        );
      }
    }

    // Defensive sanitisation of the freeform `reason` field.
    matches = matches.map((m) => ({
      ...m,
      reason: scrubWatchlistMention(m.reason, m.event_id, watchedSet),
    }));

    return matches;
  } catch (err) {
    let reason;
    if (err.message?.includes("429") || err.message?.includes("quota")) {
      console.warn("[Matching] Gemini Quota Exhausted — skipping user", profile.telegram_id);
      reason = "quota";
    } else if (err.message?.includes("timeout")) {
      console.warn(`[Matching] ${err.message}`);
      reason = "timeout";
    } else {
      console.error("[Matching] Gemini error for user", profile.telegram_id, err.message);
      reason = "error";
    }

    // Deterministic fallback: when Gemini stalls/errors we don't want to
    // return 0 results. Match by substring on the user's hint tokens (the
    // brain already extracted the salient nouns).
    //
    // AND-matching (every token must appear) — important: the previous
    // OR-version returned "סדנת עששיות" for a "סיור עששיות" query because
    // both contain the topic word. Requiring all tokens prevents that.
    // Also enforces the activity-type guard for an extra layer of safety.
    const tokens = (userTokens.length ? userTokens : userQuery ? [userQuery] : [])
      .map((t) => t.toLowerCase().trim())
      .filter((t) => t.length >= 2);

    if (!tokens.length) {
      const out = [];
      out._failureReason = reason;
      return out;
    }

    const fallback = [];
    for (const e of events) {
      const lower = (e.name || "").toLowerCase();
      const allTokensMatch = tokens.every((tok) => lower.includes(tok));
      if (!allTokensMatch) continue;
      if (!activityTypeMatches(e.name, requestedTypes)) continue;
      // Intentionally no `reason`: the deterministic fallback has no
      // genuine insight to share — better silent than parroting the
      // search term back at the user.
      fallback.push({
        event_id: e.id,
        event_name: e.name,
        confidence: "medium",
        reason: null,
      });
      if (fallback.length >= 5) break;
    }
    console.warn(`[Matching] Fallback (${reason}) returned ${fallback.length} keyword match(es) of ${events.length}`);
    fallback._failureReason = reason;
    fallback._fallbackUsed = true;
    return fallback;
  }
}

function buildMatchMessage(profile, match, event) {
  const name = profile.first_name || "";
  const lines = [
    `🎯 ${name ? name + ", " : ""}מצאתי משהו שעשוי לעניין אותך!`,
    ``,
    `${getEventIcon(event)} ${match.event_name}`,
  ];

  if (event.date) lines.push(`📅 ${formatHebrewDate(event.date)}`);
  const timeStr = formatTimeRange(event.start_time, event.end_time);
  if (timeStr) lines.push(rtlLine(`🕐 ${timeStr}`));
  const audienceLine = formatAudienceLine(event);
  if (audienceLine) lines.push(audienceLine);
  if (event.location) lines.push(`📍 ${event.location}`);
  // Shared ticket-line helper — handles free events (null → skip)
  // AND surfaces the low-stock urgency ("🎫 N כרטיסים אחרונים ❗️")
  // inline per the May-2026 single-line revamp.
  const matchTicketsLine = formatTicketsLine(event.tickets_left);
  if (matchTicketsLine) lines.push(matchTicketsLine);
  lines.push(`💡 ${match.reason}`);
  lines.push(``, getBookingUrl(event));

  return lines.join("\n");
}

// Thin re-export so existing call sites keep their local symbol; behaviour
// is now defined centrally in lib/imageUrl.js (handles legacy relative
// paths AND empty / invalid inputs uniformly). Note: callers should pass
// the full event object as the second arg so the right tenant base is
// used for relative paths.
const getImageUrl = normalizeImageUrl;

async function runMatchingForAllUsers(telegram) {
  console.log("[Matching] Fetching profiles and events...");

  const [profiles, events] = await Promise.all([
    getActiveProfiles(),
    getAvailableEvents(),
  ]);

  console.log(`[Matching] ${profiles.length} active profile(s), ${events.length} available event(s)`);

  if (!profiles.length || !events.length) {
    console.log("[Matching] Nothing to match");
    return { processed: 0, matched: 0, notified: 0 };
  }

  const eventsMap = new Map(events.map((e) => [e.id, e]));
  let totalMatched = 0;
  let totalNotified = 0;

  for (const profile of profiles) {
    console.log(`\n[Matching] User: ${profile.telegram_id} (${profile.first_name || "unknown"})`);

    const matches = await findMatchesForUser(profile, events);

    if (!matches.length) {
      console.log("  No matches found");
      continue;
    }

    console.log(`  ${matches.length} match(es) found`);
    totalMatched += matches.length;

    for (const match of matches) {
      const event = eventsMap.get(match.event_id);
      if (!event) continue;

      const message = buildMatchMessage(profile, match, event);
      const imageUrl = getImageUrl(event.image, event);

      console.log(`  -> ${match.event_name} [${match.confidence}]: ${match.reason}`);

      try {
        if (imageUrl) {
          try {
            await telegram.sendPhoto(profile.telegram_id, imageUrl, {
              caption: message,
            });
          } catch {
            await telegram.sendMessage(profile.telegram_id, message);
          }
        } else {
          await telegram.sendMessage(profile.telegram_id, message);
        }
        totalNotified++;
        console.log("    Notification sent");
      } catch (err) {
        console.error(`    Failed to notify: ${err.message}`);
      }
    }
  }

  console.log(`\n[Matching] Done — ${profiles.length} processed, ${totalMatched} matched, ${totalNotified} notified`);
  return { processed: profiles.length, matched: totalMatched, notified: totalNotified };
}

/** Load one event row with the same shape as search/matching cards. */
async function getEventById(id) {
  const eventId = parseInt(id, 10);
  if (!Number.isFinite(eventId)) return null;
  const select = await buildSelect();
  const { data, error } = await supabase
    .from("events")
    .select(select)
    .eq("id", eventId)
    .eq("archived", false)
    .maybeSingle();
  if (error || !data) return null;
  const flat = flattenEvent(data);
  await expandLabels([flat]);
  return flat;
}

module.exports = {
  findMatchesForUser,
  runMatchingForAllUsers,
  getActiveProfiles,
  getAvailableEvents,
  getAllEvents,
  getEventById,
  buildMatchMessage,
  flattenEvent,
  expandLabels,
  detectActivityTypes,
  activityTypeMatches,
};
