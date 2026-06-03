// Location preference helpers — multi-mode walk/drive/any + proximity filter.

const { LOCATION_OPTIONS } = require("./interestCategories");
const { kmForDriveMinutes } = require("./geocoding");

const DRIVE_MAX_MINUTES = 10;
const SHORT_DRIVE_KM = kmForDriveMinutes(DRIVE_MAX_MINUTES);
const TOGGLE_LOCATION_IDS = new Set(["walk", "drive", "any"]);

function getLocationOption(id) {
  return LOCATION_OPTIONS.find((o) => o.id === id) || null;
}

/** Normalized mode ids from profile constraints (legacy + location_modes). */
function getLocationModes(constraints = {}) {
  const raw = constraints.location_modes;
  if (Array.isArray(raw) && raw.length) {
    return raw.filter((id) => TOGGLE_LOCATION_IDS.has(id));
  }
  const pref = String(constraints.proximity_preference || "").trim();
  if (!pref) {
    const max = constraints.max_walking_minutes;
    if (max == null || !Number.isFinite(Number(max))) return [];
    if (Number(max) > 15) return ["drive"];
    if (Number(max) === 15) return ["walk"];
    return [];
  }
  const modes = [];
  for (const opt of LOCATION_OPTIONS) {
    if (!opt.preference || !TOGGLE_LOCATION_IDS.has(opt.id)) continue;
    if (pref === opt.preference || pref.includes(opt.preference)) {
      modes.push(opt.id);
    }
  }
  if (modes.includes("any")) return ["any"];
  return modes;
}

function formatProximityPreference(modeIds) {
  const ids = Array.isArray(modeIds) ? modeIds : [...(modeIds || [])];
  if (!ids.length) return null;
  if (ids.includes("any")) {
    return getLocationOption("any")?.preference || "כל מיקום";
  }
  const parts = ids
    .map((id) => getLocationOption(id)?.preference)
    .filter(Boolean);
  return parts.length ? parts.join(" + ") : null;
}

/** Profile constraint fields from onboarding mode selection. */
function constraintsFromLocationModes(modeIds) {
  const ids = [...(modeIds instanceof Set ? modeIds : modeIds || [])].filter((id) =>
    TOGGLE_LOCATION_IDS.has(id),
  );
  if (!ids.length) {
    return {
      max_walking_minutes: null,
      proximity_preference: null,
      location_modes: null,
    };
  }
  if (ids.includes("any")) {
    const any = getLocationOption("any");
    return {
      max_walking_minutes: any.max_walking_minutes,
      proximity_preference: any.preference,
      location_modes: ["any"],
    };
  }
  let maxWalk = null;
  if (ids.includes("walk")) maxWalk = 15;
  if (ids.includes("drive")) maxWalk = 30;
  return {
    max_walking_minutes: maxWalk,
    proximity_preference: formatProximityPreference(ids),
    location_modes: ids,
  };
}

function constraintsFromCustomWalkMinutes(minutes) {
  return {
    max_walking_minutes: minutes,
    proximity_preference: `מותאם — עד ${minutes} דק׳ הליכה`,
    location_modes: null,
  };
}

/** Minutes passed to evaluateProximity for labeling / requires_car. */
function evalWalkMinutesForModes(modeIds) {
  const ids = getLocationModes({ location_modes: modeIds });
  if (!ids.length || ids.includes("any")) return null;
  if (ids.includes("walk")) return 15;
  if (ids.includes("drive")) return 30;
  return null;
}

/** Within the user's short-drive limit (default ≤10 min). Walkable venues
 *  always pass. `maxMinutes` overrides the default (profile max_drive_minutes). */
function isWithinShortDrive(result, maxMinutes) {
  const maxMin =
    Number.isFinite(maxMinutes) && maxMinutes > 0 ? maxMinutes : DRIVE_MAX_MINUTES;
  if (!result?.resolved) return false;
  if (!result.requires_car) return true;
  if (result.drive_minutes != null && result.drive_minutes <= maxMin) {
    return true;
  }
  // Bulk filter skips Routes API; rounded heuristic minutes can overshoot
  // by 1–2 min while straight-line km is still inside the budget.
  if (result.km != null && result.km <= kmForDriveMinutes(maxMin)) return true;
  return false;
}

function eventPassesLocationModes(result, constraints) {
  const modes = getLocationModes(constraints);
  if (!modes.length || modes.includes("any")) return true;
  if (!result?.resolved) return true;

  const driveMax = constraints?.max_drive_minutes;
  if (modes.includes("walk") && modes.includes("drive")) {
    return !result.requires_car || isWithinShortDrive(result, driveMax);
  }
  if (modes.includes("walk")) return !result.requires_car;
  if (modes.includes("drive")) return isWithinShortDrive(result, driveMax);
  return true;
}

function locationModesFromConstraints(constraints) {
  return new Set(getLocationModes(constraints));
}

/**
 * Refresh distance label on a card via Google Routes (when available).
 * Bulk search filters use haversine only; without this, cards show ~ETAs.
 */
async function enrichProximityForCard(event, profile) {
  if (!event) return event;
  if (event._proximity?.travel_time_source === "google_routes") return event;

  const constraints = profile?.user_context?.constraints || profile?.constraints || {};
  const home = constraints.home_coordinates;
  if (!home?.lat || !home?.lng) return event;

  const { evaluateProximity } = require("./geocoding");
  const evalMin = evalWalkMinutesForModes(getLocationModes(constraints));
  let venueCoords = null;
  if (event._coords?.lat != null && event._coords?.lng != null) {
    venueCoords = { lat: event._coords.lat, lng: event._coords.lng };
  } else if (event.lat != null && event.lng != null) {
    venueCoords = { lat: event.lat, lng: event.lng };
  }

  const r = await evaluateProximity(
    home,
    event.location || null,
    evalMin,
    venueCoords,
    { useRoutesApi: true },
  );
  if (r && (r.resolved || r.reason === "virtual")) event._proximity = r;
  return event;
}

module.exports = {
  DRIVE_MAX_MINUTES,
  TOGGLE_LOCATION_IDS,
  getLocationModes,
  formatProximityPreference,
  constraintsFromLocationModes,
  constraintsFromCustomWalkMinutes,
  evalWalkMinutesForModes,
  eventPassesLocationModes,
  isWithinShortDrive,
  enrichProximityForCard,
  locationModesFromConstraints,
  SHORT_DRIVE_KM,
};
