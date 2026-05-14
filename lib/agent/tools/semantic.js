const { SchemaType } = require("@google/generative-ai");
const { findMatchesForUser, getAllEvents } = require("../../../bot/matchingService");
const { accessScopesForProfile, getAccessScopesForUser } = require("../../../bot/profileService");
const { todayISO, addDaysISO } = require("../../timeContext");

// ─────────────────────────────────────────────────────────────────────────
// semantic_filter_events
//
// AI-driven semantic match — used as a LAST RESORT when keyword filters
// (`search_events`) aren't enough. Examples: "אווירה רגועה לתינוק",
// "פעילות שתשמח אותו אחרי גן" — vague natural-language criteria that
// can't be substring-matched.
//
// The agent should call `search_events` first to narrow candidates, then
// call this only on the resulting subset (max 30). If `search_events` is
// already specific enough, skip this entirely.
// ─────────────────────────────────────────────────────────────────────────
const semanticFilterDecl = {
  name: "semantic_filter_events",
  description:
    "AI semantic match against a candidate event list. Pass the user's natural-language criteria " +
    "and either explicit event IDs (preferred) or a date window. Returns up to 10 events with reasons. " +
    "EXPENSIVE — only use when keyword filters are too narrow. Skip for normal date+venue+audience searches.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      user_query: { type: SchemaType.STRING, description: "User's natural-language criteria in Hebrew." },
      event_ids: {
        type: SchemaType.ARRAY,
        nullable: true,
        items: { type: SchemaType.INTEGER },
        description: "Candidate IDs (from a prior search_events). Strongly preferred over date_range.",
      },
      date_from: { type: SchemaType.STRING, nullable: true },
      date_to: { type: SchemaType.STRING, nullable: true },
    },
    required: ["user_query"],
  },
};

async function semanticFilterEvents(args, ctx) {
  // Compute community-access scopes once for this user. Prefer the
  // in-context profile (already loaded by the orchestrator) to save
  // a round-trip; fall back to a fresh fetch by telegramId when the
  // tool is invoked outside that flow.
  const accessScopes = ctx?.profile
    ? accessScopesForProfile(ctx.profile)
    : await getAccessScopesForUser(ctx?.telegramId);

  // Resolve the candidate set: either honor caller-provided event_ids
  // (preferred — the agent should narrow with search_events first) or
  // pull a fresh window. The latter is rare and intentionally bounded.
  let events;
  if (Array.isArray(args.event_ids) && args.event_ids.length) {
    const wantedSet = new Set(args.event_ids.map((n) => parseInt(n, 10)));
    // Prefer in-memory hits if the agent has them, else fetch.
    const hits = ctx.lastSearchHits || [];
    if (hits.some((e) => wantedSet.has(e.id))) {
      events = hits.filter((e) => wantedSet.has(e.id));
    } else {
      const all = await getAllEvents({
        futureOnly: true,
        dateFrom: args.date_from || todayISO(),
        dateTo: args.date_to || addDaysISO(todayISO(), 30),
        accessScopes,
      });
      events = all.filter((e) => wantedSet.has(e.id));
    }
  } else {
    events = await getAllEvents({
      futureOnly: true,
      dateFrom: args.date_from || todayISO(),
      dateTo: args.date_to || addDaysISO(todayISO(), 14),
      accessScopes,
    });
  }

  if (!events.length) return { matches: [], total_candidates: 0 };

  const profile = ctx.profile || {};
  const matches = await findMatchesForUser(
    {
      first_name: profile?.first_name,
      user_context: profile?.user_context || {},
      active_watch_list: [],
    },
    events,
    {
      userQuery: args.user_query,
      userTokens: [],
      watchedEventIds: [],
      rawMessage: args.user_query,
    },
  );

  // Hydrate so present_event_results can render without another fetch.
  // Merge into the per-turn cache instead of replacing — see
  // orchestrator.rememberSearchHits for the rationale.
  const byId = new Map(events.map((e) => [e.id, e]));
  const hydrated = (matches || [])
    .map((m) => byId.get(m.event_id))
    .filter(Boolean);
  if (typeof ctx.rememberSearchHits === "function") {
    ctx.rememberSearchHits(hydrated);
  } else {
    ctx.lastSearchHits = hydrated;
  }

  return {
    matches: (matches || []).slice(0, 10).map((m) => ({
      event_id: m.event_id,
      confidence: m.confidence,
      reason: m.reason,
    })),
    total_candidates: events.length,
    fallback_used: !!matches._fallbackUsed,
  };
}

module.exports = {
  declarations: [semanticFilterDecl],
  handlers: { semantic_filter_events: semanticFilterEvents },
};
