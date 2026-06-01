// Profile-aligned event filtering — same primitives as newsletter + search.

const {
  audienceVerdict,
  deriveDefaultAudienceSet,
  shouldExcludeAdultSubtypeEvent,
  householdKidsFitEvent,
} = require("./categories");
const { shouldHideChildEventForProfile } = require("./childEventPrefs");
const { accessScopesForProfile } = require("../bot/profileService");
const { evaluateProximity } = require("./geocoding");
const {
  evalWalkMinutesForModes,
  eventPassesLocationModes,
  getLocationModes,
} = require("./locationPrefs");
const { isEventInPast } = require("./timeContext");
const {
  eventHasSuppressedTag,
  shouldHideOnlineEventForProfile,
} = require("./tagSuppressPrefs");

const PROXIMITY_CHECK_BUDGET = 40;

/** When favorite_location_keys is set, only those venues pass (hard allow-list). */
function passesFavoriteLocationsFilter(event, profile) {
  const keys = profile?.user_context?.favorite_location_keys;
  if (!Array.isArray(keys) || keys.length === 0) return true;
  if (!event.location_key) return false;
  return keys.includes(event.location_key);
}

function passesAccessScope(event, accessScopes) {
  if (!event.access) return true;
  const scopes = Array.isArray(event.access) ? event.access : [event.access];
  return scopes.some((s) => accessScopes.includes(s));
}

function passesProfileFilters(event, profile, defaultAudienceSet) {
  if (shouldHideOnlineEventForProfile(event, profile)) return false;
  if (eventHasSuppressedTag(event, profile)) return false;
  if (shouldHideChildEventForProfile(event, profile)) return false;

  const verdict = audienceVerdict(event.name, null, {
    audience: event.audience,
    category: event.category,
  });
  if (verdict?.decision === "exclude") return false;

  if (event.audience && !defaultAudienceSet.has(event.audience)) return false;

  if (shouldExcludeAdultSubtypeEvent(event, profile)) return false;

  const kids = profile?.user_context?.kids || [];
  if (Array.isArray(kids) && kids.length) {
    const { kidsAgesYears } = require("./kidAge");
    const ages = kidsAgesYears(kids);
    if (ages.length && !householdKidsFitEvent(event, ages, kids)) return false;
  }
  return true;
}

async function passesProximityFilter(event, profile, budgetRef) {
  const constraints = profile?.user_context?.constraints || {};
  const home = constraints.home_coordinates || null;
  const modes = getLocationModes(constraints);
  if (!home?.lat || !home?.lng) return true;
  if (!modes.length || modes.includes("any")) return true;
  if (budgetRef.remaining <= 0) return true;
  budgetRef.remaining--;
  const venueCoords =
    event._coords?.lat != null && event._coords?.lng != null
      ? { lat: event._coords.lat, lng: event._coords.lng }
      : null;
  const evalMin = evalWalkMinutesForModes(modes);
  const result = await evaluateProximity(
    { lat: home.lat, lng: home.lng },
    event.location || null,
    evalMin,
    venueCoords,
  );
  return eventPassesLocationModes(result, constraints);
}

async function annotateProximity(events, profile) {
  const constraints = profile?.user_context?.constraints || {};
  const home = constraints.home_coordinates || null;
  const maxWalk = constraints.max_walking_minutes;
  if (!home?.lat || !home?.lng) return events;
  const budget = { remaining: PROXIMITY_CHECK_BUDGET };
  for (const e of events) {
    if (budget.remaining <= 0) break;
    budget.remaining--;
    const venueCoords =
      e._coords?.lat != null && e._coords?.lng != null
        ? { lat: e._coords.lat, lng: e._coords.lng }
        : null;
    const result = await evaluateProximity(
      { lat: home.lat, lng: home.lng },
      e.location || null,
      maxWalk,
      venueCoords,
    );
    if (result) e._proximity = result;
  }
  return events;
}

function interestScore(event, profile) {
  const interests = (profile?.user_context?.interests || [])
    .map((x) => String(x).trim().toLowerCase())
    .filter(Boolean);
  if (!interests.length) return 0;
  const set = new Set(interests);
  let hits = 0;
  for (const t of event.tags || []) {
    if (set.has(String(t).trim().toLowerCase())) hits++;
  }
  return hits;
}

/**
 * Filter + rank events for a user's profile (audience, kids ages, access,
 * walking budget, interests). Drops past / sold-out rows.
 *
 * @returns {{ events: Array, total: number }}
 */
async function filterAndRankForProfile(events, profile, { annotateDistance = true } = {}) {
  if (!Array.isArray(events) || !events.length) {
    return { events: [], total: 0 };
  }
  const total = events.length;
  const defaultAudienceSet = deriveDefaultAudienceSet(profile?.user_context || {});
  const accessScopes = accessScopesForProfile(profile);

  let kept = events.filter((e) => {
    if (isEventInPast(e.date, e.start_time, e.end_time)) return false;
    if (e.tickets_left === 0) return false;
    if (!passesFavoriteLocationsFilter(e, profile)) return false;
    if (!passesAccessScope(e, accessScopes)) return false;
    return passesProfileFilters(e, profile, defaultAudienceSet);
  });

  const budget = { remaining: PROXIMITY_CHECK_BUDGET };
  const proxied = [];
  for (const e of kept) {
    if (await passesProximityFilter(e, profile, budget)) proxied.push(e);
  }
  kept = proxied;

  if (annotateDistance) await annotateProximity(kept, profile);

  kept.sort((a, b) => {
    const scoreDiff = interestScore(b, profile) - interestScore(a, profile);
    if (scoreDiff !== 0) return scoreDiff;
    const da = a.date || "9999-12-31";
    const db = b.date || "9999-12-31";
    if (da !== db) return da < db ? -1 : 1;
    const ta = a.start_time || "99:99";
    const tb = b.start_time || "99:99";
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

  return { events: kept, total };
}

/** How many rows pass the same filters as `filterAndRankForProfile` (no ranking). */
async function countProfileMatches(events, profile) {
  if (!profile || !Array.isArray(events) || !events.length) return 0;
  const { events: kept } = await filterAndRankForProfile(events, profile, {
    annotateDistance: false,
  });
  return kept.length;
}

module.exports = {
  filterAndRankForProfile,
  countProfileMatches,
  passesProfileFilters,
  passesFavoriteLocationsFilter,
  annotateProximity,
};
