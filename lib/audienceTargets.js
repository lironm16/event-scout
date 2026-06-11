// Maps onboarding audience chips → Hebrew audience ENUM values on events.
// Used by "לא הקהל יעד שלי" multi-select (positive target audiences).

const supabase = require("./supabase");
const {
  AUDIENCE_CATEGORIES,
  getAudienceById,
} = require("./interestCategories");

// Audience chips now ARE the audience_t enum values, so each maps 1:1 to
// itself. Community chips (seniors/miluim/…) still resolve to a permissive
// audience set since their filtering happens on the access axis, not here.
const CHIP_TO_AUDIENCE_ENUM = {
  "תינוקות": ["תינוקות"],
  "ילדים": ["ילדים"],
  "נוער": ["נוער"],
  "מבוגרים": ["מבוגרים"],
  "לכל המשפחה": ["לכל המשפחה"],
  "הורים": ["הורים"],
  "ותיקים": ["ותיקים"],
  miluim: ["לכל המשפחה"],
  lgbtq: ["לכל המשפחה"],
  special: ["לכל המשפחה"],
  russian: ["לכל המשפחה"],
};

function audienceSetFromChipIds(chipIds) {
  const allowed = new Set(["לכל המשפחה"]);
  for (const id of chipIds || []) {
    for (const aud of CHIP_TO_AUDIENCE_ENUM[id] || []) {
      allowed.add(aud);
    }
  }
  return allowed;
}

/** Pre-select chips from profile (interests labels + kids + age_range). */
function hydrateTargetAudienceChipIds(profile) {
  const selected = new Set();
  const interests = profile?.user_context?.interests || profile?.interests || [];
  for (const raw of interests) {
    if (typeof raw !== "string") continue;
    const chip = AUDIENCE_CATEGORIES.find((c) => c.label === raw.trim());
    if (chip) selected.add(chip.id);
  }
  const kids = profile?.user_context?.kids || profile?.kids || [];
  if (Array.isArray(kids) && kids.length > 0) {
    selected.add("ילדים");
    const { kidsAgesYears } = require("./kidAge");
    const ages = kidsAgesYears(kids);
    if (ages.some((a) => a < 3)) selected.add("תינוקות");
    if (ages.some((a) => a >= 12 && a < 18)) selected.add("נוער");
  }
  // NB: the profile owner's own age (age_range) intentionally does NOT
  // auto-select an audience chip — the viewer's age no longer filters.

  const stored = profile?.user_context?.target_audience_chip_ids;
  if (Array.isArray(stored) && stored.length) {
    for (const id of stored) {
      if (getAudienceById(id)) selected.add(id);
    }
  }
  return selected;
}

async function saveTargetAudienceChips(telegramId, chipIds, { getProfile }) {
  const profile = await getProfile(telegramId);
  if (!profile) return;

  const labels = chipIds
    .map((id) => getAudienceById(id)?.label)
    .filter(Boolean);

  const ctx = profile.user_context || {};
  const existingInterests = Array.isArray(ctx.interests) ? ctx.interests : [];
  const nonAudience = existingInterests.filter((label) => {
    const t = String(label).trim();
    return !AUDIENCE_CATEGORIES.some((c) => c.label === t);
  });
  const interests = [...new Set([...nonAudience, ...labels])];

  const communities = { ...(ctx.communities || {}) };
  for (const aud of AUDIENCE_CATEGORIES) {
    if (!aud.community) continue;
    communities[aud.community] = chipIds.includes(aud.id) ? "member" : communities[aud.community];
  }

  const { error } = await supabase
    .from("profiles")
    .update({
      user_context: {
        ...ctx,
        interests,
        target_audience_chip_ids: chipIds,
        communities,
      },
    })
    .eq("telegram_id", String(telegramId));
  if (error) throw new Error(error.message);
}

function deriveAllowedAudiencesFromProfile(profile) {
  const chipIds = profile?.user_context?.target_audience_chip_ids;
  if (Array.isArray(chipIds) && chipIds.length > 0) {
    return audienceSetFromChipIds(chipIds);
  }
  return null;
}

module.exports = {
  AUDIENCE_CATEGORIES,
  CHIP_TO_AUDIENCE_ENUM,
  audienceSetFromChipIds,
  hydrateTargetAudienceChipIds,
  saveTargetAudienceChips,
  deriveAllowedAudiencesFromProfile,
};
