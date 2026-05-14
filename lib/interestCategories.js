// Curated catalog of interest "chips" presented in the /interests picker.
//
// SHAPE — each entry is { id, label, emoji }:
//   id    — short ASCII identifier embedded in Telegram callback_data
//           (`ip:tog:<id>`). MUST stay short: Telegram caps callback_data
//           at 64 BYTES, and Hebrew characters cost 2 bytes each, so we
//           reserve the budget for the prefix and keep ids ASCII.
//   label — Hebrew display string. ALSO doubles as what we store in
//           `profile.user_context.interests`, because the agent + search
//           tools already work with free-text Hebrew interest strings.
//           Keeping the on-screen label and the persisted value identical
//           means the picker round-trips cleanly: a chip the user can see
//           in /profile is the same chip they'll see pre-selected next
//           time they open the picker.
//   emoji — visual handle. Prepended in the rendered button text.
//
// EDITING — this list is the SOURCE OF TRUTH for the chips. Adding a new
// entry just shows up in the next picker render. Removing one is safe
// for new users; existing profiles may still hold the removed string in
// `interests` (free-text persistence), but the picker simply won't
// pre-select it, and the agent will still treat it as a valid interest
// tag for search.
//
// ORDERING — chips render in this order, two per row. The list is
// roughly sorted by expected popularity for a Ramat-Gan family audience:
// music + shows up top, niche / professional topics toward the end. No
// hard rule — re-order to taste.
//
// "OTHER..." escape hatch — intentionally NOT in this list. The picker
// renders an "אחר..." button separately so it can route to free-text
// input rather than toggle as a chip.

const INTEREST_CATEGORIES = [
  { id: "music",       label: "מוסיקה",            emoji: "🎵" },
  { id: "shows",       label: "תיאטרון ומופעים",   emoji: "🎭" },
  { id: "sport",       label: "ספורט וכושר",       emoji: "⚽" },
  { id: "art",         label: "אומנות ויצירה",     emoji: "🎨" },
  { id: "food",        label: "אוכל ויין",          emoji: "🍷" },
  { id: "nature",      label: "טבע וטיולים",       emoji: "🌳" },
  { id: "workshops",   label: "סדנאות",             emoji: "🛠️" },
  { id: "kids",        label: "ילדים ומשפחה",      emoji: "👨‍👩‍👧" },
  { id: "books",       label: "ספרים ותרבות",      emoji: "📚" },
  { id: "cinema",      label: "קולנוע",             emoji: "🎬" },
  { id: "community",   label: "קהילה והתנדבות",    emoji: "🤝" },
  { id: "tech",        label: "טכנולוגיה",          emoji: "💻" },
  { id: "standup",     label: "סטנדאפ והומור",     emoji: "😂" },
  { id: "wellness",    label: "בריאות ורווחה",     emoji: "🧘" },
];

const INTERESTS_BY_ID = new Map(INTEREST_CATEGORIES.map((c) => [c.id, c]));
const INTERESTS_BY_LABEL = new Map(INTEREST_CATEGORIES.map((c) => [c.label, c]));

function getInterestById(id) {
  return INTERESTS_BY_ID.get(id) || null;
}

// Look up a chip by its Hebrew label. Used when re-opening the picker —
// we walk the user's stored `interests` strings and pre-select any that
// match a known chip. Strings that don't match (free-text from "אחר..."
// or older formats) are kept in the profile but rendered as a separate
// "תחומים נוספים" preview line above the chips.
function getInterestByLabel(label) {
  if (typeof label !== "string") return null;
  return INTERESTS_BY_LABEL.get(label.trim()) || null;
}

module.exports = {
  INTEREST_CATEGORIES,
  getInterestById,
  getInterestByLabel,
};
