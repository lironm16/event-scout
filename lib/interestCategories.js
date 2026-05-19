// Curated catalog of chips presented in the onboarding picker.
//
// Two parallel groups: TOPICS ("what events am I interested in?") and
// AUDIENCES ("who am I / who is my family?"). The onboarding flow asks
// them as two separate questions; mixing them in a single list confused
// users — picking "ילדים ומשפחה" alongside "מוסיקה" reads strangely
// (one's a topic, one's an audience).
//
// SHAPE — each entry is { id, label, emoji, community? }:
//   id        — short ASCII identifier embedded in Telegram callback_data
//               (`onb:tog:topics:<id>` / `onb:tog:audiences:<id>`). MUST
//               stay short: Telegram caps callback_data at 64 BYTES, and
//               Hebrew characters cost 2 bytes each.
//   label     — Hebrew display string. ALSO doubles as what we store in
//               `profile.user_context.interests`, because the agent +
//               search tools already work with free-text Hebrew tags.
//               Keeping the on-screen label and the persisted value
//               identical means the picker round-trips cleanly.
//   emoji     — visual handle on the chip button.
//   community — (audiences only) when set, picking this chip toggles a
//               flag in `profile.user_context.communities` to the
//               access_t ENUM value here ('community-lgbtq',
//               'community-seniors', 'community-disabilities',
//               'community-miluim'). Without this flag the catalog
//               access filter HIDES those events from the user entirely,
//               so the picker is the cleanest way to surface the consent
//               question.
//
// EDITING — these arrays are the SOURCE OF TRUTH for the picker. Adding
// a new entry just shows up in the next picker render. Removing one is
// safe for new users; existing profiles may still hold the removed
// string in `interests` (free-text persistence), but the picker simply
// won't pre-select it.
//
// ORDERING — chips render in this order, two per row. Topics are sorted
// roughly by expected popularity for a Ramat-Gan family audience;
// audiences are sorted by life-stage (kids → babies → teens → young
// adults → seniors → identity communities).

// ────────────────────────────────────────────────────────────────────
// Step 1: תחומים (Topics) — "what kind of events?"
// ────────────────────────────────────────────────────────────────────
const TOPIC_CATEGORIES = [
  { id: "music",      label: "מוסיקה",            emoji: "🎵" },
  { id: "shows",      label: "תיאטרון ומופעים",   emoji: "🎭" },
  { id: "sport",      label: "ספורט וכושר",       emoji: "⚽" },
  { id: "art",        label: "אומנות ויצירה",     emoji: "🎨" },
  { id: "food",       label: "אוכל ויין",          emoji: "🍷" },
  { id: "nature",     label: "טבע וטיולים",       emoji: "🌳" },
  { id: "books",      label: "ספרים ותרבות",      emoji: "📚" },
  { id: "cinema",     label: "קולנוע",             emoji: "🎬" },
  { id: "standup",    label: "סטנדאפ והומור",     emoji: "😂" },
  { id: "makers",     label: "מייקרס וDIY",       emoji: "🔧" },
  { id: "tech",       label: "טכנולוגיה",          emoji: "💻" },
  { id: "parties",    label: "מסיבות",             emoji: "🎉" },
];

// ────────────────────────────────────────────────────────────────────
// Step 2: קהלים (Audiences) — "who is this for?"
//
// Four chips here also gate ACCESS (community-*). Picking them sets
// `communities['community-X'] = 'member'`, which unlocks events whose
// `access` column is set to that community. Unchecking sets it to
// 'not-member' so the catalog filter knows not to ask again AND keeps
// hiding those events. (Leaving the chip untouched leaves the field
// null — the catalog includes the events but the agent will know to
// soft-rank them down.)
// ────────────────────────────────────────────────────────────────────
const AUDIENCE_CATEGORIES = [
  { id: "kids",      label: "ילדים ומשפחה",      emoji: "👨‍👩‍👧" },
  { id: "babies",    label: "תינוקות והורות",    emoji: "👶" },
  { id: "teens",     label: "נוער (12-18)",       emoji: "🎒" },
  { id: "young",     label: "צעירים (18-35)",     emoji: "🎓" },
  { id: "miluim",    label: "משרתי מילואים",      emoji: "🎖️", community: "community-miluim" },
  { id: "seniors",   label: "ותיקים (60+)",       emoji: "🌷", community: "community-seniors" },
  { id: "lgbtq",     label: "קהילה גאה",          emoji: "🏳️‍🌈", community: "community-lgbtq" },
  { id: "religious", label: "קהל דתי",            emoji: "🕍" },
  { id: "special",   label: "חינוך מיוחד",        emoji: "🧩", community: "community-disabilities" },
];

// ────────────────────────────────────────────────────────────────────
// Step 3: מיקום (Location preference) — "how far is too far?"
//
// Single-choice (not multi-toggle). Each option maps to two profile
// fields:
//   - max_walking_minutes — the actionable threshold used by the
//     proximity calculator (lib/geocoding.js) to decide whether an
//     event is "walkable" or "requires_car".
//   - proximity_preference — the human-readable label, surfaced in
//     /profile and used by the agent when explaining its choices.
//
// "אחר..." routes to a free-text capture where the user types a
// number of minutes; that path bypasses the preset value below.
// ────────────────────────────────────────────────────────────────────
const LOCATION_OPTIONS = [
  {
    id: "walk",
    label: "מרחק הליכה",
    emoji: "🚶",
    max_walking_minutes: 15,
    preference: "מרחק הליכה (עד 15 דק׳)",
  },
  {
    id: "drive",
    label: "נסיעה קצרה",
    emoji: "🚗",
    max_walking_minutes: 30,
    preference: "נסיעה קצרה (עד 10 דק׳ ברכב)",
  },
  {
    id: "any",
    label: "כל מיקום",
    emoji: "🌍",
    max_walking_minutes: null,
    preference: "כל מיקום",
  },
  {
    id: "other",
    label: "אחר...",
    emoji: "✏️",
    // No preset — the bot prompts the user for a number of minutes.
    max_walking_minutes: null,
    preference: null,
  },
];

// ────────────────────────────────────────────────────────────────────
// Indexing helpers
// ────────────────────────────────────────────────────────────────────
const TOPICS_BY_ID = new Map(TOPIC_CATEGORIES.map((c) => [c.id, c]));
const TOPICS_BY_LABEL = new Map(TOPIC_CATEGORIES.map((c) => [c.label, c]));
const AUDIENCES_BY_ID = new Map(AUDIENCE_CATEGORIES.map((c) => [c.id, c]));
const AUDIENCES_BY_LABEL = new Map(AUDIENCE_CATEGORIES.map((c) => [c.label, c]));
const LOCATIONS_BY_ID = new Map(LOCATION_OPTIONS.map((o) => [o.id, o]));

// Combined ID/label maps — when re-opening the picker we walk the
// user's existing `interests[]` and want to know whether a given label
// belongs to topics or to audiences (different steps render different
// keyboards). The combined map keeps lookup O(1) without forcing
// callers to check both sets.
const ALL_BY_LABEL = new Map([
  ...TOPICS_BY_LABEL,
  ...AUDIENCES_BY_LABEL,
]);

function getTopicById(id) {
  return TOPICS_BY_ID.get(id) || null;
}

function getAudienceById(id) {
  return AUDIENCES_BY_ID.get(id) || null;
}

function getLocationById(id) {
  return LOCATIONS_BY_ID.get(id) || null;
}

// Look up any chip (topic OR audience) by its Hebrew label. Used by
// the picker bootstrap to pre-select existing interests from the
// profile, and to classify which step's "checked" set a stored label
// belongs to.
function getChipByLabel(label) {
  if (typeof label !== "string") return null;
  return ALL_BY_LABEL.get(label.trim()) || null;
}

// Backwards-compat exports for the legacy single-list picker — kept
// pointing at the combined catalog so any call site we haven't migrated
// yet keeps rendering SOMETHING (the union of topics + audiences). Once
// every entry point uses the new onboarding flow, these can be removed.
const INTEREST_CATEGORIES = [...TOPIC_CATEGORIES, ...AUDIENCE_CATEGORIES];
const INTERESTS_BY_ID = new Map(INTEREST_CATEGORIES.map((c) => [c.id, c]));

function getInterestById(id) {
  return INTERESTS_BY_ID.get(id) || null;
}

function getInterestByLabel(label) {
  return getChipByLabel(label);
}

module.exports = {
  // New onboarding-aware exports
  TOPIC_CATEGORIES,
  AUDIENCE_CATEGORIES,
  LOCATION_OPTIONS,
  getTopicById,
  getAudienceById,
  getLocationById,
  getChipByLabel,
  // Legacy single-list exports — kept so the old picker keeps working
  // until every entry point migrates to the onboarding flow.
  INTEREST_CATEGORIES,
  getInterestById,
  getInterestByLabel,
};
