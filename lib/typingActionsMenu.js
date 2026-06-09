// Action menu shown when the user sends free text (typing → send).
// Telegram bots do not receive "user is typing" events; the menu appears
// on the first text message outside special flows.

const { Markup } = require("telegraf");
const { formatProfileLines } = require("./profileDisplay");
const { pickActionVerb } = require("./genderForm");
const { getMiniAppProfileUrl, getMiniAppCatalogUrl } = require("./miniAppUrl");

const MENU = "menu";

/** Reply-keyboard labels → internal action ids */
const REPLY_ACTIONS = {
  "📋 תפריט ראשי": "main",
  // Legacy labels still routed, in case an old keyboard lingers client-side.
  "🔍 חיפוש אירוע": "search",
  "📋 פרופיל": "profile",
  "🔔 שמורים": "saved",
  "👀 במעקב": "watching",
  "⭐ תחומי עניין": "interests",
  "❓ עזרה": "help",
};

function replyActionsKeyboardMarkup() {
  // Two buttons on ONE row: a compact "❓ עזרה" to the LEFT of "📋 תפריט ראשי".
  // (Reply-keyboard buttons in a row always split width evenly — Telegram has
  // no per-button width — so "smaller" is approximated via the short label.)
  return {
    reply_markup: {
      keyboard: [[{ text: "❓ עזרה" }, { text: "📋 תפריט ראשי" }]],
      resize_keyboard: true,
      is_persistent: true,
    },
  };
}

function buildMainMenuKeyboard({ agentEnabled, hasDraft, botUsername = null }) {
  const profileUrl = getMiniAppProfileUrl();
  const catalogUrl = getMiniAppCatalogUrl();
  // Prefer a t.me/<bot>?startapp=… deep link: unlike a web_app button baked
  // into a message (which can lose initData when the message goes stale, esp.
  // on Desktop), a startapp link is resolved FRESH on every tap → always a
  // clean Mini App launch with auth. Requires the bot's Main Mini App enabled.
  // Falls back to web_app (then in-bot callback) when no username/URL.
  const startLink = (param) =>
    botUsername ? `https://t.me/${botUsername}?startapp=${param}` : null;

  // Profile opens the unified Mini App directly on the Profile tab via a
  // t.me/<bot>?startapp=profile deep link (fresh launch → always authed).
  // Falls back to the in-bot callback→message flow when no username.
  const profileLink = startLink("profile");
  const profileRow = profileLink
    ? [Markup.button.url("📋 פרופיל אישי", profileLink)]
    : [Markup.button.callback("📋 פרופיל אישי", `${MENU}:profile`)];

  const catalogLink = startLink("catalog");
  const catalogBtn = catalogLink
    ? Markup.button.url("📅 קטלוג אירועים", catalogLink)
    : catalogUrl
      ? Markup.button.webApp("📅 קטלוג אירועים", catalogUrl)
      : Markup.button.callback("📅 קטלוג אירועים", `${MENU}:catalog`);

  // Clean menu — just the essentials for now.
  const rows = [
    [catalogBtn],
    profileRow,
    [Markup.button.callback("❓ עזרה", `${MENU}:help`)],
  ];
  return Markup.inlineKeyboard(rows);
}

function buildProfileViewKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✏️ עריכה", `${MENU}:profile:edit`)],
    [Markup.button.callback("↩️ חזרה לתפריט", `${MENU}:main`)],
  ]);
}

/** Edit options — only fields we can route to a real flow today. */
function buildProfileEditKeyboard(profile) {
  const rows = [
    [Markup.button.callback("👤 שם תצוגה", `${MENU}:edit:name`)],
    [
      Markup.button.callback("👧 ילדים", `${MENU}:edit:kids`),
      Markup.button.callback("⭐ תחומי עניין", `${MENU}:edit:interests`),
    ],
    [
      Markup.button.callback("🏳️ קהילות", `${MENU}:edit:communities`),
      Markup.button.callback("📏 מרחק / מיקום", `${MENU}:edit:location`),
    ],
    [Markup.button.callback("📍 המקומות שלי", `${MENU}:edit:favorites`)],
    [Markup.button.callback("🏠 כתובת בית", `${MENU}:edit:address`)],
    [
      Markup.button.callback("⚧ מגדר", `${MENU}:edit:gender`),
      Markup.button.callback("🎂 טווח גיל", `${MENU}:edit:age`),
    ],
    [Markup.button.callback("👥 קהלי יעד", `${MENU}:edit:audiences`)],
    [Markup.button.callback("🏷️ תגיות מושתקות", `${MENU}:edit:suppressed`)],
    [Markup.button.callback("🧭 אשף מלא (הכל)", `${MENU}:edit:wizard`)],
    [Markup.button.callback("↩️ חזרה לפרופיל", `${MENU}:profile`)],
  ];
  if (profile?.user_context?.partner?.name) {
    rows.splice(4, 0, [
      Markup.button.callback("❤️ עניין בן/בת זוג", `${MENU}:edit:partner`),
    ]);
  }
  return Markup.inlineKeyboard(rows);
}

function buildGenderEditKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("אישה", "gnd:female"),
      Markup.button.callback("גבר", "gnd:male"),
    ],
    [Markup.button.callback("ניטרלי", "gnd:neutral")],
    [Markup.button.callback("↩️ חזרה", `${MENU}:profile:edit`)],
  ]);
}

function buildDisplayNameEditKeyboard({ telegramName = null } = {}) {
  const rows = [];
  if (telegramName) {
    const short =
      telegramName.length <= 24 ? telegramName : `${telegramName.slice(0, 23)}…`;
    rows.push([
      Markup.button.callback(
        `🔄 שם מטלגרם (${short})`,
        `${MENU}:edit:name:telegram`,
      ),
    ]);
  }
  rows.push([Markup.button.callback("↩️ חזרה", `${MENU}:profile:edit`)]);
  return Markup.inlineKeyboard(rows);
}

function buildAddressEditKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🗑️ מחק כתובת", `${MENU}:edit:address:clear`)],
    [Markup.button.callback("↩️ חזרה", `${MENU}:profile:edit`)],
  ]);
}

function buildAgeEditKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🧒 18-35", "age:young_adult"),
      Markup.button.callback("🧑 35-60", "age:mid_adult"),
    ],
    [Markup.button.callback("👴 60+", "age:senior")],
    [Markup.button.callback("↩️ חזרה", `${MENU}:profile:edit`)],
  ]);
}

function mainMenuIntroText(draftText, gender = null) {
  const pick = pickActionVerb(gender);
  const trimmed = String(draftText || "").trim();
  if (!trimmed) {
    return "🏠 *תפריט ראשי*"; // short — the welcome/explainer lives in /start + עזרה
  }
  const { isAgentEnabled } = require("./agentConfig");
  const { genderForm } = require("./genderForm");
  const sendHint = genderForm(gender, {
    f: "«שלחי לבוט»",
    m: "«שלח לבוט»",
    n: "«שלח/י לבוט»",
  });
  const agentHint = isAgentEnabled() ? `\n\n${sendHint} — שיחה חופשית (Gemini).` : "";
  return (
    `קיבלתי: «${trimmed}»\n\n` +
    `${pick} פעולה. «חיפוש אירוע» פותח כפתורי חיפוש.` +
    agentHint
  );
}

function resolveReplyAction(message) {
  const t = String(message || "").trim();
  return REPLY_ACTIONS[t] || null;
}

/**
 * Show the typing menu unless the user is mid-flow with the agent or a wizard.
 */
function shouldShowTypingMenu({ session, message, onbState }) {
  const text = String(message || "").trim();
  if (!text || text.startsWith("/")) return false;
  if (resolveReplyAction(text)) return false;
  if (onbState) return false;
  if (session?.pendingClarification) return false;
  if (session?.pendingSave?._fieldEdit?.field) return false;
  if (session?.pendingProfileField) return false;
  if (session?.interestsPicker?.freeTextMode) return false;
  return true;
}

module.exports = {
  MENU,
  REPLY_ACTIONS,
  replyActionsKeyboardMarkup,
  formatProfileLines,
  buildMainMenuKeyboard,
  buildProfileViewKeyboard,
  buildProfileEditKeyboard,
  buildGenderEditKeyboard,
  buildDisplayNameEditKeyboard,
  buildAddressEditKeyboard,
  buildAgeEditKeyboard,
  mainMenuIntroText,
  resolveReplyAction,
  shouldShowTypingMenu,
};
