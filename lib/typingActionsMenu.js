// Action menu shown when the user sends free text (typing → send).
// Telegram bots do not receive "user is typing" events; the menu appears
// on the first text message outside special flows.

const { Markup } = require("telegraf");
const { formatProfileLines } = require("./profileDisplay");

const MENU = "menu";

/** Reply-keyboard labels → internal action ids */
const REPLY_ACTIONS = {
  "🔍 חיפוש אירוע": "search",
  "📋 פרופיל": "profile",
  "🔔 שמורים": "saved",
  "👀 במעקב": "watching",
  "⭐ תחומי עניין": "interests",
  "❓ עזרה": "help",
};

function replyActionsKeyboardMarkup() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🔍 חיפוש אירוע" }, { text: "📋 פרופיל" }],
        [{ text: "🔔 שמורים" }, { text: "👀 במעקב" }],
        [{ text: "⭐ תחומי עניין" }, { text: "❓ עזרה" }],
      ],
      resize_keyboard: true,
      is_persistent: true,
    },
  };
}

function buildMainMenuKeyboard({ agentEnabled, hasDraft }) {
  const rows = [
    [Markup.button.callback("🔍 חיפוש אירוע", `${MENU}:search`)],
    [Markup.button.callback("📋 פרופיל אישי", `${MENU}:profile`)],
    [
      Markup.button.callback("🔔 שמורים", `${MENU}:saved`),
      Markup.button.callback("👀 במעקב", `${MENU}:watching`),
    ],
    [Markup.button.callback("⭐ תחומי עניין", `${MENU}:interests`)],
    [
      Markup.button.callback("📅 קטלוג", `${MENU}:catalog`),
      Markup.button.callback("❓ עזרה", `${MENU}:help`),
    ],
  ];
  if (agentEnabled) {
    rows.push([
      Markup.button.callback(
        hasDraft ? "💬 שלחי לבוט (שיחה)" : "💬 שיחה חופשית עם הבוט",
        `${MENU}:agent`,
      ),
    ]);
  }
  rows.push([Markup.button.callback("✖️ סגירה", `${MENU}:close`)]);
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

function mainMenuIntroText(draftText) {
  const trimmed = String(draftText || "").trim();
  if (!trimmed) {
    return (
      "🏠 *תפריט ראשי*\n\n" +
      "בחרי פעולה בכפתורים (או מהמקלדת הקבועה למטה). " +
      "אפשר גם לכתוב חיפוש כמו «מוזיקה השבוע»."
    );
  }
  const { isAgentEnabled } = require("./agentConfig");
  const agentHint = isAgentEnabled()
    ? "\n\n«שלחי לבוט» — שיחה חופשית (Gemini)."
    : "";
  return (
    `קיבלתי: «${trimmed}»\n\n` +
    "בחרי פעולה. «חיפוש אירוע» פותח כפתורי חיפוש." +
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
  buildAddressEditKeyboard,
  buildAgeEditKeyboard,
  mainMenuIntroText,
  resolveReplyAction,
  shouldShowTypingMenu,
};
