require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { Telegraf } = require("telegraf");

const { extractFromText, extractFromImage, extractSellerPhone, isSoldMessage } = require("../lib/ticketExtractor");
const {
  insertTicket,
  markSoldByWaMessage,
  getActiveTickets,
  linkTicketToEvent,
  fanOutToWatchers,
} = require("../lib/ticketService");
const supabase = require("../lib/supabase");
const { getActiveProfiles } = require("../bot/matchingService");
const { getSendAfter, queueNotification } = require("../lib/scheduleService");
const { getProfile } = require("../bot/profileService");
const { findMatchesForUser } = require("../bot/matchingService");
const { notifySavedSearchMatchesForTicket } = require("../lib/savedSearchNotifier");

const WATCH_GROUPS = (process.env.WA_WATCH_GROUPS || "").split(",").filter(Boolean);

const telegram = process.env.TELEGRAM_TOKEN
  ? new Telegraf(process.env.TELEGRAM_TOKEN).telegram
  : null;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: ".wwebjs_auth" }),
  puppeteer: { headless: true, args: ["--no-sandbox"] },
});

client.on("qr", (qr) => {
  console.log("[WA Scraper] Scan this QR code:");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("[WA Scraper] WhatsApp client ready");
  console.log(`[WA Scraper] Watching ${WATCH_GROUPS.length} group(s)`);
});

client.on("message", async (message) => {
  try {
    await handleMessage(message);
  } catch (err) {
    console.error("[WA Scraper] Message handler error:", err.message);
  }
});

client.on("message_reaction", async (reaction) => {
  try {
    if (reaction.reaction === "❌") {
      console.log(`[WA Scraper] ❌ reaction on ${reaction.msgId._serialized}`);
      await markSoldByWaMessage(reaction.msgId._serialized);
      console.log("[WA Scraper] Marked as sold via reaction");
    }
  } catch (err) {
    console.error("[WA Scraper] Reaction handler error:", err.message);
  }
});

async function handleMessage(message) {
  const chat = await message.getChat();
  if (!chat.isGroup) return;

  const groupId = chat.id._serialized;

  if (WATCH_GROUPS.length && !WATCH_GROUPS.includes(groupId)) return;

  if (message.hasQuotedMsg) {
    const quoted = await message.getQuotedMessage();
    if (isSoldMessage(message.body)) {
      console.log(`[WA Scraper] Sold reply detected in ${chat.name}`);
      await markSoldByWaMessage(quoted.id._serialized);
      return;
    }
  }

  if (isSoldMessage(message.body) && !message.hasQuotedMsg) return;

  console.log(`\n[WA Scraper] Message in "${chat.name}": ${message.body?.slice(0, 80) || "(media)"}`);

  let extraction;
  let imageUrl = null;

  if (message.hasMedia) {
    const media = await message.downloadMedia();
    if (media && media.mimetype?.startsWith("image/")) {
      const buffer = Buffer.from(media.data, "base64");
      extraction = await extractFromImage(buffer, message.body);
      imageUrl = null;
    } else {
      extraction = await extractFromText(message.body || "");
    }
  } else {
    extraction = await extractFromText(message.body || "");
  }

  if (!extraction.is_ticket_listing) {
    console.log("[WA Scraper] Not a ticket listing — skipping");
    return;
  }

  console.log(`[WA Scraper] Ticket detected: ${extraction.event_title}`);

  const sellerPhone = extractSellerPhone(message);

  // Try to match the ticket to an event in our DB BEFORE inserting.
  // When a match exists, we set event_id so:
  //   (a) The watcher fan-out below has something to JOIN against.
  //   (b) Later recap rows can JOIN events for richer metadata
  //       (location, canonical title) instead of relying solely on
  //       the free-text event_title the seller wrote.
  // If no match → event_id stays null. The ticket still surfaces in
  // the operator recap (operator can decide what to do); we just
  // don't have a watcher list to notify.
  let matchedEventId = null;
  try {
    matchedEventId = await linkTicketToEvent({
      eventTitle: extraction.event_title,
      eventDate: extraction.event_date || null,
    });
  } catch (err) {
    console.warn("[WA Scraper] linkTicketToEvent failed:", err.message);
  }

  const ticket = await insertTicket({
    wa_message_id: message.id._serialized,
    group_id: groupId,
    event_id: matchedEventId,
    source: "whatsapp",
    event_title: extraction.event_title || "Unknown Event",
    event_date: extraction.event_date || null,
    event_time: extraction.event_time || null,
    quantity: extraction.quantity || 1,
    price: extraction.price || null,
    seller_phone: sellerPhone,
    seller_name: message.author ? (await message.getContact()).pushname : null,
    raw_text: message.body,
    status: "active",
  });

  if (matchedEventId) {
    console.log(`[WA Scraper] Saved ticket ${ticket.id} (linked to event ${matchedEventId})`);
  } else {
    console.log(`[WA Scraper] Saved ticket ${ticket.id} (no event match)`);
  }

  // Three-channel notify:
  // 1. Profile-based AI matching (existing behaviour) — surface any
  //    interesting ticket to active users, with proximity/age reasoning.
  // 2. Saved-search matching — anyone tracking this exact topic should
  //    hear about a 2nd-hand ticket too, deterministic, no Gemini call.
  // 3. Event-watcher fan-out (sql/044) — if we linked the ticket to a
  //    known event_id, anyone who clicked "🔔 הודיעי לי על כרטיסים"
  //    (event_watchers row) gets a direct DM. Higher signal than the
  //    AI matcher because the user explicitly asked for THIS event.
  await notifyMatchingUsers(ticket);
  if (telegram) {
    try {
      await notifySavedSearchMatchesForTicket(ticket, telegram);
    } catch (err) {
      console.error("[WA Scraper] Saved-search match error:", err.message);
    }
  }
  if (matchedEventId && telegram) {
    try {
      await notifyEventWatchers(ticket, matchedEventId);
    } catch (err) {
      console.error("[WA Scraper] Event-watcher notify error:", err.message);
    }
  }
}

// Fan out a freshly-linked WhatsApp ticket to anyone watching the
// matched event. Uses the shared fanOutToWatchers helper (which
// stamps notified_at to prevent re-spam on duplicate messages).
//
// The card mirrors the regular WhatsApp ticket card (price, qty,
// 📞 צרי קשר button → existing ct: callback) so the user experience
// is unified — they don't need to know WHICH stream the ticket came
// from. Different from sendUserOfferToWatcher in bot/telegramBot.js
// because WhatsApp tickets have seller_phone, not seller_telegram_id.
async function notifyEventWatchers(ticket, eventId) {
  const watchers = await fanOutToWatchers(eventId);
  if (!watchers.length) return;
  // Pull event metadata so the card title uses our canonical name
  // instead of the seller's free-text version.
  const { data: event } = await supabase
    .from("events")
    .select("name, date, start_time")
    .eq("id", eventId)
    .maybeSingle();
  const displayTitle = event?.name || ticket.event_title;

  for (const w of watchers) {
    const lines = [
      `🎟️ *כרטיס חדש לאירוע שבמעקב שלך*`,
      "",
      displayTitle,
    ];
    if (event?.date) lines.push(`📅 ${event.date}`);
    if (ticket.quantity != null) lines.push(`💺 כמות: ${ticket.quantity}`);
    if (ticket.price) lines.push(`💰 ${ticket.price}`);

    const keyboard = ticket.seller_phone
      ? {
          inline_keyboard: [[
            { text: "📞 צרי קשר", callback_data: `ct:${ticket.id}` },
          ]],
        }
      : undefined;

    try {
      await telegram.sendMessage(w.telegram_id, lines.join("\n"), {
        parse_mode: "Markdown",
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
    } catch (err) {
      console.warn(
        `[WA Scraper] event-watcher DM failed (tg=${w.telegram_id}): ${err.message}`,
      );
    }
  }
}

async function notifyMatchingUsers(ticket) {
  if (!telegram) {
    console.log("[WA Scraper] No Telegram token — skipping notifications");
    return;
  }

  let profiles;
  try {
    profiles = await getActiveProfiles();
  } catch (err) {
    console.error("[WA Scraper] Failed to fetch profiles:", err.message);
    return;
  }

  if (!profiles.length) return;

  const pseudoEvent = {
    id: ticket.id,
    name: ticket.event_title,
    date: ticket.event_date,
    location: null,
    tickets_left: ticket.quantity,
  };

  for (const profile of profiles) {
    try {
      const matches = await findMatchesForUser(profile, [pseudoEvent]);
      if (!matches.length) continue;

      const match = matches[0];
      const message = buildTicketNotification(profile, ticket, match.reason);

      const sendAfter = getSendAfter(profile.is_shabbat_observant);

      if (sendAfter) {
        console.log(`[WA Scraper] Queuing notification for ${profile.telegram_id} (until ${sendAfter})`);
        await queueNotification(
          profile.telegram_id,
          ticket.id,
          message,
          ticket.image_url,
          match.reason,
          sendAfter
        );
      } else {
        await telegram.sendMessage(profile.telegram_id, message, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              {
                text: "📞 יצירת קשר עם המוכר",
                callback_data: `contact:${ticket.id}`,
              },
            ]],
          },
        });
        console.log(`[WA Scraper] Notified ${profile.telegram_id}`);
      }
    } catch (err) {
      console.error(`[WA Scraper] Notify error for ${profile.telegram_id}:`, err.message);
    }
  }
}

function buildTicketNotification(profile, ticket, reason) {
  const name = profile.first_name || "";
  const lines = [
    `🎫 ${name ? name + ", " : ""}מצאתי כרטיסים שיכולים לעניין אותך!`,
    ``,
    `🎪 <b>${ticket.event_title}</b>`,
  ];

  if (ticket.event_date) {
    const timePart = ticket.event_time ? ` ${ticket.event_time}` : "";
    lines.push(`📅 ${ticket.event_date}${timePart}`);
  }
  if (ticket.price) lines.push(`💰 מחיר: ${ticket.price}`);
  lines.push(`🎟️ כמות: ${ticket.quantity}`);
  if (reason) lines.push(`\n💡 ${reason}`);

  return lines.join("\n");
}

console.log("[WA Scraper] Initializing...");
client.initialize();
