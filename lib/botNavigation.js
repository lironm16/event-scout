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

function refinementKeyboardWithNav() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🚶 רק קרוב", "rtr:runref:walk"),
      Markup.button.callback("🎫 עם כרטיסים", "rtr:runref:tickets"),
    ],
    [
      Markup.button.callback("🔔 שמור מעקב", "rtr:save"),
      Markup.button.callback("🔍 חיפוש חדש", "rtr:menu"),
    ],
    [Markup.button.callback("↩️ תפריט ראשי", `${MENU}:main`)],
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

async function showMainMenu(ctx, { draftText = null } = {}) {
  const session = require("./agent/sessionStore");
  const { getProfile } = require("../bot/profileService");
  const telegramId = ctx.from.id;
  const profile = await getProfile(telegramId).catch(() => null);
  const gender = profile?.user_context?.gender || null;
  const s = session.ensureSession(telegramId);
  if (draftText != null) s.typingMenuDraft = String(draftText).trim() || null;
  const draft = s.typingMenuDraft;
  await ctx.reply(mainMenuIntroText(draft, gender), {
    parse_mode: "Markdown",
    ...buildMainMenuKeyboard({
      agentEnabled: isAgentEnabled(),
      hasDraft: !!draft,
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
  showSearchHub,
};
