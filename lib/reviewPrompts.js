// ⭐ Post-event review prompts. A passed SAVED event is our best "you probably
// attended" signal — so once it's over, DM the user a "how was it?" message
// with a button that opens the review window. Fires once per (user, review_key).
const supabase = require("./supabase");
const { reviewKeyForEvent } = require("./reviewService");
const { getMiniAppReviewUrl } = require("./miniAppUrl");
const { todayISO } = require("./timeContext");

async function sendReviewPrompts(telegram, { limit = 200 } = {}) {
  if (!telegram) return { sent: 0 };
  const today = todayISO();

  // Saved bookmarks whose event already passed.
  const { data: saved, error } = await supabase
    .from("saved_events")
    .select("telegram_id, event_id");
  if (error || !saved?.length) return { sent: 0 };

  const eventIds = [...new Set(saved.map((r) => r.event_id))];
  const { data: events } = await supabase
    .from("events")
    .select("id, name, date, min_months, max_months")
    .in("id", eventIds);
  const evMap = new Map((events || []).map((e) => [e.id, e]));

  // Already-prompted + already-reviewed keys, to never nag.
  const tgIds = [...new Set(saved.map((r) => String(r.telegram_id)))];
  const { data: prompted } = await supabase
    .from("review_prompts").select("telegram_id, review_key").in("telegram_id", tgIds);
  const { data: reviewed } = await supabase
    .from("reviews").select("telegram_id, review_key").in("telegram_id", tgIds);
  const done = new Set([...(prompted || []), ...(reviewed || [])].map((r) => `${r.telegram_id}|${r.review_key}`));

  let sent = 0;
  for (const row of saved) {
    if (sent >= limit) break;
    const ev = evMap.get(row.event_id);
    if (!ev || !ev.date || ev.date >= today) continue; // not passed
    const key = reviewKeyForEvent(ev);
    const dedupe = `${row.telegram_id}|${key}`;
    if (done.has(dedupe)) continue;

    const url = getMiniAppReviewUrl(ev.id);
    if (!url) continue; // no https Mini App URL → can't open review window
    try {
      await telegram.sendMessage(
        row.telegram_id,
        `⭐ איך היה ב"${ev.name}"?\nנשמח לדירוג קצר — זה עוזר להמלצות (וגם להורים אחרים).`,
        { reply_markup: { inline_keyboard: [[{ text: "⭐ לדירוג", web_app: { url } }]] } },
      );
      await supabase.from("review_prompts").upsert(
        { telegram_id: String(row.telegram_id), review_key: key, event_id: ev.id },
        { onConflict: "telegram_id,review_key" },
      );
      done.add(dedupe);
      sent++;
    } catch (err) {
      // Only stop retrying if the user blocked/deactivated the bot (permanent);
      // a transient send error should retry next cycle, not silently lose the
      // prompt (recording it here would mark it "done" forever).
      const code = err?.response?.error_code || err?.code;
      const permanent = code === 403 || /blocked|deactivated|chat not found/i.test(err?.description || err?.message || "");
      if (permanent) {
        await supabase.from("review_prompts").upsert(
          { telegram_id: String(row.telegram_id), review_key: key, event_id: ev.id },
          { onConflict: "telegram_id,review_key" },
        ).catch(() => {});
      } else {
        console.warn(`[ReviewPrompts] transient send fail (tg=${row.telegram_id} ev=${ev.id}): ${err.message} — will retry`);
      }
    }
  }
  if (sent) console.log(`[ReviewPrompts] sent ${sent} review prompt(s)`);
  return { sent };
}

module.exports = { sendReviewPrompts };
