// "❌ לא מתאים" multi-step flow — DB only (no Gemini on free-text).
//
// Every path ends with event_feedback (hides this event_id for the user).
// Profile-wide learning is optional per branch (audiences, location, hours, tags).

const { Markup } = require("telegraf");
const {
  recordFeedback,
  REASON_LABELS,
  ACK_LABELS,
} = require("./feedbackService");
const { LOCATION_OPTIONS } = require("./audienceTargets");
const labelStore = require("./labelStore");
const { updatePreferences } = require("../bot/profileService");
const { registerAudienceWizardHandlers, createKidWizardTextHandler } = require("./feedbackAudienceWizard");
const { appendKidToProfile } = require("./childEventPrefs");

const DAY_NAMES = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

function buildLabelPickerRows(tagEntries, selectedIdx, eventId) {
  const selected = new Set(selectedIdx);
  const rows = [];
  for (let i = 0; i < tagEntries.length; i += 2) {
    const row = tagEntries.slice(i, i + 2).map((entry, j) => {
      const idx = i + j;
      const on = selected.has(idx);
      const label = entry.name.length > 28 ? `${entry.name.slice(0, 26)}…` : entry.name;
      return Markup.button.callback(
        `${on ? "✅ " : ""}${label}`,
        `fb:nitog:${eventId}:${idx}`,
      );
    });
    rows.push(row);
  }
  rows.push([
    Markup.button.callback("✔️ שמירה", `fb:nidone:${eventId}`),
    Markup.button.callback("↩️ ביטול", `fb:cancel:${eventId}`),
  ]);
  return rows;
}

let kidWizardTextHandler = null;

function registerFeedbackHandlers(bot, deps) {
  const {
    supabase,
    sessionStore,
    getProfile,
    rememberKnownSeries,
    recordTooFarSignal,
    recordNotInterestedSignal,
    alertAdmin,
    replyAsCallbackResult,
  } = deps;

  async function hideEvent(telegramId, eventId, reason, note = null) {
    return recordFeedback({ eventId, telegramId, reason, note });
  }

  async function finishWithAck(ctx, eventId, reason, ackText) {
    await ctx.answerCbQuery(ackText || ACK_LABELS[reason] || "✅ תודה");
    try {
      await ctx.editMessageText(ackText || ACK_LABELS[reason] || "✅ תודה");
    } catch {
      /* toast only */
    }
    await ctx.reply("💡 תמיד אפשר לשנות — פשוט כתבו לי!").catch(() => {});
  }

  // ── Main menu ─────────────────────────────────────────────────────
  bot.action(/^fb:reasons:(\d+)$/, async (ctx) => {
    const eventId = ctx.match[1];
    await ctx.answerCbQuery().catch(() => {});
    console.log(`[Feedback] reasons event=${eventId} user=${ctx.from?.id}`);
    const rows = [
      [Markup.button.callback("👥 קהל יעד", `fb:aud:${eventId}`)],
      [Markup.button.callback("🏳️ קהילות שלי", `fb:aud:cm:${eventId}`)],
      [Markup.button.callback("🔁 זה אירוע חוזר — אין צורך להציג לי", `fb:series:${eventId}`)],
      [Markup.button.callback("📍 רחוק / לא נוח להגיע", `fb:far:${eventId}`)],
      [Markup.button.callback("🕒 לא בזמן שמתאים לי", `fb:time:${eventId}`)],
      [Markup.button.callback("🎯 הנושא לא מעניין אותי", `fb:ni:${eventId}`)],
      [Markup.button.callback("✏️ אחר…", `fb:other:${eventId}`)],
      [Markup.button.callback("↩️ חזרה", `fb:cancel:${eventId}`)],
    ];
    await replyAsCallbackResult(
      ctx,
      "למה לא מתאים?",
      Markup.inlineKeyboard(rows),
    );
  });

  bot.action(/^fb:cancel:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("👍").catch(() => {});
    await ctx.deleteMessage().catch(() => {});
  });

  // ── אחר → free text → DB only ───────────────────────────────────
  bot.action(/^fb:other:(\d+)$/, async (ctx) => {
    const eventId = ctx.match[1];
    await ctx.answerCbQuery().catch(() => {});
    const { data: ev } = await supabase
      .from("events")
      .select("name")
      .eq("id", parseInt(eventId, 10))
      .maybeSingle();
    const session = sessionStore.ensureSession(ctx.from.id);
    session.pendingFeedbackOther = {
      eventId,
      eventName: ev?.name || `#${eventId}`,
    };
    await ctx.reply("מה לא התאים? (טקסט חופשי — נשמר אצלנו, בלי סוכן)");
  });

  registerAudienceWizardHandlers(bot, {
    supabase,
    sessionStore,
    getProfile,
    hideEvent,
    finishWithAck,
    replyAsCallbackResult,
  });
  kidWizardTextHandler = createKidWizardTextHandler({
    sessionStore,
    hideEvent,
    appendKidToProfile,
  });

  // ── סדרה חוזרת ───────────────────────────────────────────────────
  bot.action(/^fb:series:(\d+)$/, async (ctx) => {
    const eventId = ctx.match[1];
    try {
      await hideEvent(ctx.from.id, eventId, "already_known");
      await rememberKnownSeries(ctx.from.id, eventId);
      await finishWithAck(ctx, eventId, "already_known", ACK_LABELS.already_known);
    } catch (err) {
      console.error("[Feedback] series:", err.message);
      await ctx.answerCbQuery("⚠️ לא הצלחתי לשמור");
    }
  });

  // ── רחוק ──────────────────────────────────────────────────────────
  bot.action(/^fb:far:(\d+)$/, async (ctx) => {
    const eventId = ctx.match[1];
    await ctx.answerCbQuery().catch(() => {});
    await replyAsCallbackResult(
      ctx,
      "מה הכי מתאים?",
      Markup.inlineKeyboard([
        [Markup.button.callback("📌 רק האירוע הזה", `fb:faronly:${eventId}`)],
        [Markup.button.callback("📍 לא אגיע לשם שוב", `fb:farvenue:${eventId}`)],
        [Markup.button.callback("🚶 עדכון מרחק הליכה", `fb:farloc:walk:${eventId}`)],
        [Markup.button.callback("🚗 עדכון — נסיעה קצרה", `fb:farloc:drive:${eventId}`)],
        [Markup.button.callback("🌍 כל מיקום בסדר", `fb:farloc:any:${eventId}`)],
        [Markup.button.callback("↩️ חזרה", `fb:reasons:${eventId}`)],
      ]),
    );
  });

  bot.action(/^fb:faronly:(\d+)$/, async (ctx) => {
    const eventId = ctx.match[1];
    try {
      await hideEvent(ctx.from.id, eventId, "too_far");
      await finishWithAck(ctx, eventId, "too_far", "✅ האירוע הוסתר");
    } catch (err) {
      await ctx.answerCbQuery("⚠️");
    }
  });

  bot.action(/^fb:farvenue:(\d+)$/, async (ctx) => {
    const eventId = ctx.match[1];
    try {
      await hideEvent(ctx.from.id, eventId, "too_far");
      await recordTooFarSignal(ctx.from.id, eventId);
      await finishWithAck(ctx, eventId, "too_far", ACK_LABELS.too_far);
    } catch (err) {
      await ctx.answerCbQuery("⚠️");
    }
  });

  bot.action(/^fb:farloc:(walk|drive|any):(\d+)$/, async (ctx) => {
    const [, locId, eventId] = ctx.match;
    const opt = LOCATION_OPTIONS.find((o) => o.id === locId);
    if (!opt) {
      await ctx.answerCbQuery("⚠️");
      return;
    }
    try {
      const profile = await getProfile(ctx.from.id);
      const ctxData = profile?.user_context || {};
      const constraints = { ...(ctxData.constraints || {}) };
      constraints.max_walking_minutes = opt.max_walking_minutes;
      constraints.proximity_preference = opt.preference;
      await supabase
        .from("profiles")
        .update({ user_context: { ...ctxData, constraints } })
        .eq("telegram_id", String(ctx.from.id));
      await hideEvent(ctx.from.id, eventId, "too_far");
      await finishWithAck(
        ctx,
        eventId,
        "too_far",
        `✅ עדכנתי מיקום (${opt.label}) — האירוע הוסתר`,
      );
    } catch (err) {
      console.error("[Feedback] farloc:", err.message);
      await ctx.answerCbQuery("⚠️");
    }
  });

  // ── זמן ───────────────────────────────────────────────────────────
  bot.action(/^fb:time:(\d+)$/, async (ctx) => {
    const eventId = ctx.match[1];
    await ctx.answerCbQuery().catch(() => {});
    await replyAsCallbackResult(
      ctx,
      "מתי בדרך כלל פנוי/ה?",
      Markup.inlineKeyboard([
        [Markup.button.callback("📌 רק האירוע הזה", `fb:timeonly:${eventId}`)],
        [Markup.button.callback("🌅 בוקר (08–12)", `fb:timesave:${eventId}:morning`)],
        [Markup.button.callback("🌆 ערב (17–22)", `fb:timesave:${eventId}:evening`)],
        [Markup.button.callback("📅 סופ״ש בלבד", `fb:timesave:${eventId}:weekend`)],
        [Markup.button.callback("📆 לפי ימים…", `fb:timedays:${eventId}`)],
        [Markup.button.callback("↩️ חזרה", `fb:reasons:${eventId}`)],
      ]),
    );
  });

  bot.action(/^fb:timeonly:(\d+)$/, async (ctx) => {
    const eventId = ctx.match[1];
    try {
      await hideEvent(ctx.from.id, eventId, "wrong_time");
      await finishWithAck(ctx, eventId, "wrong_time", "✅ האירוע הוסתר");
    } catch (err) {
      await ctx.answerCbQuery("⚠️");
    }
  });

  const TIME_PRESETS = {
    morning: { label: "בוקר", blocks: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "12:00" }] },
    evening: { label: "ערב", blocks: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "17:00", end: "22:00" }] },
    weekend: {
      label: "סופ״ש",
      blocks: [{ days: [5, 6], start: "09:00", end: "22:00" }],
    },
  };

  bot.action(/^fb:timesave:(\d+):(morning|evening|weekend)$/, async (ctx) => {
    const [, eventId, preset] = ctx.match;
    const p = TIME_PRESETS[preset];
    try {
      const profile = await getProfile(ctx.from.id);
      const u = profile?.user_context || {};
      const constraints = { ...(u.constraints || {}), availability: { preset, blocks: p.blocks } };
      await supabase
        .from("profiles")
        .update({ user_context: { ...u, constraints } })
        .eq("telegram_id", String(ctx.from.id));
      await hideEvent(ctx.from.id, eventId, "wrong_time");
      await finishWithAck(ctx, eventId, "wrong_time", `✅ שמרתי — ${p.label} — האירוע הוסתר`);
    } catch (err) {
      await ctx.answerCbQuery("⚠️");
    }
  });

  bot.action(/^fb:timedays:(\d+)$/, async (ctx) => {
    const eventId = ctx.match[1];
    await ctx.answerCbQuery().catch(() => {});
    const session = sessionStore.ensureSession(ctx.from.id);
    session.pendingFeedbackTimeDays = { eventId, days: new Set([0, 1, 2, 3, 4]), slot: "evening" };
    const rows = DAY_NAMES.map((name, i) => [
      Markup.button.callback(
        `${session.pendingFeedbackTimeDays.days.has(i) ? "✅ " : ""}${name}`,
        `fb:timeday:${eventId}:${i}`,
      ),
    ]);
    rows.push([
      Markup.button.callback("🌅 בוקר", `fb:timeslot:${eventId}:morning`),
      Markup.button.callback("🌆 ערב", `fb:timeslot:${eventId}:evening`),
    ]);
    rows.push([Markup.button.callback("✔️ שמירה", `fb:timedaydone:${eventId}`)]);
    await replyAsCallbackResult(ctx, "בחרי ימים + משבצת:", Markup.inlineKeyboard(rows));
  });

  bot.action(/^fb:timeday:(\d+):(\d)$/, async (ctx) => {
    const [, eventId, dayIdx] = ctx.match;
    const session = sessionStore.ensureSession(ctx.from.id);
    const st = session.pendingFeedbackTimeDays;
    if (!st || String(st.eventId) !== eventId) return;
    await ctx.answerCbQuery().catch(() => {});
    const d = parseInt(dayIdx, 10);
    if (st.days.has(d)) st.days.delete(d);
    else st.days.add(d);
    const rows = DAY_NAMES.map((name, i) => [
      Markup.button.callback(
        `${st.days.has(i) ? "✅ " : ""}${name}`,
        `fb:timeday:${eventId}:${i}`,
      ),
    ]);
    rows.push([
      Markup.button.callback(`${st.slot === "morning" ? "✅ " : ""}🌅 בוקר`, `fb:timeslot:${eventId}:morning`),
      Markup.button.callback(`${st.slot === "evening" ? "✅ " : ""}🌆 ערב`, `fb:timeslot:${eventId}:evening`),
    ]);
    rows.push([Markup.button.callback("✔️ שמירה", `fb:timedaydone:${eventId}`)]);
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: rows });
    } catch {
      /* ok */
    }
  });

  bot.action(/^fb:timeslot:(\d+):(morning|evening)$/, async (ctx) => {
    const [, eventId, slot] = ctx.match;
    const session = sessionStore.ensureSession(ctx.from.id);
    const st = session.pendingFeedbackTimeDays;
    if (!st || String(st.eventId) !== eventId) return;
    st.slot = slot;
    await ctx.answerCbQuery().catch(() => {});
  });

  bot.action(/^fb:timedaydone:(\d+)$/, async (ctx) => {
    const eventId = ctx.match[1];
    const session = sessionStore.ensureSession(ctx.from.id);
    const st = session.pendingFeedbackTimeDays;
    if (!st || String(st.eventId) !== eventId) {
      await ctx.answerCbQuery("⚠️");
      return;
    }
    delete session.pendingFeedbackTimeDays;
    const preset = st.slot === "morning" ? "morning" : "evening";
    const block = TIME_PRESETS[preset].blocks[0];
    const days = [...st.days].sort((a, b) => a - b);
    try {
      const profile = await getProfile(ctx.from.id);
      const u = profile?.user_context || {};
      const constraints = {
        ...(u.constraints || {}),
        availability: { preset: "custom_days", blocks: [{ days, start: block.start, end: block.end }] },
      };
      await supabase
        .from("profiles")
        .update({ user_context: { ...u, constraints } })
        .eq("telegram_id", String(ctx.from.id));
      await hideEvent(ctx.from.id, eventId, "wrong_time");
      await finishWithAck(ctx, eventId, "wrong_time", "✅ שמרתי זמינות — האירוע הוסתר");
    } catch (err) {
      await ctx.answerCbQuery("⚠️");
    }
  });

  // ── לא מעניין ─────────────────────────────────────────────────────
  bot.action(/^fb:ni:(\d+)$/, async (ctx) => {
    const eventId = ctx.match[1];
    await ctx.answerCbQuery().catch(() => {});
    await replyAsCallbackResult(
      ctx,
      "מה לא מעניין?",
      Markup.inlineKeyboard([
        [Markup.button.callback("📌 רק האירוע הזה", `fb:nionly:${eventId}`)],
        [Markup.button.callback("🏷️ תחומים/תגיות מהאירוע", `fb:nilabels:${eventId}`)],
        [Markup.button.callback("↩️ חזרה", `fb:reasons:${eventId}`)],
      ]),
    );
  });

  bot.action(/^fb:nionly:(\d+)$/, async (ctx) => {
    const eventId = ctx.match[1];
    try {
      await hideEvent(ctx.from.id, eventId, "not_interested");
      await finishWithAck(ctx, eventId, "not_interested", "✅ האירוע הוסתר");
    } catch (err) {
      await ctx.answerCbQuery("⚠️");
    }
  });

  bot.action(/^fb:nilabels:(\d+)$/, async (ctx) => {
    const eventId = ctx.match[1];
    await ctx.answerCbQuery().catch(() => {});
    const grouped = await labelStore.getLabelsForEvent(parseInt(eventId, 10)).catch(() => null);
    const tagNames = grouped?.tags || [];
    if (!tagNames.length) {
      await ctx.reply("לא מצאתי תגיות — מסתירה רק את האירוע הזה.");
      await hideEvent(ctx.from.id, eventId, "not_interested");
      return;
    }
    const { data: ev } = await supabase
      .from("events")
      .select("tag_ids")
      .eq("id", parseInt(eventId, 10))
      .maybeSingle();
    const ids = ev?.tag_ids || [];
    const { data: dictRows } = await supabase.from("labels").select("id, name").in("id", ids);
    const tagEntries = (dictRows || []).map((r) => ({ id: r.id, name: r.name }));
    const session = sessionStore.ensureSession(ctx.from.id);
    session.pendingFeedbackLabels = { eventId, tagEntries, selected: [] };
    await replyAsCallbackResult(
      ctx,
      "אילו תגיות לא מתאימות לך?",
      Markup.inlineKeyboard(buildLabelPickerRows(tagEntries, [], eventId)),
    );
  });

  bot.action(/^fb:nitog:(\d+):(\d+)$/, async (ctx) => {
    const [, eventId, idxStr] = ctx.match;
    const idx = parseInt(idxStr, 10);
    const session = sessionStore.ensureSession(ctx.from.id);
    const st = session.pendingFeedbackLabels;
    if (!st || String(st.eventId) !== eventId) return;
    await ctx.answerCbQuery().catch(() => {});
    const set = new Set(st.selected);
    if (set.has(idx)) set.delete(idx);
    else set.add(idx);
    st.selected = [...set];
    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: buildLabelPickerRows(st.tagEntries, st.selected, eventId),
      });
    } catch {
      /* ok */
    }
  });

  bot.action(/^fb:nidone:(\d+)$/, async (ctx) => {
    const eventId = ctx.match[1];
    const session = sessionStore.ensureSession(ctx.from.id);
    const st = session.pendingFeedbackLabels;
    if (!st || String(st.eventId) !== eventId) {
      await ctx.answerCbQuery("⚠️");
      return;
    }
    delete session.pendingFeedbackLabels;
    try {
      const adjustments = [];
      for (const i of st.selected) {
        const entry = st.tagEntries[i];
        if (entry?.id) {
          adjustments.push({ kind: "tag", key: String(entry.id), preset: "suppress" });
        }
      }
      if (adjustments.length) {
        await updatePreferences(ctx.from.id, adjustments);
      }
      await hideEvent(ctx.from.id, eventId, "not_interested");
      if (!adjustments.length) {
        await recordNotInterestedSignal(ctx.from.id, eventId).catch(() => {});
      }
      await finishWithAck(
        ctx,
        eventId,
        "not_interested",
        adjustments.length
          ? "✅ עדכנתי תגיות — האירוע הוסתר"
          : "✅ האירוע הוסתר",
      );
    } catch (err) {
      console.error("[Feedback] nidone:", err.message);
      await ctx.answerCbQuery("⚠️");
    }
  });
}

/** Handle pendingFeedbackOther text — call from bot text handler. */
async function handlePendingFeedbackText(ctx, message, sessionStore) {
  const session = sessionStore.getSession(ctx.from.id) || sessionStore.ensureSession(ctx.from.id);
  const pending = session.pendingFeedbackOther;
  if (!pending) return false;
  delete session.pendingFeedbackOther;
  const note = String(message || "").trim().slice(0, 500);
  if (!note) {
    await ctx.reply("לא קיבלתי טקסט — נסי שוב או בחרי מהתפריט.");
    return true;
  }
  try {
    await recordFeedback({
      eventId: pending.eventId,
      telegramId: ctx.from.id,
      reason: "other",
      note,
    });
    await ctx.reply("✅ תודה — נשמר. האירוע לא יוצג שוב.");
  } catch (err) {
    console.error("[Feedback] other text:", err.message);
    await ctx.reply("⚠️ לא הצלחתי לשמור");
  }
  return true;
}

async function handlePendingFeedbackKidWizardText(ctx, message, sessionStore) {
  if (!kidWizardTextHandler) return false;
  return kidWizardTextHandler(ctx, message);
}

module.exports = {
  registerFeedbackHandlers,
  handlePendingFeedbackText,
  handlePendingFeedbackKidWizardText,
  REASON_LABELS,
};
