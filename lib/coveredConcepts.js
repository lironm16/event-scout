// Concepts already captured by the events.audience (age/life-stage) field, so
// they must NEVER also exist as a free `tag` / a row in the `labels` dictionary
// — there the duplication is real and adds nothing (a baby event ALWAYS has
// audience=תינוקות). e.g. "נוער" is the audience, not a tag.
//
// COMMUNITIES are deliberately NOT covered here: a community ("קהילה גאה",
// "נשים", …) is a legitimate TAG (theme — "ברוח הקהילה, פתוח") that is distinct
// from the access scope (eligibility — "סגור לקהילה"). A community can be both.
// The suppress-tag-vs-membership contradiction that creates is resolved at
// SAVE time by lib/conceptConflict.js, not by hiding the tag here.
//
// Used by:
//   • lib/eventEnricher.js  — reconcileLabels strips these from a result's tags.
//   • lib/labelStore.js     — getOrCreateLabel refuses to mint them as labels.

// audience_t values (age/life-stage). Hardcoded (stable enum) to avoid a
// circular require on eventEnricher. NOTE: "נשים" is NOT here — it migrated to
// the community-women access scope, so it is allowed as a tag like any other
// community.
const AUDIENCE_VALUES = [
  "תינוקות", "ילדים", "נוער", "הורים", "מבוגרים", "ותיקים", "לכל המשפחה",
];

function normConcept(s) {
  return String(s || "").replace(/["'״׳]/g, "").replace(/\s+/g, " ").trim();
}

// We do NOT hand-maintain spelling variants: the labelStore alias-fold catches
// the common ones, and Gemini (which receives the full vocabulary every call)
// recognises semantic variants. This guard is just a cheap last-line backstop.
const COVERED = new Set(AUDIENCE_VALUES.map(normConcept));

/** True when `name` is owned by audience/access and must not be a tag/label. */
function isCoveredConcept(name) {
  return COVERED.has(normConcept(name));
}

module.exports = { isCoveredConcept, normConcept, COVERED };
