// Button-first bot navigation (no Gemini). Menus, search hub, back links.

const { Markup } = require("telegraf");
const { MENU, buildMainMenuKeyboard, mainMenuIntroText } = require("./typingActionsMenu");
const { isAgentEnabled } = require("./agentConfig");

const {
  SEARCH_TOPICS,
  SEARCH_KEYWORDS,
  SEARCH_ACTIVITIES,
  SEARCH_AUDIENCES,
  tagFromRouterId,
  kwFromRouterId,
} = require("./searchDraftPicker");

function searchHubKeyboard(gender = null) {
  const { buildSearchDraftKeyboard } = require("./searchDraftPicker");
  return buildSearchDraftKeyboard(null, gender);
}

function refinementKeyboardWithNav(opts = {}) {
  // Optional leading rows let the post-search flow fold the "show more"
  // and "expand window" CTAs into this ONE keyboard instead of sending
  // them as separate, contradictory follow-up messages.
  const leadingRows = Array.isArray(opts.leadingRows) ? opts.leadingRows : [];
  return Markup.inlineKeyboard([
    ...leadingRows,
    [
      Markup.button.callback("🚶 רק קרוב", "rtr:runref:walk"),
      Markup.button.callback("🎫 עם כרטיסים", "rtr:runref:tickets"),
    ],
    [
      Markup.button.callback("🔔 שמור מעקב", "rtr:save"),
      Markup.button.callback("🔍 חיפוש חדש", "rtr:menu"),
    ],
    [Markup.button.callback("↩️ תפריט ראשי", `${MENU}:main`)],
    // Re-run the same query in the other scope (two buttons, not a toggle).
    [
      Markup.button.callback("✨ בשבילי", "rtr:scope:me"),
      Markup.button.callback("🌐 כללי", "rtr:scope:all"),
    ],
  ]);
}

function searchHubIntroText(draftText, gender = null) {
  const { buildSearchDraftHeader, emptyDraft } = require("./searchDraftPicker");
  return buildSearchDraftHeader(emptyDraft(), draftText, gender);
}

const { profileSetupNeeds } = require("./profileCompleteness");

function buildProfileViewKeyboardExtra(profile) {
  const missing = profileSetupNeeds(profile);
  if (!missing.length) return null;
  const rows = [];
  if (missing.includes("address")) {
    rows.push([Markup.button.callback("🏠 הוספת כתובת", `${MENU}:edit:address`)]);
  }
  if (missing.includes("interests")) {
    rows.push([Markup.button.callback("⭐ תחומי עניין", `${MENU}:edit:interests`)]);
  }
  if (missing.includes("kids")) {
    rows.push([Markup.button.callback("👧 גילאי ילדים", `${MENU}:edit:kids`)]);
  }
  return rows.length ? Markup.inlineKeyboard(rows) : null;
}

// Lightweight launcher: a SINGLE "📋 תפריט ראשי" button. Tapping it
// (callback MENU:main) sends the full button menu as a FRESH message, so its
// web_app/link buttons reliably carry initData. We route everything through
// this instead of dumping the full inline menu (whose buttons go stale when
// the message scrolls into history — losing initData on Desktop).
async function showMainMenu(ctx, { draftText = null } = {}) {
  const session = require("./agent/sessionStore");
  const telegramId = ctx.from.id;
  const s = session.ensureSession(telegramId);
  if (draftText != null) s.typingMenuDraft = String(draftText).trim() || null;
  await ctx.reply("👋 מה תרצי לעשות?", {
    reply_markup: {
      inline_keyboard: [[{ text: "📋 תפריט ראשי", callback_data: `${MENU}:main` }]],
    },
  });
}

// The full button menu — sent FRESH each time the launcher is tapped.
async function showFullMenu(ctx, { draftText = null } = {}) {
  const session = require("./agent/sessionStore");
  const { getProfile } = require("../bot/profileService");
  const telegramId = ctx.from.id;
  const profile = await getProfile(telegramId).catch(() => null);
  const gender = profile?.user_context?.gender || null;
  const s = session.ensureSession(telegramId);
  if (draftText != null) s.typingMenuDraft = String(draftText).trim() || null;
  const draft = s.typingMenuDraft;
  let botUsername = null;
  try {
    botUsername = await require("./referralService").getBotUsername(ctx.telegram);
  } catch { /* fall back to web_app button */ }
  await ctx.reply(mainMenuIntroText(draft, gender), {
    parse_mode: "Markdown",
    ...buildMainMenuKeyboard({
      agentEnabled: isAgentEnabled(),
      hasDraft: !!draft,
      botUsername,
    }),
  });
}


async function showSearchHub(ctx, { draftText = null } = {}) {
  const sessionStore = require("./agent/sessionStore");
  const { openSearchDraftHub } = require("./searchDraftPicker");
  await openSearchDraftHub(ctx, sessionStore, { draftText });
}

module.exports = {
  SEARCH_TOPICS,
  tagFromRouterId,
  kwFromRouterId,
  searchHubKeyboard,
  refinementKeyboardWithNav,
  searchHubIntroText,
  profileSetupNeeds,
  buildProfileViewKeyboardExtra,
  showMainMenu,
  showFullMenu,
  showSearchHub,
};
