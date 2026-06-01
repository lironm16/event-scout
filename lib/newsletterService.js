// Weekly newsletter generator — deterministic, per-user, no Gemini.
//
// Replaces the live `notifySavedSearchMatchesFor` push (api/check.js)
// per the May-2026 spec. Saved searches still exist in the DB and
// still drive low-stock pushes (lib/lowStockNotifier.js), but the
// proactive "I found something for you" path is now batched into a
// weekly digest delivered by lib/newsletterScheduler.js.
//
// Design choices:
//
//  • DETERMINISTIC FILTERS, NO LLM. Per-user Gemini calls every week
//    is both costly and slow at the per-tick batch size we expect.
//    The agent-driven search still uses Gemini for relevance ranking;
//    the digest uses deterministic profile filters (audience, ages,
//    proximity, access, dislikes) and ranks by tag-overlap with
//    interests + recency.
//
//  • NEW SINCE LAST DELIVERY. Each user's `last_sent_at` defines the
//    threshold. Events qualify when:
//       events.first_seen_at  > last_sent_at  (truly new)
//       OR
//       events.last_changed_at > last_sent_at (stock came back / time moved)
//    On the first-ever delivery (last_sent_at IS NULL) we cap at the
//    last 14 days so a new subscriber doesn't get firehose'd by every
//    event in the catalog.
//
//  • HARD vs SOFT signals:
//       HARD (skip)   — archived, past, sold-out, audience mismatch,
//                       age mismatch (when user has kids), proximity
//                       fail (when user explicitly chose walking),
//                       venue in profile.disliked_venues,
//                       any prior event_feedback row from this user.
//       SOFT (demote) — tags overlap profile.disliked_tags.
//    The asymmetry is intentional: "I don't like the topic" should
//    rank an event LOWER but not hide it (the same topic can land
//    differently with different framing); "I don't like this venue"
//    is an actionable, repeatable opt-out.
//
//  • CAP at MAX_EVENTS_PER_DIGEST. Beyond that the digest stops being
//    "things to consider" and becomes "scroll-through fatigue".

const supabase = require("./supabase");
const { getAllEvents } = require("../bot/matchingService");
const {
  audienceVerdict,
  deriveDefaultAudienceSet,
  shouldExcludeAdultSubtypeEvent,
  householdKidsFitEvent,
} = require("./categories");
const { shouldHideChildEventForProfile } = require("./childEventPrefs");
const { accessScopesForProfile } = require("../bot/profileService");
const { evaluateProximity } = require("./geocoding");
const { todayISO, addDaysISO, isEventInPast } = require("./timeContext");

const MAX_EVENTS_PER_DIGEST = 10;
// On a first-ever delivery (no last_sent_at), look back this many days
// instead of "everything since the dawn of time". 14 days matches the
// hard-cap on the search tool so behaviour stays consistent with what
// users see when they ask the agent for "events".
const FIRST_DELIVERY_LOOKBACK_DAYS = 14;
// Per-event proximity geocoding is expensive (Google Routes API). We
// cap how many events we test per user per delivery so a poorly
// configured profile doesn't burn through quota. Anything above this
// cap is included without a proximity check — better to over-include
// than to silently drop events because we ran out of geocode budget.
const PROXIMITY_CHECK_BUDGET = 30;

// ────────────────────────────────────────────────────────────────────
// State accessors — wrap the user_newsletter_state row reads/writes
// behind tiny helpers so callers don't have to know the column layout.
// ────────────────────────────────────────────────────────────────────

/** Returns null when the user has never been delivered to. */
async function getNewsletterState(telegramId) {
  const { data, error } = await supabase
    .from("user_newsletter_state")
    .select("telegram_id, last_sent_at, paused, delivery_dow, delivery_hour, subscribed_at")
    .eq("telegram_id", String(telegramId))
    .maybeSingle();
  if (error) {
    // Table-missing case is benign — sql/047 hasn't been applied yet.
    // The caller treats null as "default state".
    if (error.code === "42P01" || error.code === "PGRST205") return null;
    throw new Error(`getNewsletterState failed: ${error.message}`);
  }
  return data || null;
}

/** Upsert subscription state. Idempotent — safe to call repeatedly. */
async function setNewsletterPaused(telegramId, paused) {
  const row = {
    telegram_id: String(telegramId),
    paused: !!paused,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase
    .from("user_newsletter_state")
    .upsert(row, { onConflict: "telegram_id" });
  if (error) throw new Error(`setNewsletterPaused failed: ${error.message}`);
}

/** Stamp `last_sent_at` after a successful (or empty) delivery. */
async function markNewsletterDelivered(telegramId, when = new Date()) {
  const iso = when.toISOString();
  const row = {
    telegram_id: String(telegramId),
    last_sent_at: iso,
    updated_at: iso,
  };
  const { error } = await supabase
    .from("user_newsletter_state")
    .upsert(row, { onConflict: "telegram_id" });
  if (error) throw new Error(`markNewsletterDelivered failed: ${error.message}`);
}

// ────────────────────────────────────────────────────────────────────
// Generate (read-only)
// ────────────────────────────────────────────────────────────────────

async function getUserFeedbackEventIds(telegramId) {
  const { data, error } = await supabase
    .from("event_feedback")
    .select("event_id")
    .eq("telegram_id", String(telegramId));
  if (error) {
    // Table-missing degrades to "no feedback known" instead of
    // refusing to deliver. The feedback module already surfaces a
    // one-shot warning in that case (lib/feedbackService.js); we
    // don't re-spam it from here.
    if (error.code === "42P01" || error.code === "PGRST205") return new Set();
    console.warn(`[Newsletter] event_feedback read failed: ${error.message}`);
    return new Set();
  }
  return new Set((data || []).map((r) => r.event_id));
}

function asISOorNull(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

// Apply the "new since last delivery" filter in JS rather than at the
// DB level: getAllEvents() runs through expandLabels() which we want
// for ranking, so we accept the slightly larger fetch in exchange for
// keeping the SQL fast-path simple.
function filterNewSince(events, lastSentAt) {
  // First delivery — no `last_sent_at` to compare against. Fall back
  // to the lookback window so the user doesn't get a catalog-wide
  // welcome blast.
  if (!lastSentAt) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - FIRST_DELIVERY_LOOKBACK_DAYS);
    const cutoffIso = cutoff.toISOString();
    return events.filter((e) => {
      const seen = asISOorNull(e.first_seen_at) || asISOorNull(e.last_updated);
      return seen && seen >= cutoffIso;
    });
  }
  return events.filter((e) => {
    const seen = asISOorNull(e.first_seen_at);
    const changed = asISOorNull(e.last_changed_at);
    return (seen && seen > lastSentAt) || (changed && changed > lastSentAt);
  });
}

// Series-level suppression — recurring events the user has marked
// "I know this exists, don't bring it up again" via the new
// `already_known` feedback reason. The key is the same shape that
// bot/telegramBot.js#seriesKeyFor produces: "<lower-trimmed-name>::<location_key>".
// Pure string comparison — fast even at the cap of 100 entries per user.
function makeSeriesKey(name, locationKey) {
  const lower = String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!lower) return null;
  return `${lower}::${locationKey || ""}`;
}

// Audience + age filter — uses the same primitives the live search
// uses so the digest behaves identically to "what would the agent
// surface right now?".
function passesProfileFilters(event, profile, defaultAudienceSet) {
  if (shouldHideChildEventForProfile(event, profile)) return false;

  // Audience verdict: skip when the event's audience ENUM doesn't
  // overlap the user's default set. We pass `null` as audienceEN
  // because the digest never asks the user "for who?" — defaults are
  // derived from profile.kids.
  const verdict = audienceVerdict(event.name, null, {
    audience: event.audience,
    category: event.category,
  });
  if (verdict?.decision === "exclude") return false;
  // Default-set narrowing: when the user has kids, exclude
  // adult-only entries (and vice versa). audienceVerdict above only
  // catches mismatches against an explicit audience filter; the
  // default-set check is the digest-specific cover.
  if (event.audience && !defaultAudienceSet.has(event.audience)) return false;

  if (shouldExcludeAdultSubtypeEvent(event, profile)) return false;

  // Age filter — when profile lists kids' ages, drop events outside their range
  // (includes "עד גיל שנה" inferred from the event title when max_months is null).
  const kids = profile?.user_context?.kids || [];
  if (Array.isArray(kids) && kids.length) {
    const { kidsAgesYears } = require("./kidAge");
    const ages = kidsAgesYears(kids);
    if (ages.length && !householdKidsFitEvent(event, ages, kids)) return false;
  }
  return true;
}

// Proximity filter — opt-in based on the user's walking budget.
// Returns true/false synchronously when the answer is deterministic
// (no home coords, virtual event, user has no budget configured);
// otherwise calls evaluateProximity. Each evaluateProximity call may
// hit Google Routes so we share a `budget` counter with the caller.
async function passesProximityFilter(event, profile, budgetRef) {
  const constraints = profile?.user_context?.constraints || {};
  const home = constraints.home_coordinates || null;
  const maxWalk = constraints.max_walking_minutes;
  // No home coords OR no max-walk preference → not opted into the
  // filter at all. Skip the check entirely.
  if (!home?.lat || !home?.lng) return true;
  if (!Number.isFinite(maxWalk) || maxWalk <= 0) return true;
  // User accepts driving (proximity_preference = "any" / "drive") →
  // no need to filter; the badge will indicate distance on the card.
  if (maxWalk > 15) return true;
  // Tight walking budget — actually run the proximity calc.
  if (budgetRef.remaining <= 0) return true;
  budgetRef.remaining--;
  const venueCoords =
    event._coords?.lat != null && event._coords?.lng != null
      ? { lat: event._coords.lat, lng: event._coords.lng }
      : null;
  const result = await evaluateProximity(
    { lat: home.lat, lng: home.lng },
    event.location || null,
    maxWalk,
    venueCoords,
  );
  // Unresolvable venues (no geocode hit) → permissive include.
  if (!result?.resolved) return true;
  return !result.requires_car;
}

// Soft-rank score. Higher = better. Used for sorting the filtered
// candidate list. The big multipliers (interest match) dominate;
// the tie-breakers (recency, low-stock) just push borderline events
// up.
function computeScore(event, interestsLower, dislikedTagsLower) {
  let score = 0;
  const tags = Array.isArray(event.tags) ? event.tags : [];
  if (tags.length) {
    let interestHits = 0;
    let dislikeHits = 0;
    for (const t of tags) {
      const lower = String(t || "").trim().toLowerCase();
      if (interestsLower.has(lower)) interestHits++;
      if (dislikedTagsLower.has(lower)) dislikeHits++;
    }
    score += interestHits * 100;
    score -= dislikeHits * 25;
  }
  // Low-stock nudge — if the event is in the ⚠️ ≤10 zone, surface
  // it slightly higher than equivalent fully-stocked ones. The user
  // already gets a low-stock push live; the nudge here makes sure
  // the digest doesn't bury it below newer-but-less-urgent items.
  if (event.tickets_left != null && event.tickets_left > 0 && event.tickets_left <= 10) {
    score += 5;
  }
  return score;
}

/**
 * Generate the digest payload for ONE user.
 *
 * @param {string|number} telegramId
 * @returns {Promise<{ events: Array, lastSentAt: string|null, reason: 'no_profile'|'empty'|'ok' }>}
 */
async function generateUserNewsletter(telegramId) {
  const id = String(telegramId);

  const { data: profile, error: profErr } = await supabase
    .from("profiles")
    .select("telegram_id, first_name, user_context")
    .eq("telegram_id", id)
    .maybeSingle();
  if (profErr) throw new Error(`Profile read failed: ${profErr.message}`);
  if (!profile) {
    return { events: [], lastSentAt: null, reason: "no_profile" };
  }

  const state = await getNewsletterState(id);
  const lastSentAt = state?.last_sent_at || null;

  const accessScopes = accessScopesForProfile(profile);
  const defaultAudienceSet = deriveDefaultAudienceSet(profile);

  // Cap the date window — 60 days forward is enough to cover the next
  // newsletter cycle plus 3-4 weeks of planning headroom. Anything
  // farther out is more discovery than action.
  const dateTo = addDaysISO(todayISO(), 60);

  let events = await getAllEvents({
    futureOnly: true,
    dateTo,
    accessScopes,
  });

  // The matchingService selection didn't include first_seen_at /
  // last_changed_at (it's optimised for the hot search path). Read
  // those columns in a single bulk query and zip them onto the
  // events here. We deliberately don't push this into getAllEvents
  // — most callers don't need it, and the hot path stays lean.
  if (events.length) {
    const ids = events.map((e) => e.id).filter(Number.isFinite);
    const { data: tsData, error: tsErr } = await supabase
      .from("events")
      .select("id, first_seen_at, last_changed_at, last_updated, tickets_left, is_sold_out")
      .in("id", ids);
    if (tsErr) {
      // If first_seen_at isn't there yet (sql/047 unapplied), fall
      // back to last_updated so we still ship a useful digest.
      console.warn(`[Newsletter] timestamp join failed: ${tsErr.message}`);
    } else {
      const tsMap = new Map((tsData || []).map((r) => [r.id, r]));
      for (const e of events) {
        const meta = tsMap.get(e.id);
        if (meta) {
          e.first_seen_at = meta.first_seen_at;
          e.last_changed_at = meta.last_changed_at;
          e.last_updated = meta.last_updated;
          e.is_sold_out = meta.is_sold_out;
          // Re-stamp tickets_left from the fresh read in case the
          // labels expansion path read a slightly stale value.
          if (meta.tickets_left !== undefined) e.tickets_left = meta.tickets_left;
        }
      }
    }
  }

  // Hard: drop sold-out events. The matchingService base path
  // already filters them via tickets_left>0, but `getAllEvents`
  // doesn't (it's the broader path). Re-check here for safety.
  events = events.filter((e) => {
    if (e.is_sold_out) return false;
    if (e.tickets_left === 0) return false;
    return true;
  });

  // Hard: drop past events. getAllEvents() filters date >= today,
  // but an event TODAY whose start_time has already passed is still
  // "today" by date — we want it out of the digest. The same
  // primitive the live search uses (isEventInPast) handles both
  // checks, so the digest behaves identically to "what would the
  // agent surface right now?".
  events = events.filter((e) => !isEventInPast(e.date, e.start_time, e.end_time));

  // Hard: series-level suppression for events the user marked
  // `already_known` (the "I know משחקיית רגעים, stop reminding me"
  // pattern). The series key is name + location_key; we precompute
  // the user's set once for O(1) per-event lookups below.
  const ctxKnownSeries = profile.user_context?.known_series;
  const knownSeriesSet = Array.isArray(ctxKnownSeries)
    ? new Set(ctxKnownSeries.map(String).filter(Boolean))
    : null;
  if (knownSeriesSet && knownSeriesSet.size) {
    events = events.filter((e) => {
      const key = makeSeriesKey(e.name, e.location_key);
      return !key || !knownSeriesSet.has(key);
    });
  }

  // Hard: "new since last delivery" — first-delivery uses a lookback
  // window so a new subscriber's first digest isn't a catalog dump.
  events = filterNewSince(events, lastSentAt);

  // Hard: drop anything the user has already given feedback on.
  // Includes both "❌ לא מתאים" rejects AND the bulk "not relevant"
  // path from the newsletter itself — once a user marks an event,
  // they never see it again.
  const seenFeedback = await getUserFeedbackEventIds(id);
  if (seenFeedback.size) {
    events = events.filter((e) => !seenFeedback.has(e.id));
  }

  // Hard: drop events at venues the user disliked.
  const ctx = profile.user_context || {};
  const dislikedVenues = new Set(
    (ctx.disliked_venues || [])
      .map((v) => (typeof v === "string" ? v.trim() : null))
      .filter(Boolean),
  );
  if (dislikedVenues.size) {
    events = events.filter((e) => !dislikedVenues.has(e.location_key));
  }

  // Hard: profile + audience + age filters.
  events = events.filter((e) => passesProfileFilters(e, profile, defaultAudienceSet));

  // Hard (but budgeted): proximity. Only filters when the user has a
  // tight walking preference.
  const proximityBudget = { remaining: PROXIMITY_CHECK_BUDGET };
  const passedProximity = [];
  for (const e of events) {
    const ok = await passesProximityFilter(e, profile, proximityBudget);
    if (ok) passedProximity.push(e);
  }
  events = passedProximity;

  // Soft rank — interest hits dominate, low-stock nudge, then recency.
  const interestsLower = new Set(
    (ctx.interests || []).map((s) => String(s || "").trim().toLowerCase()).filter(Boolean),
  );
  const dislikedTagsLower = new Set(
    (ctx.disliked_tags || []).map((s) => String(s || "").trim().toLowerCase()).filter(Boolean),
  );
  for (const e of events) {
    e._newsletterScore = computeScore(e, interestsLower, dislikedTagsLower);
  }
  events.sort((a, b) => {
    if (b._newsletterScore !== a._newsletterScore) return b._newsletterScore - a._newsletterScore;
    // Tie-break on chronological date (earlier first), then on
    // first_seen_at DESC so newer rows surface above older ties.
    if (a.date !== b.date) {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date < b.date ? -1 : 1;
    }
    return (b.first_seen_at || "").localeCompare(a.first_seen_at || "");
  });

  const out = events.slice(0, MAX_EVENTS_PER_DIGEST);
  return {
    events: out,
    lastSentAt,
    reason: out.length ? "ok" : "empty",
  };
}

// ────────────────────────────────────────────────────────────────────
// Immediate-with-buffer delivery — per-event candidate matching
//
// The buffer-based model (lib/newsletterBuffer.js) needs the inverse
// of `generateUserNewsletter`: given a SINGLE event, which users
// should it be enqueued for? `enqueueRecentEvents` is the entry
// point called by api/check.js after each scrape. It loads all
// active profiles + their newsletter state ONCE per cycle, then
// runs the cheap deterministic filters per (user × event).
//
// Expensive checks (proximity geocoding) are deferred to flush time
// where the candidate set is small (1-N events per user vs.
// N-events × M-users at enqueue time).
// ────────────────────────────────────────────────────────────────────

const NEWSLETTER_LOOKBACK_MS = 15 * 60 * 1000; // events.first_seen_at within last 15 min

async function fetchRecentlyArrivedEventIds(sinceMs = NEWSLETTER_LOOKBACK_MS) {
  const cutoff = new Date(Date.now() - sinceMs).toISOString();
  const { data, error } = await supabase
    .from("events")
    .select("id")
    .gte("first_seen_at", cutoff)
    .eq("archived", false)
    .gte("date", todayISO());
  if (error) {
    // first_seen_at column not yet applied (sql/047) — skip silently.
    if (error.code === "42703" || /column .* does not exist/i.test(error.message || "")) {
      return [];
    }
    console.warn(`[Newsletter] fetchRecentlyArrivedEventIds: ${error.message}`);
    return [];
  }
  return (data || []).map((r) => r.id).filter(Number.isFinite);
}

// Profiles+state cache used per scrape cycle. Built once at the top
// of `enqueueRecentEvents` so the per-event loop is plain in-memory
// work. Cache shape:
//   { telegramId, profile, state, defaultAudienceSet, accessScopes,
//     knownSeriesSet, dislikedVenuesSet, feedbackEventIds }
async function loadActiveSubscriberCache() {
  const { data: profiles, error: profErr } = await supabase
    .from("profiles")
    .select("telegram_id, first_name, user_context");
  if (profErr) {
    console.warn(`[Newsletter] loadActiveSubscriberCache profiles: ${profErr.message}`);
    return [];
  }
  if (!profiles?.length) return [];

  const ids = profiles.map((p) => p.telegram_id).filter(Boolean);
  const { data: states, error: stateErr } = await supabase
    .from("user_newsletter_state")
    .select("telegram_id, last_sent_at, paused")
    .in("telegram_id", ids);
  if (stateErr && stateErr.code !== "42P01" && stateErr.code !== "PGRST205") {
    console.warn(`[Newsletter] loadActiveSubscriberCache states: ${stateErr.message}`);
  }
  const stateMap = new Map(
    (states || []).map((s) => [String(s.telegram_id), s]),
  );

  // Pre-load each user's feedback event ids in a single bulk query
  // — saves one round trip per event later. The set is small
  // typically (≤100 per user).
  const { data: feedback } = await supabase
    .from("event_feedback")
    .select("telegram_id, event_id")
    .in("telegram_id", ids);
  const feedbackByUser = new Map();
  for (const row of feedback || []) {
    const key = String(row.telegram_id);
    if (!feedbackByUser.has(key)) feedbackByUser.set(key, new Set());
    feedbackByUser.get(key).add(row.event_id);
  }

  const out = [];
  for (const p of profiles) {
    const state = stateMap.get(String(p.telegram_id)) || null;
    // Treat absent state as "subscribed, never delivered". Paused
    // users opt out of buffer-delivery entirely.
    if (state?.paused) continue;
    const ctx = p.user_context || {};
    const knownSeries = Array.isArray(ctx.known_series) ? ctx.known_series : [];
    const dislikedVenues = Array.isArray(ctx.disliked_venues) ? ctx.disliked_venues : [];
    out.push({
      telegramId: String(p.telegram_id),
      profile: p,
      state,
      defaultAudienceSet: deriveDefaultAudienceSet(p),
      accessScopes: accessScopesForProfile(p),
      knownSeriesSet: new Set(knownSeries.map(String).filter(Boolean)),
      dislikedVenuesSet: new Set(dislikedVenues.map(String).filter(Boolean)),
      feedbackEventIds: feedbackByUser.get(String(p.telegram_id)) || new Set(),
    });
  }
  return out;
}

// Series identity helper — shared with generateUserNewsletter above
// (the generator uses makeSeriesKey directly).
function eventSeriesKey(event) {
  return makeSeriesKey(event?.name, event?.location_key);
}

/**
 * Run cheap deterministic filters: is this event a candidate for
 * this user's buffer? Excludes proximity (expensive — applied at
 * flush time).
 */
function eventQualifiesForUser(event, cacheEntry) {
  const { state, defaultAudienceSet, accessScopes, knownSeriesSet,
          dislikedVenuesSet, feedbackEventIds, profile } = cacheEntry;

  // Cross-cycle dedup: we've already delivered events older than
  // last_sent_at. (Implicit "first delivery" path = no last_sent_at
  // = pass.)
  const lastSentAt = state?.last_sent_at || null;
  if (lastSentAt) {
    const seen = event.first_seen_at;
    if (seen && new Date(seen).toISOString() <= lastSentAt) return false;
  }

  // Hard: past or sold-out.
  if (isEventInPast(event.date, event.start_time, event.end_time)) return false;
  if (event.tickets_left === 0 || event.is_sold_out) return false;

  // Hard: access scope. events.access is now access_t[] (sql/060).
  // The event is visible if ANY element of its access array is in
  // the user's allowed scope set ('open' + member communities).
  if (
    event.access &&
    !event.access.some((s) => accessScopes.includes(s))
  )
    return false;

  // Hard: per-event feedback rejection.
  if (feedbackEventIds.has(event.id)) return false;

  // Hard: series-level "already known" suppression.
  const key = eventSeriesKey(event);
  if (key && knownSeriesSet.has(key)) return false;

  // Hard: venue dislike.
  if (event.location_key && dislikedVenuesSet.has(event.location_key)) return false;

  const favoriteKeys = profile?.user_context?.favorite_location_keys;
  if (Array.isArray(favoriteKeys) && favoriteKeys.length > 0) {
    if (!event.location_key || !favoriteKeys.includes(event.location_key)) return false;
  }

  // Hard: audience + age. The generator uses the same primitive so
  // both paths stay behaviourally identical.
  if (!passesProfileFilters(event, profile, defaultAudienceSet)) return false;

  return true;
}

/**
 * Hydrate a list of event ids into full event rows usable by the
 * card renderer (with labels, location, coords, …). Reuses the same
 * select shape as the existing matchingService path, plus the
 * timestamp + access columns we need for filtering. Returns events
 * in the order requested (when ids align), missing rows dropped.
 */
async function hydrateEventsById(ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const { getAllEvents } = require("../bot/matchingService");
  const all = await getAllEvents({
    futureOnly: true,
    dateTo: addDaysISO(todayISO(), 60),
    accessScopes: ["open", "community-disabilities", "community-lgbtq", "community-seniors", "community-miluim", "community-russian", "community-olim"],
  });
  const set = new Set(ids);
  const byId = new Map(all.filter((e) => set.has(e.id)).map((e) => [e.id, e]));

  // Pull access + first_seen_at in a single bulk query so the
  // per-(user, event) check above can compare against the FRESH
  // timestamp.
  const { data: meta, error } = await supabase
    .from("events")
    .select("id, access, first_seen_at, last_changed_at, is_sold_out, tickets_left")
    .in("id", ids);
  if (!error && meta) {
    for (const m of meta) {
      const e = byId.get(m.id);
      if (!e) continue;
      e.access = m.access || null;
      e.first_seen_at = m.first_seen_at || null;
      e.last_changed_at = m.last_changed_at || null;
      e.is_sold_out = m.is_sold_out || false;
      if (m.tickets_left !== undefined) e.tickets_left = m.tickets_left;
    }
  }
  // Re-order to the input list shape so callers can rely on
  // deterministic ordering.
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * Entry point called from api/check.js after each scrape cycle.
 * Queries events that arrived in the last NEWSLETTER_LOOKBACK_MS and
 * enqueues each qualifying event into per-user buffers. The buffer
 * module dedupes within its window so multiple scrape cycles within
 * the 5-min buffer don't cause duplicate enqueues.
 */
async function enqueueRecentEvents() {
  const ids = await fetchRecentlyArrivedEventIds();
  if (!ids.length) return { events: 0, enqueued: 0, users: 0 };

  const events = await hydrateEventsById(ids);
  if (!events.length) return { events: 0, enqueued: 0, users: 0 };

  const cache = await loadActiveSubscriberCache();
  if (!cache.length) return { events: events.length, enqueued: 0, users: 0 };

  const buffer = require("./newsletterBuffer");

  let enqueued = 0;
  const touchedUsers = new Set();
  for (const event of events) {
    for (const entry of cache) {
      if (!eventQualifiesForUser(event, entry)) continue;
      if (buffer.enqueue(entry.telegramId, event)) {
        enqueued++;
        touchedUsers.add(entry.telegramId);
      }
    }
  }
  return { events: events.length, enqueued, users: touchedUsers.size };
}

/**
 * Flush-time proximity filter. The enqueue path skips proximity
 * (geocoding is expensive at N×M); at flush we have a small list
 * and can afford the calls. Same primitive `passesProximityFilter`
 * used by generateUserNewsletter — shared budget per flush.
 */
async function filterAtFlush(events, profile) {
  if (!events?.length) return [];
  const budget = { remaining: PROXIMITY_CHECK_BUDGET };
  const out = [];
  for (const e of events) {
    const ok = await passesProximityFilter(e, profile, budget);
    if (ok) out.push(e);
  }
  return out;
}

module.exports = {
  generateUserNewsletter,
  getNewsletterState,
  setNewsletterPaused,
  markNewsletterDelivered,
  enqueueRecentEvents,
  filterAtFlush,
  loadActiveSubscriberCache,
  eventQualifiesForUser,
  // Series identity for `known_series` suppression — exported so the
  // agent's live search can apply the same mute the newsletter does.
  // Both paths must use the SAME normalization so an event muted via
  // the "❌ לא מתאים → already_known" button on a search card is also
  // suppressed in the next newsletter (and vice-versa).
  makeSeriesKey,
  MAX_EVENTS_PER_DIGEST,
  NEWSLETTER_LOOKBACK_MS,
};
