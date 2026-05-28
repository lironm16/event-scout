// Human-readable profile text for /profile and the typing menu.

const supabase = require("./supabase");
const { getAudienceById } = require("./interestCategories");
const { COMMUNITY_CHIPS } = require("./kidsWizardUi");
const {
  memberKeysForCommunityPicker,
  hasExplicitCommunityConfig,
} = require("./communityAccess");
const { getLocation } = require("./locationStore");
const { locationLabel } = require("./topLocationsService");

const DAY_NAMES = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

const TIME_PRESET_HE = {
  morning: "בוקר (08:00–12:00)",
  evening: "ערב (17:00–22:00)",
  weekend: "סופ״ש (09:00–22:00)",
};

/** Strip age_band and other non-filter fields before persisting kids[]. */
function normalizeKidEntry(kid) {
  if (!kid || typeof kid !== "object") return null;
  const out = {};
  const name = kid.name != null ? String(kid.name).trim() : "";
  const age = kid.age != null ? Number(kid.age) : null;
  if (name) out.name = name;
  else if (Number.isFinite(age)) out.name = "ילד/ה";
  if (Number.isFinite(age)) out.age = age;
  if (Array.isArray(kid.stages) && kid.stages.length) {
    out.stages = kid.stages.filter(Boolean);
  }
  if (!out.name && !Number.isFinite(out.age)) return null;
  return out;
}

function normalizeKids(kids) {
  if (!Array.isArray(kids)) return [];
  return kids.map(normalizeKidEntry).filter(Boolean);
}

function formatKidLine(kid) {
  const agePart = kid.age != null ? ` (${kid.age})` : "";
  const stages =
    Array.isArray(kid.stages) && kid.stages.length
      ? ` — ${kid.stages.join(", ")}`
      : "";
  return `• ${kid.name}${agePart}${stages}`;
}

function formatKidLines(kids) {
  if (!Array.isArray(kids) || !kids.length) return [];
  return ["👧 ילדים", ...kids.map(formatKidLine)];
}

function formatCommunitiesLines(communities) {
  const c = communities && typeof communities === "object" ? communities : {};
  if (!hasExplicitCommunityConfig(c)) {
    return ["🏳️ קהילות: רשום/ה לכל הקהילות (ברירת מחדל)"];
  }
  const labels = COMMUNITY_CHIPS.filter((ch) => c[ch.key] === "member").map(
    (ch) => ch.label,
  );
  if (!labels.length) {
    const legacyLabels = memberKeysForCommunityPicker(c)
      .map((k) => COMMUNITY_CHIPS.find((ch) => ch.key === k)?.label)
      .filter(Boolean);
    if (!legacyLabels.length) {
      return ["🏳️ קהילות: לא סומן שיוך — ערכי דרך «קהילות»"];
    }
    return ["🏳️ קהילות", "רשום/ה לקהילות:", ...legacyLabels];
  }
  return ["🏳️ קהילות", "רשום/ה לקהילות:", ...labels];
}

function formatInterestsLines(interests) {
  const list = Array.isArray(interests)
    ? interests.map((x) => String(x).trim()).filter(Boolean)
    : [];
  if (!list.length) {
    return ["⭐ תחומי עניין: לא הוגדרו", "_לעדכון: «עריכה» → תחומי עניין_"];
  }
  return ["⭐ תחומי עניין", ...list.map((label) => `• ${label}`)];
}

function formatAvailability(constraints) {
  const av = constraints?.availability;
  if (!av) return null;
  if (TIME_PRESET_HE[av.preset]) return TIME_PRESET_HE[av.preset];
  const block = av.blocks?.[0];
  if (!block) return null;
  const days = (block.days || [])
    .sort((a, b) => a - b)
    .map((d) => DAY_NAMES[d] || String(d))
    .join(", ");
  const slot =
    block.start === "08:00" && block.end === "12:00"
      ? "בוקר"
      : block.start === "17:00" && block.end === "22:00"
        ? "ערב"
        : `${block.start}–${block.end}`;
  return days ? `${days}: ${slot}` : slot;
}

function formatTargetAudiences(userContext) {
  const chipIds = userContext?.target_audience_chip_ids;
  if (!Array.isArray(chipIds) || !chipIds.length) return null;
  const labels = chipIds
    .map((id) => getAudienceById(id)?.label)
    .filter(Boolean);
  return labels.length ? labels.join(", ") : null;
}

async function resolveSuppressedTagNames(tagWeights) {
  const ids = Object.entries(tagWeights || {})
    .filter(([, w]) => w < 0.8)
    .sort(([, a], [, b]) => a - b)
    .map(([id]) => parseInt(id, 10))
    .filter((n) => !Number.isNaN(n));
  if (!ids.length) return [];
  const { data, error } = await supabase.from("labels").select("id, name").in("id", ids);
  if (error) {
    console.warn(`[ProfileDisplay] tag lookup failed: ${error.message}`);
    return [];
  }
  const byId = new Map((data || []).map((r) => [r.id, r.name]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * Profile card lines (Markdown). No duplicate «לא מתאים» block — kids/interests
 * appear once in the main sections.
 */
function formatProfileLines(profile) {
  const lines = ["📋 *הפרופיל שלך*"];
  if (!profile) {
    lines.push("");
    lines.push("_עדיין אין פרופיל — אפשר למלא דרך «עריכה» או /start_");
    return lines;
  }
  if (profile.first_name) lines.push(`👤 ${profile.first_name}`);
  const c = profile.user_context || {};
  const genderHe =
    c.gender === "female" ? "נקבה" : c.gender === "male" ? "זכר" : null;
  if (genderHe) lines.push(`⚧ מגדר: ${genderHe}`);
  if (c.age_range) {
    const ageLabel =
      c.age_range === "young_adult"
        ? "18-35"
        : c.age_range === "mid_adult"
          ? "35-60"
          : c.age_range === "senior"
            ? "60+"
            : null;
    if (ageLabel) lines.push(`🎂 טווח גיל: ${ageLabel}`);
  }

  lines.push("");
  lines.push(...formatInterestsLines(c.interests));

  if (c.suppress_child_audiences) {
    lines.push("");
    lines.push("🚫 לא מציג אירועי ילדים/תינוקות/נוער");
  }
  const kidLines = formatKidLines(c.kids);
  if (kidLines.length) {
    lines.push("");
    lines.push(...kidLines);
  }

  const commLines = formatCommunitiesLines(c.communities);
  if (commLines.length) {
    lines.push("");
    lines.push(...commLines);
  }

  const homeAddr =
    String(c.constraints?.home_address || "").trim() ||
    String(c.constraints?.preferred_area || "").trim() ||
    String(c.preferences?.home_address || "").trim() ||
    String(c.preferences?.preferred_area || "").trim() ||
    null;
  if (homeAddr) {
    lines.push("");
    const coords = c.constraints?.home_coordinates;
    const coordSuffix = coords ? " ✓" : " ⚠️ (לא אותר במפה)";
    lines.push(`🏠 כתובת: ${homeAddr}${coordSuffix}`);
  }
  if (c.constraints?.proximity_preference) {
    lines.push(`📏 מרחק: ${c.constraints.proximity_preference}`);
  }

  const audiences = formatTargetAudiences(c);
  if (audiences) lines.push(`👥 קהלי יעד: ${audiences}`);

  if (c.partner?.name) {
    const partnerInterests =
      Array.isArray(c.partner.interests) && c.partner.interests.length
        ? `\n• עניין: ${c.partner.interests.join(", ")}`
        : "";
    lines.push("");
    lines.push(
      `❤️ בן/בת זוג: ${c.partner.name}${c.partner.age != null ? ` (${c.partner.age})` : ""}${partnerInterests}`,
    );
  }

  return lines;
}

/** Async lines for favorite_location_keys (resolved to human venue names). */
async function formatFavoriteLocationsLines(userContext) {
  const keys = userContext?.favorite_location_keys;
  if (!Array.isArray(keys) || !keys.length) return [];
  const names = [];
  for (const key of keys.slice(0, 8)) {
    const loc = await getLocation(key).catch(() => null);
    names.push(loc ? locationLabel(loc) : key);
  }
  const more = keys.length > 8 ? ` (+${keys.length - 8})` : "";
  return [`📍 רק במקומות: ${names.join(" · ")}${more}`];
}

/**
 * Negative signals learned from feedback (agent / advanced views only).
 */
async function buildLearnedPreferencesLines(userContext) {
  const c = userContext || {};
  const prefs = c.preferences || {};
  const constraints = c.constraints || {};
  const lines = [];

  const availability = formatAvailability(constraints);
  if (availability) lines.push(`🕒 זמינות: ${availability}`);

  const suppressedCats = Object.entries(prefs.category_weights || {})
    .filter(([, w]) => w < 0.8)
    .sort(([, a], [, b]) => a - b)
    .map(([cat]) => cat);
  if (suppressedCats.length) {
    lines.push(`📉 פחות קטגוריות: ${suppressedCats.join(", ")}`);
  }

  const suppressedTags = await resolveSuppressedTagNames(prefs.tag_weights);
  if (suppressedTags.length) {
    lines.push(`🏷️ תגיות מושתקות: ${suppressedTags.join(", ")}`);
  }

  const suppressedSeries = prefs.series_suppress || [];
  if (suppressedSeries.length) {
    lines.push(`🔇 סדרות מושתקות: ${suppressedSeries.join(", ")}`);
  }

  const knownSeries = Array.isArray(c.known_series) ? c.known_series : [];
  if (knownSeries.length) {
    const preview = knownSeries.slice(-5).map((k) => {
      const name = String(k).split("::")[0];
      return name.length > 40 ? `${name.slice(0, 38)}…` : name;
    });
    const more = knownSeries.length > 5 ? ` (+${knownSeries.length - 5})` : "";
    lines.push(`🔁 אירועים חוזרים שלא להציג: ${preview.join(" · ")}${more}`);
  }

  const suppressedLocations = prefs.suppressed_locations || [];
  if (suppressedLocations.length) {
    lines.push(`📍 מקומות שלא להציג: ${suppressedLocations.join(", ")}`);
  }

  return lines;
}

module.exports = {
  normalizeKidEntry,
  normalizeKids,
  formatProfileLines,
  formatFavoriteLocationsLines,
  formatKidLines,
  formatCommunitiesLines,
  formatInterestsLines,
  buildLearnedPreferencesLines,
  formatAvailability,
  formatTargetAudiences,
};
