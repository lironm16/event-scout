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
const { tryAgainVerb, searchGoLabel } = require("./genderForm");

function refinementKeyboard() {
  return refinementKeyboardWithNav();
}

function searchMenuKeyboard(gender = null) {
  return searchHubKeyboard(gender);
}

function profileGender(profile) {
  return profile?.user_context?.gender || null;
}

async function runSearchWithFilters(telegramId, agentCtx, filters) {
  const ctx = await enrichAgentCtx(agentCtx, telegramId);
  const searchArgs = filtersToSearchArgs(filters);
  const result = await dispatch("search_events", searchArgs, ctx);

  const gender = profileGender(ctx.profile);

  if (result?.error) {
    console.error("[Router] search_events failed:", result.message || result.error);
    const retry = tryAgainVerb(gender);
    await ctx.tg.reply(
      `⚠️ החיפוש נתקע טכנית — ${retry} שוב בעוד רגע. אם זה חוזר, עדכנו אותנו.`,
      searchMenuKeyboard(gender),
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
    await ctx.tg.reply(msg);
    // Ways to turn 0 results into some: widen the window, drop the
    // profile filter ("חיפוש כללי"), or edit the query. We do NOT
    // re-send the full search-hub menu here — the edit button opens it
    // on demand (seeded with the last search).
    const rows = [];
    if (result?.can_extend_beyond_window && result?.extension_hint) {
      rows.push([Markup.button.callback("📅 להרחיב את הטווח", "rtr:extend")]);
    }
    if (!filters?.ignore_profile) {
      rows.push([
        Markup.button.callback("🌐 חפשו בכל מה שיש (בלי הפרופיל)", "rtr:scope:all"),
      ]);
    }
    rows.push([Markup.button.callback("✏️ ערוך חיפוש חדש", "rtr:menu")]);
    await ctx.tg.reply("רוצים לנסות אחרת?", Markup.inlineKeyboard(rows));
    return { ok: true, matched: 0, result };
  }

  // Pagination pool — page through up to the tool's full result cap
  // (MAX_RESULTS=30) five at a time, so a wide "upcoming" search isn't
  // truncated to the first 15.
  const ids = (result.events || []).map((e) => e.id).filter((id) => id != null).slice(0, 30);
  const intro = buildIntroFromSearchResult(result);
  // Suppress the tool's own "יש עוד N — להראות?" message; we fold that
  // CTA into the single combined post-search keyboard below so the user
  // sees ONE prompt, not three contradictory ones (show-more / narrow /
  // expand). The tool still wires up session hits for `pgn:next`.
  const presentResult = await dispatch(
    "present_event_results",
    { event_ids: ids, intro_text: intro, suppress_pagination_prompt: true },
    ctx,
  );

  const moreRemaining = Number(presentResult?.more_remaining_series) || 0;
  const canExtend =
    Boolean(result?.can_extend_beyond_window && result?.extension_hint);

  const leadingRows = [];
  if (moreRemaining > 0) {
    const showLabel =
      moreRemaining === 1
        ? "👀 להראות עוד אירוע"
        : `👀 להראות עוד ${moreRemaining}`;
    leadingRows.push([Markup.button.callback(showLabel, "pgn:next")]);
  }
  if (canExtend) {
    const when = result.extension_hint.label_he || "מאוחר יותר";
    leadingRows.push([
      Markup.button.callback(`📅 להרחיב — גם ${when}`, "rtr:extend"),
    ]);
  }

  await ctx.tg.reply("מה הלאה?", refinementKeyboardWithNav({ leadingRows }));
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
      const profile = await getProfile(telegramId).catch(() => null);
      const gender = profileGender(profile);
      const retry = tryAgainVerb(gender);
      await telegrafCtx.reply(
        `אין הרחבה שמורה — ${retry} חיפוש חדש.`,
        searchMenuKeyboard(gender),
      );
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
    if (!filters.date_preset && !filters.date_from) filters.date_preset = "upcoming";
  } else if (preset.startsWith("tag:")) {
    const raw = preset.slice(4);
    const { tagFromRouterId } = require("./botNavigation");
    const tag = tagFromRouterId(raw) || decodeURIComponent(raw);
    filters = { ...last, tags: [tag], date_preset: last.date_preset || "upcoming" };
  } else if (preset.startsWith("kw:")) {
    const raw = preset.slice(3);
    const { kwFromRouterId } = require("./botNavigation");
    const kw = kwFromRouterId(raw) || decodeURIComponent(raw);
    filters = { ...last, keywords: [kw], date_preset: last.date_preset || "upcoming" };
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
        : "upcoming";
    }
  }
  return runSearchWithFilters(telegramId, agentCtx, filters);
}

async function startSaveFromLastSearch(telegramId, agentCtx) {
  const filters = sessionStore.getLastSearchFilters(telegramId);
  const ctx = await enrichAgentCtx(agentCtx, telegramId);
  const gender = profileGender(ctx.profile);
  const go = searchGoLabel(gender);
  if (!filters) {
    await agentCtx.tg.reply(
      `אין חיפוש אחרון לשמירה — ${go} קודם, ואז «שמור מעקב».`,
      searchMenuKeyboard(gender),
    );
    return;
  }
  const snapshot = filtersToSaveSnapshot(filters);
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
