// Evening-before reminder service for ⭐ event interests.
//
// Called from api/check.js once per scrape cycle. Only fires during the
// reminder window (18:00–22:00 Jerusalem time) to avoid sending reminders
// in the middle of the night or early morning. Within the window, each
// interest is processed at most once (reminder_sent_at gate).
//
// Message format:
//   ⭐ מחר — <name>
//   🕐 <time>   📍 <location>   (if available)
//   [🔗 פרטים]  [❌ הסר תזכורת]

const { getPendingReminders, markReminderSent } = require("./interestService");
const { formatHebrewDate, formatTimeRange, rtlLine } = require("./eventFormat");
const { getBookingUrl } = require("./sourceUrls");
const { normalizeImageUrl } = require("./imageUrl");

// Jerusalem timezone offset for "is it 18:00–22:00 here?"
const REMINDER_WINDOW_START_H = 18;
const REMINDER_WINDOW_END_H   = 22;
const JERUSALEM_TZ = "Asia/Jerusalem";

function nowJerusalem() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: JERUSALEM_TZ }),
  );
}

function tomorrowISO() {
  const d = nowJerusalem();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function isInReminderWindow() {
  const h = nowJerusalem().getHours();
  return h >= REMINDER_WINDOW_START_H && h < REMINDER_WINDOW_END_H;
}

/**
 * Send evening-before reminders for all interests where event.date = tomorrow.
 * Safe to call on every scrape cycle — gated by the time window and
 * reminder_sent_at.
 *
 * @param {import('telegraf').Telegram} telegram  Telegraf telegram instance
 */
async function sendPendingReminders(telegram) {
  if (!telegram) return;
  if (!isInReminderWindow()) return;

  const tomorrow = tomorrowISO();
  let pending;
  try {
    pending = await getPendingReminders(tomorrow);
  } catch (err) {
    console.error("[Reminders] getPendingReminders failed:", err.message);
    return;
  }

  if (!pending.length) return;
  console.log(`[Reminders] Sending ${pending.length} reminder(s) for ${tomorrow}`);

  for (const { telegramId, event } of pending) {
    try {
      await sendReminder(telegram, telegramId, event);
      await markReminderSent(telegramId, event.id);
    } catch (err) {
      console.warn(
        `[Reminders] Failed to send to ${telegramId} for event #${event.id}: ${err.message}`,
      );
    }
  }
}

async function sendReminder(telegram, telegramId, event) {
  const lines = [];
  const hebrewDate = formatHebrewDate(event.date);
  lines.push(`⭐ מחר — *${event.name}*`);
  if (hebrewDate) lines.push(`📅 ${hebrewDate}`);
  const timeStr = formatTimeRange(event.start_time, event.end_time);
  if (timeStr) lines.push(`🕐 ${timeStr}`);

  const text = lines.map(rtlLine).join("\n");

  // Build inline buttons
  const buttons = [];
  const bookingUrl = getBookingUrl(event);
  if (bookingUrl) {
    buttons.push([{ text: "🔗 לפרטים ורישום", url: bookingUrl }]);
  }
  buttons.push([
    {
      text: "❌ הסר תזכורת",
      callback_data: `int:rem:${event.id}`,
    },
  ]);

  const photoUrl = normalizeImageUrl(event.image, event);
  const replyMarkup = { inline_keyboard: buttons };

  if (photoUrl) {
    try {
      await telegram.sendPhoto(telegramId, photoUrl, {
        caption: text,
        parse_mode: "Markdown",
        reply_markup: replyMarkup,
      });
      return;
    } catch {
      // Fall through to text-only
    }
  }
  await telegram.sendMessage(telegramId, text, {
    parse_mode: "Markdown",
    reply_markup: replyMarkup,
  });
}

module.exports = { sendPendingReminders };
