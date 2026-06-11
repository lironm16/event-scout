// Single source of truth: 60+ / senior programming → audience ENUM `ותיקים`.
// Senior status is read from STRUCTURED fields only (audience / min_months /
// access) — the LLM enricher classifies `ותיקים` (it gets the umbrella_title
// context, e.g. "הרצאות במועדונים לוותיקים"). No regex text-scan of the name.

const CHILD_AUDIENCES = new Set(["תינוקות", "ילדים", "נוער"]);

/** Unified card line for every senior-targeted event. */
const SENIOR_AUDIENCE_DISPLAY_LINE = "🎯 אזרחים ותיקים";

function isSixtyPlusMonths(min) {
  return Number.isFinite(min) && min >= 720;
}

function accessIncludesSeniors(access) {
  if (!access) return false;
  if (access === "community-seniors") return true;
  return Array.isArray(access) && access.includes("community-seniors");
}

/**
 * True when the row is `ותיקים` (60+) — STRUCTURED signals only.
 */
function hasSeniorSignals(ctx = {}) {
  if (!ctx || typeof ctx !== "object") return false;
  if (ctx.audience === "ותיקים") return true;
  if (isSixtyPlusMonths(ctx.min_months)) return true;
  if (accessIncludesSeniors(ctx.access)) return true;
  return false;
}

function shouldPromoteToVatikim(ctx = {}) {
  if (!ctx || typeof ctx !== "object") return false;
  if (CHILD_AUDIENCES.has(ctx.audience)) return false;
  if (ctx.audience === "הורים") return false;
  return hasSeniorSignals(ctx);
}

/**
 * Normalize label payload before DB write (enricher / backfill).
 */
function normalizeSeniorLabels(labels, context = {}) {
  if (!labels || typeof labels !== "object") return labels;
  const merged = {
    name: context.name,
    umbrella_title: context.umbrella_title,
    description: context.description,
    access: context.access,
    audienceType: context.audienceType,
    tags: labels.tags,
    audience: labels.audience,
    min_months: labels.min_months,
    max_months: labels.max_months,
  };
  if (!shouldPromoteToVatikim(merged)) return labels;

  // Do not add "גיל הזהב" as a discovery tag — `audience: ותיקים` and
  // `access: community-seniors` already carry the signal; the tag
  // crowded out real topic labels (e.g. תזונה, בריאות on lectures).
  const tags = (labels.tags || []).filter((t) => !/גיל\s*הזהב/.test(String(t)));
  let min = labels.min_months;
  let max = labels.max_months;
  if (!isSixtyPlusMonths(min)) min = 720;
  if (
    max != null &&
    max >= 1200 &&
    (labels.min_months == null || labels.min_months < 720)
  ) {
    max = null;
  }
  return {
    ...labels,
    audience: "ותיקים",
    tags: [...tags],
    min_months: min,
    max_months: max,
  };
}

/** After city `mapAudience()` — promote 60+ buckets to `ותיקים`. */
function normalizeScrapedAudience(audience, ctx = {}) {
  if (CHILD_AUDIENCES.has(audience) || audience === "הורים") return audience;
  if (audience === "ותיקים") return "ותיקים";
  if (shouldPromoteToVatikim({ ...ctx, audience })) return "ותיקים";
  return audience;
}

/** Card display: one line for all senior rows (ENUM or legacy מבוגרים+signals). */
function formatSeniorAudienceLine(event) {
  if (!event) return null;
  if (event.audience === "ותיקים") return SENIOR_AUDIENCE_DISPLAY_LINE;
  if (event.audience === "מבוגרים" && hasSeniorSignals(event)) {
    return SENIOR_AUDIENCE_DISPLAY_LINE;
  }
  return null;
}

module.exports = {
  SENIOR_AUDIENCE_DISPLAY_LINE,
  isSixtyPlusMonths,
  hasSeniorSignals,
  shouldPromoteToVatikim,
  normalizeSeniorLabels,
  normalizeScrapedAudience,
  formatSeniorAudienceLine,
};
