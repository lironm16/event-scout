// Per-tag "לא מעוניין ב…" feedback + hiding suppressed labels on cards.

const supabase = require("./supabase");
const {
  getProfile,
  setCommunityNotMember,
  communityKeyForAudienceLabel,
} = require("../bot/profileService");
const labelStore = require("./labelStore");

/** tag_weights at or below this → treated as suppressed (matches preset "suppress"). */
const SUPPRESS_TAG_WEIGHT_MAX = 0.25;

function suppressedLabelNamesLower(profile) {
  const ctx = profile?.user_context || {};
  const names = new Set();
  for (const raw of [
    ...(ctx.suppressed_labels || []),
    ...(ctx.disliked_tags || []),
  ]) {
    const s = String(raw || "").trim().toLowerCase();
    if (s) names.add(s);
  }
  return names;
}

function suppressedTagIdSet(profile) {
  const prefs = profile?.user_context?.preferences || {};
  const tw = prefs.tag_weights || {};
  const ids = new Set();
  for (const [id, w] of Object.entries(tw)) {
    if (Number(w) <= SUPPRESS_TAG_WEIGHT_MAX) ids.add(String(id));
  }
  return ids;
}

function tagNameIsSuppressed(name, profile) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return false;
  return suppressedLabelNamesLower(profile).has(n);
}

function eventHasSuppressedTag(event, profile) {
  if (!event || !profile) return false;
  const ids = suppressedTagIdSet(profile);
  for (const id of event.tag_ids || []) {
    if (ids.has(String(id))) return true;
  }
  for (const t of event.tags || []) {
    if (tagNameIsSuppressed(t, profile)) return true;
  }
  return false;
}

function filterTagsForDisplay(tags, profile) {
  if (!Array.isArray(tags) || !tags.length) return [];
  if (!profile) return tags;
  return tags.filter((t) => !tagNameIsSuppressed(t, profile));
}

function profileSuppressesOnlineEvents(profile) {
  return Boolean(profile?.user_context?.suppress_online_events);
}

function isOnlineEvent(event) {
  if (!event) return false;
  if (event.online_url && String(event.online_url).trim()) return true;
  return false;
}

function shouldHideOnlineEventForProfile(event, profile) {
  if (!profileSuppressesOnlineEvents(profile)) return false;
  return isOnlineEvent(event);
}

/**
 * Labels on this event that are not already suppressed — for feedback buttons.
 */
function visibleTagEntriesForFeedback(event, profile) {
  const tags = filterTagsForDisplay(event?.tags || [], profile);
  const entries = [];
  const seen = new Set();
  for (const name of tags) {
    const n = String(name || "").trim();
    if (!n) continue;
    const k = labelStore.normalizeName(n);
    if (seen.has(k)) continue;
    seen.add(k);
    entries.push({ name: n });
  }
  return entries;
}

async function addSuppressedLabel(telegramId, { labelId, labelName }) {
  const name = String(labelName || "").trim();
  if (!name) return;
  const profile = await getProfile(telegramId);
  const ctx = profile?.user_context || {};
  const suppressed = new Set(
    Array.isArray(ctx.suppressed_labels) ? ctx.suppressed_labels : [],
  );
  suppressed.add(name);
  const interests = Array.isArray(ctx.interests)
    ? ctx.interests.filter((i) => i !== name)
    : [];
  const prefs = { ...(ctx.preferences || {}) };
  const tagWeights = { ...(prefs.tag_weights || {}) };
  if (labelId != null) tagWeights[String(labelId)] = 0.2;

  const disliked = Array.isArray(ctx.disliked_tags) ? [...ctx.disliked_tags] : [];
  if (!disliked.includes(name)) disliked.push(name);

  const { error } = await supabase
    .from("profiles")
    .update({
      user_context: {
        ...ctx,
        suppressed_labels: [...suppressed],
        interests,
        disliked_tags: disliked.slice(-50),
        preferences: { ...prefs, tag_weights: tagWeights },
      },
    })
    .eq("telegram_id", String(telegramId));
  if (error) throw new Error(`addSuppressedLabel failed: ${error.message}`);

  const communityKey = communityKeyForAudienceLabel(name);
  if (communityKey) {
    await setCommunityNotMember(telegramId, communityKey);
  }
}

async function listSuppressedLabelsForProfile(profile) {
  const ctx = profile?.user_context || {};
  const names = new Set();
  for (const raw of ctx.suppressed_labels || []) {
    const s = String(raw || "").trim();
    if (s) names.add(s);
  }
  const tw = ctx.preferences?.tag_weights || {};
  const ids = Object.entries(tw)
    .filter(([, w]) => Number(w) <= SUPPRESS_TAG_WEIGHT_MAX)
    .map(([id]) => parseInt(id, 10))
    .filter(Number.isFinite);
  if (ids.length) {
    const { data } = await supabase.from("labels").select("id, name").in("id", ids);
    for (const row of data || []) {
      if (row?.name) names.add(row.name);
    }
  }
  if (ctx.suppress_online_events) names.add("אירועים אונליין");
  return [...names].sort((a, b) => a.localeCompare(b, "he"));
}

async function removeSuppressedLabel(telegramId, labelName) {
  const name = String(labelName || "").trim();
  if (!name) return;
  const profile = await getProfile(telegramId);
  const ctx = profile?.user_context || {};
  const suppressed = (ctx.suppressed_labels || []).filter((s) => s !== name);
  const disliked = (ctx.disliked_tags || []).filter((s) => s !== name);
  const interests = Array.isArray(ctx.interests) ? ctx.interests : [];
  const prefs = { ...(ctx.preferences || {}) };
  const tagWeights = { ...(prefs.tag_weights || {}) };
  const { data: rows } = await supabase
    .from("labels")
    .select("id, name")
    .ilike("name", name)
    .limit(3);
  for (const row of rows || []) {
    if (labelStore.normalizeName(row.name) === labelStore.normalizeName(name)) {
      delete tagWeights[String(row.id)];
    }
  }
  const nextCtx = {
    ...ctx,
    suppressed_labels: suppressed,
    disliked_tags: disliked,
    interests,
    preferences: { ...prefs, tag_weights: tagWeights },
  };
  if (name === "אירועים אונליין") nextCtx.suppress_online_events = false;

  const { error } = await supabase
    .from("profiles")
    .update({ user_context: nextCtx })
    .eq("telegram_id", String(telegramId));
  if (error) throw new Error(`removeSuppressedLabel failed: ${error.message}`);
}

async function setSuppressOnlineEvents(telegramId, suppress = true) {
  const profile = await getProfile(telegramId);
  const ctx = profile?.user_context || {};
  const { error } = await supabase
    .from("profiles")
    .update({
      user_context: { ...ctx, suppress_online_events: !!suppress },
    })
    .eq("telegram_id", String(telegramId));
  if (error) throw new Error(`setSuppressOnlineEvents failed: ${error.message}`);
}

module.exports = {
  SUPPRESS_TAG_WEIGHT_MAX,
  suppressedLabelNamesLower,
  suppressedTagIdSet,
  tagNameIsSuppressed,
  eventHasSuppressedTag,
  filterTagsForDisplay,
  profileSuppressesOnlineEvents,
  isOnlineEvent,
  shouldHideOnlineEventForProfile,
  visibleTagEntriesForFeedback,
  addSuppressedLabel,
  listSuppressedLabelsForProfile,
  removeSuppressedLabel,
  setSuppressOnlineEvents,
};
