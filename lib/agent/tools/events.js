const { SchemaType } = require("@google/generative-ai");
const { getAllEvents } = require("../../../bot/matchingService");
const { getAccessScopesForUser } = require("../../../bot/profileService");
const { getActiveTickets } = require("../../ticketService");
const { evaluateProximity } = require("../../geocoding");
const {
  AUDIENCE_KEYS,
  ACTIVITY_TYPE_KEYS,
  audienceVerdict,
  categoryMatches,
  ageMatches,
  deriveDefaultAudienceSet,
} = require("../../categories");
const labelStore = require("../../labelStore");
const { refreshEvent } = require("../../eventRefreshService");
const sessionStore = require("../sessionStore");
const {
  todayISO,
  weekRangeIL,
  nextWeekRangeIL,
  monthAheadRangeIL,
  addDaysISO,
  describeWindowHe,
} = require("../../timeContext");

const MAX_RESULTS = 30;
// Hard ceiling on how far ahead a single search_events call can look.
// Wider ranges (e.g. "ביוני או ביולי") get clamped to the first
// MAX_WINDOW_DAYS-day chunk; the unread tail comes back as `next_window`
// so the agent can offer the user "show me the next 2 weeks". Cap chosen
// to match the existing default scope and the user's mental model
// ("2 weeks at a time"). Bumping this without thought will balloon the
// candidate set and may push us back into the >120s territory that
// triggered Telegraf's handlerTimeout last week.
const MAX_WINDOW_DAYS = 14;

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
    "Empty filters = the next 14 days, all audiences. " +
    "HARD 14-DAY WINDOW: if date_from..date_to spans more than 14 days, the tool CLAMPS to the first 14 days and returns `clamped:true` with the user's original range in `requested_window` and the next 14-day chunk in `next_window`. The agent MUST mention the cap in intro_text and offer continuation (see system prompt). " +
    "SESSION DEDUPE: events already rendered as cards earlier in this conversation are filtered out automatically — `already_shown_excluded` reports how many were dropped. If `matched===0` AND `already_shown_excluded > 0`, tell the user the matches were already shown (don't pretend none exist). " +
    "Returns { events, total_in_window, matched, already_shown_excluded, truncated, window:{from,to,label_he,was_default}, clamped, requested_window, next_window, resolved_tags, unresolved_tags }. " +
    "Use `window.label_he` (e.g. 'בשבועיים הקרובים', 'בין 5 ביוני ל-19 ביוני') verbatim in your `intro_text` when presenting results.",
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
        description: "ISO YYYY-MM-DD inclusive upper bound. Default: date_from + 14 days. HARD CAP: if the requested span is > 14 days, the tool silently clamps to date_from + 14 days and returns `next_window` with the remainder — the agent must surface this to the user (see system prompt).",
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
  const userSetDate = !!(preset || args?.date_from || args?.date_to);
  const dateFrom = preset?.from || args?.date_from || todayISO();
  const requestedDateTo = preset?.to || args?.date_to || addDaysISO(dateFrom, MAX_WINDOW_DAYS);

  // Hard 14-day cap. If the agent (because the user said "ביוני או
  // ביולי" or "החודש הבא וגם הבא אחריו") asks for a wider window, we
  // CLAMP and tell it about the next chunk via `next_window`. The
  // system prompt instructs the agent to (a) mention the cap in
  // intro_text and (b) offer continuation. Doing the clamp here in
  // the tool (not in the prompt) means a forgetful Gemini round can't
  // bypass the safety: we will not fetch 90 days of candidates and
  // burn the agent's 75s budget on a single search.
  const maxAllowedDateTo = addDaysISO(dateFrom, MAX_WINDOW_DAYS);
  const clamped = requestedDateTo > maxAllowedDateTo;
  const dateTo = clamped ? maxAllowedDateTo : requestedDateTo;

  // Compute the next 14-day chunk only if there's actually unread
  // tail. ISO YYYY-MM-DD strings compare lexicographically, which is
  // why a plain `>` works without parsing into Date objects.
  let nextWindow = null;
  if (clamped) {
    const nextFrom = addDaysISO(dateTo, 1);
    if (nextFrom <= requestedDateTo) {
      const nextChunkEnd = addDaysISO(nextFrom, MAX_WINDOW_DAYS - 1);
      const nextTo = nextChunkEnd < requestedDateTo ? nextChunkEnd : requestedDateTo;
      nextWindow = { date_from: nextFrom, date_to: nextTo };
    }
  }

  const format = args?.format && args.format !== "any" ? args.format : null;

  // Resolve which community-access scopes this user is allowed to see.
  // 'open' is always present; community values appear when the user has
  // declared "member" in their profile via update_profile.communities.
  const accessScopes = await getAccessScopesForUser(ctx?.telegramId);

  // Fetch the candidate window from Supabase (already deduped, archived
  // filtered, past-time filtered for today, admin junk dropped).
  let events = await getAllEvents({
    futureOnly: true,
    dateFrom,
    dateTo,
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
  if (args?.audience === "all") {
    // Explicit opt-in to ALL audience tiers — no filtering.
  } else if (args?.audience) {
    events = events
      .map((e) => {
        const v = audienceVerdict(e.name, args.audience, e);
        e._audience_verdict = v;
        return e;
      })
      .filter((e) => e._audience_verdict.decision === "include");
  } else {
    const allowedAudiences = deriveDefaultAudienceSet(ctx.profile);
    events = events.filter((e) => !e.audience || allowedAudiences.has(e.audience));
  }

  // Activity-type filter — bridges English keys (tour/workshop/…) to
  // the Hebrew `category` stored on each event row. Permissive: events
  // with no category fall through and are kept.
  if (Array.isArray(args?.activity_types) && args.activity_types.length) {
    events = events.filter((e) => categoryMatches(e, args.activity_types));
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

  // Tag filter — resolve user's free-form Hebrew topic words against the
  // labels dictionary, then keep events whose tag_ids overlap. Tags that
  // don't resolve to any known label are surfaced back to the agent in
  // `unresolved_tags` so it can offer a topic watcher: "אין כרגע אירוע
  // עם התגית X — לעקוב אחרי תגית זו?".
  //
  // IMPORTANT: when NONE of the user's tags resolves to a known label we
  // deliberately DO NOT zero out the result set. The user may have named
  // a smarticket cluster ("שבת קהילה") that doesn't exist in our labels
  // dictionary, but whose meaning is still encoded in the event TITLE,
  // the AUDIENCE filter, or KEYWORDS the agent passed alongside. Those
  // signals must continue to apply, and the agent gets `unresolved_tags`
  // back so it can decide what to do (offer a watcher / suggest similar /
  // re-ask). This was a real bug — see event ids 22396/22397/22399/22400.
  let unresolvedTags = [];
  let resolvedTags = [];
  if (Array.isArray(args?.tags) && args.tags.length) {
    const { resolved, unresolved } = await labelStore.resolveTagNamesToIds(args.tags);
    resolvedTags = resolved;
    unresolvedTags = unresolved;
    if (resolved.length) {
      const wantIds = new Set(resolved.map((r) => r.label_id));
      events = events.filter((e) => {
        const ids = e.tag_ids || [];
        return ids.some((id) => wantIds.has(id));
      });
    }
    // If `resolved.length === 0`: pass through. The other filters
    // (keywords / audience / date / proximity) still apply, and the
    // unresolved list is reported to the agent.
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
  if (typeof ctx.rememberSearchHits === "function") {
    ctx.rememberSearchHits(events);
  } else {
    ctx.lastSearchHits = events;
  }

  // Trimmed projection — only what Gemini needs to reason over. Coordinates
  // and image stay server-side. We DO include `tags` because they help the
  // agent rank/group results and explain matches honestly to the user.
  const projection = events.map((e) => ({
    id: e.id,
    name: e.name,
    date: e.date,
    start_time: e.start_time,
    end_time: e.end_time,
    tickets_left: e.tickets_left,
    location: e.location,
    location_key: e.location_key,
    tags: (e.tags || []).slice(0, 5),
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
    // Clamp telemetry. `clamped: true` means the user asked for more
    // than MAX_WINDOW_DAYS and we showed only the first chunk.
    // `requested_window` echoes the user's original ask so the agent
    // can honestly say "you wanted X..Y but I'm showing X..Y-14".
    // `next_window` is null when there's nothing left to offer.
    clamped,
    requested_window: clamped ? { from: dateFrom, to: requestedDateTo } : null,
    next_window: nextWindow
      ? { ...nextWindow, label_he: describeWindowHe(nextWindow.date_from, nextWindow.date_to) }
      : null,
    resolved_tags: resolvedTags.map((t) => ({ asked: t.name, matched: t.label_name, label_id: t.label_id })),
    unresolved_tags: unresolvedTags,
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

module.exports = {
  declarations: [searchEventsDecl, findEventByNameDecl, searchSecondHandDecl, refreshEventDecl],
  handlers: {
    search_events: searchEventsTool,
    find_event_by_name: findEventByName,
    search_secondhand_tickets: searchSecondHand,
    refresh_event: refreshEventTool,
  },
};
