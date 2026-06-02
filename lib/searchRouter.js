// Deterministic Hebrew text → search_events args (no Gemini).
// Used when AGENT_ENABLED=false; complements inline `rtr:*` callbacks.

const { ACTIVITY_TYPE_KEYWORDS } = require("./categories");

const REFINE_WALK = /^(רק\s+)?(קרוב|בסביבה|בהליכה|מה שאני יכול|מה שאפשר ללכת)/u;
const REFINE_TICKETS = /^(רק\s+)?(עם\s+)?כרטיסים/u;
const REFINE_ADULTS = /^(גם\s+)?(ל)?מבוגרים/u;
const REFINE_ALL = /^(תראי|הראי|הצג)\s+(לי\s+)?הכל/u;
const EXTEND_YES = /^(כן|כן[,.]?\s*(תראי|להראות|להרחיב)|להראות|להרחיב|תראי\s+גם)/u;

const DATE_RULES = [
  { re: /\b(היום|today)\b/u, preset: "today" },
  { re: /\b(מחר|tomorrow)\b/u, preset: "tomorrow" },
  { re: /\b(שבוע\s*הבא|next\s*week)\b/u, preset: "next_week" },
  { re: /\b(השבוע|this\s*week|מה\s+יש\s+השבוע|מה\s+השבוע)\b/u, preset: "this_week" },
  { re: /\b(סוף\s*שבוע|weekend)\b/u, preset: "this_week" },
];

// Topic hints passed as `tags` — resolved fuzzy in search_events.
const TAG_HINTS = [
  "מוזיקה",
  "שבת קהילה",
  "עששיות",
  "שבועות",
  "חנוכה",
  "פסח",
  "טבע",
  "יצירה",
  "ספורט",
  "תיאטרון",
  "ספרייה",
  "מייקרס",
];

const SEARCH_VERBS = /\b(חפש|חפשי|מצא|מצאי|תמצא|יש|מה\s+יש|מה\s+הולך|אירועים)\b/u;

function normalizeText(raw) {
  return String(raw || "")
    .trim()
    .replace(/[.!?…]+$/u, "")
    .replace(/\s+/g, " ");
}

function detectActivityTypes(text) {
  const lower = text.toLowerCase();
  const out = [];
  for (const [type, words] of Object.entries(ACTIVITY_TYPE_KEYWORDS)) {
    if (words.some((w) => w && lower.includes(w.toLowerCase()))) out.push(type);
  }
  return [...new Set(out)];
}

function extractAges(text) {
  const ages = [];
  const re = /(?:בן|בת|גיל|לגיל|גילאי|בני)\s*(\d{1,2})/gu;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 0 && n <= 18) ages.push(n);
  }
  return [...new Set(ages)];
}

function extractTagsAndKeywords(text, activityTypes) {
  const lower = text.toLowerCase();
  const tags = [];
  const keywords = [];
  for (const hint of TAG_HINTS) {
    if (lower.includes(hint.toLowerCase())) tags.push(hint);
  }
  // Residual tokens (≥3 chars) as keywords when not already a tag/activity.
  const stripped = lower
    .replace(SEARCH_VERBS, " ")
    .replace(/\b(היום|מחר|השבוע|שבוע|סוף|אירועים|לילדים|לילד|לתינוק|למשפחה)\b/gu, " ");
  for (const w of stripped.split(/[\s,]+/)) {
    const t = w.trim();
    if (t.length < 3) continue;
    if (tags.some((tag) => tag.includes(t) || t.includes(tag))) continue;
    if (activityTypes.some((type) =>
      (ACTIVITY_TYPE_KEYWORDS[type] || []).some((kw) => kw && t.includes(kw)),
    )) {
      continue;
    }
    keywords.push(t);
  }
  const dateNoise = new Set([
    "השבוע", "שבוע", "היום", "מחר", "סוף", "weekend", "today", "tomorrow",
  ]);
  return {
    tags: [...new Set(tags)],
    keywords: [...new Set(keywords)].filter((k) => !dateNoise.has(k)).slice(0, 5),
  };
}

/**
 * Merge router filters into search_events tool args.
 * Omits null/empty fields.
 */
function filtersToSearchArgs(filters) {
  if (!filters || typeof filters !== "object") return {};
  const args = {};
  if (filters.date_preset) args.date_preset = filters.date_preset;
  if (filters.date_from) args.date_from = filters.date_from;
  if (filters.date_to) args.date_to = filters.date_to;
  if (filters.tags?.length) args.tags = filters.tags;
  if (filters.keywords?.length) args.keywords = filters.keywords;
  if (filters.activity_types?.length) args.activity_types = filters.activity_types;
  if (filters.proximity) args.proximity = filters.proximity;
  if (filters.ignore_profile) args.ignore_profile = true;
  if (filters.available_only) args.available_only = true;
  if (filters.unseen_only) args.unseen_only = true;
  if (filters.audience) args.audience = filters.audience;
  if (filters.audiences?.length) args.audiences = filters.audiences;
  if (filters.ages?.length) args.ages = filters.ages;
  else if (filters.age != null) args.age = filters.age;
  return args;
}

function parseNewSearch(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const filters = {};
  for (const { re, preset } of DATE_RULES) {
    if (re.test(normalized)) {
      filters.date_preset = preset;
      break;
    }
  }
  if (!filters.date_preset && SEARCH_VERBS.test(normalized)) {
    // No explicit date → search everything coming up (not just this week).
    filters.date_preset = "upcoming";
  }

  const activity_types = detectActivityTypes(normalized);
  if (activity_types.length) filters.activity_types = activity_types;

  const ages = extractAges(normalized);
  if (ages.length) filters.ages = ages;

  const { tags, keywords } = extractTagsAndKeywords(normalized, activity_types);
  // Playroom → strict activity_types filter; fuzzy tag "משחק" is too broad.
  if (tags.length && !activity_types.includes("playspace")) filters.tags = tags;
  if (keywords.length) filters.keywords = keywords;

  if (
    !filters.date_preset &&
    !filters.tags?.length &&
    !filters.keywords?.length &&
    !filters.activity_types?.length &&
    !filters.ages?.length
  ) {
    return null;
  }
  if (!filters.date_preset) filters.date_preset = "upcoming";

  return filters;
}

function parseRefinement(text, lastFilters) {
  const normalized = normalizeText(text);
  if (!lastFilters) return null;
  const next = { ...lastFilters };

  if (REFINE_WALK.test(normalized)) {
    next.proximity = "walk";
    return next;
  }
  if (REFINE_TICKETS.test(normalized)) {
    next.available_only = true;
    return next;
  }
  if (REFINE_ADULTS.test(normalized)) {
    next.audience = "adults";
    return next;
  }
  if (REFINE_ALL.test(normalized)) {
    next.audience = "all";
    return next;
  }
  return null;
}

/**
 * @returns {{ kind: string, filters?: object }}
 *   kind: search | refine | extend | menu | unknown
 */
function routeMessage(text, { lastFilters = null, hasExtensionHint = false } = {}) {
  const normalized = normalizeText(text);
  if (!normalized) return { kind: "menu" };

  if (hasExtensionHint && EXTEND_YES.test(normalized)) {
    return { kind: "extend" };
  }

  const refine = parseRefinement(normalized, lastFilters);
  if (refine) return { kind: "refine", filters: refine };

  const search = parseNewSearch(normalized);
  if (search) return { kind: "search", filters: search };

  // Short topic-only follow-up while a search is active: "רק מוזיקה"
  if (lastFilters && normalized.length <= 40) {
    const topic = parseNewSearch(normalized);
    if (topic?.tags?.length || topic?.keywords?.length) {
      return {
        kind: "refine",
        filters: { ...lastFilters, ...topic, date_preset: lastFilters.date_preset || topic.date_preset },
      };
    }
  }

  if (/^(חיפוש|תפריט|עזרה|help|search)$/iu.test(normalized)) {
    return { kind: "menu" };
  }

  return { kind: "unknown" };
}

function buildIntroFromSearchResult(result) {
  const label = result?.window?.label_he || "בחלון שבחרת";
  const n = result?.matched ?? 0;
  if (n === 0) return null;
  // Keep it simple — no counts. The series/occurrence numbers only
  // confused (e.g. "2 אירועים (3 מופעים בסך הכל)"), and a raw series
  // count under-reported recurring events. Just introduce the list.
  if (result?.resolved_tags?.length) {
    const names = result.resolved_tags.map((t) => t.matched || t.asked).join(", ");
    return `הנה האירועים ${label} (תגיות: ${names}):`;
  }
  return `הנה האירועים ${label}:`;
}

function buildNoResultsMessage(result) {
  const label = result?.window?.label_he || "בחלון הזה";
  let msg = `לא מצאתי אירועים ${label}.`;
  if (result?.unresolved_tags?.length) {
    msg += `\nלא מצאתי תגית «${result.unresolved_tags.join(", ")}» — אפשר לנסות מילה אחרת או לשמור מעקב.`;
  }
  if (result?.already_shown_excluded > 0 && (result?.matched ?? 0) === 0) {
    msg += "\nכל מה שמצאתי בחיפוש הזה כבר הוצג לך — כבה «שלא ראיתי» או הרחיבי את התאריכים.";
  }
  if (result?.can_extend_beyond_window && result?.extension_hint) {
    const hint = result.extension_hint;
    // State the fact only — the "להרחיב?" question + button comes as a
    // single follow-up in the runner, so we don't ask twice.
    msg += `\nיש לפחות ${hint.count_at_least || "עוד"} אירועים ${hint.label_he || "מאוחר יותר"}.`;
  }
  return msg;
}

/** Saved-search snapshot from last router filters + optional label. */
function filtersToSaveSnapshot(filters, label) {
  const f = filters || {};
  const snapshot = {
    query: label || buildDefaultSaveLabel(f),
    tokens: Array.isArray(f.keywords) ? [...f.keywords] : [],
    filters: {},
    tickets_needed: null,
  };
  if (f.date_from) snapshot.filters.date_from = f.date_from;
  if (f.date_to) snapshot.filters.date_to = f.date_to;
  if (f.proximity) snapshot.filters.proximity = f.proximity;
  if (f.audience && f.audience !== "all") snapshot.filters.audience = f.audience;
  else if (f.audiences?.length === 1) snapshot.filters.audience = f.audiences[0];
  if (f.ages?.length) snapshot.filters.ages = f.ages;
  if (f.tags?.length) snapshot.filters.watch_tag_names = f.tags;
  return snapshot;
}

function buildDefaultSaveLabel(f) {
  const parts = [];
  if (f.tags?.length) parts.push(f.tags.join(" "));
  else if (f.keywords?.length) parts.push(f.keywords.join(" "));
  if (f.date_preset === "this_week") parts.push("השבוע");
  else if (f.date_preset === "tomorrow") parts.push("מחר");
  else if (f.date_preset === "today") parts.push("היום");
  if (f.proximity === "walk") parts.push("קרוב");
  if (f.unseen_only) parts.push("שלא ראיתי");
  return parts.filter(Boolean).join(" ").trim() || "מעקב על חיפוש";
}

function presetFilters(preset) {
  if (preset === "this_week") return { date_preset: "this_week" };
  if (preset === "tomorrow") return { date_preset: "tomorrow" };
  if (preset === "next_week") return { date_preset: "next_week" };
  if (preset === "today") return { date_preset: "today" };
  if (preset === "upcoming") return { date_preset: "upcoming" };
  if (preset === "walk") return { proximity: "walk" };
  if (preset === "tickets") return { available_only: true };
  return { date_preset: "upcoming" };
}

module.exports = {
  routeMessage,
  filtersToSearchArgs,
  filtersToSaveSnapshot,
  buildIntroFromSearchResult,
  buildNoResultsMessage,
  presetFilters,
  parseNewSearch,
};
