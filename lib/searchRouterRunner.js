// Execute a deterministic search turn: search_events → present_event_results.
// No Gemini — relies on enriched DB labels from eventEnricher.

const { Markup } = require("telegraf");
const sessionStore = require("./agent/sessionStore");
const { dispatch } = require("./agent/tools");
const { getProfile } = require("../bot/profileService");
const { rememberSearchHits } = require("./searchCtx");
const {
  filtersToSearchArgs,
  filtersToSaveSnapshot,
  buildIntroFromSearchResult,
  buildNoResultsMessage,
  routeMessage,
  presetFilters,
} = require("./searchRouter");
/** Attach session/profile/search cache to a buildAgentCtx() object. */
async function enrichAgentCtx(agentCtx, telegramId) {
  agentCtx.telegramId = telegramId;
  agentCtx.session = sessionStore.ensureSession(telegramId);
  agentCtx.profile = await getProfile(telegramId).catch(() => null);
  agentCtx.lastSearchHits = [];
  agentCtx.lastSearchResultIds = new Set();
  agentCtx.rememberSearchHits = (events) => rememberSearchHits(agentCtx, events);
  return agentCtx;
}

const {
  searchHubKeyboard,
  refinementKeyboardWithNav,
} = require("./botNavigation");

function refinementKeyboard() {
  return refinementKeyboardWithNav();
}

function searchMenuKeyboard() {
  return searchHubKeyboard();
}

async function runSearchWithFilters(telegramId, agentCtx, filters) {
  const ctx = await enrichAgentCtx(agentCtx, telegramId);
  const searchArgs = filtersToSearchArgs(filters);
  const result = await dispatch("search_events", searchArgs, ctx);

  if (result?.error) {
    console.error("[Router] search_events failed:", result.message || result.error);
    await ctx.tg.reply(
      "⚠️ החיפוש נתקע טכנית — נסי שוב בעוד רגע. אם זה חוזר, עדכני אותנו.",
      searchMenuKeyboard(),
    );
    return { ok: false, error: result.error };
  }

  sessionStore.setLastSearchFilters(telegramId, {
    ...filters,
    date_from: result?.window?.from ?? filters.date_from,
    date_to: result?.window?.to ?? filters.date_to,
  });
  if (result?.can_extend_beyond_window && result?.extension_hint) {
    sessionStore.setLastExtensionHint(telegramId, result.extension_hint);
  } else {
    sessionStore.clearLastExtensionHint(telegramId);
  }

  const matched = result?.matched ?? 0;
  if (matched === 0) {
    const msg = buildNoResultsMessage(result);
    await ctx.tg.reply(msg, searchMenuKeyboard());
    if (result?.can_extend_beyond_window && result?.extension_hint) {
      await ctx.tg.reply(
        "להרחיב את החיפוש?",
        Markup.inlineKeyboard([[Markup.button.callback("כן, להרחיב", "rtr:extend")]]),
      );
    }
    return { ok: true, matched: 0, result };
  }

  const ids = (result.events || []).map((e) => e.id).filter((id) => id != null).slice(0, 15);
  const intro = buildIntroFromSearchResult(result);
  await dispatch("present_event_results", { event_ids: ids, intro_text: intro }, ctx);
  await ctx.tg.reply("רוצה לצמצם?", refinementKeyboard());
  return { ok: true, matched, result };
}

async function runRouterTextTurn(telegramId, agentCtx, telegrafCtx, message) {
  const lastFilters = sessionStore.getLastSearchFilters(telegramId);
  const hasExtensionHint = !!sessionStore.getLastExtensionHint(telegramId);
  const routed = routeMessage(message, { lastFilters, hasExtensionHint });

  if (routed.kind === "extend") {
    const hint = sessionStore.getLastExtensionHint(telegramId);
    const base = lastFilters || presetFilters("this_week");
    if (!hint?.suggested_date_to) {
      await telegrafCtx.reply("אין הרחבה שמורה — נסי חיפוש חדש.", searchMenuKeyboard());
      return { ok: false };
    }
    const filters = {
      ...base,
      date_preset: undefined,
      date_from: base.date_from || undefined,
      date_to: hint.suggested_date_to,
    };
    delete filters.date_preset;
    if (!filters.date_from && lastFilters?.date_preset) {
      const { weekRangeIL, todayISO } = require("./timeContext");
      if (lastFilters.date_preset === "this_week") {
        const w = weekRangeIL();
        filters.date_from = w.startISO;
      } else {
        filters.date_from = todayISO();
      }
    }
    return runSearchWithFilters(telegramId, agentCtx, filters);
  }

  if (routed.kind === "menu") {
    const { showSearchHub } = require("./botNavigation");
    await showSearchHub(telegrafCtx);
    return { ok: true, menu: true };
  }

  if (routed.kind === "search" || routed.kind === "refine") {
    return runSearchWithFilters(telegramId, agentCtx, routed.filters);
  }

  const { showMainMenu } = require("./botNavigation");
  await showMainMenu(telegrafCtx, { draftText: message });
  return { ok: false, unknown: true };
}

async function runRouterPreset(telegramId, agentCtx, telegrafCtx, preset) {
  const last = sessionStore.getLastSearchFilters(telegramId) || {};
  let filters;
  if (preset === "walk" || preset === "tickets") {
    filters = { ...last, ...presetFilters(preset) };
    if (!filters.date_preset && !filters.date_from) filters.date_preset = "this_week";
  } else if (preset.startsWith("tag:")) {
    const raw = preset.slice(4);
    const { tagFromRouterId } = require("./botNavigation");
    const tag = tagFromRouterId(raw) || decodeURIComponent(raw);
    filters = { ...last, tags: [tag], date_preset: last.date_preset || "this_week" };
  } else if (preset.startsWith("kw:")) {
    const raw = preset.slice(3);
    const { kwFromRouterId } = require("./botNavigation");
    const kw = kwFromRouterId(raw) || decodeURIComponent(raw);
    filters = { ...last, keywords: [kw], date_preset: last.date_preset || "this_week" };
  } else {
    filters = { ...last, ...presetFilters(preset) };
    // New date preset must not keep stale date_from/date_to from a prior search.
    if (filters.date_preset) {
      delete filters.date_from;
      delete filters.date_to;
    }
    if (!filters.date_preset && !filters.date_from && !filters.date_to) {
      filters.date_preset = preset === "tomorrow" || preset === "today" || preset === "next_week"
        ? preset
        : "this_week";
    }
  }
  return runSearchWithFilters(telegramId, agentCtx, filters);
}

async function startSaveFromLastSearch(telegramId, agentCtx) {
  const filters = sessionStore.getLastSearchFilters(telegramId);
  if (!filters) {
    await agentCtx.tg.reply(
      "אין חיפוש אחרון לשמירה — חפשי קודם, ואז «שמור מעקב».",
      searchMenuKeyboard(),
    );
    return;
  }
  const snapshot = filtersToSaveSnapshot(filters);
  const ctx = await enrichAgentCtx(agentCtx, telegramId);
  await dispatch(
    "present_save_confirmation",
    {
      query: snapshot.query,
      tokens: snapshot.tokens,
      filters: snapshot.filters,
      tickets_needed: null,
    },
    ctx,
  );
}

module.exports = {
  runRouterTextTurn,
  runSearchWithFilters,
  runRouterPreset,
  startSaveFromLastSearch,
  searchMenuKeyboard,
  refinementKeyboard,
};
