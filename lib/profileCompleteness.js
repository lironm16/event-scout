// Decide which profile fields are genuinely missing (setup nudges, menus).

const { AUDIENCE_CATEGORIES } = require("./interestCategories");
const { kidHasBirthInfo } = require("./kidAge");

const CHILD_AUDIENCE_CHIP_IDS = new Set(["kids", "babies", "teens"]);

function hasHomeAddress(userContext) {
  const c = userContext || {};
  const constraints = c.constraints || {};
  if (String(constraints.home_address || "").trim()) return true;
  const coords = constraints.home_coordinates;
  if (
    coords &&
    Number.isFinite(coords.lat) &&
    Number.isFinite(coords.lng)
  ) {
    return true;
  }
  if (String(constraints.preferred_area || "").trim()) return true;
  const prefs = c.preferences;
  if (prefs && typeof prefs === "object") {
    if (String(prefs.home_address || "").trim()) return true;
    if (String(prefs.preferred_area || "").trim()) return true;
  }
  return false;
}

/** Walking budget alone is not a street address, but users who set it chose location prefs. */
function hasLocationPreference(userContext) {
  const constraints = userContext?.constraints || {};
  if (
    constraints.max_walking_minutes != null &&
    Number.isFinite(Number(constraints.max_walking_minutes))
  ) {
    return true;
  }
  return Boolean(String(constraints.proximity_preference || "").trim());
}

function hasMeaningfulKids(kids) {
  if (!Array.isArray(kids) || !kids.length) return false;
  return kids.some((k) => kidHasBirthInfo(k) && String(k.name || "").trim());
}

function hasChildAudienceIntent(userContext) {
  const c = userContext || {};
  if (c.suppress_child_audiences) return false;
  const chipIds = c.target_audience_chip_ids;
  if (
    Array.isArray(chipIds) &&
    chipIds.some((id) => CHILD_AUDIENCE_CHIP_IDS.has(id))
  ) {
    return true;
  }
  const interests = Array.isArray(c.interests) ? c.interests : [];
  for (const raw of interests) {
    const label = String(raw).trim();
    const chip = AUDIENCE_CATEGORIES.find((a) => a.label === label);
    if (chip && CHILD_AUDIENCE_CHIP_IDS.has(chip.id)) return true;
  }
  return false;
}

function hasInterests(userContext) {
  const list = userContext?.interests;
  return Array.isArray(list) && list.some((x) => String(x).trim());
}

/**
 * Returns subset of: "address" | "interests" | "kids"
 * Only lists fields that are actually missing for this user.
 */
function profileSetupNeeds(profile) {
  if (!profile) return ["address", "interests", "kids"];
  const c = profile.user_context || {};
  const missing = [];
  if (!hasHomeAddress(c) && !hasLocationPreference(c)) {
    missing.push("address");
  }
  if (!hasInterests(c)) missing.push("interests");
  if (!hasMeaningfulKids(c.kids) && hasChildAudienceIntent(c)) {
    missing.push("kids");
  }
  return missing;
}

module.exports = {
  hasHomeAddress,
  hasLocationPreference,
  hasMeaningfulKids,
  hasChildAudienceIntent,
  hasInterests,
  profileSetupNeeds,
};
