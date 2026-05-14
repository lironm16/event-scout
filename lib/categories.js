// Audience / category / age matchers, current as of sql/032.
//
// The schema:
//   - events.audience  audience_t  native ENUM (sql/032)
//   - events.category  category_t  native ENUM (sql/032)
//   - events.tag_ids   INT[]       FKs into the tags-only `labels` dict
//   - events.min_months / events.max_months  numeric age range
//
// This module operates on the *expanded* shape produced by
// `lib/labelStore.getLabelsForEvents` (or attached directly when the
// event row already carries the ENUM strings):
//
//   {
//     audience:  "ילדים",                    // 0..1 Hebrew name
//     category:  "סדנה",                     // 0..1 Hebrew name
//     tags:      ["מוזיקה", "ל״ג בעומר"],     // 0+ free-form
//     min_months: 6,  max_months: 18          // numeric range
//   }
//
// The agent's `search_events` tool keeps its English audience / activity
// keys (kids, family, workshop, tour, …) — they're easier to embed in
// system prompts and the saved-search service stores them too. The maps
// below bridge to the Hebrew names actually stored on events.

// English audience keys exposed to the tool ↔ Hebrew names in the dict.
const AUDIENCE_LABELS = {
  toddlers: "תינוקות",
  kids: "ילדים",
  family: "לכל המשפחה",
  teens: "נוער",
  adults: "מבוגרים",
};
const AUDIENCE_KEYS = Object.keys(AUDIENCE_LABELS);

// Map from English request → set of Hebrew audience tags that are
// considered "good enough" for this audience filter. Asymmetric: a
// "family" event satisfies a "kids" search; a "kids" event satisfies a
// "family" search; an "adults" event does NOT satisfy a "kids" search.
//
// Maintained explicitly rather than derived from a hierarchy because
// human family-event judgment isn't tree-shaped (e.g. teens-only event
// doesn't fit a kids search even though both are "non-adult").
const ACCEPTABLE_AUDIENCES_HE = {
  toddlers: ["תינוקות", "לכל המשפחה"],
  kids: ["ילדים", "תינוקות", "לכל המשפחה"],
  family: ["לכל המשפחה", "ילדים", "תינוקות", "נוער"],
  teens: ["נוער", "לכל המשפחה"],
  adults: ["מבוגרים"],
};

// Mapping of activity_type request keys (the agent tool's enum) to
// the Hebrew category names stored on events. `show` accepts BOTH
// "הצגה" and "הופעה" because the user often asks for "מופע / הצגה /
// הופעה" interchangeably.
const ACTIVITY_TYPES = {
  tour:        ["סיור"],
  workshop:    ["סדנה"],
  show:        ["הצגה", "הופעה"],
  performance: ["הופעה"],
  activity:    ["הפעלה"],
  lecture:     ["הרצאה"],
  playspace:   ["משחקייה"],
  party:       ["מסיבה"],
  meal:        ["ארוחה"],
  gathering:   ["מפגש"],
  sport:       ["ספורט"],
  movie:       [],          // no canonical Hebrew category; matched only by title
};
const ACTIVITY_TYPE_KEYS = Object.keys(ACTIVITY_TYPES);

// Title-keyword fallbacks. Used by `activityTypeMatches` to detect
// activity types from a free-form user query string ("מצא לי סיור
// עששיות" → ["tour"]). Not used for filtering events themselves now —
// that goes through the structured `category` column.
const ACTIVITY_TYPE_KEYWORDS = {
  tour:        ["סיור", "סיורים", "סיורי"],
  workshop:    ["סדנה", "סדנת", "סדנאות", "סדנאת"],
  show:        ["הצגה", "הצגת", "הצגות", "מופע", "מופעי", "מופעים"],
  performance: ["הופעה", "הופעת", "הופעות"],
  activity:    ["הפעלה"],
  lecture:     ["הרצאה", "הרצאות"],
  playspace:   ["משחקייה", "משחקיית", "משחקיות"],
  party:       ["מסיבה", "מסיבת", "מסיבות", "rooftop party", "club night", "party"],
  meal:        ["ארוחה", "ארוחת", "ארוחות", "dinner", "shabbat dinner", "community dinner", "ארוחת שישי", "פוטלאך", "ארוחת חג"],
  gathering:   ["מפגש", "מפגשים", "ערב חברתי", "ערבי חברה", "ערב הכרויות", "mixer", "meetup", "wine and cheese", "wine & cheese", "ערב טעימות", "מועדון קריאה", "קבוצת תמיכה"],
  sport:       ["ספורט"],
  movie:       ["סרט", "סרטון", "סרטי", "סרטים"],
};

// ──────────────────────────────────────────────────────────────────────
// audienceVerdict — single source of truth for "should this event
// match the user's audience filter?"
//
// Returns:
//   { decision: 'include' | 'exclude',
//     confidence: 0..1,
//     source:    'no_filter' | 'no_label' |
//                'label_match' | 'label_mismatch',
//     reason?:   Hebrew label for UI annotation }
//
// Layered logic:
//   1. No filter set → include with confidence 1.
//   2. No audience on the event → include with low confidence (silent
//      events aren't great signal but we'd rather over-include than
//      hide a potentially relevant row).
//   3. Event audience is in the acceptable set for this filter →
//      include with high confidence.
//   4. Event audience explicitly belongs to a non-overlapping bucket
//      → exclude.
//
// `eventLabels` is the expanded shape from labelStore — pass the whole
// event row to keep the call sites short.
// ──────────────────────────────────────────────────────────────────────
function audienceVerdict(eventName, audienceEN, eventLabels) {
  if (!audienceEN) {
    return { decision: "include", confidence: 1, source: "no_filter" };
  }
  const accepted = ACCEPTABLE_AUDIENCES_HE[audienceEN];
  if (!accepted) {
    return { decision: "include", confidence: 1, source: "unknown_filter" };
  }
  const audience = eventLabels?.audience || null;
  if (!audience) {
    return { decision: "include", confidence: 0.4, source: "no_label" };
  }
  if (accepted.includes(audience)) {
    return { decision: "include", confidence: 0.95, source: "label_match" };
  }
  return {
    decision: "exclude",
    confidence: 0.95,
    source: "label_mismatch",
    reason: `המסווג זיהה כקהל ${audience}`,
  };
}

// Compatibility check used by the saved-search notifier. Same logic as
// audienceVerdict but returns just the boolean — exists for less
// verbose call sites.
function audienceCompatible(eventName, audienceEN, eventLabels) {
  return audienceVerdict(eventName, audienceEN, eventLabels).decision === "include";
}

function audienceLabel(audienceEN) {
  return AUDIENCE_LABELS[audienceEN] || audienceEN || null;
}

// ──────────────────────────────────────────────────────────────────────
// deriveDefaultAudienceSet — single source of truth for "which audience
// ENUM values are relevant to this user by default".
//
// This exists so we don't have to scatter ad-hoc audience exclusions
// across the codebase as new ENUM values get added. Today the only
// non-family value is `מבוגרים` — a parent searching for events
// shouldn't see senior-citizen lectures by default. Tomorrow we may
// add `גיל שלישי`, age-restricted party tiers, or community-scoped
// audiences; each one only needs to be added HERE and every search
// path picks up the right behaviour automatically.
//
// Returns a Set of Hebrew ENUM values that this user's PROFILE makes
// relevant by default. The `search_events` tool intersects results
// against this set when the agent does NOT pass an explicit audience.
// Callers can always bypass it by passing `audience: 'all'` (user
// explicitly asked to see everything) or any other AUDIENCE_KEYS
// value (explicit subset).
//
// SAFE FALLBACK: any audience ENUM value NOT in the returned set is
// excluded by default. This is the conservative choice — adding a
// new ENUM value to the schema without adding it here means it stays
// hidden until we deliberately opt in (better than silently
// surfacing brand-new audience tiers to every user).
// ──────────────────────────────────────────────────────────────────────
function deriveDefaultAudienceSet(profile) {
  const kids = profile?.user_context?.kids || profile?.kids || [];
  if (Array.isArray(kids) && kids.length > 0) {
    return new Set(["תינוקות", "ילדים", "נוער", "לכל המשפחה"]);
  }
  return new Set(["מבוגרים", "לכל המשפחה"]);
}

// ──────────────────────────────────────────────────────────────────────
// Category / activity-type matching.
//
// `categoryMatches(eventLabels, types)` — returns true if the event's
// Hebrew category falls into ANY of the requested English types. Both
// directions are permissive: an event with no category passes through
// (we don't have a signal), and `types=[]` is "no filter".
// ──────────────────────────────────────────────────────────────────────
function categoryMatches(eventLabels, requestedTypesEN) {
  if (!Array.isArray(requestedTypesEN) || !requestedTypesEN.length) return true;
  const cat = eventLabels?.category;
  if (!cat) return true;
  for (const t of requestedTypesEN) {
    const acceptedHe = ACTIVITY_TYPES[t];
    if (acceptedHe && acceptedHe.includes(cat)) return true;
  }
  return false;
}

// Detect activity types FROM a free-form user query (different from
// matching events). Used by matchingService's deterministic guard.
function activityMatches(text, types) {
  if (!Array.isArray(types) || !types.length) return true;
  const lower = String(text || "").toLowerCase();
  for (const t of types) {
    const kws = ACTIVITY_TYPE_KEYWORDS[t] || [];
    if (kws.some((kw) => lower.includes(kw))) return true;
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────
// Age matcher — reads min_months / max_months directly off the event.
//
// Accepts EITHER a single age OR an array of ages (parents with several
// kids: pass [4, 9] to match events suitable for AT LEAST ONE of those
// kids). The ANY semantic matches the typical user intent — "what can
// I take any of my kids to" — better than ALL would, which would
// silently filter out perfectly-good kids events when a teen is also
// in the household. Callers who really want "fits everyone in the
// same room" can intersect by passing the narrowest tier instead.
//
// `null, null` event range is "no signal" — permissive include.
// `0, 1200` is the canonical "all ages / family" range and matches
// every input. Anything else is interpreted literally: ageMonths must
// fall within the closed range [min, max] (with null bounds treated
// as 0 / +∞).
// ──────────────────────────────────────────────────────────────────────
function ageMatches(eventLabels, ageYearsOrAges) {
  if (ageYearsOrAges == null) return true;
  const lo = eventLabels?.min_months;
  const hi = eventLabels?.max_months;
  if (lo == null && hi == null) return true;
  const min = typeof lo === "number" && Number.isFinite(lo) ? lo : 0;
  const max = typeof hi === "number" && Number.isFinite(hi) ? hi : Infinity;
  const candidates = Array.isArray(ageYearsOrAges) ? ageYearsOrAges : [ageYearsOrAges];
  for (const y of candidates) {
    if (y == null || !Number.isFinite(y)) continue;
    const ageMonths = y * 12;
    if (ageMonths >= min && ageMonths <= max) return true;
  }
  // Empty / all-null array → no usable signal → permissive.
  if (!candidates.some((y) => y != null && Number.isFinite(y))) return true;
  return false;
}

module.exports = {
  AUDIENCE_LABELS,
  AUDIENCE_KEYS,
  ACTIVITY_TYPES,
  ACTIVITY_TYPE_KEYS,
  ACTIVITY_TYPE_KEYWORDS,
  ACCEPTABLE_AUDIENCES_HE,
  audienceVerdict,
  audienceCompatible,
  audienceLabel,
  deriveDefaultAudienceSet,
  categoryMatches,
  activityMatches,
  ageMatches,
};
