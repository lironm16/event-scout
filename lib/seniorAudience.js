// Single source of truth: 60+ / senior programming → audience ENUM `ותיקים`.

const SENIOR_TEXT_RE =
  /אזרחים\s*ותיקים|הגיל\s*השלישי|גיל\s*הזהב|מועדון\s*ותיקים|גיל\s*60|60\s*\+|for[-_ ]age[-_ ]60|lectures-for-age-60/i;

const CHILD_AUDIENCES = new Set(["תינוקות", "ילדים", "נוער"]);

/** Unified card line for every senior-targeted event. */
const SENIOR_AUDIENCE_DISPLAY_LINE = "🎯 אזרחים ותיקים (60+)";

function isSixtyPlusMonths(min) {
  return Number.isFinite(min) && min >= 720;
}

function accessIncludesSeniors(access) {
  if (!access) return false;
  if (access === "community-seniors") return true;
  return Array.isArray(access) && access.includes("community-seniors");
}

function audienceTypeNamesSignalSenior(audienceTypeArray) {
  if (!Array.isArray(audienceTypeArray)) return false;
  const names = audienceTypeArray.map((a) => a?.name || "").filter(Boolean);
  return names.some((n) => SENIOR_TEXT_RE.test(n));
}

/**
 * True when the row should be stored / shown as `ותיקים` (60+).
 */
function hasSeniorSignals(ctx = {}) {
  if (!ctx || typeof ctx !== "object") return false;
  if (ctx.audience === "ותיקים") return true;
  if (isSixtyPlusMonths(ctx.min_months)) return true;
  if (accessIncludesSeniors(ctx.access)) return true;
  const tags = Array.isArray(ctx.tags) ? ctx.tags : [];
  if (tags.some((t) => /גיל\s*הזהב/.test(String(t)))) return true;
  if (audienceTypeNamesSignalSenior(ctx.audienceType)) return true;
  const hay = [ctx.name, ctx.umbrella_title, ctx.description]
    .filter(Boolean)
    .join(" ");
  return SENIOR_TEXT_RE.test(hay);
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
  SENIOR_TEXT_RE,
  SENIOR_AUDIENCE_DISPLAY_LINE,
  isSixtyPlusMonths,
  hasSeniorSignals,
  shouldPromoteToVatikim,
  normalizeSeniorLabels,
  normalizeScrapedAudience,
  formatSeniorAudienceLine,
};
