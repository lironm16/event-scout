// Mini App profile editing — orchestration between the web form and the
// existing profile helpers. The Express routes stay thin; ALL persistence
// reuses the same helpers the bot already uses (saveProfile, the audience/
// suppression/favorite setters), so the web and bot stay consistent.

const supabase = require("./supabase");
const {
  getProfile,
  saveProfile,
  profileToBrainShape,
  saveFavoriteLocationKeys,
  getFavoriteLocationKeys,
} = require("../bot/profileService");
const {
  AUDIENCE_CATEGORIES,
  saveTargetAudienceChips,
  hydrateTargetAudienceChipIds,
} = require("./audienceTargets");
const {
  TOPIC_CATEGORIES,
  getTopicById,
  getTopicByLabel,
} = require("./interestCategories");
const { COMMUNITY_CHIPS, DEV_STAGES } = require("./kidsWizardUi");
const { setSuppressChildAudiences } = require("./childEventPrefs");
const { formatProximityPreference } = require("./locationPrefs");
const {
  setSuppressOnlineEvents,
  removeSuppressedLabel,
  addSuppressedLabel,
} = require("./tagSuppressPrefs");

const TOPIC_LABELS = new Set(TOPIC_CATEGORIES.map((t) => t.label));
const AUD_LABELS = new Set(AUDIENCE_CATEGORIES.map((a) => a.label));

// Audience chips that are NOT communities (communities get their own
// section). Communities are AUDIENCE_CATEGORIES with a `community` key.
const AUDIENCE_CHIPS = AUDIENCE_CATEGORIES.filter((c) => !c.community).map((c) => ({
  id: c.id,
  label: c.label,
  emoji: c.emoji || "",
}));
const AUDIENCE_CHIP_IDS = new Set(AUDIENCE_CHIPS.map((c) => c.id));

const TIME_SLOTS = [
  { id: "morning", label: "בוקר", start: "08:00", end: "13:00" },
  { id: "noon", label: "צהריים", start: "13:00", end: "16:00" },
  { id: "afternoon", label: 'אחה"צ', start: "16:00", end: "19:00" },
  { id: "evening", label: "ערב", start: "19:00", end: "23:00" },
  { id: "night", label: "לילה", start: "23:00", end: "23:59" },
];

const LOCATION_MODES = [
  { id: "walk", label: "ברגל" },
  { id: "drive", label: "נסיעה" },
  { id: "any", label: "כל מרחק" },
];

const GENDERS = [
  { id: "female", label: "אישה" },
  { id: "male", label: "גבר" },
];

/** Shape the form renders: current values + the option lists to choose from. */
function buildProfileEditPayload(profile) {
  const ctx = profile?.user_context || {};
  const constraints = ctx.constraints || {};
  const interests = Array.isArray(ctx.interests) ? ctx.interests : [];

  const topicIds = interests
    .map((label) => getTopicByLabel(label)?.id)
    .filter(Boolean);

  const audienceChipIds = [...hydrateTargetAudienceChipIds(profile)].filter((id) =>
    AUDIENCE_CHIP_IDS.has(id),
  );

  return {
    profile: {
      first_name: profile?.first_name || "",
      gender: ctx.gender || null,
      kids: (Array.isArray(ctx.kids) ? ctx.kids : []).map((k) => ({
        name: k?.name || "",
        birth_date: k?.birth_date || null,
        gender: k?.gender || null,
        stages: Array.isArray(k?.stages) ? k.stages : [],
      })),
      topic_ids: topicIds,
      // Arbitrary "wanted" tags chosen from the full label list (not one of
      // the 12 topic chips and not an audience label).
      interest_tags: interests.filter(
        (l) => !TOPIC_LABELS.has(l) && !AUD_LABELS.has(l),
      ),
      audience_chip_ids: audienceChipIds,
      communities: ctx.communities && typeof ctx.communities === "object" ? ctx.communities : {},
      constraints: {
        home_address: constraints.home_address || "",
        location_modes: Array.isArray(constraints.location_modes)
          ? constraints.location_modes
          : [],
        max_walking_minutes: constraints.max_walking_minutes ?? null,
        max_drive_minutes: constraints.max_drive_minutes ?? null,
        availability: constraints.availability || null,
      },
      suppress_child_audiences: Boolean(ctx.suppress_child_audiences),
      suppress_online_events: Boolean(ctx.suppress_online_events),
      favorite_location_keys: getFavoriteLocationKeys(profile) || [],
      suppressed_labels: Array.isArray(ctx.suppressed_labels) ? ctx.suppressed_labels : [],
      known_series: Array.isArray(ctx.known_series) ? ctx.known_series : [],
      suppressed_locations: Array.isArray(ctx.preferences?.suppressed_locations)
        ? ctx.preferences.suppressed_locations
        : [],
    },
    options: {
      genders: GENDERS,
      devStages: DEV_STAGES, // [{id,label}]
      audiences: AUDIENCE_CHIPS,
      communities: COMMUNITY_CHIPS, // [{key,short,label}]
      topics: TOPIC_CATEGORIES, // [{id,label,emoji}]
      locationModes: LOCATION_MODES,
      timeSlots: TIME_SLOTS,
    },
  };
}

function sanitizeKids(kids) {
  if (!Array.isArray(kids)) return [];
  return kids
    .map((k) => {
      const name = String(k?.name || "").trim();
      const birth_date =
        typeof k?.birth_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(k.birth_date)
          ? k.birth_date
          : null;
      const gender = k?.gender === "female" || k?.gender === "male" ? k.gender : null;
      const stages = Array.isArray(k?.stages)
        ? k.stages.filter((s) => DEV_STAGES.some((d) => d.id === s))
        : [];
      return { name, birth_date, gender, stages };
    })
    // Birth date is required — drop any kid without it (name etc. optional).
    .filter((k) => k.birth_date);
}

/**
 * Apply a full save from the Mini App profile form. The patch is a complete
 * snapshot of the editable sections (single "Save" button), applied via the
 * existing helpers in a conflict-safe order.
 */
async function applyProfilePatch(telegramId, patch = {}) {
  const existing = await getProfile(telegramId);
  const brain = profileToBrainShape(existing) || {};

  if ("first_name" in patch) brain.first_name = String(patch.first_name || "").trim();
  if ("gender" in patch) brain.gender = patch.gender || null;
  if ("kids" in patch) brain.kids = sanitizeKids(patch.kids);

  // Topic chips + arbitrary "wanted" tags → interests (audience labels are
  // re-added by saveTargetAudienceChips below).
  if (Array.isArray(patch.topic_ids) || Array.isArray(patch.interest_tags)) {
    const topicLabels = (patch.topic_ids || [])
      .map((id) => getTopicById(id)?.label)
      .filter(Boolean);
    const extra = (patch.interest_tags || [])
      .filter((t) => typeof t === "string" && t.trim())
      .map((t) => t.trim());
    brain.interests = [...new Set([...topicLabels, ...extra])];
  }

  if (patch.communities && typeof patch.communities === "object") {
    brain.communities = patch.communities;
  }

  if (patch.constraints && typeof patch.constraints === "object") {
    const c = { ...(brain.constraints || {}) };
    if ("home_address" in patch.constraints) {
      c.home_address = String(patch.constraints.home_address || "").trim() || null;
    }
    if (Array.isArray(patch.constraints.location_modes)) {
      c.location_modes = patch.constraints.location_modes.filter((m) =>
        ["walk", "drive", "any"].includes(m),
      );
    }
    if ("max_walking_minutes" in patch.constraints) {
      const n = Number(patch.constraints.max_walking_minutes);
      c.max_walking_minutes = Number.isFinite(n) && n > 0 ? n : null;
    }
    if ("max_drive_minutes" in patch.constraints) {
      const n = Number(patch.constraints.max_drive_minutes);
      c.max_drive_minutes = Number.isFinite(n) && n > 0 ? n : null;
    }
    if ("availability" in patch.constraints) {
      c.availability = patch.constraints.availability || null;
    }
    // Normalize so the distance fields + proximity text stay consistent with
    // the selected modes (toggling a mode off must clear its stale minutes).
    const modes = Array.isArray(c.location_modes) ? c.location_modes : [];
    const hasAny = modes.includes("any") || modes.length === 0;
    if (hasAny) {
      c.max_walking_minutes = null;
      c.max_drive_minutes = null;
    } else {
      if (!modes.includes("walk")) c.max_walking_minutes = null;
      if (!modes.includes("drive")) c.max_drive_minutes = null;
    }
    c.proximity_preference = formatProximityPreference(modes);
    brain.constraints = c;
  }

  // 1) Brain-shape save (handles geocoding of home_address, normalization).
  await saveProfile(telegramId, brain, existing);

  // 2) Toggles + favorites FIRST — note setSuppressChildAudiences strips
  //    kid chips from target_audience_chip_ids, so it must run BEFORE we
  //    write the audience chips (step 3), or it would wipe them.
  if (typeof patch.suppress_child_audiences === "boolean") {
    await setSuppressChildAudiences(telegramId, patch.suppress_child_audiences);
  }
  if (typeof patch.suppress_online_events === "boolean") {
    await setSuppressOnlineEvents(telegramId, patch.suppress_online_events);
  }
  if (Array.isArray(patch.favorite_location_keys)) {
    await saveFavoriteLocationKeys(telegramId, patch.favorite_location_keys);
  }

  // 3) Target audiences LAST (writes interests + target_audience_chip_ids).
  //    Only non-community chips so communities (saved in step 1) aren't
  //    touched by its member-merge loop.
  if (Array.isArray(patch.audience_chip_ids)) {
    const ids = patch.audience_chip_ids.filter((id) => AUDIENCE_CHIP_IDS.has(id));
    await saveTargetAudienceChips(telegramId, ids, { getProfile });
  }

  // 4) Suppression adds ("לא רוצה" tags) + removals.
  for (const name of patch.add_suppressed_labels || []) {
    if (typeof name === "string" && name.trim()) {
      await addSuppressedLabel(telegramId, { labelName: name.trim() });
    }
  }
  for (const name of patch.remove_suppressed_labels || []) {
    await removeSuppressedLabel(telegramId, name);
  }
  if (
    (patch.remove_known_series || []).length ||
    (patch.remove_suppressed_locations || []).length
  ) {
    await removeFromUserContextArrays(telegramId, {
      known_series: patch.remove_known_series || [],
      suppressed_locations: patch.remove_suppressed_locations || [],
    });
  }

  return buildProfileEditPayload(await getProfile(telegramId));
}

/** Targeted removal from known_series / preferences.suppressed_locations. */
async function removeFromUserContextArrays(telegramId, { known_series, suppressed_locations }) {
  const profile = await getProfile(telegramId);
  const ctx = profile?.user_context || {};
  const rmSeries = new Set((known_series || []).map(String));
  const rmLoc = new Set((suppressed_locations || []).map(String));
  const nextKnown = (Array.isArray(ctx.known_series) ? ctx.known_series : []).filter(
    (k) => !rmSeries.has(String(k)),
  );
  const prefs = { ...(ctx.preferences || {}) };
  prefs.suppressed_locations = (
    Array.isArray(prefs.suppressed_locations) ? prefs.suppressed_locations : []
  ).filter((k) => !rmLoc.has(String(k)));
  const { error } = await supabase
    .from("profiles")
    .update({ user_context: { ...ctx, known_series: nextKnown, preferences: prefs } })
    .eq("telegram_id", String(telegramId));
  if (error) throw new Error(error.message);
}

module.exports = { buildProfileEditPayload, applyProfilePatch };
