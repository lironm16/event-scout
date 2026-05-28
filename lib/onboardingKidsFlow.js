// Onboarding steps: kids (positive) + communities — mirrors feedback wizard.

const { Markup } = require("telegraf");
const {
  decodeAge,
  stageLabels,
  buildAge03Keyboard,
  buildStagesKeyboard,
  buildKidsBandKeyboard,
  buildCommunityKeyboard,
  COMMUNITY_CHIPS,
} = require("./kidsWizardUi");
const { communitiesFromPickerSelection } = require("../bot/profileService");
const { memberKeysForCommunityPicker } = require("./communityAccess");

function ensureKidsDraft(state) {
  if (!state.kidsDraft) state.kidsDraft = { stages: [] };
  return state.kidsDraft;
}

function pushKidToState(state) {
  const d = state.kidsDraft;
  if (!d?.name || d.age == null) return false;
  if (!Array.isArray(state.kids)) state.kids = [];
  state.kids.push({
    name: d.name,
    age: d.age,
    stages: stageLabels(d.stages),
  });
  state.kidsDraft = null;
  return true;
}

function buildOnboardingKidsBody(state, gender) {
  const mark = gender === "female" ? "סמני" : gender === "male" ? "סמן" : "אפשר לסמן";
  const step = state.step;

  if (step === "kids") {
    return (
      "👧 *הילדים שלך*\n\n" +
      "כדי להציע אירועים שמתאימים לגיל — ספרי לי מי בבית:\n" +
      "• תינוק/ת (0–3) — גיל ושלבי התפתחות\n" +
      "• ילד/ה (3–18) — גיל ושם\n" +
      "• אפשר כמה ילדים"
    );
  }
  if (step === "kids_age03") {
    return "👶 *גיל התינוק/ת*\n\nבחרי גיל (בשנים, כולל חצאים — 0.5, 1.5…):";
  }
  if (step === "kids_stages") {
    return `🧩 *שלבי התפתחות*\n\n${mark} את כל המתאימים:`;
  }
  if (step === "kids_name") {
    return "✏️ *שם הילד/ה*\n\nכתבי שם בהודעה הבאה (למשל: תומר):";
  }
  if (step === "kids_age3p") {
    return "🧒 *גיל הילד/ה*\n\nכתבי מספר שלם בין 3 ל-18, ואחר כך את השם:";
  }
  if (step === "kids_more") {
    const last = state.kids?.[state.kids.length - 1];
    const who = last ? `${last.name} (${last.age})` : "";
    return `✅ שמרתי${who ? ` את ${who}` : ""}.\n\nיש עוד ילד/ה?`;
  }
  if (step === "communities") {
    return (
      "🏳️ *קהילות*\n\n" +
      `${mark} את הקהילות שאת/ה *רשום/ה* אליהן (✅). ` +
      "אפשר להוסיף או להסיר סימון — נשמר רק מה שמסומן."
    );
  }
  return "";
}

function buildOnboardingKidsKeyboard(state) {
  const step = state.step;
  if (step === "kids") {
    const afterMore = (state.kids || []).length > 0;
    return { inline_keyboard: buildKidsBandKeyboard("onb", null, { positive: true, afterMore }) };
  }
  if (step === "kids_age03") {
    return { inline_keyboard: buildAge03Keyboard("onb", null) };
  }
  if (step === "kids_stages") {
    return {
      inline_keyboard: buildStagesKeyboard("onb", null, state.kidsDraft?.stages || []),
    };
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
  if (step === "kids_name" || step === "kids_age3p") {
    return {
      inline_keyboard: [[Markup.button.callback("← חזרה", "onb:back:kids")]],
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

  async function afterKidsBlock(ctx, telegramId) {
    const state = sessionStore.getOnboarding(telegramId);
    await persistOnboardingState(telegramId, state, { touchKids: true });
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

  bot.action("onb:kids:03", async (ctx) => {
    const telegramId = ctx.from.id;
    await ctx.answerCbQuery();
    const state = await deps.ensureOnboardingState(ctx, "kids");
    ensureKidsDraft(state);
    state.kidsDraft.band = "0-3";
    sessionStore.updateOnboarding(telegramId, { kidsDraft: state.kidsDraft });
    await goTo(ctx, telegramId, "kids_age03");
  });

  bot.action("onb:kids:3p", async (ctx) => {
    const telegramId = ctx.from.id;
    await ctx.answerCbQuery();
    const state = await deps.ensureOnboardingState(ctx, "kids");
    ensureKidsDraft(state);
    state.kidsDraft.band = "3+";
    state.kidsDraft.awaitingAge = true;
    sessionStore.updateOnboarding(telegramId, { kidsDraft: state.kidsDraft, step: "kids_age3p" });
    await renderOnboardingStep(ctx, sessionStore.getOnboarding(telegramId));
  });

  bot.action(/^onb:ka:(\d+)$/, async (ctx) => {
    const telegramId = ctx.from.id;
    const age = decodeAge(ctx.match[1]);
    const state = await deps.ensureOnboardingState(ctx, "kids_age03");
    if (age == null) return;
    await ctx.answerCbQuery();
    const d = ensureKidsDraft(state);
    d.age = age;
    d.stages = [];
    sessionStore.updateOnboarding(telegramId, { kidsDraft: d });
    await goTo(ctx, telegramId, "kids_stages");
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
    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: buildStagesKeyboard("onb", null, d.stages),
      });
    } catch {
      /* ok */
    }
  });

  bot.action("onb:stgn", async (ctx) => {
    const telegramId = ctx.from.id;
    await ctx.answerCbQuery();
    await goTo(ctx, telegramId, "kids_name");
  });

  bot.action(/^onb:kmore:(y|n)$/, async (ctx) => {
    const telegramId = ctx.from.id;
    const yn = ctx.match[1];
    await ctx.answerCbQuery();
    if (yn === "n") {
      await afterKidsBlock(ctx, telegramId);
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

  bot.action("onb:back:kids", async (ctx) => {
    const telegramId = ctx.from.id;
    await ctx.answerCbQuery();
    const state = await deps.ensureOnboardingState(ctx, "kids_age03");
    const prev =
      state.step === "kids_name" || state.step === "kids_stages"
        ? "kids_age03"
        : state.step === "kids_age3p"
          ? "kids"
          : "kids";
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

async function handleOnboardingKidsText(ctx, message, sessionStore, { renderOnboardingStep, persistOnboardingState }) {
  const telegramId = ctx.from.id;
  const state = sessionStore.getOnboarding(telegramId);
  if (!state) return false;

  const text = String(message || "").trim();

  if (state.step === "kids_age3p" && state.kidsDraft?.awaitingAge) {
    const age = parseInt(text.replace(",", "."), 10);
    if (!Number.isFinite(age) || age < 3 || age > 18) {
      await ctx.reply("נא להקליד מספר שלם בין 3 ל-18.");
      return true;
    }
    state.kidsDraft.age = age;
    state.kidsDraft.awaitingAge = false;
    state.kidsDraft.awaitingName = true;
    sessionStore.updateOnboarding(telegramId, { kidsDraft: state.kidsDraft });
    await ctx.reply("מה שם הילד/ה?");
    return true;
  }

  if (
    (state.step === "kids_age3p" && state.kidsDraft?.awaitingName) ||
    state.step === "kids_name"
  ) {
    if (!text || text.length < 2) {
      await ctx.reply("נא להקליד שם (לפחות 2 תווים).");
      return true;
    }
    state.kidsDraft.name = text.slice(0, 40);
    if (!pushKidToState(state)) {
      await ctx.reply("⚠️ חסר מידע");
      return true;
    }
    sessionStore.updateOnboarding(telegramId, {
      kids: state.kids,
      kidsDraft: null,
      step: "kids_more",
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
