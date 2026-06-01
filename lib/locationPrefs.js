// Location preference helpers — multi-mode walk/drive/any + proximity filter.

const { LOCATION_OPTIONS } = require("./interestCategories");

const DRIVE_MAX_MINUTES = 10;
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

function eventPassesLocationModes(result, constraints) {
  const modes = getLocationModes(constraints);
  if (!modes.length || modes.includes("any")) return true;
  if (!result?.resolved) return true;

  const shortDrive =
    result.requires_car &&
    result.drive_minutes != null &&
    result.drive_minutes <= DRIVE_MAX_MINUTES;

  if (modes.includes("walk") && modes.includes("drive")) {
    return !result.requires_car || shortDrive;
  }
  if (modes.includes("walk")) return !result.requires_car;
  if (modes.includes("drive")) return shortDrive;
  return true;
}

function locationModesFromConstraints(constraints) {
  return new Set(getLocationModes(constraints));
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
  locationModesFromConstraints,
};
