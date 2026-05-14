// User-initiated secondary-market ticket offers.
//
// Flow:
//   1. User says "יש לי כרטיס נוסף ל…" / "אני רוצה למכור…" → Gemini
//      routes to `match_event_for_ticket_offer` with the title text
//      (and an optional date hint). The tool returns up to 3 ranked
//      candidates from events. The agent surfaces them as buttons.
//
//   2. User picks an event_id → agent calls
//      `present_ticket_offer_confirmation` with the chosen event +
//      seller-supplied quantity/price/phone. The bot renders a
//      preview card with "💾 שמירה" / "ביטול" buttons.
//
//   3. On confirm → agent calls `save_ticket_offer` which writes the
//      tickets row (source='telegram_user'), fans out to event
//      watchers, and ACKs the seller.
//
// Why a separate match tool instead of reusing find_event_by_name:
//   - The offer flow needs DETERMINISTIC ranking: we sort by date
//     proximity to the user's hint and prefer titles whose
//     normalized form is a closer match (Levenshtein-ish). The
//     existing tool returns substring matches alphabetically.
//   - It enforces the "require_match" rule the operator chose:
//     return EMPTY candidates rather than fuzzy guesses, and let
//     the agent tell the user "I don't carry this event."
//   - Returning fewer fields keeps the agent's downstream prompt
//     tight — we don't need locations/ages here, only id+name+date.

const { SchemaType } = require("@google/generative-ai");
const { Markup } = require("telegraf");
const supabase = require("../../supabase");
const { todayISO, addDaysISO } = require("../../timeContext");
const { fanOutToWatchers } = require("../../ticketService");
const { formatHebrewDate, formatTimeRange } = require("../../eventFormat");

// Hebrew text normalization. Strips nikud (vowel marks), quotation
// glyphs, and collapses whitespace so "מטילדה" and "מַטִילְדָּה" compare
// equal. Kept in this file (vs sharing with ticketService) because
// the offer flow's scoring is slightly different — see below.
function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/[״׳"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Token-set similarity: counts overlapping ≥3-char words. The 3-char
// floor keeps common stop-tokens ("של", "על", "כדי") from inflating
// matches. Returns a 0..1 score.
function tokenOverlap(a, b) {
  const ta = new Set(a.split(" ").filter((t) => t.length >= 3));
  const tb = new Set(b.split(" ").filter((t) => t.length >= 3));
  if (!ta.size || !tb.size) return 0;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return overlap / Math.max(ta.size, tb.size);
}

// ─────────────────────────────────────────────────────────────────────
// Tool 1: match_event_for_ticket_offer
// ─────────────────────────────────────────────────────────────────────
const matchEventDecl = {
  name: "match_event_for_ticket_offer",
  description:
    "When the user offers a ticket through the bot (\"יש לי כרטיס נוסף ל…\" / \"אני רוצה למכור…\"), " +
    "find up to 3 candidate events from our DB that match the title (and optional date). " +
    "Returns [] if nothing matches — the agent must then tell the user we don't carry this event. " +
    "Do NOT use for general event search (use search_events / find_event_by_name).",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      free_text: {
        type: SchemaType.STRING,
        description: "Event title as the seller said it (Hebrew). Required.",
      },
      date_hint: {
        type: SchemaType.STRING,
        nullable: true,
        description: "ISO YYYY-MM-DD if the seller mentioned a date; else omit.",
      },
    },
    required: ["free_text"],
  },
};

async function matchEventForTicketOffer(args, _ctx) {
  const needle = normalize(args?.free_text);
  if (needle.length < 4) {
    return { candidates: [], reason: "title_too_short" };
  }
  const dateHint = args?.date_hint || null;
  const today = todayISO();

  // Pull future events; if we have a date hint, narrow to ±7 days
  // around it (covers same-week siblings without exploding the
  // candidate set).
  let q = supabase
    .from("events")
    .select("id, name, date, start_time, location_key, locations:location_key(raw_address)")
    .eq("archived", false)
    .gte("date", today);

  if (dateHint) {
    q = q
      .gte("date", addDaysISO(dateHint, -7))
      .lte("date", addDaysISO(dateHint, 7));
  } else {
    // 60-day forward horizon when no date hint: anything further out
    // is almost certainly a different event with a coincidental
    // title match.
    q = q.lte("date", addDaysISO(today, 60));
  }

  const { data, error } = await q.limit(200);
  if (error) {
    return { error: "match_failed", message: error.message };
  }

  // Score each candidate. Title score is the max of:
  //   - substring containment (1.0 if the seller's text is contained
  //     in the event title or vice versa, after normalization)
  //   - token-overlap ratio
  // Date score is 1.0 at exact date, decaying linearly to 0 at ±7d
  // when a hint is provided; 0.5 (neutral) otherwise so titles
  // dominate.
  const scored = [];
  for (const row of data || []) {
    const hay = normalize(row.name);
    if (!hay) continue;
    const sub =
      hay.includes(needle) || (needle.length >= 8 && needle.includes(hay))
        ? 1
        : 0;
    const tok = tokenOverlap(needle, hay);
    const titleScore = Math.max(sub, tok);
    if (titleScore < 0.34) continue; // require at least one 3-char token overlap

    let dateScore = 0.5;
    if (dateHint) {
      const days = Math.abs(
        (new Date(row.date).getTime() - new Date(dateHint).getTime()) /
          86_400_000,
      );
      dateScore = Math.max(0, 1 - days / 7);
    }
    scored.push({ row, score: titleScore * 0.7 + dateScore * 0.3 });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3).map(({ row, score }) => ({
    event_id: row.id,
    event_name: row.name,
    date: row.date,
    start_time: row.start_time,
    location: row.locations?.raw_address || null,
    confidence: Number(score.toFixed(2)),
  }));

  return { candidates: top };
}

// ─────────────────────────────────────────────────────────────────────
// Tool 2: present_ticket_offer_confirmation
//
// "Pause-the-agent" tool that hands a pre-save preview to the bot.
// The orchestrator detects {paused:true} and returns control to the
// human; the bot renders a preview card with confirm/cancel buttons.
// Confirm flips into save_ticket_offer below.
//
// We stash the offer payload on the user's session so the
// `tof:save:<n>` / `tof:cancel:<n>` callback handlers don't have to
// re-derive it from the conversation history (which Gemini can drop
// during context trimming).
// ─────────────────────────────────────────────────────────────────────
const confirmDecl = {
  name: "present_ticket_offer_confirmation",
  description:
    "Show the seller a confirmation card BEFORE saving their ticket offer. " +
    "Call AFTER the user has picked one specific event_id (returned by " +
    "match_event_for_ticket_offer) and supplied quantity (and optionally price + phone). " +
    "The bot will display the card with שמירה / ביטול buttons; the agent should NOT also " +
    "send its own confirmation message — wait for the user's tap.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      event_id: { type: SchemaType.INTEGER },
      quantity: { type: SchemaType.INTEGER },
      price: {
        type: SchemaType.STRING,
        nullable: true,
        description: "Free-text price as the seller said it (e.g. \"100₪\", \"חינם\"). Optional.",
      },
      phone: {
        type: SchemaType.STRING,
        nullable: true,
        description: "Optional phone number the seller shared. Skip if they don't want to share.",
      },
    },
    required: ["event_id", "quantity"],
  },
};

async function presentTicketOfferConfirmation(args, ctx) {
  // Look up the event to render the preview card.
  const { data: event, error } = await supabase
    .from("events")
    .select("id, name, date, start_time, location_key, locations:location_key(raw_address)")
    .eq("id", args.event_id)
    .maybeSingle();
  if (error || !event) {
    return {
      error: "event_not_found",
      message: `אין אצלי אירוע עם id=${args.event_id}.`,
    };
  }

  // Stash the offer payload keyed by an opaque token so the bot's
  // callback handlers (`tof:save:<offerId>` / `tof:cancel:<offerId>`)
  // can reload the validated state without trusting any data carried
  // in the callback string itself (callback_data is user-controllable).
  // The offerId combines telegram_id + timestamp so two concurrent
  // wizards from the same user don't collide.
  const offerId = `${ctx.telegramId}_${Date.now()}`;
  const payload = {
    event_id: event.id,
    event_name: event.name,
    event_date: event.date,
    event_time: event.start_time,
    location: event.locations?.raw_address || null,
    quantity: args.quantity,
    price: args.price || null,
    phone: args.phone || null,
    seller_telegram_id: String(ctx.telegramId),
    createdAt: Date.now(),
  };

  ctx.session = ctx.session || {};
  ctx.session.pendingTicketOffers = ctx.session.pendingTicketOffers || {};
  ctx.session.pendingTicketOffers[offerId] = payload;

  // Build the preview card. Mirrors the existing sendEventCard
  // structure (icon-title, date, time, location, then the offer-
  // specific fields) so it FEELS like a regular event card to the
  // seller — they're confirming "this is the event I'm offering for".
  const lines = ["🎟️ *הצעת כרטיס למכירה*", "", event.name];
  if (event.date) lines.push(`📅 ${formatHebrewDate(event.date)}`);
  const timeStr = formatTimeRange(event.start_time, null);
  if (timeStr) lines.push(`🕐 ${timeStr}`);
  if (payload.location) lines.push(`📍 ${payload.location}`);
  lines.push("");
  lines.push(`💺 כמות: ${payload.quantity}`);
  if (payload.price) lines.push(`💰 מחיר: ${payload.price}`);
  if (payload.phone) lines.push(`📱 טלפון לקשר: ${payload.phone}`);
  lines.push("");
  lines.push("לשמור ולפרסם לעוקבים אחרי האירוע?");

  await ctx.tg.reply(
    lines.join("\n"),
    Markup.inlineKeyboard([
      [
        Markup.button.callback("💾 שמירה", `tof:save:${offerId}`),
        Markup.button.callback("✖️ ביטול", `tof:cancel:${offerId}`),
      ],
    ]),
  );

  return { paused: true };
}

// ─────────────────────────────────────────────────────────────────────
// Tool 3: save_ticket_offer
//
// Called either by the bot's `tof:save:<offerId>` callback after the
// user taps שמירה (preferred path — the offer payload is reloaded
// from the session), OR directly by the agent in the rare case the
// user types "שמרי את זה" without tapping the button. Both call sites
// route through this function for one source of truth.
// ─────────────────────────────────────────────────────────────────────
const saveDecl = {
  name: "save_ticket_offer",
  description:
    "Persist a confirmed user-offered ticket. Prefer letting the bot's שמירה button trigger this " +
    "(it reloads the validated offer from session). Only call directly when the user explicitly " +
    "confirms via free text.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      event_id: { type: SchemaType.INTEGER },
      quantity: { type: SchemaType.INTEGER },
      price: { type: SchemaType.STRING, nullable: true },
      phone: { type: SchemaType.STRING, nullable: true },
    },
    required: ["event_id", "quantity"],
  },
};

async function saveTicketOffer(args, ctx) {
  return saveOffer({
    event_id: args.event_id,
    quantity: args.quantity,
    price: args.price || null,
    phone: args.phone || null,
    seller_telegram_id: String(ctx.telegramId),
  });
}

/**
 * Shared persistence path. Reused by:
 *   - The save_ticket_offer agent tool above.
 *   - The bot's `tof:save:<offerId>` callback handler.
 * Returns { ok: true, ticket_id, notified_count } on success.
 */
async function saveOffer({
  event_id,
  quantity,
  price = null,
  phone = null,
  seller_telegram_id,
}) {
  if (!event_id) {
    return { error: "missing_event_id" };
  }
  // Re-read the event to (a) snapshot title/date onto the ticket row
  // for resilience against later event-row mutations, and (b) verify
  // it still exists and is in the future.
  const { data: event, error: evErr } = await supabase
    .from("events")
    .select("id, name, date, start_time, archived")
    .eq("id", event_id)
    .maybeSingle();
  if (evErr) {
    return { error: "event_lookup_failed", message: evErr.message };
  }
  if (!event || event.archived) {
    return { error: "event_not_available" };
  }

  const row = {
    source: "telegram_user",
    event_id,
    event_title: event.name,
    event_date: event.date,
    event_time: event.start_time,
    quantity,
    price,
    seller_phone: phone,
    seller_telegram_id,
    status: "active",
    // wa_message_id stays null — distinguishes telegram_user offers
    // from WhatsApp scrapes in the recap.
  };

  const { data: ticket, error: insErr } = await supabase
    .from("tickets")
    .insert(row)
    .select()
    .single();
  if (insErr) {
    return { error: "save_failed", message: insErr.message };
  }

  // Fan out to event watchers. The Telegram send is done by the
  // bot's notifier (savedSearchNotifier / sendTicketCard via the
  // bot.telegram handle); we return the watcher list so the caller
  // can deliver.
  const watchers = await fanOutToWatchers(event_id);
  return {
    ok: true,
    ticket_id: ticket.id,
    event_id,
    notified_count: watchers.length,
    watchers, // caller (bot) does the Telegram send
  };
}

module.exports = {
  declarations: [matchEventDecl, confirmDecl, saveDecl],
  handlers: {
    match_event_for_ticket_offer: matchEventForTicketOffer,
    present_ticket_offer_confirmation: presentTicketOfferConfirmation,
    save_ticket_offer: saveTicketOffer,
  },
  // Exposed so the bot's `tof:save:<offerId>` callback can call the
  // same persistence path the agent tool uses.
  _saveOffer: saveOffer,
};
