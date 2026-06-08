// Single source of truth: concepts that are already captured by a DEDICATED
// structured field — events.audience (age/life-stage) or events.access (a
// community scope). Such a concept must NEVER also exist as a free `tag` / a
// row in the `labels` dictionary: it would duplicate (and could conflict with)
// the structured field. e.g. "נוער" is the audience; "קהילה גאה" is the access
// community — neither belongs in the tag vocabulary.
//
// Used by:
//   • lib/eventEnricher.js  — reconcileLabels strips these from a result's tags.
//   • lib/labelStore.js     — getOrCreateLabel refuses to mint them as labels.

const { AUDIENCE_CATEGORIES } = require("./interestCategories");

// audience_t values (age/life-stage). Hardcoded (stable enum) to avoid a
// circular require on eventEnricher.
const AUDIENCE_VALUES = [
  "תינוקות", "ילדים", "נוער", "הורים", "מבוגרים", "ותיקים", "לכל המשפחה", "נשים",
];

function normConcept(s) {
  return String(s || "").replace(/["'״׳]/g, "").replace(/\s+/g, " ").trim();
}

// ONLY the exact structured values — audience enum + community labels — both
// auto-derived (zero maintenance). We deliberately do NOT hand-maintain spelling
// variants here: the labelStore alias-fold catches the common ones, and Gemini
// (which receives the full existing vocabulary + audiences + communities every
// call) is responsible for recognising semantic variants and not emitting them
// in the first place. This guard is just a cheap last-line backstop.
const COVERED = new Set(
  [
    ...AUDIENCE_VALUES,
    ...AUDIENCE_CATEGORIES.filter((a) => a.community).map((a) => a.label),
  ].map(normConcept),
);

/** True when `name` is owned by audience/access and must not be a tag/label. */
function isCoveredConcept(name) {
  return COVERED.has(normConcept(name));
}

module.exports = { isCoveredConcept, normConcept, COVERED };
