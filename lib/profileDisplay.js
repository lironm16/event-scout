// Human-readable profile text for /profile and the typing menu.

const supabase = require("./supabase");
const { AUDIENCE_CATEGORIES, getAudienceById } = require("./interestCategories");

const AUDIENCE_LABELS = new Set(AUDIENCE_CATEGORIES.map((a) => a.label));
const { COMMUNITY_CHIPS } = require("./kidsWizardUi");
const {
  memberKeysForCommunityPicker,
  hasExplicitCommunityConfig,
} = require("./communityAccess");
const { getLocation } = require("./locationStore");
const { locationLabel } = require("./topLocationsService");
const {
  normalizeKidForStorage,
  formatKidProfileSuffix,
  kidHasBirthInfo,
  kidNounHe,
} = require("./kidAge");
const {
  registeredToCommunitiesLabel,
  registeredToAllCommunitiesLabel,
} = require("./genderForm");

const DAY_NAMES = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

const TIME_PRESET_HE = {
  morning: "בוקר (08:00–12:00)",
  noon: "צהריים (12:00–15:00)",
  afternoon: "אחה״צ (15:00–18:00)",
  evening: "ערב (18:00–22:00)",
  weekend: "סופ״ש (09:00–22:00)",
};

/** Persist kids[] with birth_date (preferred) or legacy age. */
function normalizeKidEntry(kid) {
  return normalizeKidForStorage(kid);
}

function normalizeKids(kids) {
  if (!Array.isArray(kids)) return [];
  return kids.map(normalizeKidEntry).filter(Boolean);
}

function formatKidLine(kid) {
  const meta = formatKidProfileSuffix(kid);
  const stages =
    Array.isArray(kid.stages) && kid.stages.length
      ? ` — ${kid.stages.join(", ")}`
      : "";
  const suffix = meta ? ` (${meta})` : "";
  return `• ${kid.name || kidNounHe(kid.gender)}${suffix}${stages}`;
}

function formatKidLines(kids) {
  if (!Array.isArray(kids) || !kids.length) return [];
  return ["👧 ילדים", ...kids.map(formatKidLine)];
}

function formatCommunitiesLines(communities, gender = null) {
  const c = communities && typeof communities === "object" ? communities : {};
  if (!hasExplicitCommunityConfig(c)) {
    // Default = member of every community. List them explicitly so the
    // user sees which communities she's actually in, not just a vague
    // "all communities" label.
    return [
      `🏳️ קהילות — ${registeredToAllCommunitiesLabel(gender)} (ברירת מחדל):`,
      ...COMMUNITY_CHIPS.map((ch) => `• ${ch.label}`),
    ];
  }

  const memberLabels = COMMUNITY_CHIPS.filter((ch) => c[ch.key] === "member").map(
    (ch) => ch.label,
  );
  const notMemberLabels = COMMUNITY_CHIPS.filter((ch) => c[ch.key] === "not-member").map(
    (ch) => ch.label,
  );

  const lines = ["🏳️ קהילות"];

  if (notMemberLabels.length) {
    lines.push("🚫 לא חלק מ:", ...notMemberLabels.map((l) => `• ${l}`));
  }

  const explicitMembers = memberLabels.length > 0;
  let memberDisplay = memberLabels;
  if (!explicitMembers && !notMemberLabels.length) {
    return ["🏳️ קהילות: לא סומן שיוך — ערכי דרך «קהילות»"];
  }
  if (!explicitMembers && notMemberLabels.length) {
    // No explicit "member" marks, but some opt-outs. By default she's in
    // every community she didn't opt out of — name those explicitly
    // instead of a vague "rest are default".
    const notMemberKeys = new Set(
      COMMUNITY_CHIPS.filter((ch) => c[ch.key] === "not-member").map((ch) => ch.key),
    );
    const impliedMembers = COMMUNITY_CHIPS.filter((ch) => !notMemberKeys.has(ch.key));
    if (impliedMembers.length) {
      lines.push(
        `${registeredToCommunitiesLabel(gender)} (ברירת מחדל):`,
        ...impliedMembers.map((ch) => `• ${ch.label}`),
      );
    }
    return lines;
  }
  if (!explicitMembers) {
    memberDisplay = memberKeysForCommunityPicker(c)
      .map((k) => COMMUNITY_CHIPS.find((ch) => ch.key === k)?.label)
      .filter(Boolean);
  }

  const memberLine = registeredToCommunitiesLabel(gender);
  if (memberDisplay.length) {
    lines.push(`${memberLine}:`, ...memberDisplay.map((l) => `• ${l}`));
  }
  return lines;
}

function audienceLabelsHiddenByCommunities(communities) {
  const c = communities && typeof communities === "object" ? communities : {};
  return new Set(
    AUDIENCE_CATEGORIES.filter((a) => a.community && c[a.community] === "not-member").map(
      (a) => a.label,
    ),
  );
}

/** Split stored interests[] into curated audiences vs topics/tags. */
function partitionInterests(interests) {
  const topics = [];
  const audiences = [];
  const seenTopics = new Set();
  const seenAudiences = new Set();
  for (const raw of interests || []) {
    const label = String(raw).trim();
    if (!label) continue;
    if (AUDIENCE_LABELS.has(label)) {
      if (!seenAudiences.has(label)) {
        audiences.push(label);
        seenAudiences.add(label);
      }
      continue;
    }
    if (!seenTopics.has(label)) {
      topics.push(label);
      seenTopics.add(label);
    }
  }
  return { topics, audiences };
}

function formatInterestsLines(interests) {
  const { topics } = partitionInterests(interests);
  if (!topics.length) {
    return ["⭐ תחומי עניין: לא הוגדרו", "_לעדכון: «עריכה» → תחומי עניין_"];
  }
  return ["⭐ תחומי עניין", ...topics.map((label) => `• ${label}`)];
}

function formatAudiencesLines(interests, userContext = {}) {
  const hidden = audienceLabelsHiddenByCommunities(userContext?.communities);
  const { audiences } = partitionInterests(interests);
  const chipLine = formatTargetAudiences(userContext);
  if (chipLine) {
    for (const part of chipLine.split(", ")) {
      const t = part.trim();
      if (t && !audiences.includes(t) && !hidden.has(t)) audiences.push(t);
    }
  }
  const visible = audiences.filter((label) => !hidden.has(label));
  if (!visible.length) {
    return ["👥 קהלי יעד: לא הוגדרו", "_לעדכון: «עריכה» → קהלי יעד_"];
  }
  return ["👥 קהלי יעד", ...visible.map((label) => `• ${label}`)];
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
  const SLOT_BY_RANGE = {
    "08:00–12:00": "בוקר",
    "12:00–15:00": "צהריים",
    "15:00–18:00": "אחה״צ",
    "18:00–22:00": "ערב",
  };
  const slot = SLOT_BY_RANGE[`${block.start}–${block.end}`] || `${block.start}–${block.end}`;
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
  if (profile.first_name) {
    lines.push(`👤 ${profile.first_name}`);
    lines.push("_לשינוי השם: «עריכה» → שם תצוגה_");
  }
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

  lines.push("");
  lines.push(...formatAudiencesLines(c.interests, c));

  lines.push("");
  if (c.suppress_child_audiences) {
    lines.push("🚫 לא מציג אירועי ילדים/תינוקות/נוער");
  } else {
    const kidLines = formatKidLines(c.kids);
    if (kidLines.length) {
      lines.push(...kidLines);
    } else {
      lines.push("👧 ילדים: לא הוגדרו");
      lines.push("_לעדכון: «עריכה» → ילדים (תאריך לידה, מגדר, שלבים)_");
    }
  }

  const commLines = formatCommunitiesLines(c.communities, c.gender);
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
  const suppressedLabels = Array.isArray(c.suppressed_labels)
    ? c.suppressed_labels.filter(Boolean)
    : [];
  const tagLineParts = [...new Set([...suppressedLabels, ...suppressedTags])];
  if (tagLineParts.length) {
    lines.push(`🏷️ לא מעוניינת ב: ${tagLineParts.join(", ")}`);
    lines.push("_לעריכה: «עריכה» → תגיות מושתקות_");
  }

  if (c.suppress_online_events) {
    lines.push("📷 לא מעוניין באירועים אונליין");
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
  kidHasBirthInfo,
  formatProfileLines,
  formatFavoriteLocationsLines,
  formatKidLines,
  formatCommunitiesLines,
  formatInterestsLines,
  formatAudiencesLines,
  partitionInterests,
  buildLearnedPreferencesLines,
  formatAvailability,
  formatTargetAudiences,
};
