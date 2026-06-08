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

const COVERED = new Set(
  [
    ...AUDIENCE_VALUES,
    // community labels (access scopes): קהילה גאה / דוברי רוסית / משרתי מילואים…
    ...AUDIENCE_CATEGORIES.filter((a) => a.community).map((a) => a.label),
    // common variants Gemini / sources tend to emit for the above:
    "הקהילה הגאה", "להטב", 'להט"ב', "גאווה", "נשים בלבד", "גברים בלבד",
    "מילואים", "עולים", "דוברי רוסית", "גיל הזהב", "גיל הזהב 60+",
  ].map(normConcept),
);

/** True when `name` is owned by audience/access and must not be a tag/label. */
function isCoveredConcept(name) {
  return COVERED.has(normConcept(name));
}

module.exports = { isCoveredConcept, normConcept, COVERED };
