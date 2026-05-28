// "לא מתאים" → קהל יעד: ילדים (0-3 / 3+), ביטול אירועי ילדים, קהילות.

const { Markup } = require("telegraf");
const { formatAudienceLine } = require("./eventFormat");
const {
  isChildTargetedEvent,
  setSuppressChildAudiences,
  appendKidToProfile,
} = require("./childEventPrefs");
const { communitiesFromPickerSelection } = require("../bot/profileService");
const { memberKeysForCommunityPicker } = require("./communityAccess");
const {
  BIRTH_DATE_PROMPT,
  parseBirthDateInput,
  validateBirthDate,
  formatKidProfileSuffix,
} = require("./kidAge");

const {
  stageLabels,
  COMMUNITY_CHIPS,
  buildBirthDateBackKeyboard,
  buildStagesKeyboard,
  buildKidsBandKeyboard,
  buildCommunityKeyboard,
} = require("./kidsWizardUi");

function wizardState(session) {
  return session.pendingFbKid || null;
}

function setWizard(session, state) {
  session.pendingFbKid = state;
}

function clearWizard(session) {
  delete session.pendingFbKid;
}

async function finalizeKidAndAskMore(ctx, session, eventId, { hideEvent, appendKidToProfile }) {
  const w = wizardState(session);
  if (!w?.draft?.name || !w.draft.birth_date) {
    await ctx.reply("⚠️ חסר שם או תאריך לידה");
    return;
  }
  try {
    const stages = stageLabels(w.draft.stages);
    await appendKidToProfile(ctx.from.id, {
      name: w.draft.name,
      birth_date: w.draft.birth_date,
      stages,
    });
    await hideEvent(ctx.from.id, eventId, "wrong_audience");
    w.step = "more_child";
    const who = formatKidProfileSuffix({ name: w.draft.name, birth_date: w.draft.birth_date });
    await ctx.reply(
      `✅ שמרתי את ${w.draft.name} (${who}).\n\nיש ילד/ה נוסף/ת?`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("כן", `fb:more:${eventId}:y`),
          Markup.button.callback("לא", `fb:more:${eventId}:n`),
        ],
      ]),
    );
  } catch (err) {
    console.error("[FbAud] save kid:", err.message);
    await ctx.reply("⚠️ לא הצלחתי לשמור");
  }
}

function registerAudienceWizardHandlers(bot, deps) {
  const {
    supabase,
    sessionStore,
    getProfile,
    hideEvent,
    finishWithAck,
    replyAsCallbackResult,
  } = deps;

  async function loadEvent(eventId) {
    const { data } = await supabase
      .from("events")
      .select("id, name, audience, min_months, max_months, description, access")
      .eq("id", parseInt(eventId, 10))
      .maybeSingle();
    return data;
  }

  async function showAudienceEntry(ctx, eventId) {
    const ev = await loadEvent(eventId);
    const line = ev ? formatAudienceLine(ev) : null;
    const header = line ? `קהל האירוע: ${line}\n\n` : "";

    if (ev && isChildTargetedEvent(ev)) {
      await replyAsCallbackResult(
        ctx,
        `${header}מה מתאים לך?`,
        Markup.inlineKeyboard(buildKidsBandKeyboard("fb", eventId)),
      );
      return;
    }

    const rows = [
      [Markup.button.callback("📌 רק האירוע הזה", `fb:ageno:${eventId}`)],
      [Markup.button.callback("↩️ חזרה", `fb:reasons:${eventId}`)],
    ];
    await replyAsCallbackResult(ctx, `${header}מה לא מתאים בקהל?`, Markup.inlineKeyboard(rows));
  }

  bot.action(/^fb:aud:(\d+)$/, async (ctx) => {
    const eventId = ctx.match[1];
    await ctx.answerCbQuery().catch(() => {});
    clearWizard(sessionStore.ensureSession(ctx.from.id));
    await showAudienceEntry(ctx, eventId);
  });

  bot.action(/^fb:aud:nk:(\d+)$/, async (ctx) => {
    const eventId = ctx.match[1];
    try {
      await setSuppressChildAudiences(ctx.from.id, true);
      await hideEvent(ctx.from.id, eventId, "wrong_audience");
      await finishWithAck(
        ctx,
        eventId,
        "wrong_audience",
        "✅ לא אציג אירועים לילדים/תינוקות/נוער",
      );
    } catch (err) {
      console.error("[FbAud] nk:", err.message);
      await ctx.answerCbQuery("⚠️");
    }
  });

  bot.action(/^fb:aud:03:(\d+)$/, async (ctx) => {
    const eventId = ctx.match[1];
    await ctx.answerCbQuery().catch(() => {});
    const session = sessionStore.ensureSession(ctx.from.id);
    setWizard(session, {
      eventId,
      step: "birthdate",
      band: "0-3",
      draft: { stages: [], awaitingBirthDate: true },
    });
    await replyAsCallbackResult(ctx, BIRTH_DATE_PROMPT, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buildBirthDateBackKeyboard("fb", eventId)),
    });
  });

  bot.action(/^fb:aud:3p:(\d+)$/, async (ctx) => {
    const eventId = ctx.match[1];
    await ctx.answerCbQuery().catch(() => {});
    const session = sessionStore.ensureSession(ctx.from.id);
    setWizard(session, {
      eventId,
      step: "birthdate",
      band: "3+",
      draft: { awaitingBirthDate: true },
    });
    await replyAsCallbackResult(ctx, BIRTH_DATE_PROMPT, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buildBirthDateBackKeyboard("fb", eventId)),
    });
  });

  bot.action(/^fb:stg:(\d+):(crawl|walk|talk|wean|solids)$/, async (ctx) => {
    const [, eventId, stageId] = ctx.match;
    const session = sessionStore.ensureSession(ctx.from.id);
    const w = wizardState(session);
    if (!w || String(w.eventId) !== eventId || w.step !== "stages") return;
    await ctx.answerCbQuery().catch(() => {});
    const set = new Set(w.draft.stages || []);
    if (set.has(stageId)) set.delete(stageId);
    else set.add(stageId);
    w.draft.stages = [...set];
    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: buildStagesKeyboard("fb", eventId, w.draft.stages),
      });
    } catch {
      /* ok */
    }
  });

  bot.action(/^fb:stgn:(\d+)$/, async (ctx) => {
    const eventId = ctx.match[1];
    const session = sessionStore.ensureSession(ctx.from.id);
    const w = wizardState(session);
    if (!w || String(w.eventId) !== eventId) return;
    await ctx.answerCbQuery().catch(() => {});
    w.step = "name_text";
    await ctx.reply("מה שם הילד/ה?");
  });

  bot.action(/^fb:more:(\d+):(y|n)$/, async (ctx) => {
    const [, eventId, yn] = ctx.match;
    const session = sessionStore.ensureSession(ctx.from.id);
    await ctx.answerCbQuery().catch(() => {});
    if (yn === "n") {
      clearWizard(session);
      await ctx.reply("✅ מעולה — אשתמש בפרופיל לסינון אירועים לפי גיל.");
      return;
    }
    clearWizard(session);
    await replyAsCallbackResult(
      ctx,
      "בחרי טווח גיל לילד/ה הבא/ה:",
      Markup.inlineKeyboard(buildKidsBandKeyboard("fb", eventId, { afterMore: true })),
    );
  });

  bot.action(/^fb:aud:cm:(\d+)$/, async (ctx) => {
    const eventId = ctx.match[1];
    await ctx.answerCbQuery().catch(() => {});
    const profile = await getProfile(ctx.from.id).catch(() => null);
    const communities = profile?.user_context?.communities || {};
    const memberKeys = memberKeysForCommunityPicker(communities);
    const session = sessionStore.ensureSession(ctx.from.id);
    session.pendingFeedbackCommunities = { eventId, member: [...memberKeys] };
    await replyAsCallbackResult(
      ctx,
      "באילו קהילות את/ה רשום/ה? סמני ✅ את כל הרלוונטיות (עדכון כללי לפרופיל):",
      Markup.inlineKeyboard(buildCommunityKeyboard("fb", eventId, memberKeys)),
    );
  });

  bot.action(/^fb:cm:(\d+):([a-z]+)$/, async (ctx) => {
    const [, eventId, short] = ctx.match;
    const chip = COMMUNITY_CHIPS.find((c) => c.short === short);
    if (!chip) return;
    const session = sessionStore.ensureSession(ctx.from.id);
    const st = session.pendingFeedbackCommunities;
    if (!st || String(st.eventId) !== eventId) return;
    await ctx.answerCbQuery().catch(() => {});
    const set = new Set(st.member);
    if (set.has(chip.key)) set.delete(chip.key);
    else set.add(chip.key);
    st.member = [...set];
    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: buildCommunityKeyboard("fb", eventId, st.member),
      });
    } catch {
      /* ok */
    }
  });

  bot.action(/^fb:cmd:(\d+)$/, async (ctx) => {
    const eventId = ctx.match[1];
    const session = sessionStore.ensureSession(ctx.from.id);
    const st = session.pendingFeedbackCommunities;
    if (!st || String(st.eventId) !== eventId) {
      await ctx.answerCbQuery("⚠️");
      return;
    }
    delete session.pendingFeedbackCommunities;
    try {
      const profile = await getProfile(ctx.from.id);
      const ctxData = profile?.user_context || {};
      const communities = communitiesFromPickerSelection(st.member);
      await supabase
        .from("profiles")
        .update({ user_context: { ...ctxData, communities } })
        .eq("telegram_id", String(ctx.from.id));
      await hideEvent(ctx.from.id, eventId, "wrong_audience");
      await finishWithAck(ctx, eventId, "wrong_audience", "✅ עדכנתי קהילות — האירוע הוסתר");
    } catch (err) {
      console.error("[FbAud] communities:", err.message);
      await ctx.answerCbQuery("⚠️");
    }
  });

  bot.action(/^fb:ageno:(\d+)$/, async (ctx) => {
    const eventId = ctx.match[1];
    try {
      await hideEvent(ctx.from.id, eventId, "wrong_audience");
      await finishWithAck(ctx, eventId, "wrong_audience", "✅ האירוע הוסתר");
    } catch (err) {
      await ctx.answerCbQuery("⚠️");
    }
  });
}

function createKidWizardTextHandler(deps) {
  const { sessionStore, hideEvent, appendKidToProfile } = deps;
  return async function handlePendingFeedbackKidWizardText(ctx, message) {
    const session = sessionStore.ensureSession(ctx.from.id);
    const w = wizardState(session);
    if (!w) return false;

    const text = String(message || "").trim();
    const eventId = w.eventId;

    if (w.step === "birthdate" && w.draft?.awaitingBirthDate) {
      const birth_date = parseBirthDateInput(text);
      if (!birth_date || !validateBirthDate(birth_date)) {
        await ctx.reply("לא הצלחתי לפרש תאריך תקין. נסי שוב, למשל: 15.3.2024");
        return true;
      }
      w.draft.birth_date = birth_date;
      w.draft.awaitingBirthDate = false;
      if (w.band === "0-3") {
        w.step = "stages";
        w.draft.stages = [];
        await ctx.reply(
          "שלבי התפתחות (בחרי את כל המתאימים):",
          Markup.inlineKeyboard(buildStagesKeyboard("fb", eventId, [])),
        );
      } else {
        w.step = "name_text";
        await ctx.reply("מה שם הילד/ה?");
      }
      return true;
    }

    if (w.step === "name_text") {
      if (!text || text.length < 2) {
        await ctx.reply("נא להקליד שם (לפחות 2 תווים).");
        return true;
      }
      w.draft.name = text.slice(0, 40);
      await finalizeKidAndAskMore(ctx, session, eventId, { hideEvent, appendKidToProfile });
      return true;
    }

    return false;
  };
}

module.exports = {
  registerAudienceWizardHandlers,
  createKidWizardTextHandler,
};
