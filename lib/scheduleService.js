const { DateTime } = require("luxon");
const axios = require("axios");
const supabase = require("./supabase");
const { normalizeImageUrl } = require("./imageUrl");

const TZ = "Asia/Jerusalem";
const QUIET_START = 22;
const QUIET_END = 8;

let _shabbatCache = { key: null, data: null };

function nowIL() {
  return DateTime.now().setZone(TZ);
}

function isQuietHour(dt = nowIL()) {
  const h = dt.hour;
  return h >= QUIET_START || h < QUIET_END;
}

function nextActiveWindow(dt = nowIL()) {
  if (!isQuietHour(dt)) return dt;
  let next = dt.set({ hour: QUIET_END, minute: 0, second: 0, millisecond: 0 });
  if (next <= dt) next = next.plus({ days: 1 });
  return next;
}

async function fetchShabbatTimes(dt = nowIL()) {
  const cacheKey = dt.toISODate();
  if (_shabbatCache.key === cacheKey && _shabbatCache.data) {
    return _shabbatCache.data;
  }

  try {
    const { data } = await axios.get("https://www.hebcal.com/shabbat", {
      params: {
        cfg: "json",
        geonameid: 293397,
        M: "on",
      },
    });

    const items = data.items || [];
    const candles = items.find((i) => i.category === "candles");
    const havdalah = items.find((i) => i.category === "havdalah");

    const result = {
      candleLighting: candles?.date
        ? DateTime.fromISO(candles.date, { zone: TZ })
        : null,
      havdalah: havdalah?.date
        ? DateTime.fromISO(havdalah.date, { zone: TZ })
        : null,
    };

    _shabbatCache = { key: cacheKey, data: result };
    return result;
  } catch (err) {
    console.error("[Schedule] Hebcal API error:", err.message);
    return { candleLighting: null, havdalah: null };
  }
}

async function isShabbatOrHolidayNow(dt = nowIL()) {
  const times = await fetchShabbatTimes(dt);

  if (times.candleLighting && times.havdalah) {
    return dt >= times.candleLighting && dt < times.havdalah;
  }

  const friday = dt.weekday === 5;
  const saturday = dt.weekday === 6;
  if (friday && dt.hour >= 16) return true;
  if (saturday && dt.hour < 20) return true;

  return false;
}

async function getHavdalahTime(dt = nowIL()) {
  const times = await fetchShabbatTimes(dt);

  if (times.havdalah) {
    return times.havdalah.plus({ hours: 1 });
  }

  const saturday =
    dt.weekday === 6 ? dt : dt.plus({ days: (6 - dt.weekday + 7) % 7 });
  return saturday.set({ hour: 20, minute: 30 });
}

async function getSendAfter(isShabbatObservant) {
  const dt = nowIL();

  if (isShabbatObservant && (await isShabbatOrHolidayNow(dt))) {
    return (await getHavdalahTime(dt)).toJSDate();
  }

  if (isQuietHour(dt)) {
    return nextActiveWindow(dt).toJSDate();
  }

  return null;
}

async function queueNotification(telegramId, ticketId, messageText, imageUrl, reason, sendAfter) {
  const { error } = await supabase.from("pending_notifications").insert({
    telegram_id: telegramId,
    ticket_id: ticketId,
    message_text: messageText,
    image_url: imageUrl,
    reason,
    send_after: sendAfter.toISOString(),
  });
  if (error) console.error("[Schedule] Queue insert failed:", error.message);
}

async function getDueNotifications() {
  const { data, error } = await supabase
    .from("pending_notifications")
    .select("*")
    .eq("status", "pending")
    .lte("send_after", new Date().toISOString())
    .order("send_after", { ascending: true });

  if (error) throw new Error(`Pending fetch failed: ${error.message}`);
  return data || [];
}

async function markNotificationSent(id) {
  await supabase
    .from("pending_notifications")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", id);
}

async function flushDueNotifications(telegram) {
  const due = await getDueNotifications();
  if (!due.length) return 0;

  console.log(`[Schedule] Flushing ${due.length} queued notification(s)`);

  const byUser = new Map();
  for (const n of due) {
    if (!byUser.has(n.telegram_id)) byUser.set(n.telegram_id, []);
    byUser.get(n.telegram_id).push(n);
  }

  let sent = 0;
  for (const [telegramId, notifications] of byUser) {
    if (notifications.length === 1) {
      const n = notifications[0];
      try {
        const photoUrl = normalizeImageUrl(n.image_url);
        if (photoUrl) {
          try {
            await telegram.sendPhoto(telegramId, photoUrl, { caption: n.message_text });
          } catch {
            await telegram.sendMessage(telegramId, n.message_text);
          }
        } else {
          await telegram.sendMessage(telegramId, n.message_text);
        }
        await markNotificationSent(n.id);
        sent++;
      } catch (err) {
        console.error(`[Schedule] Send failed for ${telegramId}:`, err.message);
      }
    } else {
      const summary = [`📬 יש לך ${notifications.length} התראות חדשות:\n`];
      for (const n of notifications) {
        summary.push(n.message_text);
        summary.push("---");
      }

      try {
        await telegram.sendMessage(telegramId, summary.join("\n"));
        for (const n of notifications) await markNotificationSent(n.id);
        sent += notifications.length;
      } catch (err) {
        console.error(`[Schedule] Summary send failed for ${telegramId}:`, err.message);
      }
    }
  }

  return sent;
}

module.exports = {
  nowIL,
  isQuietHour,
  isShabbatOrHolidayNow,
  getSendAfter,
  queueNotification,
  getDueNotifications,
  flushDueNotifications,
};
