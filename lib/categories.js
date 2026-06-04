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
//
// `young_adult` is a narrower SUBTYPE of `adults` (still audience=מבוגרים
// at the ENUM level — there's no separate ENUM value for 18-35). Selecting
// it requires the event ALSO carry the discovery tag "צעירים", which the
// city CMS attaches when an editor explicitly targets the 18-35 cohort
// AND the scrape-time backfill (jobs/backfillTagYoungAdults.js) adds for
// events with an unambiguous young max_months bound. The tag-AND check
// happens in lib/agent/tools/events.js after the audience verdict.
const AUDIENCE_LABELS = {
  toddlers: "תינוקות",
  kids: "ילדים",
  family: "לכל המשפחה",
  teens: "נוער",
  parents: "הורים",
  young_adult: "צעירים (18-35)",
  adults: "מבוגרים",
  seniors: "ותיקים",
  women: "נשים",
};
const AUDIENCE_KEYS = Object.keys(AUDIENCE_LABELS);

// Subset of AUDIENCE_KEYS whose semantics REQUIRE the matching event also
// carry a specific Hebrew SUBTYPE TAG (in addition to the ENUM verdict).
// search_events reads this to intersect the audience-verdict result with
// a tag filter. Mapping is name-keyed (canonical Hebrew label string)
// rather than id-keyed so dev/prod DBs stay in sync without a config
// hand-off.
//
// Today's only entry: 'young_adult' → 'צעירים'. Pattern is reusable for
// any future audience whose canonical 18-35 / 60+ / similar bucket can't
// be expressed as a stand-alone ENUM value because of cross-cutting
// audience overlap (the same event can simultaneously be "מבוגרים" and
// "צעירים" subtype — they describe different facets).
const AUDIENCE_REQUIRED_SUBTYPE_TAGS = {
  young_adult: "צעירים",
};

// Map from English request → set of Hebrew audience tags that are
// considered "good enough" for this audience filter. Asymmetric: a
// "family" event satisfies a "kids" search; a "kids" event satisfies a
// "family" search; an "adults" event does NOT satisfy a "kids" search.
//
// Maintained explicitly rather than derived from a hierarchy because
// human family-event judgment isn't tree-shaped (e.g. teens-only event
// doesn't fit a kids search even though both are "non-adult").
//
// `young_adult` accepts only `מבוגרים`. The tag intersection (above)
// then narrows further to events explicitly marked young.
const ACCEPTABLE_AUDIENCES_HE = {
  toddlers: ["תינוקות", "לכל המשפחה"],
  kids: ["ילדים", "תינוקות", "לכל המשפחה"],
  family: ["לכל המשפחה", "ילדים", "תינוקות", "נוער"],
  teens: ["נוער", "לכל המשפחה"],
  parents: ["הורים", "לכל המשפחה"],
  young_adult: ["מבוגרים"],
  adults: ["מבוגרים", "הורים", "ותיקים"],
  seniors: ["ותיקים", "לכל המשפחה"],
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
  // `קורס` / `קורסי` cover one-off curated courses ("קורס החייאה
  // ועזרה ראשונה") that the city CMS files alongside open-ended
  // workshops — same UX bucket for the user.
  workshop:    ["סדנה", "סדנת", "סדנאות", "סדנאת", "קורס", "קורסי", "קורסים"],
  // `ההצגה` / `המופע` (definite article) catch the common
  // description pattern "מה מחכה לכם? ההצגה X" used by the
  // "גינה פעילה" series.
  show:        ["הצגה", "הצגת", "הצגות", "ההצגה", "מופע", "מופעי", "מופעים", "המופע"],
  // Music-direction prose. The city CMS's Friday-music garden series
  // ("שישי ישראלי") describes each park with "בניהולו/בניהולה המוזיקלי
  // של …" — a strong, narrowly-scoped signal that the event is a
  // music performance.
  performance: ["הופעה", "הופעת", "הופעות", "ההופעה", "מוזיקלי", "מוזיקלית", "מוסיקלי", "מוסיקלית"],
  // `שעת סיפור` is the canonical Hebrew label for a children's
  // storytelling session — a curator-defined recurring activity
  // (e.g. the city CMS's "מעשה בזום" series). We keep it as a
  // multi-word phrase rather than tokenizing it because `סיפור`
  // alone ("story") appears in narrative prose far too often to
  // be a safe signal.
  activity:    ["הפעלה", "הפעלת", "הפעלות", "שעת סיפור"],
  // `שיעור` / `שיעורי` cover religious/educational lessons
  // ("שיעורי שבועות מפי הרב …") that aren't framed as full lectures
  // but share the same single-presenter-talks-to-audience shape.
  lecture:     ["הרצאה", "הרצאת", "הרצאות", "שיעור", "שיעורי", "שיעורים"],
  playspace:   ["משחקייה", "משחקיית", "משחקיות"],
  party:       ["מסיבה", "מסיבת", "מסיבות", "rooftop party", "club night", "party"],
  meal:        ["ארוחה", "ארוחת", "ארוחות", "dinner", "shabbat dinner", "community dinner", "ארוחת שישי", "פוטלאך", "ארוחת חג"],
  // `חגיגה` / `חגיגת` / `חוגגים` for community celebration events.
  // We file them under gathering — they're festive gatherings, not
  // ticketed parties (those self-identify with "מסיבה" in the
  // title). The Shavuot "חגיגת שבועות" / "שכנים חוגגים ביכורים"
  // events are the canonical examples: public, free, community-
  // festival shaped.
  // `יריד` / `הפנינג` are the city CMS's go-to labels for public
  // free festival-style events (Shavuot markets, holiday happenings).
  // We file them under gathering — same logic as "חגיגה": festive,
  // community-shaped, not ticketed parties.
  gathering:   ["מפגש", "מפגשת", "מפגשים", "חגיגה", "חגיגת", "חגיגות", "חוגגים", "חוגגות", "יריד", "ירידי", "ירידים", "הפנינג", "הפנינגי", "ערב חברתי", "ערבי חברה", "ערב הכרויות", "mixer", "meetup", "wine and cheese", "wine & cheese", "ערב טעימות", "מועדון קריאה", "קבוצת תמיכה"],
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
  const { deriveAllowedAudiencesFromProfile } = require("./audienceTargets");
  const fromChips = deriveAllowedAudiencesFromProfile(profile);
  if (fromChips) {
    if (profile?.user_context?.suppress_child_audiences) {
      const filtered = new Set(fromChips);
      filtered.delete("תינוקות");
      filtered.delete("ילדים");
      filtered.delete("נוער");
      return filtered;
    }
    return fromChips;
  }

  // DEFAULT = SEE EVERYTHING (Liron's call, 2026-06). When the user
  // hasn't explicitly picked target-audience chips (handled above), we
  // do NOT narrow by kids / age_range — same opt-out spirit as
  // communities. A parent is also an adult, so adult events show by
  // default; the user narrows only by explicitly choosing audiences.
  // suppress_child_audiences (an explicit "hide kids events" opt-out) is
  // still honoured.
  const allowed = new Set([
    "לכל המשפחה",
    "תינוקות",
    "ילדים",
    "נוער",
    "הורים",
    "מבוגרים",
    "ותיקים",
    "נשים",
  ]);
  if (profile?.user_context?.suppress_child_audiences) {
    allowed.delete("תינוקות");
    allowed.delete("ילדים");
    allowed.delete("נוער");
  }
  return allowed;
}

// Per-subtype TAG filter inside the `מבוגרים` audience tier.
//
// The city CMS emits subtype-tagged events ("גיל הזהב" for 60+
// lectures, "צעירים" for 18-35 themed activities) — see
// `extractAudienceSubtypeTags` in lib/cityApi.js. All three subtypes
// (young / mid / senior) share the `מבוגרים` audience ENUM, but a
// 28-year-old shouldn't see senior lectures and a 70-year-old
// shouldn't see DJ parties.
//
// Returns the LIST of tag NAMES to EXCLUDE from results based on
// the user's `age_range`. Empty list when:
//   - `age_range` is unset (no signal → no filtering),
//   - `age_range` is 'mid_adult' (the middle bucket has no opposite
//     extreme to exclude — both subtype tags are off-target).
//
// The matching is by tag NAME, applied AFTER the audience ENUM
// filter — so an event tagged `גיל הזהב` AND audience `מבוגרים`
// is dropped for a 'young_adult' user, but events tagged `גיל הזהב`
// AND audience `לכל המשפחה` would still pass (family events ignore
// the subtype gate).
// Last-resort category fallback (May-2026).
//
// Gemini occasionally returns `category: null` for events whose NAME
// makes the type unambiguous — typically when the surrounding context
// (umbrella + description) leans the other way. Real-world case:
// "מסיבת שבועות" rows under the "lectures-for-age-60-and-over"
// umbrella; Gemini saw "senior lectures" context and went null
// instead of trusting the leading "מסיבת" in the title.
//
// We infer the category from the FIRST WORD of the event name only —
// in Hebrew, the activity type almost always leads ("מסיבת X",
// "סדנת Y", "הרצאת Z"). Matching anywhere in the name would
// over-trigger (e.g. "סדנת מסיבת תה" → workshop, not party).
// Exact-word match against the curated `ACTIVITY_TYPE_KEYWORDS`
// inflection list keeps the false-positive surface tiny.
//
// Returns the canonical Hebrew category from `ACTIVITY_TYPES` (the
// first entry — that's the ENUM-canonical form), or null when the
// first word doesn't match any known type. Callers chain it after
// Gemini's output + existing DB value:
//     labels.category || existing.category || inferCategoryFromName(name)
function inferCategoryFromName(name) {
  if (!name || typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  // Hebrew names occasionally lead with an English marker
  // ("SHAVUOT PARTY -מסיבה …") — split on whitespace AND a few
  // ASCII delimiters that the curators use as section separators
  // before the topical Hebrew word.
  const firstWord = trimmed.split(/[\s\-–—|,]+/u)[0];
  if (!firstWord) return null;
  const lowered = firstWord.toLocaleLowerCase("he-IL");
  for (const [typeKey, kws] of Object.entries(ACTIVITY_TYPE_KEYWORDS)) {
    for (const kw of kws) {
      // Exact match against any inflection in the curated list. We
      // intentionally do NOT do startsWith / substring — "מסיבת" is
      // an inflection that's already in the list; matching loosely
      // would catch unrelated tokens like "מסיביתון" / "סדנאתו".
      if (lowered === kw.toLocaleLowerCase("he-IL")) {
        const categories = ACTIVITY_TYPES[typeKey];
        if (categories && categories.length) return categories[0];
      }
    }
  }
  return null;
}

// More aggressive variant for UMBRELLA TITLES — scans ANY word, not
// just the leading one. Umbrellas describe an activity series with
// meta-phrasing where the genre word lives mid-sentence:
//   "מגוון הרצאות מרתקות לאזרחים ותיקים" → 'הרצאות' is word #2
//   "הרצאה מזמרת"                       → 'הרצאה' is word #1 (catch both)
//   "סדנאות בשבועות"                    → 'סדנאות' is word #1
//
// Safe because umbrella titles are short, curated, and explicitly
// describe what's inside; mid-sentence keyword hits there are reliable
// signals of the children's type. We do NOT run this on the event
// NAME — that's covered by the conservative leading-word check above
// (where mid-sentence keywords routinely produce false positives like
// "סדנת מסיבת תה" → workshop, not party).
//
// First match wins; iteration order on ACTIVITY_TYPE_KEYWORDS is the
// dictionary literal's declaration order. If two keywords compete in
// the same title (rare for real-world umbrella names), order will
// resolve it deterministically.
function inferCategoryFromUmbrellaTitle(umbrellaTitle) {
  if (!umbrellaTitle || typeof umbrellaTitle !== "string") return null;
  const trimmed = umbrellaTitle.trim();
  if (!trimmed) return null;
  const titleLower = trimmed.toLocaleLowerCase("he-IL");
  const words = trimmed
    .split(/[\s\-–—|,]+/u)
    .map((w) => w.toLocaleLowerCase("he-IL"))
    .filter(Boolean);
  if (!words.length) return null;
  const wordSet = new Set(words);
  for (const [typeKey, kws] of Object.entries(ACTIVITY_TYPE_KEYWORDS)) {
    for (const kw of kws) {
      const kwLower = kw.toLocaleLowerCase("he-IL");
      // Multi-word phrases (anything with whitespace) only match
      // via substring; single tokens match via the word set so a
      // mid-keyword inflection like "מסיבת" can't accidentally
      // catch "מסיביתון".
      const phrase = /\s/.test(kwLower);
      const hit = phrase ? titleLower.includes(kwLower) : wordSet.has(kwLower);
      if (hit) {
        const categories = ACTIVITY_TYPES[typeKey];
        if (categories && categories.length) return categories[0];
      }
    }
  }
  return null;
}

// Whole-text scan for prose DESCRIPTIONS. Looser than the umbrella
// scan because descriptions are longer and can mention multiple
// activity types in passing — but still strict enough to avoid
// false positives from incidental words. We split on any
// non-Hebrew/Latin char (whitespace, punctuation, Unicode pictographs)
// so emoji markers like "📍" / "🎵" become delimiters and don't merge
// with adjacent words ("📍מופע" → ['מופע']).
//
// Iteration order = ACTIVITY_TYPE_KEYWORDS declaration order. First
// keyword that matches a whole word wins. We picked the order so the
// most specific types (workshop/lecture/party/show) come before
// generic catch-alls (gathering/sport/movie).
//
// Returns the canonical Hebrew category or null. Used as the last
// inference fallback in `applyLabels` AFTER name + umbrella scans,
// since description-based inference is the loosest signal of the three.
// Common single-letter Hebrew prefixes (definite article + the
// inflectional prepositions). Matching the activity keyword against
// the word AND each prefix+word combo lets the description scanner
// catch "המוזיקלי" / "במופע" / "להופעה" without having to enumerate
// every prefixed form in `ACTIVITY_TYPE_KEYWORDS`.
//
// Why these five (ה / ב / ל / כ / מ): they're the canonical
// proclitic preposition / definite-article set in Hebrew. We omit
// `ו` (and) — it occasionally fuses with a topical noun ("ומופע")
// but more often introduces an unrelated coordinate clause; the
// false-positive surface there is too wide for the modest recall
// gain. Same logic for `ש` (that/which).
const HEBREW_PREFIXES = ["", "ה", "ב", "ל", "כ", "מ"];

function inferCategoryFromDescription(description) {
  if (!description || typeof description !== "string") return null;
  const trimmed = description.trim();
  if (!trimmed) return null;
  const descLower = trimmed.toLocaleLowerCase("he-IL");
  // Tokenize: keep only Hebrew + Latin + digits as "word characters".
  // Everything else (whitespace, punctuation, emoji, pipes/quotes) is a
  // boundary. Lowercase the Latin part for case-insensitive matching;
  // Hebrew has no case so `toLocaleLowerCase('he-IL')` is a no-op for
  // those chars but harmless.
  const words = new Set();
  for (const m of trimmed.matchAll(/[\u0590-\u05FFA-Za-z0-9]+/gu)) {
    words.add(m[0].toLocaleLowerCase("he-IL"));
  }
  if (!words.size) return null;
  for (const [typeKey, kws] of Object.entries(ACTIVITY_TYPE_KEYWORDS)) {
    for (const kw of kws) {
      const base = kw.toLocaleLowerCase("he-IL");
      // Multi-word phrases (with whitespace) match via substring
      // against the raw description text — necessary because the
      // word-tokenizer above can't reassemble them across the
      // delimiter set. Single tokens match via the word set with
      // Hebrew-prefix support (see HEBREW_PREFIXES rationale).
      if (/\s/.test(base)) {
        if (descLower.includes(base)) {
          const categories = ACTIVITY_TYPES[typeKey];
          if (categories && categories.length) return categories[0];
        }
        continue;
      }
      const isPlainHebrew = /^[\u0590-\u05FF]+$/.test(base);
      const variants = isPlainHebrew
        ? HEBREW_PREFIXES.map((p) => p + base)
        : [base];
      for (const v of variants) {
        if (words.has(v)) {
          const categories = ACTIVITY_TYPES[typeKey];
          if (categories && categories.length) return categories[0];
        }
      }
    }
  }
  return null;
}

const { hasSeniorSignals } = require("./seniorAudience");

function deriveExcludedSubtypeTags(profile) {
  const ageRange = profile?.user_context?.age_range || profile?.age_range || null;
  // "גיל הזהב" tag retired — young/senior narrowing uses
  // `shouldExcludeAdultSubtypeEvent` (audience, access, min_months).
  if (ageRange === "senior") return ["צעירים"];
  return [];
}

/**
 * Within `מבוגרים` (and legacy מבוגרים+senior-signal rows), drop events
 * aimed at the opposite cohort for the user's `age_range`.
 */
function shouldExcludeAdultSubtypeEvent(event, profile) {
  const ageRange = profile?.user_context?.age_range || profile?.age_range || null;
  if (!ageRange) return false;
  if (event?.audience !== "מבוגרים" && event?.audience !== "ותיקים") return false;
  if (ageRange === "young_adult") return hasSeniorSignals(event);
  if (ageRange === "senior") {
    const tags = Array.isArray(event.tags) ? event.tags : [];
    return tags.includes("צעירים");
  }
  return false;
}

// Numeric age-window derived from the user's profile `age_range`, in
// MONTHS. Matches the convention used on events.min_months / max_months
// so callers can do a direct interval-overlap check.
//
// Buckets (May-2026 onboarding):
//   young_adult → [216, 420]   (18-35y)
//   mid_adult   → [420, 720]   (35-60y)
//   senior      → [720, null]  (60+y, null = open-ended upper bound)
//   unset       → null         (no filtering signal)
//
// Returns `{ min, max }` (max may be null for open-ended ranges) or
// `null` when the profile has no `age_range` set — callers should
// short-circuit on null (no overlap gate to enforce).
//
// Why MONTHS and not years: events.min_months/max_months are MONTHS
// (kid events frequently use ranges like "6-24 months" for babies);
// returning the same unit removes a conversion step at every caller
// and avoids rounding surprises near boundaries (18y == 216m exact).
function userAgeWindowMonths(profile) {
  const ageRange = profile?.user_context?.age_range || profile?.age_range || null;
  if (ageRange === "young_adult") return { min: 216, max: 420 };
  if (ageRange === "mid_adult") return { min: 420, max: 720 };
  if (ageRange === "senior") return { min: 720, max: null };
  return null;
}

// Does the event's age range overlap the user's age range?
//
// Treats nulls as open ends (event.min_months=null → "no lower bound
// pinned", same for max; identical for the user side). Both sides
// supply HALF-OPEN intervals — overlap exists iff
//     max(userMin, evMin) <  min(userMax, evMax)
// using +Infinity for null upper bounds and 0 for null lower bounds.
//
// Returns true also when the event has neither bound set — those
// rows carry no age signal, and we keep the permissive behaviour
// the legacy ageMatches() path established (don't drop unknowns).
function ageWindowOverlaps(event, userWindow) {
  if (!userWindow) return true;
  const eMin = Number.isFinite(event?.min_months) ? event.min_months : null;
  const eMax = Number.isFinite(event?.max_months) ? event.max_months : null;
  if (eMin == null && eMax == null) return true;
  const lo = Math.max(userWindow.min ?? 0, eMin ?? 0);
  const hi = Math.min(
    userWindow.max ?? Number.POSITIVE_INFINITY,
    eMax ?? Number.POSITIVE_INFINITY,
  );
  return lo < hi;
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

/** Hebrew playroom surface forms — spelling variants on Smarticket rows. */
const PLAYROOM_TEXT_RE = /משחקי[הת]?|משחקיה|משחקיות/u;

function isPlayroomKeyword(keyword) {
  return PLAYROOM_TEXT_RE.test(String(keyword || "").trim());
}

/** Title/keyword match tolerant of משחקייה vs משחקיה vs משחקיות. */
function keywordMatchesPlayroomText(text, keyword) {
  const hay = String(text || "").toLowerCase();
  const k = String(keyword || "").toLowerCase().trim();
  if (!k) return true;
  if (hay.includes(k)) return true;
  if (isPlayroomKeyword(k) && PLAYROOM_TEXT_RE.test(hay)) return true;
  return false;
}

/** Strict playspace filter — used when the user asked for "משחקייה". */
function playspaceMatches(event) {
  if (isConsultationEvent(event)) return false;
  const name = event?.name || "";
  const desc = event?.description || "";
  const cat = event?.category || null;
  // Obvious non-playroom shapes even when category is missing/wrong.
  if (/בלון|בלונים|מופע(?=\s|$)|הצג[הת](?=\s|$)|סרט|סיור(?=\s|$)|סדנ[הת](?=\s|$)/u.test(name)) {
    if (cat !== "משחקייה") return false;
  }
  if (cat === "משחקייה") return true;
  if (/משחקי[הת]|משחקיה|משחקיות/u.test(name)) return true;
  const inferred =
    inferCategoryFromName(name) ||
    inferCategoryFromDescription(desc) ||
    inferCategoryFromDescription(name);
  return inferred === "משחקייה";
}

/**
 * Strict party filter — used when the user asked for "מסיבה". Mirrors
 * `playspaceMatches`: trust the category when set, but DON'T drop a row
 * just because `category` is null or was mis-tagged by the enricher.
 * A literal "מסיבה" in the title (anywhere, not just the first word)
 * or a keyword inference is enough. This is the fix for "there ARE
 * parties but a search for מסיבה finds nothing" — previously party
 * required `event.category === "מסיבה"` and nothing else.
 */
function partyMatches(event) {
  const cat = event?.category || null;
  if (cat === "מסיבה") return true;
  const name = event?.name || "";
  if (/מסיב[הות]/u.test(name) || /\bparty\b/i.test(name)) return true;
  if (!cat) {
    const inferred =
      inferCategoryFromName(name) ||
      inferCategoryFromDescription(event?.description || "");
    if (inferred === "מסיבה") return true;
  }
  return false;
}

/**
 * Activity-type filter for search_events. `party` and `playspace` use
 * strict matching; other types keep the permissive null-category pass.
 */
function eventMatchesActivityTypes(event, requestedTypesEN) {
  if (!Array.isArray(requestedTypesEN) || !requestedTypesEN.length) return true;
  for (const t of requestedTypesEN) {
    if (t === "playspace") {
      if (playspaceMatches(event)) return true;
      continue;
    }
    if (t === "party") {
      if (partyMatches(event)) return true;
      continue;
    }
    if (categoryMatches(event, [t])) return true;
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
// Consultation detection — 1:1 advice sessions vs. regular activities.
//
// "ייעוץ" / "קליניקת הנקה" / "התייעצות" events are a different shape
// than the things-to-do the bot is built for: they're 1:1 advice slots
// with a professional, not a workshop / show / playgroup. A parent
// asking "מה השבוע?" almost never means them, and surfacing them
// alongside activities crowds out real events.
//
// The agent's search_events tool filters them out by default and
// only includes them when the user explicitly mentions consultation
// keywords ("ייעוץ הורות", "קליניקת הנקה", "להתייעץ", …). See
// `include_consultations` in lib/agent/tools/events.js + the
// CONSULTATION EVENTS section in the system prompt.
//
// Two-layer detection. OR semantics so we catch both labelled and
// title-only cases; restrictive enough that legitimate activities
// like "סדנת הנקה" / "הרצאה על הורות" stay in the regular result set:
//
//   1. TAG MEMBERSHIP — event tagged with a canonical consultation
//      label name. Maintained as a Set of exact-match strings so an
//      event tagged "ייעוץ הורות" matches without false-firing on
//      "הורות" alone (which is a legitimate workshop topic).
//   2. NAME REGEX — event title matches `/(ייעוץ|התייעצות|קליניקת)/`.
//      Covers untagged rows whose category column points at a broad
//      bucket (מפגש / הרצאה) but whose name makes the consultation
//      intent obvious ("ייעוץ אישי לכל אם", "קליניקת התפתחות").
//
// We deliberately do NOT match bare "הנקה" / "הורות" — those are
// activity topics; the trigger must be the consultation framing.
// ──────────────────────────────────────────────────────────────────────
const CONSULTATION_TAG_NAMES = new Set([
  "ייעוץ",
  "ייעוץ הורות",
  "ייעוץ הנקה",
  "קליניקת הנקה",
  "התייעצות",
]);
const CONSULTATION_NAME_RX = /(ייעוץ|התייעצות|קליניקת)/;

function isConsultationEvent(eventLabels) {
  const tags = Array.isArray(eventLabels?.tags) ? eventLabels.tags : [];
  for (const t of tags) {
    if (typeof t !== "string") continue;
    if (CONSULTATION_TAG_NAMES.has(t.trim())) return true;
  }
  const name = String(eventLabels?.name || "");
  return CONSULTATION_NAME_RX.test(name);
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
const {
  effectiveEventAgeBounds,
  kidConflictsEventExclusions,
  detectBabyStage,
} = require("./eventFormat");

// Developmental-stage matching. Babies develop at different rates, so a
// profile that says "זוחל" should match a crawlers event regardless of
// the exact month count. Maps free text (event stage label OR a kid's
// stored stage id/label) to canonical stage ids.
const STAGE_ID_PATTERNS = {
  crawl: /זוחל|זחיל/u,
  walk: /הולכ|הולך/u,
  wean: /גמול/u,
  solids: /מוצק/u,
};
function stageIdsFromText(text) {
  const t = String(text || "");
  const ids = [];
  for (const [id, re] of Object.entries(STAGE_ID_PATTERNS)) {
    if (re.test(t)) ids.push(id);
  }
  return ids;
}
function kidStageIdSet(kid) {
  const out = new Set();
  for (const s of kid?.stages || []) {
    const str = String(s);
    if (STAGE_ID_PATTERNS[str]) out.add(str); // already a canonical id
    else for (const id of stageIdsFromText(str)) out.add(id); // a label
  }
  return out;
}
/** True when a household kid's DEV STAGE matches the event's stage band. */
function kidStageFitsEvent(event, kidsProfiles) {
  if (!Array.isArray(kidsProfiles) || !kidsProfiles.length) return false;
  const evStageIds = stageIdsFromText(
    detectBabyStage(event?.name || "", event?.description || ""),
  );
  if (!evStageIds.length) return false;
  for (const kid of kidsProfiles) {
    const ks = kidStageIdSet(kid);
    if (evStageIds.some((id) => ks.has(id))) return true;
  }
  return false;
}

// True when at least one household kid's age fits the event range.
// Uses title-inferred bounds when DB max_months is missing (e.g. "עד גיל שנה").
// Optional `kidsProfiles` — full kid rows with stages[] — hides events that
// exclude crawlers when a household child is crawling (by stage or ~6–11 mo).
function householdKidsFitEvent(event, kidsAgesYears, kidsProfiles = null) {
  if (kidConflictsEventExclusions(event, kidsProfiles)) return false;
  // Stage match wins over the numeric age window: a kid marked "זוחל"
  // fits a crawlers event even if their month-count drifts outside the
  // inferred band. Positive override only — a stage MISMATCH falls back
  // to the age check below rather than excluding.
  if (kidStageFitsEvent(event, kidsProfiles)) return true;
  if (!Array.isArray(kidsAgesYears) || !kidsAgesYears.length) return true;
  const bounds = effectiveEventAgeBounds(event);
  if (bounds.min_months == null && bounds.max_months == null) {
    return ageMatches(event, kidsAgesYears);
  }
  const usable = kidsAgesYears.filter((y) => y != null && Number.isFinite(y));
  if (!usable.length) return true;
  const lo = bounds.min_months ?? 0;
  const hi = bounds.max_months ?? Number.POSITIVE_INFINITY;
  return usable.some((y) => {
    const m = y * 12;
    return m >= lo && m <= hi;
  });
}

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
  AUDIENCE_REQUIRED_SUBTYPE_TAGS,
  ACTIVITY_TYPES,
  ACTIVITY_TYPE_KEYS,
  ACTIVITY_TYPE_KEYWORDS,
  ACCEPTABLE_AUDIENCES_HE,
  audienceVerdict,
  audienceCompatible,
  audienceLabel,
  deriveDefaultAudienceSet,
  deriveExcludedSubtypeTags,
  shouldExcludeAdultSubtypeEvent,
  userAgeWindowMonths,
  ageWindowOverlaps,
  inferCategoryFromName,
  inferCategoryFromUmbrellaTitle,
  inferCategoryFromDescription,
  categoryMatches,
  playspaceMatches,
  isPlayroomKeyword,
  keywordMatchesPlayroomText,
  eventMatchesActivityTypes,
  activityMatches,
  ageMatches,
  householdKidsFitEvent,
  CONSULTATION_TAG_NAMES,
  CONSULTATION_NAME_RX,
  isConsultationEvent,
};
