const { SchemaType } = require("@google/generative-ai");
const { getAllEvents } = require("../../../bot/matchingService");
const { getAccessScopesForUser } = require("../../../bot/profileService");
const { getActiveTickets } = require("../../ticketService");
const { evaluateProximity } = require("../../geocoding");
const {
  AUDIENCE_KEYS,
  AUDIENCE_REQUIRED_SUBTYPE_TAGS,
  ACTIVITY_TYPE_KEYS,
  audienceVerdict,
  categoryMatches,
  ageMatches,
  deriveDefaultAudienceSet,
  deriveExcludedSubtypeTags,
  userAgeWindowMonths,
  ageWindowOverlaps,
  isConsultationEvent,
} = require("../../categories");
const labelStore = require("../../labelStore");
const { refreshEvent } = require("../../eventRefreshService");
const sessionStore = require("../sessionStore");
const { groupIntoSeries } = require("../../eventSeries");
const { makeSeriesKey } = require("../../newsletterService");
const {
  todayISO,
  weekRangeIL,
  nextWeekRangeIL,
  monthAheadRangeIL,
  addDaysISO,
  describeWindowHe,
} = require("../../timeContext");

const MAX_RESULTS = 30;
// `activity_types` values where the normal "permissive null category"
// fallback is wrong: an event without a `category` ENUM almost always
// is NOT a party (it's a senior lecture / music meetup / city
// programming without a category yet). For these types we require an
// EXACT category match. Hoisted to module scope because the same set
// drives both the main category filter AND the out-of-audience-in-
// category projection at the end of runFilterChain.
const STRICT_ACTIVITY_TYPES = new Set(["party"]);
// Default window when the user didn't pin a date range. Used as both the
// initial window AND the chunk size for the auto-extend loop below.
const DEFAULT_WINDOW_DAYS = 14;
// Auto-extend target. When the user did NOT pin a window and the initial
// 14-day window has fewer than this many matching events, the tool
// silently widens `date_to` by EXTEND_CHUNK_DAYS until either (a) the
// match count reaches MIN_RESULTS_TARGET, (b) widening adds zero new
// events (data horizon reached). NO hard date cap — the natural ceiling
// is the scraper, which currently looks ahead at most ~50 days
// (LOOKAHEAD_DAYS=45 in api/check.js + ~50d on the city CMS), so
// MAX_EXTEND_ITERATIONS × EXTEND_CHUNK_DAYS comfortably covers that.
const MIN_RESULTS_TARGET = 5;
const EXTEND_CHUNK_DAYS = 14;
const MAX_EXTEND_ITERATIONS = 4;
// When the user DID pin a window and matched < MIN_RESULTS_TARGET inside
// it, we run a single existence probe past `date_to` (up to
// PROBE_HORIZON_DAYS from `date_from`) to tell the agent honestly whether
// extending would yield more results — so it can OFFER (not silently
// do) the extension. The probe still respects every filter the user
// applied (audience, tags, proximity, …); it does NOT lower the
// relevance bar to hit a count.
const PROBE_HORIZON_DAYS = 90;

// ─────────────────────────────────────────────────────────────────────────
// search_events
//
// Deterministic event search. The agent supplies the structured filters it
// extracted from the user message; we run them against `events` joined with
// `locations` and return a trimmed projection. NO Gemini call here — the
// filtering is pure JS / SQL.
//
// The agent should use this for almost every search. The "AI semantic
// match" pass (`semantic_filter_events`) is reserved for the rare case
// where keyword matching is too narrow (e.g. "אווירה רגועה" → no obvious
// substring).
// ─────────────────────────────────────────────────────────────────────────
const searchEventsDecl = {
  name: "search_events",
  description:
    "Search the events database with structured filters. Returns up to 30 events ordered by date. " +
    "Pass the user's structured intent — date window, audience, location_key, format, optional name keywords. " +
    "Empty filters = the next 14 days as a starting window, all audiences. " +
    "DYNAMIC WINDOW: " +
    "(a) WHEN THE USER DID NOT PIN A DATE RANGE (no date_from/date_to/date_preset from the agent) the tool starts with today + 14 days and AUTO-EXTENDS in 14-day chunks until at least 5 events match OR the database runs out of future events. Response carries `window_extended: true` and `data_horizon_reached: true|false` accordingly. The `window.from/to` reflects the FINAL window actually scanned (so `window.label_he` is honest). Phrase intro_text from `window.label_he`, not from a hardcoded \"השבועיים הקרובים\". " +
    "(b) WHEN THE USER DID PIN A DATE RANGE (preset, or explicit date_from/date_to) the tool RESPECTS the pinned window — no silent extension. If fewer than 5 events match inside it, the tool probes the data horizon past date_to and reports `can_extend_beyond_window: true` with `extension_hint: { suggested_date_to, count_at_least, label_he }`. The agent should OFFER the user to extend in intro_text/reply_text (e.g. \"מצאתי 3 השבוע. יש לי עוד 4+ מאוחר יותר — להראות?\"). If the user says yes, call search_events AGAIN with date_to=extension_hint.suggested_date_to. " +
    "SESSION DEDUPE: events already rendered as cards earlier in this conversation are filtered out automatically — `already_shown_excluded` reports how many were dropped. If `matched===0` AND `already_shown_excluded > 0`, tell the user the matches were already shown (don't pretend none exist). " +
    "AUDIENCE EXCLUSIONS (telemetry-only): when the user did NOT pin an audience, the tool filters by the profile-derived default audience set and reports the silent drops as `audience_excluded: { count, by_audience }` (e.g. `{ count: 3, by_audience: { 'מבוגרים': 3 } }`). DO NOT surface this in user-facing text — the contract is silent suppression. The agent recognises the explicit opt-in phrases (\"בשבילי\", \"תראי לי הכל\", etc.) and re-searches with the right audience instead. Empty `{ count: 0, by_audience: {} }` when the user pinned an audience explicitly or `audience: 'all'`. " +
    "Returns { events, total_in_window, matched, already_shown_excluded, truncated, window:{from,to,label_he,was_default}, window_extended, data_horizon_reached, can_extend_beyond_window, extension_hint, resolved_tags, unresolved_tags, audience_excluded, subtype_excluded, consultations_excluded, audience_auto_promoted, out_of_audience_in_category }. " +
    "OUT-OF-AUDIENCE MENTION: when you pass `activity_types` AND the audience filter (explicit or default) drops events that DO match that category, the tool surfaces up to 3 in `out_of_audience_in_category: [{id,name,date,audience}]`. The agent should briefly MENTION these in `reply_text` with a soft offer (\"ויש גם מסיבה לגיל 35+ — להראות?\"). Do NOT render them as cards — they're outside the user's pinned audience and surface only after explicit consent. On 'yes', re-call `search_events` with the SAME filters PLUS a broader `audience` (read the dropped event's `audience` to choose: e.g. 'מבוגרים' on the dropped row → broaden to `audience: 'adults'`). The field is `[]` when activity_types isn't set OR no relevant drops happened; only surface when non-empty. " +
    "Use `window.label_he` (e.g. 'בשבועיים הקרובים', 'בחודש הקרוב', 'בין 5 ביוני ל-19 ביוני') verbatim in your `intro_text` when presenting results.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      date_from: {
        type: SchemaType.STRING,
        nullable: true,
        description: "ISO YYYY-MM-DD inclusive lower bound. Default: today.",
      },
      date_to: {
        type: SchemaType.STRING,
        nullable: true,
        description: "ISO YYYY-MM-DD inclusive upper bound. When omitted (AND date_from/date_preset also omitted) the tool defaults to date_from + 14 days and AUTO-EXTENDS to reach at least 5 matching events — see DYNAMIC WINDOW in the description. When you pass any of date_from/date_to/date_preset the tool TREATS THE WINDOW AS PINNED — no silent extension; instead `can_extend_beyond_window`/`extension_hint` is returned so you can OFFER the user to extend.",
      },
      date_preset: {
        type: SchemaType.STRING,
        nullable: true,
        format: "enum",
        enum: ["today", "tomorrow", "this_week", "next_week", "this_month"],
        description: "Convenience for natural-language date scopes. If set, overrides date_from/date_to.",
      },
      audience: {
        type: SchemaType.STRING,
        nullable: true,
        format: "enum",
        enum: [...AUDIENCE_KEYS, "all"],
        description:
          "Audience category. The tool AUTOMATICALLY filters by audiences relevant to this user's profile when this parameter is UNSET — pass it only when the user is overriding that default. " +
          "Values: kids/family/adults/teens/toddlers — explicit subset; matched against the event's `audience` ENUM column (sql/032). " +
          "'all' — explicit user override: bypass the profile-derived default and return every audience tier (use for 'תראי לי הכל', 'גם דברים בשבילי', 'גם אירועים למבוגרים'). " +
          "Events with no audience set are included with low confidence under any value.",
      },
      activity_types: {
        type: SchemaType.ARRAY,
        nullable: true,
        items: { type: SchemaType.STRING, format: "enum", enum: ACTIVITY_TYPE_KEYS },
        description: "Restrict to specific activity kinds (tour, workshop, show, …). Matched against the event's `category` ENUM column (sql/032) — events with no category pass through.",
      },
      age: {
        type: SchemaType.INTEGER,
        nullable: true,
        description: "Specific child age in years. Filters by the event's min_months/max_months range (e.g. age=2 keeps events with min_months ≤ 24 ≤ max_months). When the user has multiple kids, use `ages` instead.",
      },
      ages: {
        type: SchemaType.ARRAY,
        nullable: true,
        items: { type: SchemaType.INTEGER },
        description:
          "Ages of ALL kids in the household, in years (e.g. [4, 9]). An event matches if its min_months/max_months range fits AT LEAST ONE of these ages — i.e. 'something at least one of my kids can do'. " +
          "USE THIS (not `audience: 'family'`) when the user says 'אירועים למשפחה שלי' / 'מה שמתאים לילדים שלי' / 'אירועים שמתאימים למשפחה' — they mean 'fits MY family composition', NOT the literal 'לכל המשפחה' audience tag. " +
          "Read the ages from `profile.kids`. If you also pass `age`, the singleton is folded into the array.",
      },
      format: {
        type: SchemaType.STRING,
        nullable: true,
        format: "enum",
        enum: ["physical", "virtual", "any"],
        description: "Physical vs virtual venue. Default: any (no filter).",
      },
      location_key: {
        type: SchemaType.STRING,
        nullable: true,
        description: "Pinned venue (FK from resolve_venue). Only events at this exact location are returned.",
      },
      keywords: {
        type: SchemaType.ARRAY,
        nullable: true,
        items: { type: SchemaType.STRING },
        description: "Hebrew keywords AND-matched as substrings against the event title. Example: ['עששיות'].",
      },
      tags: {
        type: SchemaType.ARRAY,
        nullable: true,
        items: { type: SchemaType.STRING },
        description:
          "Hebrew topic tags to match against the event's `tag_ids` column (FK array into the `labels` dictionary; sql/032 turned `labels` into a tags-only table). " +
          "Use this WHENEVER the user is searching by topic ('מוזיקה', 'התפתחות', 'ל״ג בעומר', 'AI') — " +
          "tag matches are far more reliable than substring matches on the title. " +
          "Pass the user's words as-is; the tool resolves them against the labels dictionary using fuzzy match. " +
          "Tags that don't resolve to any existing label are returned in `unresolved_tags` so you can offer the user a topic watcher.",
      },
      proximity: {
        type: SchemaType.STRING,
        nullable: true,
        format: "enum",
        enum: ["walk", "drive"],
        description:
          "Filter by distance from the user's home. 'walk' = within their personal walk tolerance (default 15 minutes, overridable via profile.constraints.max_walking_minutes); 'drive' = farther than that. " +
          "REFINEMENT RULE: when the user asks 'רק קרוב' / 'רק מה שאני יכולה ללכת' / 'בסביבה' as a follow-up to a previous search, you MUST re-call search_events with proximity='walk' PLUS all the other filters from the previous call (tags, audience, age, date). Do NOT drop the previous filters.",
      },
      available_only: {
        type: SchemaType.BOOLEAN,
        nullable: true,
        description: "When true, only events with tickets_left > 0.",
      },
      include_consultations: {
        type: SchemaType.BOOLEAN,
        nullable: true,
        description:
          "Whether to include 1:1 consultation events (ייעוץ הורות, ייעוץ הנקה, קליניקת הנקה, התייעצות). Default: FALSE — these crowd out activity searches and are silently filtered out. " +
          "Pass TRUE only when the user query EXPLICITLY contains consultation framing: 'ייעוץ', 'התייעצות', 'ייעוץ הורות', 'ייעוץ הנקה', 'קליניקת הנקה', 'להתייעץ', 'סיוע אישי'. " +
          "Adjacent topic words alone do NOT count — 'סדנה להורים' / 'הרצאה על הנקה' / 'מפגש הורות' are activities, leave this false.",
      },
    },
  },
};

function resolveDatePreset(preset) {
  if (!preset) return null;
  if (preset === "today") {
    const t = todayISO();
    return { from: t, to: t };
  }
  if (preset === "tomorrow") {
    const t = addDaysISO(todayISO(), 1);
    return { from: t, to: t };
  }
  if (preset === "this_week") {
    const w = weekRangeIL();
    return { from: w.startISO, to: w.endISO };
  }
  if (preset === "next_week") {
    const w = nextWeekRangeIL();
    return { from: w.startISO, to: w.endISO };
  }
  if (preset === "this_month") {
    const r = monthAheadRangeIL();
    return { from: r.startISO, to: r.endISO };
  }
  return null;
}

async function searchEventsTool(args, ctx) {
  const preset = resolveDatePreset(args?.date_preset);
  // Track whether the user actually pinned a window or whether we're
  // falling back to the default (today + 14 days). The agent surfaces this
  // verbatim in the result and uses it to decide phrasing — "השבוע מצאתי"
  // vs "הנה מה שמצאתי בשבועיים הקרובים" vs nothing at all.
  //
  // The flag also gates the auto-extend behaviour: when userSetDate is
  // false (open-ended "what's on?" query) we silently widen the window
  // until min_results is satisfied; when it's true we respect the user's
  // pinned bounds and only OFFER to extend via `extension_hint`.
  const userSetDate = !!(preset || args?.date_from || args?.date_to);
  const dateFrom = preset?.from || args?.date_from || todayISO();
  const initialDateTo =
    preset?.to || args?.date_to || addDaysISO(dateFrom, DEFAULT_WINDOW_DAYS);

  const format = args?.format && args.format !== "any" ? args.format : null;

  // Resolve which community-access scopes this user is allowed to see.
  // 'open' is always present; community values appear when the user has
  // declared "member" in their profile via update_profile.communities.
  const accessScopes = await getAccessScopesForUser(ctx?.telegramId);

  // Resolve tags ONCE outside the filter chain — the result doesn't
  // change across auto-extend iterations, and resolveTagNamesToIds
  // hits the labels table so we don't want to repeat it on every
  // chunk. The filter chain reads `resolvedTags` from this closure.
  let resolvedTags = [];
  let unresolvedTags = [];
  if (Array.isArray(args?.tags) && args.tags.length) {
    const r = await labelStore.resolveTagNamesToIds(args.tags);
    resolvedTags = r.resolved;
    unresolvedTags = r.unresolved;
  }

  // Resolve audience promotion ONCE — it's purely a function of
  // the agent's `args` (the audience the user asked for + the
  // activity_types they pinned). The filter chain reads this
  // closure variable. Lifted out of runFilterChain so both the
  // chain AND the outer response can see whether we promoted.
  // See the rationale block below near the audience filter.
  const ADULT_CODED_ACTIVITY_TYPES = new Set(["party"]);
  const requestedTypes = Array.isArray(args?.activity_types)
    ? args.activity_types
    : [];
  const adultCodedRequested = requestedTypes.some((t) =>
    ADULT_CODED_ACTIVITY_TYPES.has(t),
  );
  // Treat both `undefined` and explicit `null` as "agent did not
  // pin an audience" — Gemini sometimes serialises a missing
  // optional field as `null`.
  const agentSetAudience = args?.audience != null;
  const audiencePromoted = !agentSetAudience && adultCodedRequested;
  const effectiveAudience = audiencePromoted ? "adults" : args?.audience;

  // Helper: run the full filter chain for a given [searchFrom, searchTo]
  // window. Returns the filtered events + the same telemetry counts the
  // tool reports (audience_excluded, subtype_excluded, …). Auto-extend
  // and out-of-window probe both call this; the main flow uses the
  // LATEST result for telemetry, so chunks discarded by the loop don't
  // leak into the response.
  async function runFilterChain(searchFrom, searchTo) {
    let events = await getAllEvents({
      futureOnly: true,
      dateFrom: searchFrom,
      dateTo: searchTo,
      format,
      accessScopes,
    });
    const totalInWindow = events.length;

    // Layer the agent-provided filters on top — all deterministic, no AI.
    const wantKey = args?.location_key || null;
    if (wantKey) events = events.filter((e) => e.location_key === wantKey);

    if (args?.available_only) events = events.filter((e) => (e.tickets_left || 0) > 0);

    // Audience filter — three modes, in priority order:
    //
    //   1. `audience === 'all'` — explicit user override ("תראי לי הכל",
    //      "גם דברים בשבילי"). Skip the audience filter entirely and
    //      return rows of every audience tier.
    //   2. `audience` set to a specific key (e.g. 'kids' / 'adults') —
    //      the agent extracted a specific intent from the user; run the
    //      original `audienceVerdict` and respect it as-is.
    //   3. `audience` UNSET — the common case. Fall back to the user's
    //      profile-derived default audience set (see
    //      `deriveDefaultAudienceSet` in lib/categories.js). This is the
    //      single source of truth for "what's relevant to this user by
    //      default" — adding a new audience ENUM value tomorrow only
    //      needs one mapping line there, NOT a new exclusion here.
    //
    // Events carry the expanded `audience` (single Hebrew name) attached
    // by matchingService.expandLabels. NULL audience means "no signal"
    // and we keep those rows in modes 2 and 3 alike (low-confidence
    // include) — better than hiding a potentially relevant row, and
    // present_event_results can flag them in the UI.
    // Track silently-dropped audience exclusions so the agent can offer
    // them as a follow-up ("יש עוד 3 אירועים למבוגרים בקרבתך — להראות?").
    // Only populated when the user did NOT explicitly opt in to "all"
    // or specify a target audience — those modes are intentional, not
    // hidden.
    const audienceExcluded = { count: 0, by_audience: {} };
    function trackExcluded(e) {
      if (!e?.audience) return;
      audienceExcluded.count++;
      audienceExcluded.by_audience[e.audience] =
        (audienceExcluded.by_audience[e.audience] || 0) + 1;
    }

    // Audience filter. `effectiveAudience` is resolved in the outer
    // scope (see `audiencePromoted` rationale above): it equals
    // `args.audience` when the agent pinned one, OR is promoted to
    // 'adults' when the agent requested an intrinsically-adult
    // activity_type (e.g. 'party') without an audience override.
    // Without this promotion a parent profile asking for "מסיבות"
    // would silently drop every match (all parties are מבוגרים-
    // tier; the default audience set is kids+family).
    //
    // Track every event the audience block DROPS (verdict or subtype
    // tag) into `audienceDropped` — used downstream to surface a
    // brief "out-of-audience-in-category" mention when the user asked
    // for a specific activity_type (e.g. "מסיבות") but the audience
    // filter excluded otherwise-relevant matches. Helps the user see
    // there's a 35+ party even though they pinned young_adult,
    // WITHOUT silently widening their filter.
    const audienceDropped = [];
    if (effectiveAudience === "all") {
      // Explicit opt-in to ALL audience tiers — no filtering.
    } else if (effectiveAudience) {
      const verdictKept = [];
      for (const e of events) {
        const v = audienceVerdict(e.name, effectiveAudience, e);
        e._audience_verdict = v;
        if (v.decision === "include") {
          verdictKept.push(e);
        } else {
          audienceDropped.push(e);
        }
      }
      events = verdictKept;

      // Subtype-tag intersection. Some audience values express a
      // narrower bucket WITHIN the ENUM verdict — today only
      // `young_adult` (which requires the discovery tag "צעירים"
      // on top of `audience=מבוגרים`). The required-tag name is
      // canonical Hebrew matched against the EXPANDED `tags` array
      // attached by matchingService.expandLabels (an array of label
      // names, NOT raw label ids — so this stays portable across
      // dev/prod label-id namespaces).
      //
      // We deliberately use STRICT membership: an event without the
      // required tag is dropped, even when it has a plausible
      // min_months/max_months range. The discovery tag is our
      // signal of editorial intent; numeric bounds alone aren't
      // enough (most adult events default to min_months=216 without
      // actually being young-targeted, which would flood a
      // `young_adult` query with senior lectures).
      const requiredTag = AUDIENCE_REQUIRED_SUBTYPE_TAGS[effectiveAudience];
      if (requiredTag) {
        const tagKept = [];
        for (const e of events) {
          const tags = Array.isArray(e.tags) ? e.tags : [];
          if (tags.includes(requiredTag)) {
            tagKept.push(e);
          } else {
            audienceDropped.push(e);
          }
        }
        events = tagKept;
      }
    } else {
      const allowedAudiences = deriveDefaultAudienceSet(ctx.profile);
      const defaultKept = [];
      for (const e of events) {
        if (!e.audience || allowedAudiences.has(e.audience)) {
          defaultKept.push(e);
        } else {
          trackExcluded(e);
          audienceDropped.push(e);
        }
      }
      events = defaultKept;
    }

    // Adult SUBTYPE filter (May-2026). Independent layer on top of
    // the audience ENUM filter: when the user's profile sets
    // `age_range`, we exclude `מבוגרים`-tier events tagged with the
    // OPPOSITE subtype:
    //   young_adult → exclude events tagged `גיל הזהב`
    //   senior      → exclude events tagged `צעירים`
    //   mid_adult   → no exclusion (broad middle)
    //   unset       → no exclusion (legacy behaviour)
    //
    // Why a tag filter and not another ENUM: the city CMS lumps all
    // three subtypes under `מבוגרים`, and we resurrected the subtype
    // info as DISCOVERY tags during scrape (see
    // `extractAudienceSubtypeTags` in lib/cityApi.js). That keeps the
    // schema unchanged while letting search differentiate.
    //
    // Honour `audience: 'all'` and explicit `audience:'adults'` too —
    // the user opted in to broader content explicitly, second-guessing
    // them with a subtype gate would be over-engineering.
    let subtypeExcluded = 0;
    // Cohort gate (May-2026): runs when the audience filter ran in
    // "promoted" or "no-pin" mode — i.e. the user did NOT explicitly
    // opt in to a broader audience like 'adults' or 'all'. Two layered
    // checks both feed `audienceDropped` so off-cohort matches can be
    // surfaced via `out_of_audience_in_category` (soft offer in
    // reply_text) instead of being silently hidden:
    //
    //   • SUBTYPE TAG gate (`deriveExcludedSubtypeTags`) — drops
    //     events tagged with the OPPOSITE subtype of the user's
    //     cohort (`young_adult` drops `גיל הזהב`; `senior` drops
    //     `צעירים`).
    //   • NUMERIC AGE-WINDOW gate (`userAgeWindowMonths` +
    //     `ageWindowOverlaps`) — drops events whose
    //     min_months/max_months window does NOT overlap the user's
    //     own age window. Catches the case the tag gate misses: a
    //     "מסיבה בלבן 35+" carries no subtype tag, but a young_adult
    //     user (216-420m) shouldn't see it on a default search.
    //
    // We extend the gate to also fire on `audiencePromoted` (was
    // previously skipped — see the audience-promotion comment above)
    // following the May-2026 user feedback that age-restricted parties
    // should be excluded from default results but offered as a side
    // mention. Dropped events go into `audienceDropped`, which the
    // `outOfAudienceInCategory` projection picks up further down so
    // the agent can phrase "ויש גם מסיבה ל-35+ — להראות?".
    //
    // Explicit `audience: 'adults'` / `audience: 'all'` still bypasses
    // BOTH gates — the user widened on purpose, second-guessing them
    // would hide the content they asked for.
    const applyCohortGate = audiencePromoted || !effectiveAudience;
    if (applyCohortGate) {
      const excludedTags = deriveExcludedSubtypeTags(ctx.profile);
      const userAgeWindow = userAgeWindowMonths(ctx.profile);
      if (excludedTags.length || userAgeWindow) {
        const excludedSet = new Set(excludedTags);
        const before = events.length;
        const kept = [];
        for (const e of events) {
          // Only gate `מבוגרים` rows — a family event tagged
          // `גיל הזהב` (rare but possible) or one with an adult-tier
          // min_months bound shouldn't be hidden from family searches.
          if (e.audience !== "מבוגרים") {
            kept.push(e);
            continue;
          }
          const tags = Array.isArray(e.tags) ? e.tags : [];
          if (excludedSet.size && tags.some((t) => excludedSet.has(t))) {
            audienceDropped.push(e);
            continue;
          }
          if (userAgeWindow && !ageWindowOverlaps(e, userAgeWindow)) {
            audienceDropped.push(e);
            continue;
          }
          kept.push(e);
        }
        events = kept;
        subtypeExcluded = before - events.length;
      }
    }

    // Activity-type filter — bridges English keys (tour/workshop/…) to
    // the Hebrew `category` stored on each event row. Permissive by
    // default: events with no `category` ENUM pass through (history
    // of partially-enriched data, especially Smarticket events that
    // pre-date the city CMS importer).
    //
    // STRICT TYPES: a small allowlist of categories where the
    // permissive null-category fallback is wrong. For 'party' a null
    // category does NOT mean "could be a party" — it almost always
    // means "this is a senior lecture / music meetup whose enricher
    // didn't tag a category yet". Letting them through after the
    // audience promotion to 'adults' floods the result set with non-
    // parties (a 'party'-query that returned 28 lectures was a real
    // bug). For STRICT types we require an actual category match.
    //
    // Other types stay permissive — losing legitimate workshops /
    // tours to missing-category data is a worse failure mode.
    if (Array.isArray(args?.activity_types) && args.activity_types.length) {
      const strict = args.activity_types.some((t) =>
        STRICT_ACTIVITY_TYPES.has(t),
      );
      if (strict) {
        events = events.filter((e) => {
          if (!e.category) return false;
          for (const t of args.activity_types) {
            if (categoryMatches(e, [t])) return true;
          }
          return false;
        });
      } else {
        events = events.filter((e) => categoryMatches(e, args.activity_types));
      }
    }

    // Age filter — uses min_months/max_months. Permissive: events with
    // neither bound set pass through (no signal to filter on).
    // Accepts `age` (single int) and/or `ages` (array). When both are
    // present we union them and pass the array to ageMatches, which
    // returns true when AT LEAST ONE age fits the event's range — the
    // "something at least one of my kids can do" semantic for households
    // with several kids of different ages.
    const ageArg = args?.age;
    const agesArg = Array.isArray(args?.ages) ? args.ages : null;
    let ageFilter = null;
    if (agesArg && agesArg.length) {
      ageFilter = ageArg != null ? [...agesArg, ageArg] : agesArg;
    } else if (ageArg != null) {
      ageFilter = ageArg;
    }
    if (ageFilter != null) {
      events = events.filter((e) => ageMatches(e, ageFilter));
    }

    if (Array.isArray(args?.keywords) && args.keywords.length) {
      const kws = args.keywords.map((k) => String(k || "").toLowerCase().trim()).filter(Boolean);
      events = events.filter((e) => {
        const lower = (e.name || "").toLowerCase();
        return kws.every((k) => lower.includes(k));
      });
    }

    // Tag filter — uses the PRE-RESOLVED `resolvedTags` from the outer
    // scope (hoisted out of the helper because resolveTagNamesToIds is
    // a DB hit whose result is invariant across auto-extend iterations).
    //
    // IMPORTANT: when NONE of the user's tags resolves to a known label we
    // deliberately DO NOT zero out the result set. The user may have named
    // a smarticket cluster ("שבת קהילה") that doesn't exist in our labels
    // dictionary, but whose meaning is still encoded in the event TITLE,
    // the AUDIENCE filter, or KEYWORDS the agent passed alongside. Those
    // signals must continue to apply, and the agent gets `unresolved_tags`
    // back so it can decide what to do (offer a watcher / suggest similar /
    // re-ask). This was a real bug — see event ids 22396/22397/22399/22400.
    if (resolvedTags.length) {
      const wantIds = new Set(resolvedTags.map((r) => r.label_id));
      events = events.filter((e) => {
        const ids = e.tag_ids || [];
        return ids.some((id) => wantIds.has(id));
      });
    }

    // Proximity is computed lazily and only when requested — Haversine is
    // cheap, but we still avoid annotating every event when not needed.
    if (args?.proximity) {
      const profile = ctx.profile || null;
      const home = profile?.user_context?.constraints?.home_coordinates
        || profile?.constraints?.home_coordinates
        || null;
      // User's personal walk tolerance, in minutes. evaluateProximity
      // uses this as the HARD cutoff for walk-vs-drive labelling. Falls
      // back to DEFAULT_MAX_WALK_MINUTES inside the helper when null —
      // we don't apply the default here so the helper stays the single
      // source of truth.
      const maxWalkMin = profile?.user_context?.constraints?.max_walking_minutes
        ?? profile?.constraints?.max_walking_minutes
        ?? null;
      if (home?.lat != null && home?.lng != null) {
        const filtered = [];
        for (const e of events) {
          const r = await evaluateProximity(home, e.location || null, maxWalkMin, e._coords || null);
          if (!r?.resolved) continue; // ungeocodable / virtual → drop
          const ok = args.proximity === "walk" ? !r.requires_car : r.requires_car;
          if (ok) {
            e._proximity = r;
            filtered.push(e);
          }
        }
        events = filtered;
      }
    }

    // Per-user series mute — the user has previously tapped "❌ לא מתאים
    // → אני מכירה את האירוע" on this series, telling us to stop
    // surfacing recurring instances of it. Newsletter applies the same
    // filter (see lib/newsletterService.js#generateUserNewsletter); we
    // run the equivalent here so the live agent search behaves
    // identically — a series the user muted should NOT come back via
    // "מה השבוע?" the next day.
    //
    // Key: makeSeriesKey(name, location_key) — the same shape rememberKnownSeries
    // writes to profile.user_context.known_series. Stored set is FIFO-capped
    // at KNOWN_SERIES_CAP entries (see bot/telegramBot.js).
    const knownSeriesList = Array.isArray(ctx?.profile?.user_context?.known_series)
      ? ctx.profile.user_context.known_series
      : null;
    if (knownSeriesList && knownSeriesList.length) {
      const knownSeriesSet = new Set(knownSeriesList.map(String).filter(Boolean));
      if (knownSeriesSet.size) {
        events = events.filter((e) => {
          const key = makeSeriesKey(e.name, e.location_key);
          return !key || !knownSeriesSet.has(key);
        });
      }
    }

    // Consultation filter — silent default-on filter that drops 1:1
    // advice events (ייעוץ הורות / ייעוץ הנקה / קליניקת הנקה / התייעצות)
    // from general searches. Parents asking "מה השבוע?" almost never
    // mean these, and surfacing them alongside activities crowds out
    // real things to do. Override by passing `include_consultations: true`
    // when the user's query explicitly mentions consultation framing —
    // see the CONSULTATION EVENTS section in the system prompt for the
    // exact trigger keywords.
    //
    // The drop count is tracked as `consultations_excluded` purely for
    // telemetry (debug + monitoring); the system prompt instructs the
    // agent NOT to surface it to the user — silence is the contract.
    // Different from `audience_excluded` deliberately: audience exclusions
    // are about WHO; consultations are about WHAT-SHAPE, and the user-
    // facing offer pattern doesn't fit ("יש גם 4 ייעוצי הנקה — להראות?"
    // is exactly the noise we're trying to suppress).
    let consultationsExcluded = 0;
    if (!args?.include_consultations) {
      const before = events.length;
      events = events.filter((e) => !isConsultationEvent(e));
      consultationsExcluded = before - events.length;
    }

    // Session-level dedupe: filter out events the user already saw a
    // card for in this conversation. Why: "events this week" and
    // "family events" can both legitimately match the same row (an
    // event happening this week AND tagged לכל המשפחה). Without this
    // filter, the user gets the SAME card twice across consecutive
    // turns, which reads like the bot has nothing new to offer.
    //
    // Applied AFTER all other filters so we don't waste the MAX_RESULTS
    // budget on already-seen rows. The agent doesn't see this filter at
    // all — it's a pure UX layer. If the user explicitly asks "show me
    // that workshop again", the agent should route through
    // `find_event_by_name` (which intentionally does NOT dedupe) or
    // call the renderer directly with the id from history.
    //
    // We expose `already_shown_excluded` in the response so the agent
    // can react when the dedupe wipes everything ("the family-event
    // results are all things I already showed you — want me to look
    // further out?").
    let alreadyShownExcluded = 0;
    if (ctx?.telegramId) {
      const shown = sessionStore.getShownEventIds(ctx.telegramId);
      if (shown.length) {
        const shownSet = new Set(shown);
        const before = events.length;
        events = events.filter((e) => !shownSet.has(e.id));
        alreadyShownExcluded = before - events.length;
      }
    }

    // Out-of-audience-in-category projection. When the user asked for
    // a specific `activity_types` (e.g. "מסיבות" → 'party') AND the
    // audience filter dropped events that DO match that category,
    // surface up to 3 of those as a soft mention. Lets the agent
    // phrase "מצאתי 2 מסיבות לצעירים, אבל יש גם מסיבה אחת לגיל 35+ —
    // להראות?" without us silently widening the user's audience.
    //
    // Scoping rules:
    //   - Only fires when `activity_types` is set — generic queries
    //     ("מה השבוע?") stay silent (the user said don't be noisy
    //     about adult content on every search).
    //   - Same STRICT_ACTIVITY_TYPES gate as the main category filter:
    //     null-category events aren't claimed as "in category" for
    //     'party' searches.
    //   - Capped at 3 to keep the mention brief — present_event_results
    //     is NOT used for these; the agent mentions them in reply_text
    //     and re-calls search_events with a broader audience if the
    //     user accepts.
    let outOfAudienceInCategory = [];
    if (
      Array.isArray(args?.activity_types) &&
      args.activity_types.length &&
      audienceDropped.length
    ) {
      const strict = args.activity_types.some((t) =>
        STRICT_ACTIVITY_TYPES.has(t),
      );
      outOfAudienceInCategory = audienceDropped
        .filter((e) => {
          if (strict && !e.category) return false;
          return categoryMatches(e, args.activity_types);
        })
        .sort((a, b) => {
          const aDate = a.date || "9999-12-31";
          const bDate = b.date || "9999-12-31";
          return aDate < bDate ? -1 : aDate > bDate ? 1 : 0;
        })
        .slice(0, 3)
        .map((e) => ({
          id: e.id,
          name: e.name,
          date: e.date,
          audience: e.audience,
        }));
    }

    return {
      events,
      totalInWindow,
      audienceExcluded,
      subtypeExcluded,
      consultationsExcluded,
      alreadyShownExcluded,
      outOfAudienceInCategory,
    };
  }
  // ── end of runFilterChain helper ──

  // Initial fetch using the (possibly default) window.
  let dateTo = initialDateTo;
  let result = await runFilterChain(dateFrom, dateTo);

  // Auto-extend loop — only when the user did NOT pin a window.
  // Widens `date_to` in EXTEND_CHUNK_DAYS steps until either we hit
  // MIN_RESULTS_TARGET filtered matches or widening returns the same
  // raw candidate count (= we've reached the data horizon). The
  // filters from the user's query stay strict throughout — we widen
  // the WINDOW, never the relevance bar.
  let windowExtended = false;
  let dataHorizonReached = false;
  if (!userSetDate && result.events.length < MIN_RESULTS_TARGET) {
    let iterations = 0;
    let prevTotalInWindow = result.totalInWindow;
    while (
      result.events.length < MIN_RESULTS_TARGET &&
      iterations < MAX_EXTEND_ITERATIONS
    ) {
      const nextDateTo = addDaysISO(dateTo, EXTEND_CHUNK_DAYS);
      const widened = await runFilterChain(dateFrom, nextDateTo);
      if (widened.totalInWindow === prevTotalInWindow) {
        // No new rows past the current dateTo — the scrapers haven't
        // published any further out. Stop widening and let the agent
        // be honest ("זה כל מה שיש לי כרגע").
        dataHorizonReached = true;
        break;
      }
      result = widened;
      dateTo = nextDateTo;
      prevTotalInWindow = widened.totalInWindow;
      windowExtended = true;
      iterations++;
    }
  }

  // Out-of-window probe — only when the user DID pin a window and the
  // matched count fell short. The user asked for "this week" and we
  // found 2 — is it worth offering to look further out? Run one
  // additional filter-chain pass past `dateTo` (covering the rest of
  // the data horizon) and surface a structured `extension_hint` so
  // the agent can OFFER the user to extend EXPLICITLY. We never
  // silently widen — that would violate the user's pinned scope.
  let canExtendBeyondWindow = false;
  let extensionHint = null;
  if (userSetDate && result.events.length < MIN_RESULTS_TARGET) {
    const probeFrom = addDaysISO(dateTo, 1);
    const probeTo = addDaysISO(dateFrom, PROBE_HORIZON_DAYS);
    if (probeFrom <= probeTo) {
      const probe = await runFilterChain(probeFrom, probeTo);
      if (probe.events.length > 0) {
        // Find the actual max date among probe matches — the agent
        // uses this as the `date_to` for its follow-up search if the
        // user accepts. Anchored to a real event date (vs.
        // PROBE_HORIZON_DAYS) so the hint stays honest about where
        // the data actually ends.
        let maxDate = probe.events[0].date;
        for (const e of probe.events) {
          if (e.date && e.date > maxDate) maxDate = e.date;
        }
        canExtendBeyondWindow = true;
        extensionHint = {
          suggested_date_to: maxDate,
          count_at_least: Math.min(probe.events.length, MAX_RESULTS),
          label_he: describeWindowHe(probeFrom, maxDate),
        };
      }
    }
  }

  // Unpack the final result for downstream processing.
  let {
    events,
    totalInWindow,
    audienceExcluded,
    subtypeExcluded,
    consultationsExcluded,
    alreadyShownExcluded,
    outOfAudienceInCategory,
  } = result;

  const truncated = events.length > MAX_RESULTS;
  events = events.slice(0, MAX_RESULTS);

  // Annotate each event with which of the user-asked tags actually matched.
  // The renderer uses this to RANK matched tags ahead of incidental ones
  // inside the (capped) tag line, so the tag that explains the match is
  // always among the first few shown. Without this, tag-search results
  // look identical to keyword-search results in the UI.
  if (resolvedTags.length) {
    const matchedNames = new Set(resolvedTags.map((r) => r.label_name.toLowerCase()));
    for (const e of events) {
      const eventTagSet = new Set((e.tags || []).map((t) => String(t || "").toLowerCase()));
      e._searchedTagNames = [...matchedNames].filter((n) => eventTagSet.has(n));
    }
  }

  // Stash the hydrated objects on the context so `present_event_results`
  // can render them without another DB round-trip. We MERGE into the
  // existing cache (keyed by id) instead of replacing — a follow-up
  // search that returns 0 results must not wipe the previous hits the
  // agent might still want to render.
  //
  // IMPORTANT: lastSearchHits keeps ALL OCCURRENCES (one row per date
  // for recurring activities). The projection below collapses them to
  // one row per SERIES so Gemini doesn't drown in 8 near-identical
  // "משחקיית רגעים" rows, but the renderer (`selectSeriesForRender`)
  // and pagination logic still walk the full occurrence list from
  // lastSearchHits to compute series sizes, "כל המופעים" lists, and
  // `more_remaining_series` counts. The two read paths must stay
  // in sync (full hits server-side, collapsed view agent-side).
  if (typeof ctx.rememberSearchHits === "function") {
    ctx.rememberSearchHits(events);
  } else {
    ctx.lastSearchHits = events;
  }

  // ─────────────────────────────────────────────────────────────────
  // Collapse to series representatives for Gemini's projection.
  //
  // Why: Smarticket exposes each recurring activity as N near-identical
  // rows (same name + venue + age, only date differs). Without this
  // collapse, a query like "מה השבוע" returns ~50 rows of which only
  // ~8 are distinct series — Gemini sees 8 "משחקיית רגעים" rows in a
  // row and frequently picks them all for its 5-card budget, crowding
  // out one-time specials (the May-2026 user report: "I asked what's
  // this week and got 5 playgroup rows instead of the special Shavuot
  // events").
  //
  // The collapse mirrors what `selectSeriesForRender` does at render
  // time — same `seriesKey` (name + min/max_months) groups everything.
  // We attach `total_occurrences` so Gemini can reason about
  // "recurring vs special" explicitly in its reply text and ranking.
  //
  // Sort policy (May-2026 v2, user clarification): ALL one-time
  // events come BEFORE all recurring events, globally — not just
  // within the same calendar day. The user's explicit ask was "at
  // LEAST put recurring at the end of the search, not at the
  // beginning". Reasoning: a "what's this week" query that returns
  // 12 results with 4 specials and 8 weekly playgroups should put
  // all 4 specials in the visible top, then the playgroups below;
  // chronological-first ordering would interleave them and the
  // user-reported problem ("I got 5 משחקיית רגעים rows in a row,
  // and missed the Shavuot specials") would return on any week
  // that has a Wed-Thu special after Mon-Tue routine activity.
  //
  // Within each bucket (specials / recurring), order is
  // chronological by date+start_time — the user's secondary
  // expectation is "what's coming up soonest first". Stable id
  // tiebreak keeps the order deterministic across retries.
  //
  // Hard mute (`known_series`) is a SEPARATE filter applied
  // upstream — that's "I never want to see this again". This
  // sort is the soft policy for the un-muted recurring series:
  // they still show up, just not as the top results.
  const seriesBuckets = groupIntoSeries(events);
  const representatives = seriesBuckets.map((s) => ({
    ...s.representative,
    _seriesSize: s.occurrences.length,
  }));
  representatives.sort((a, b) => {
    // Primary: one-time (size=1) before recurring. Global, not
    // per-date — that's the whole point of this sort.
    const aOne = a._seriesSize === 1 ? 0 : 1;
    const bOne = b._seriesSize === 1 ? 0 : 1;
    if (aOne !== bOne) return aOne - bOne;
    // Secondary: chronological within each bucket.
    const aDate = a.date || "9999-12-31";
    const bDate = b.date || "9999-12-31";
    if (aDate !== bDate) return aDate < bDate ? -1 : 1;
    const aTime = a.start_time || "99:99";
    const bTime = b.start_time || "99:99";
    if (aTime !== bTime) return aTime < bTime ? -1 : 1;
    return (a.id || 0) - (b.id || 0);
  });

  // Trimmed projection — only what Gemini needs to reason over. Coordinates
  // and image stay server-side. We DO include `tags` because they help the
  // agent rank/group results and explain matches honestly to the user.
  const projection = representatives.map((e) => ({
    id: e.id,
    name: e.name,
    date: e.date,
    start_time: e.start_time,
    end_time: e.end_time,
    tickets_left: e.tickets_left,
    location: e.location,
    location_key: e.location_key,
    tags: (e.tags || []).slice(0, 5),
    // Series size hint. >1 = recurring activity with N occurrences in
    // this query window. Gemini uses this to (a) avoid wasting card
    // budget on multiple recurring rows of the same activity, and (b)
    // optionally mention "this happens X times this week" in copy.
    total_occurrences: e._seriesSize,
  }));

  return {
    events: projection,
    total_in_window: totalInWindow,
    matched: projection.length,
    // How many candidates were dropped because the user already saw a
    // card for them earlier in this session. The agent should react if
    // (matched===0 && already_shown_excluded > 0) by acknowledging
    // ("the family events I have for this week I already showed you")
    // instead of saying "nothing matches".
    already_shown_excluded: alreadyShownExcluded,
    truncated,
    window: {
      from: dateFrom,
      to: dateTo,
      label_he: describeWindowHe(dateFrom, dateTo),
      was_default: !userSetDate,
    },
    // Auto-extend telemetry. `window_extended: true` means the tool
    // widened `date_to` past the default 14-day chunk to satisfy
    // MIN_RESULTS_TARGET. Only fires when the user did NOT pin a
    // window — otherwise see `can_extend_beyond_window`.
    window_extended: windowExtended,
    // True when the auto-extend loop bailed because the DB had no
    // more events past the current window. Tells the agent to phrase
    // honestly ("העירייה לא פירסמה הלאה") rather than apologise.
    data_horizon_reached: dataHorizonReached,
    // True when the user DID pin a window AND extending past it
    // would surface more matches. The agent should ASK the user
    // whether to extend (template in system prompt); on yes, re-call
    // search_events with date_to = extension_hint.suggested_date_to.
    can_extend_beyond_window: canExtendBeyondWindow,
    extension_hint: extensionHint,
    resolved_tags: resolvedTags.map((t) => ({ asked: t.name, matched: t.label_name, label_id: t.label_id })),
    unresolved_tags: unresolvedTags,
    // Silently-dropped events by audience filter (telemetry only —
    // as of May-2026 the agent NO LONGER surfaces these; the prompt
    // section was removed because the proactive "יש גם N אירועים
    // למבוגרים" tail was noisy on every search). Populated when
    // user did NOT pin an audience and the profile-default filter
    // dropped rows. Use for monitoring, not for user-facing copy.
    audience_excluded: audienceExcluded,
    // Silently-dropped by the adult-subtype filter (May-2026). When
    // the user's profile has `age_range` set to 'young_adult' or
    // 'senior', `מבוגרים`-audience events tagged with the OPPOSITE
    // subtype (`גיל הזהב` for young, `צעירים` for senior) are
    // hidden. Counts as telemetry, not surfaced to user.
    subtype_excluded: subtypeExcluded,
    // How many candidates were dropped by the consultation filter
    // (1:1 advice events suppressed unless the user explicitly asked
    // for them). Telemetry only — the system prompt instructs the
    // agent NOT to surface this in reply_text / intro_text. The
    // user opted in to silent filtering; offering them is exactly
    // the noise they wanted gone.
    consultations_excluded: consultationsExcluded,
    // Set when the tool auto-promoted the effective audience to
    // 'adults' because the agent requested an adult-coded
    // activity_type (e.g. 'party') without an explicit audience.
    // Tells the agent the result set covers ALL adult-tier events of
    // that category — phrase honestly ("מצאתי N מסיבות"), don't
    // re-offer to "show more for adults" (already shown).
    audience_auto_promoted: audiencePromoted ? "adults" : null,
    // Up to 3 events that MATCH the requested activity_type but were
    // dropped by the audience filter (verdict or subtype-tag
    // intersection). Empty when no `activity_types` filter was set
    // or when nothing was dropped. Surfaced so the agent can briefly
    // MENTION the existence of category-matching events outside the
    // user's audience scope — e.g. when the user pins
    // `audience: 'young_adult'` AND `activity_types: ['party']`, the
    // white party (35+, no `צעירים` tag) gets dropped silently
    // otherwise. The agent's job is to weave a one-line offer into
    // `reply_text` ("ויש גם מסיבה אחת לגיל 35+ — להראות?"), NOT to
    // render cards for these — they're outside the user's pinned
    // audience and should only surface after explicit consent. See
    // the OUT-OF-AUDIENCE MENTION pattern in the system prompt.
    out_of_audience_in_category: outOfAudienceInCategory || [],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// find_event_by_name
//
// Lighter alternative when the agent has a specific show name and just
// wants to know if it exists / when it's on. Substring search over event
// titles in the configured date window.
// ─────────────────────────────────────────────────────────────────────────
const findEventByNameDecl = {
  name: "find_event_by_name",
  description:
    "Find events whose title contains the given substring (Hebrew, case-insensitive). " +
    "Use when the user names a specific show ('מטילדה', 'סיור עששיות') and just wants showtimes. " +
    "Returns up to 20 results ordered by date.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      name: { type: SchemaType.STRING, description: "Substring to match against event titles." },
      date_from: { type: SchemaType.STRING, nullable: true },
      date_to: { type: SchemaType.STRING, nullable: true },
    },
    required: ["name"],
  },
};

async function findEventByName(args, ctx) {
  const dateFrom = args?.date_from || todayISO();
  const dateTo = args?.date_to || addDaysISO(todayISO(), 60);
  const accessScopes = await getAccessScopesForUser(ctx?.telegramId);
  const events = await getAllEvents({ futureOnly: true, dateFrom, dateTo, accessScopes });
  const needle = String(args.name || "").toLowerCase().trim();
  if (!needle) return { events: [] };
  const matched = events
    .filter((e) => (e.name || "").toLowerCase().includes(needle))
    .slice(0, 20);
  if (typeof ctx.rememberSearchHits === "function") {
    ctx.rememberSearchHits(matched);
  } else {
    ctx.lastSearchHits = matched;
  }
  return {
    events: matched.map((e) => ({
      id: e.id,
      name: e.name,
      date: e.date,
      start_time: e.start_time,
      end_time: e.end_time,
      tickets_left: e.tickets_left,
      location: e.location,
      location_key: e.location_key,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// search_secondhand_tickets
//
// Active second-hand tickets (WhatsApp groups). Lighter schema than events;
// substring search by event name.
// ─────────────────────────────────────────────────────────────────────────
const searchSecondHandDecl = {
  name: "search_secondhand_tickets",
  description:
    "Search active second-hand tickets posted by users in monitored WhatsApp groups. Substring match by name.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      name: { type: SchemaType.STRING, description: "Substring of the event title." },
    },
    required: ["name"],
  },
};

async function searchSecondHand(args) {
  const tickets = await getActiveTickets();
  const needle = String(args.name || "").toLowerCase().trim();
  const out = tickets.filter((t) => (t.event_title || "").toLowerCase().includes(needle));
  return {
    tickets: out.map((t) => ({
      id: t.id,
      event_title: t.event_title,
      event_date: t.event_date,
      event_time: t.event_time,
      price: t.price,
      quantity: t.quantity,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// refresh_event
//
// Force-fetch the latest ticket count for a SINGLE event from Smarticket
// instead of relying on whatever the last scheduled scrape persisted.
// Use this when the user reports a number that disagrees with our DB
// ("the site shows 1 but you said 2") or explicitly asks to re-check.
//
// Returns a small payload describing what changed; the agent should
// then phrase the answer naturally ("בדקתי שוב — עכשיו רק כרטיס אחד")
// rather than dump the JSON.
//
// Rate-limited inside the service: 30s/event, 5/minute/user. Errors
// surface as `{ ok: false, error }` so the agent can choose to retry,
// apologise, or fall back gracefully.
// ─────────────────────────────────────────────────────────────────────────
const refreshEventDecl = {
  name: "refresh_event",
  description:
    "Force-fetch the latest ticket count for ONE event directly from Smarticket. " +
    "Use this when the user disputes the ticket count you reported, asks to re-check, or specifically wants the freshest data. " +
    "DO NOT call this on every search — it costs an external API hit. Call it for ONE specific event the user is asking about. " +
    "Returns { ok, event:{id,name,date,start_time,end_time,tickets_left,is_sold_out,location,last_checked}, changed, previous_tickets_left, new_tickets_left, was_cached } " +
    "or { ok:false, error } where error ∈ {rate_limited, not_found, archived, fetch_failed}. " +
    "If `changed` is true, explicitly tell the user the new count and what it was before. " +
    "If `changed` is false AND the user thought it was different, suggest they may be looking at a different date/instance.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      event_id: {
        type: SchemaType.NUMBER,
        description: "The numeric Smarticket event id, e.g. 22081. Find it in earlier search results.",
      },
    },
    required: ["event_id"],
  },
};

async function refreshEventTool(args, ctx) {
  const eventId = Number(args?.event_id);
  if (!Number.isFinite(eventId)) {
    return { ok: false, error: "invalid_event_id" };
  }
  const result = await refreshEvent(eventId, { telegramId: ctx?.telegramId });
  if (!result.ok) return result;

  // Trim the payload sent back to Gemini — keep only fields useful for
  // phrasing the reply. The full enriched event row stays server-side.
  // We expose `last_changed_at` (sql/029) alongside `last_checked` so
  // the model can phrase replies with confidence: "המספר הזה לא זז כבר
  // 4 שעות" reads very differently than "המספר זז לפני שנייה".
  const e = result.event || {};
  return {
    ok: true,
    event: {
      id: e.id,
      name: e.name,
      date: e.date,
      start_time: e.start_time,
      end_time: e.end_time,
      tickets_left: e.tickets_left,
      is_sold_out: e.is_sold_out,
      location: e.location,
      last_checked: e.last_checked,
      last_changed_at: e.last_changed_at,
    },
    changed: result.changed,
    previous_tickets_left: result.previous_tickets_left,
    new_tickets_left: result.new_tickets_left,
    was_cached: result.was_cached,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// peek_community_count
//
// Count-only probe for community-gated content. Lets the agent ask "how
// many events would the user see if they were a member of community X?"
// without actually revealing those events to a non-member. Drives the
// HYBRID FLOW (see system prompt): when a user's query signals interest
// in gated content ("הרצאות לוותיקים", "מסיבות להט\"ב", "אירועי מילואים"),
// the agent uses this tool to decide whether it's worth offering
// membership, then either continues with `search_events` (if the user
// is already a member, or has just opted in via `update_profile`) or
// short-circuits with an honest "אין כרגע" if the community is empty.
//
// PRIVACY CONTRACT — strictly no content leakage. The tool returns only
// the count + the date window + whether the user is already a member.
// Event ids, titles, locations, anything that could identify a specific
// event NEVER leaves the server. Non-members get a number, nothing more.
//
// Why a separate tool (not a flag on search_events): keeping the
// privacy boundary explicit makes the contract auditable. A future
// change to `search_events` that accidentally widens its access_scopes
// can't leak community content if there's a separate, narrow tool
// covering this use case.
// ─────────────────────────────────────────────────────────────────────────
const COMMUNITY_ENUM = [
  "community-seniors",
  "community-miluim",
  "community-lgbtq",
  "community-disabilities",
];

const peekCommunityCountDecl = {
  name: "peek_community_count",
  description:
    "COUNT-ONLY probe for community-gated events. Use this BEFORE offering the user to join a community — it tells you whether there's actually enough content there to be worth the ask. " +
    "Returns { community, count, window:{from,to,label_he}, is_member } — NO event titles, NO ids, NO locations. The user cannot see anything from this tool until they actually join the community (call update_profile.communities) and then you re-run `search_events`. " +
    "When `is_member: true`, the user is already in that community and `search_events` will surface its events normally — DO NOT prompt to join again. " +
    "Pass the same date filters you would on `search_events`; defaults to the next 14 days when omitted.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      community: {
        type: SchemaType.STRING,
        format: "enum",
        enum: COMMUNITY_ENUM,
        description:
          "The community access scope to probe. One of: " +
          "'community-seniors' (אזרחים ותיקים), " +
          "'community-miluim' (משרתי מילואים), " +
          "'community-lgbtq' (קהילה גאה), " +
          "'community-disabilities' (אנשים עם מוגבלויות).",
      },
      date_from: {
        type: SchemaType.STRING,
        nullable: true,
        description: "ISO YYYY-MM-DD inclusive lower bound. Default: today.",
      },
      date_to: {
        type: SchemaType.STRING,
        nullable: true,
        description: "ISO YYYY-MM-DD inclusive upper bound. Default: date_from + 14 days.",
      },
      date_preset: {
        type: SchemaType.STRING,
        nullable: true,
        format: "enum",
        enum: ["today", "tomorrow", "this_week", "next_week", "this_month"],
        description: "Convenience for natural-language date scopes. Overrides date_from/date_to when set.",
      },
    },
    required: ["community"],
  },
};

async function peekCommunityCountTool(args, ctx) {
  const community = String(args?.community || "").trim();
  if (!COMMUNITY_ENUM.includes(community)) {
    return { ok: false, error: "invalid_community" };
  }

  const preset = resolveDatePreset(args?.date_preset);
  const dateFrom = preset?.from || args?.date_from || todayISO();
  const dateTo =
    preset?.to || args?.date_to || addDaysISO(dateFrom, DEFAULT_WINDOW_DAYS);

  // Is the user already a member? If so the agent doesn't need
  // to gate — surface that state and let it fall through to a
  // regular search_events call instead of prompting to join.
  const userScopes = await getAccessScopesForUser(ctx?.telegramId);
  const isMember = Array.isArray(userScopes) && userScopes.includes(community);

  // Count events restricted to ONLY the requested community scope.
  // Note: this deliberately bypasses the user's normal access scope
  // mix. We're answering "what's there to see in <community>?",
  // not "what would the user see right now?". Membership status is
  // reported separately via `is_member`.
  //
  // We don't apply audience / age / proximity filters here — the
  // tool's only job is to answer "is there content here?" with a
  // raw count. Once the user joins and `search_events` runs, the
  // full filter chain applies.
  const events = await getAllEvents({
    futureOnly: true,
    dateFrom,
    dateTo,
    accessScopes: [community],
  });

  return {
    community,
    count: events.length,
    window: {
      from: dateFrom,
      to: dateTo,
      label_he: describeWindowHe(dateFrom, dateTo),
    },
    is_member: isMember,
  };
}

module.exports = {
  declarations: [
    searchEventsDecl,
    findEventByNameDecl,
    searchSecondHandDecl,
    refreshEventDecl,
    peekCommunityCountDecl,
  ],
  handlers: {
    search_events: searchEventsTool,
    find_event_by_name: findEventByName,
    search_secondhand_tickets: searchSecondHand,
    refresh_event: refreshEventTool,
    peek_community_count: peekCommunityCountTool,
  },
};
