// Onboarding steps: kids (positive) + communities — mirrors feedback wizard.

const { Markup } = require("telegraf");
const {
  BIRTH_DATE_PROMPT,
  parseBirthDateInput,
  validateBirthDate,
  formatKidProfileSuffix,
  kidAgeMonths,
  normalizeKidGender,
} = require("./kidAge");
const {
  stageLabels,
  stageIdsFromLabels,
  bandFromKid,
  buildBirthDateBackKeyboard,
  buildKidGenderKeyboard,
  buildStagesKeyboard,
  buildKidsBandKeyboard,
  buildKidsManageKeyboard,
  buildKidEditHubKeyboard,
  buildCommunityKeyboard,
  COMMUNITY_CHIPS,
} = require("./kidsWizardUi");
const { communitiesFromPickerSelection } = require("../bot/profileService");
const { memberKeysForCommunityPicker } = require("./communityAccess");

function ensureKidsDraft(state) {
  if (!state.kidsDraft) state.kidsDraft = { stages: [] };
  return state.kidsDraft;
}

function commitKidsDraft(state) {
  const d = state.kidsDraft;
  if (!d?.name || !d.birth_date) return false;
  if (!Array.isArray(state.kids)) state.kids = [];
  const entry = {
    name: d.name,
    birth_date: d.birth_date,
    stages: stageLabels(d.stages),
  };
  const gender = normalizeKidGender(d.gender);
  if (gender) entry.gender = gender;
  if (d.editIndex != null && d.editIndex >= 0 && d.editIndex < state.kids.length) {
    state.kids[d.editIndex] = entry;
  } else {
    state.kids.push(entry);
  }
  state.kidsDraft = null;
  return true;
}

function loadKidIntoDraft(state, index) {
  const kid = state.kids?.[index];
  if (!kid) return false;
  state.kidsDraft = {
    editIndex: index,
    name: kid.name,
    birth_date: kid.birth_date,
    gender: kid.gender ?? null,
    stages: stageIdsFromLabels(kid.stages),
    band: bandFromKid(kid),
  };
  return true;
}

function kidsManageAfterAdd(state) {
  return state.editReturn === "profile" && (state.kids || []).length > 0;
}

const { genderForm } = require("./genderForm");

function buildOnboardingKidsBody(state, gender) {
  const mark = genderForm(gender, { f: "סמני", m: "סמן", n: "אפשר לסמן" });
  const step = state.step;

  if (step === "kids_manage") {
    const n = (state.kids || []).length;
    return (
      "👧 *הילדים שלך*\n\n" +
      (n
        ? `יש ${n} ילד/ים ברשימה. לעריכה — לחצי על השורה. אפשר גם להוסיף או למחוק.`
        : "אין עדיין ילדים ברשימה — הוסיפי ילד/ה.")
    );
  }
  if (step === "kids_edit") {
    const d = state.kidsDraft;
    const who = d?.name
      ? `${d.name}${formatKidProfileSuffix(d) ? ` (${formatKidProfileSuffix(d)})` : ""}`
      : "ילד/ה";
    return `✏️ *עריכת ${who}*\n\nבחרי מה לעדכן:`;
  }
  if (step === "kids") {
    return (
      "👧 *הילדים שלך*\n\n" +
      "כדי להציע אירועים שמתאימים לגיל — ספרי לי מי בבית:\n" +
      "• תינוק/ת (0–3) — תאריך לידה, שלבים, מגדר, שם\n" +
      "• ילד/ה (3–18) — תאריך לידה, מגדר, שם\n" +
      "• אפשר כמה ילדים"
    );
  }
  if (step === "kids_birthdate") {
    return BIRTH_DATE_PROMPT;
  }
  if (step === "kids_stages") {
    return `🧩 *שלבי התפתחות*\n\n${mark} את כל המתאימים:`;
  }
  if (step === "kids_gender") {
    return "⚧ *מגדר הילד/ה*\n\nבן, בת, או «לא מציין»:";
  }
  if (step === "kids_name") {
    return "✏️ *שם הילד/ה*\n\nכתבי שם בהודעה הבאה (למשל: תומר):";
  }
  if (step === "kids_more") {
    const last = state.kids?.[state.kids.length - 1];
    const who = last
      ? `${last.name} (${formatKidProfileSuffix(last) || ""})`
      : "";
    return `✅ שמרתי${who ? ` את ${who}` : ""}.\n\nיש עוד ילד/ה?`;
  }
  if (step === "communities") {
    return (
      "🏳️ *קהילות*\n\n" +
      `${mark} את הקהילות ש${genderForm(gender, {
        f: "את *רשומה*",
        m: "אתה *רשום*",
        n: "את/ה *רשום/ה*",
      })} אליהן (✅). ` +
      "אפשר להוסיף או להסיר סימון — נשמר רק מה שמסומן."
    );
  }
  return "";
}

function buildOnboardingKidsKeyboard(state) {
  const step = state.step;
  if (step === "kids_manage") {
    return {
      inline_keyboard: buildKidsManageKeyboard(state.kids, {
        editReturn: state.editReturn,
      }),
    };
  }
  if (step === "kids_edit") {
    return { inline_keyboard: buildKidEditHubKeyboard(state.kidsDraft) };
  }
  if (step === "kids") {
    const afterMore = (state.kids || []).length > 0;
    const rows = buildKidsBandKeyboard("onb", null, { positive: true, afterMore });
    if (state.editReturn === "profile" && afterMore) {
      rows.push([Markup.button.callback("↩️ חזרה לרשימה", "onb:kid:back:list")]);
    }
    return { inline_keyboard: rows };
  }
  if (step === "kids_birthdate") {
    const back = state.kidsDraft?.editIndex != null ? "onb:kid:back:hub" : null;
    return { inline_keyboard: buildBirthDateBackKeyboard("onb", null, { backCallback: back }) };
  }
  if (step === "kids_stages") {
    const editing = state.kidsDraft?.editIndex != null;
    return {
      inline_keyboard: buildStagesKeyboard("onb", null, state.kidsDraft?.stages || [], {
        editing,
      }),
    };
  }
  if (step === "kids_gender") {
    const back = state.kidsDraft?.editIndex != null ? "onb:kid:back:hub" : null;
    return { inline_keyboard: buildKidGenderKeyboard("onb", null, { backCallback: back }) };
  }
  if (step === "kids_more") {
    return {
      inline_keyboard: [
        [
          Markup.button.callback("כן, עוד ילד/ה", "onb:kmore:y"),
          Markup.button.callback("לא, המשך", "onb:kmore:n"),
        ],
      ],
    };
  }
  if (step === "kids_name") {
    const back =
      state.kidsDraft?.editIndex != null ? "onb:kid:back:hub" : "onb:back:kids";
    return {
      inline_keyboard: [[Markup.button.callback("← חזרה", back)]],
    };
  }
  if (step === "communities") {
    let member = state.communityMember instanceof Set
      ? [...state.communityMember]
      : Array.isArray(state.communityMember)
        ? state.communityMember
        : [];
    if (!member.length) {
      member = memberKeysForCommunityPicker({});
    }
    return { inline_keyboard: buildCommunityKeyboard("onb", null, member) };
  }
  return null;
}

function registerOnboardingKidsHandlers(bot, deps) {
  const { sessionStore, renderOnboardingStep, persistOnboardingState, getProfile } = deps;

  async function goTo(ctx, telegramId, step) {
    sessionStore.updateOnboarding(telegramId, { step });
    await renderOnboardingStep(ctx, sessionStore.getOnboarding(telegramId));
  }

  async function goToKidsManage(ctx, telegramId) {
    sessionStore.updateOnboarding(telegramId, { step: "kids_manage", kidsDraft: null });
    await renderOnboardingStep(ctx, sessionStore.getOnboarding(telegramId));
  }

  async function afterKidsBlock(ctx, telegramId) {
    const state = sessionStore.getOnboarding(telegramId);
    await persistOnboardingState(telegramId, state, { touchKids: true });
    if (state.editReturn === "profile" && deps.finishProfileEdit) {
      sessionStore.clearOnboarding(telegramId);
      await deps.finishProfileEdit(ctx);
      return;
    }
    const profile = await getProfile(telegramId).catch(() => null);
    const comm = profile?.user_context?.communities || {};
    const member = memberKeysForCommunityPicker(comm);
    sessionStore.updateOnboarding(telegramId, {
      step: "communities",
      communityMember: new Set(member),
    });
    await renderOnboardingStep(ctx, sessionStore.getOnboarding(telegramId));
  }

  bot.action("onb:kids:skip", async (ctx) => {
    const telegramId = ctx.from.id;
    try {
      await ctx.answerCbQuery();
      const state = await deps.ensureOnboardingState(ctx, "kids");
      state.kids = state.kids || [];
      await afterKidsBlock(ctx, telegramId);
    } catch (err) {
      console.error("[OnbKids] skip:", err.message);
      await ctx.answerCbQuery("⚠️");
    }
  });

  bot.action("onb:kids:done", async (ctx) => {
    const telegramId = ctx.from.id;
    await ctx.answerCbQuery();
    await afterKidsBlock(ctx, telegramId);
  });

  function startBirthdateStep(state) {
    ensureKidsDraft(state);
    state.kidsDraft.birth_date = null;
    state.kidsDraft.stages = [];
    state.kidsDraft.awaitingBirthDate = true;
  }

  bot.action("onb:kids:03", async (ctx) => {
    const telegramId = ctx.from.id;
    await ctx.answerCbQuery();
    const state = await deps.ensureOnboardingState(ctx, "kids");
    startBirthdateStep(state);
    state.kidsDraft.band = "0-3";
    sessionStore.updateOnboarding(telegramId, { kidsDraft: state.kidsDraft, step: "kids_birthdate" });
    await renderOnboardingStep(ctx, sessionStore.getOnboarding(telegramId));
  });

  bot.action("onb:kids:3p", async (ctx) => {
    const telegramId = ctx.from.id;
    await ctx.answerCbQuery();
    const state = await deps.ensureOnboardingState(ctx, "kids");
    startBirthdateStep(state);
    state.kidsDraft.band = "3+";
    sessionStore.updateOnboarding(telegramId, { kidsDraft: state.kidsDraft, step: "kids_birthdate" });
    await renderOnboardingStep(ctx, sessionStore.getOnboarding(telegramId));
  });

  bot.action(/^onb:stg:(crawl|walk|talk|wean|solids)$/, async (ctx) => {
    const telegramId = ctx.from.id;
    const stageId = ctx.match[1];
    const state = await deps.ensureOnboardingState(ctx, "kids_stages");
    await ctx.answerCbQuery();
    const d = ensureKidsDraft(state);
    const set = new Set(d.stages || []);
    if (set.has(stageId)) set.delete(stageId);
    else set.add(stageId);
    d.stages = [...set];
    sessionStore.updateOnboarding(telegramId, { kidsDraft: d });
    const editing = d.editIndex != null;
    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: buildStagesKeyboard("onb", null, d.stages, { editing }),
      });
    } catch {
      /* ok */
    }
  });

  bot.action("onb:stgn", async (ctx) => {
    const telegramId = ctx.from.id;
    await ctx.answerCbQuery();
    const state = sessionStore.getOnboarding(telegramId);
    if (state?.kidsDraft?.editIndex != null) {
      await goTo(ctx, telegramId, "kids_edit");
      return;
    }
    await goTo(ctx, telegramId, "kids_gender");
  });

  bot.action("onb:kid:field:stages:save", async (ctx) => {
    const telegramId = ctx.from.id;
    await ctx.answerCbQuery("✅");
    await goTo(ctx, telegramId, "kids_edit");
  });

  bot.action(/^onb:kgen:(male|female|skip)$/, async (ctx) => {
    const telegramId = ctx.from.id;
    const choice = ctx.match[1];
    const state = await deps.ensureOnboardingState(ctx, "kids_gender");
    await ctx.answerCbQuery();
    const d = ensureKidsDraft(state);
    d.gender = choice === "skip" ? null : normalizeKidGender(choice);
    const next = d.editIndex != null ? "kids_edit" : "kids_name";
    sessionStore.updateOnboarding(telegramId, { kidsDraft: d, step: next });
    await renderOnboardingStep(ctx, sessionStore.getOnboarding(telegramId));
  });

  bot.action(/^onb:kmore:(y|n)$/, async (ctx) => {
    const telegramId = ctx.from.id;
    const yn = ctx.match[1];
    await ctx.answerCbQuery();
    if (yn === "n") {
      await afterKidsBlock(ctx, telegramId);
      return;
    }
    const state = sessionStore.getOnboarding(telegramId);
    if (kidsManageAfterAdd(state)) {
      await goToKidsManage(ctx, telegramId);
      return;
    }
    await goTo(ctx, telegramId, "kids");
  });

  bot.action(/^onb:ctog:([a-z]+)$/, async (ctx) => {
    const telegramId = ctx.from.id;
    const short = ctx.match[1];
    const chip = COMMUNITY_CHIPS.find((c) => c.short === short);
    if (!chip) return;
    const state = await deps.ensureOnboardingState(ctx, "communities");
    await ctx.answerCbQuery();
    let member = state.communityMember;
    if (!(member instanceof Set)) {
      member = new Set(Array.isArray(member) ? member : []);
    }
    if (member.has(chip.key)) member.delete(chip.key);
    else member.add(chip.key);
    state.communityMember = member;
    sessionStore.updateOnboarding(telegramId, { communityMember: member });
    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: buildCommunityKeyboard("onb", null, [...member]),
      });
    } catch {
      /* ok */
    }
  });

  bot.action("onb:comm:done", async (ctx) => {
    const telegramId = ctx.from.id;
    try {
      const state = await deps.ensureOnboardingState(ctx, "communities");
      await ctx.answerCbQuery("✅");
      await persistOnboardingState(telegramId, state, { touchCommunitiesOnly: true });
      if (state.editReturn === "profile" && deps.finishProfileEdit) {
        sessionStore.clearOnboarding(telegramId);
        await deps.finishProfileEdit(ctx);
        return;
      }
      await goTo(ctx, telegramId, "location");
    } catch (err) {
      console.error("[OnbKids] comm done:", err.message);
      await ctx.answerCbQuery("⚠️");
    }
  });

  bot.action(/^onb:kid:edit:(\d+)$/, async (ctx) => {
    const telegramId = ctx.from.id;
    const index = Number(ctx.match[1]);
    await ctx.answerCbQuery();
    const state = await deps.ensureOnboardingState(ctx, "kids_manage");
    if (!loadKidIntoDraft(state, index)) {
      await ctx.answerCbQuery("לא נמצא");
      return;
    }
    sessionStore.updateOnboarding(telegramId, { kidsDraft: state.kidsDraft, step: "kids_edit" });
    await renderOnboardingStep(ctx, sessionStore.getOnboarding(telegramId));
  });

  bot.action("onb:kids:new", async (ctx) => {
    const telegramId = ctx.from.id;
    await ctx.answerCbQuery();
    const state = await deps.ensureOnboardingState(ctx, "kids_manage");
    sessionStore.updateOnboarding(telegramId, { step: "kids", kidsDraft: null });
    await renderOnboardingStep(ctx, sessionStore.getOnboarding(telegramId));
  });

  bot.action("onb:kids:save", async (ctx) => {
    const telegramId = ctx.from.id;
    await ctx.answerCbQuery("✅");
    const state = sessionStore.getOnboarding(telegramId);
    if (!state) return;
    if (state.kidsDraft) commitKidsDraft(state);
    await persistOnboardingState(telegramId, state, { touchKids: true });
    if (deps.finishProfileEdit) {
      sessionStore.clearOnboarding(telegramId);
      await deps.finishProfileEdit(ctx);
    }
  });

  bot.action("onb:kids:cancel", async (ctx) => {
    const telegramId = ctx.from.id;
    await ctx.answerCbQuery();
    sessionStore.clearOnboarding(telegramId);
    if (deps.finishProfileEdit) await deps.finishProfileEdit(ctx);
  });

  bot.action("onb:kids:none", async (ctx) => {
    const telegramId = ctx.from.id;
    await ctx.answerCbQuery("נמחק");
    const state = await deps.ensureOnboardingState(ctx, "kids_manage");
    state.kids = [];
    state.kidsDraft = null;
    sessionStore.updateOnboarding(telegramId, { kids: [], kidsDraft: null });
    await persistOnboardingState(telegramId, state, { touchKids: true });
    if (state.editReturn === "profile" && deps.finishProfileEdit) {
      sessionStore.clearOnboarding(telegramId);
      await deps.finishProfileEdit(ctx);
      return;
    }
    await afterKidsBlock(ctx, telegramId);
  });

  bot.action("onb:kid:back:list", async (ctx) => {
    const telegramId = ctx.from.id;
    await ctx.answerCbQuery();
    const state = sessionStore.getOnboarding(telegramId);
    if (state?.kidsDraft) {
      commitKidsDraft(state);
      sessionStore.updateOnboarding(telegramId, { kids: state.kids, kidsDraft: null });
    }
    await goToKidsManage(ctx, telegramId);
  });

  bot.action("onb:kid:back:hub", async (ctx) => {
    const telegramId = ctx.from.id;
    await ctx.answerCbQuery();
    await goTo(ctx, telegramId, "kids_edit");
  });

  bot.action("onb:kid:field:birth", async (ctx) => {
    const telegramId = ctx.from.id;
    await ctx.answerCbQuery();
    const state = await deps.ensureOnboardingState(ctx, "kids_edit");
    const d = ensureKidsDraft(state);
    d.awaitingBirthDate = true;
    sessionStore.updateOnboarding(telegramId, { kidsDraft: d, step: "kids_birthdate" });
    await renderOnboardingStep(ctx, sessionStore.getOnboarding(telegramId));
  });

  bot.action("onb:kid:field:gender", async (ctx) => {
    const telegramId = ctx.from.id;
    await ctx.answerCbQuery();
    await goTo(ctx, telegramId, "kids_gender");
  });

  bot.action("onb:kid:field:stages", async (ctx) => {
    const telegramId = ctx.from.id;
    await ctx.answerCbQuery();
    await goTo(ctx, telegramId, "kids_stages");
  });

  bot.action("onb:kid:field:name", async (ctx) => {
    const telegramId = ctx.from.id;
    await ctx.answerCbQuery();
    await goTo(ctx, telegramId, "kids_name");
  });

  bot.action(/^onb:kid:del:(\d+)$/, async (ctx) => {
    const telegramId = ctx.from.id;
    const index = Number(ctx.match[1]);
    await ctx.answerCbQuery();
    const state = sessionStore.getOnboarding(telegramId);
    if (!state?.kids?.length || index < 0 || index >= state.kids.length) return;
    state.kids.splice(index, 1);
    sessionStore.updateOnboarding(telegramId, { kids: state.kids, kidsDraft: null });
    await goToKidsManage(ctx, telegramId);
  });

  bot.action("onb:back:kids", async (ctx) => {
    const telegramId = ctx.from.id;
    await ctx.answerCbQuery();
    const state = sessionStore.getOnboarding(telegramId);
    if (!state) return;
    if (state.kidsDraft?.editIndex != null) {
      await goTo(ctx, telegramId, "kids_edit");
      return;
    }
    if (kidsManageAfterAdd(state)) {
      await goToKidsManage(ctx, telegramId);
      return;
    }
    let prev = "kids";
    if (state.step === "kids_name") prev = "kids_gender";
    else if (state.step === "kids_gender") {
      prev = state.kidsDraft?.band === "0-3" ? "kids_stages" : "kids_birthdate";
    } else if (state.step === "kids_stages" || state.step === "kids_birthdate") {
      prev = state.step === "kids_stages" ? "kids_birthdate" : "kids";
    }
    sessionStore.updateOnboarding(telegramId, { step: prev, kidsDraft: null });
    await renderOnboardingStep(ctx, sessionStore.getOnboarding(telegramId));
  });

  bot.action("onb:back:audiences", async (ctx) => {
    const telegramId = ctx.from.id;
    await ctx.answerCbQuery();
    sessionStore.updateOnboarding(telegramId, { step: "audiences" });
    await renderOnboardingStep(ctx, sessionStore.getOnboarding(telegramId));
  });
}

async function handleOnboardingKidsText(ctx, message, sessionStore, { renderOnboardingStep }) {
  const telegramId = ctx.from.id;
  const state = sessionStore.getOnboarding(telegramId);
  if (!state) return false;

  const text = String(message || "").trim();

  if (state.step === "kids_birthdate" && state.kidsDraft?.awaitingBirthDate) {
    const birth_date = parseBirthDateInput(text);
    if (!birth_date || !validateBirthDate(birth_date)) {
      await ctx.reply(
        "לא הצלחתי לפרש תאריך תקין (עתידי או ישן מדי?). נסי שוב, למשל: 15.3.2024",
      );
      return true;
    }
    const d = ensureKidsDraft(state);
    d.birth_date = birth_date;
    d.awaitingBirthDate = false;
    const months = kidAgeMonths({ birth_date });
    if (months != null) d.band = months < 36 ? "0-3" : "3+";
    if (d.editIndex != null) {
      sessionStore.updateOnboarding(telegramId, { kidsDraft: d, step: "kids_edit" });
      await renderOnboardingStep(ctx, sessionStore.getOnboarding(telegramId));
      return true;
    }
    if (d.band === "0-3") {
      d.stages = d.stages || [];
      sessionStore.updateOnboarding(telegramId, { kidsDraft: d, step: "kids_stages" });
      await renderOnboardingStep(ctx, sessionStore.getOnboarding(telegramId));
    } else {
      sessionStore.updateOnboarding(telegramId, { kidsDraft: d, step: "kids_gender" });
      await renderOnboardingStep(ctx, sessionStore.getOnboarding(telegramId));
    }
    return true;
  }

  if (state.step === "kids_name") {
    if (!text || text.length < 2) {
      await ctx.reply("נא להקליד שם (לפחות 2 תווים).");
      return true;
    }
    state.kidsDraft.name = text.slice(0, 40);
    if (state.kidsDraft.editIndex != null) {
      sessionStore.updateOnboarding(telegramId, {
        kidsDraft: state.kidsDraft,
        step: "kids_edit",
      });
      await renderOnboardingStep(ctx, sessionStore.getOnboarding(telegramId));
      return true;
    }
    if (!commitKidsDraft(state)) {
      await ctx.reply("⚠️ חסר תאריך לידה או שם");
      return true;
    }
    const nextStep = kidsManageAfterAdd(state) ? "kids_manage" : "kids_more";
    sessionStore.updateOnboarding(telegramId, {
      kids: state.kids,
      kidsDraft: null,
      step: nextStep,
    });
    await renderOnboardingStep(ctx, sessionStore.getOnboarding(telegramId));
    return true;
  }

  return false;
}

module.exports = {
  buildOnboardingKidsBody,
  buildOnboardingKidsKeyboard,
  registerOnboardingKidsHandlers,
  handleOnboardingKidsText,
};
