const supabase = require("./supabase");

async function insertTicket(ticket) {
  const { data, error } = await supabase
    .from("tickets")
    .upsert(ticket, { onConflict: "wa_message_id" })
    .select()
    .single();

  if (error) throw new Error(`Ticket insert failed: ${error.message}`);
  return data;
}

async function markSoldById(ticketId) {
  const { data, error } = await supabase
    .from("tickets")
    .update({ status: "sold" })
    .eq("id", ticketId)
    .select()
    .single();

  if (error && error.code !== "PGRST116") {
    console.error("[TicketService] markSoldById error:", error.message);
  }
  return data;
}

async function markSoldByWaMessage(waMessageId) {
  const { data, error } = await supabase
    .from("tickets")
    .update({ status: "sold" })
    .eq("wa_message_id", waMessageId)
    .select()
    .single();

  if (error && error.code !== "PGRST116") {
    console.error("[TicketService] markSoldByWaMessage error:", error.message);
  }
  return data;
}

async function updateQuantity(ticketId, newQuantity) {
  const update =
    newQuantity <= 0
      ? { quantity: 0, status: "sold" }
      : { quantity: newQuantity };

  const { data, error } = await supabase
    .from("tickets")
    .update(update)
    .eq("id", ticketId)
    .select()
    .single();

  if (error) throw new Error(`Quantity update failed: ${error.message}`);
  return data;
}

async function getTicket(ticketId) {
  const { data, error } = await supabase
    .from("tickets")
    .select("*")
    .eq("id", ticketId)
    .single();

  if (error) return null;
  return data;
}

async function getActiveTickets() {
  const { isEventInPast, todayISO } = require("./timeContext");
  const { data, error } = await supabase
    .from("tickets")
    .select("*")
    .eq("status", "active")
    .gte("event_date", todayISO())
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Active tickets fetch failed: ${error.message}`);
  return (data || []).filter((t) => !isEventInPast(t.event_date, t.event_time));
}

async function expirePastEvents() {
  const now = new Date().toISOString().split("T")[0];

  const { data, error } = await supabase
    .from("tickets")
    .update({ status: "expired" })
    .eq("status", "active")
    .lt("event_date", now)
    .select("id");

  if (error) {
    console.error("[TicketService] Expire error:", error.message);
    return 0;
  }
  return data?.length || 0;
}

async function isStillActive(ticketId) {
  const ticket = await getTicket(ticketId);
  return ticket?.status === "active";
}

async function getDistinctCategories() {
  const { todayISO, isAdminEntry } = require("./timeContext");
  const { data, error } = await supabase
    .from("events")
    .select("name")
    .gt("tickets_left", 0)
    .eq("archived", false)
    .gte("date", todayISO());

  if (error || !data?.length) return [];

  const filtered = data.filter((e) => !isAdminEntry(e.name));

  const keywords = new Map();
  const categoryPatterns = [
    { pattern: /הצגה|הצגות|תיאטרון/i, label: "הצגות" },
    { pattern: /קרקס/i, label: "קרקס" },
    { pattern: /ספורט|כדורגל|כדורסל/i, label: "ספורט" },
    { pattern: /מוזיקה|מוסיקה|קונצרט|הופעה/i, label: "מוזיקה" },
    { pattern: /יצירה|סדנה|סדנאות/i, label: "יצירה" },
    { pattern: /ג'ימבורי|ג׳ימבורי|פעילות/i, label: "פעילויות" },
    { pattern: /בלט|ריקוד|מחול/i, label: "ריקוד" },
    { pattern: /קולנוע|סרט/i, label: "קולנוע" },
    { pattern: /סטנדאפ|קומדיה/i, label: "סטנדאפ" },
  ];

  for (const event of filtered) {
    for (const { pattern, label } of categoryPatterns) {
      if (pattern.test(event.name)) {
        keywords.set(label, (keywords.get(label) || 0) + 1);
      }
    }
  }

  return Array.from(keywords.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([label]) => label);
}

// ─────────────────────────────────────────────────────────────────────
// Linking + watcher fan-out
// ─────────────────────────────────────────────────────────────────────

// Hebrew text normalization for the title-similarity match. We strip
// nikud (vowel marks) and collapse whitespace; the resulting strings
// compare reliably regardless of which copy of the title uses
// pointing or extra spaces.
//
// Kept inside ticketService (not exported) because the offer flow
// uses a slightly different normalization (date_hint-aware) and we
// don't want to lock our internal callers to this exact shape.
function _normalizeForMatch(s) {
  return String(s || "")
    .toLowerCase()
    // Hebrew nikud range (U+0591..U+05C7) — keep the consonants only.
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/[״׳"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Best-effort match of a ticket's free-text event title to an events
 * row, returning the matched event_id or null. Used by:
 *
 *   - WhatsApp ingest (scraper/whatsappScraper.js): tries to link a
 *     newly-scraped ticket to a known event automatically so the
 *     watcher fan-out fires for the right rows.
 *
 *   - The Telegram offer wizard: the agent calls this through the
 *     match_event_for_ticket_offer tool — but that path uses its own
 *     scoring (top-3 candidates) and only re-uses this helper for
 *     the date-tightening step.
 *
 * Match rules (conservative — we'd rather link no row than the wrong
 * one):
 *   1. Title substring or substring-of (normalized, length ≥ 4 chars
 *      either side). Single-word matches are too noisy.
 *   2. Date window: ±2 days of `eventDate` when provided. Without a
 *      date hint the title alone must be very specific (single
 *      remaining candidate after the title filter).
 *   3. Future-only (we never link a secondary ticket to a past event).
 */
async function linkTicketToEvent({ eventTitle, eventDate = null }) {
  const needle = _normalizeForMatch(eventTitle);
  if (needle.length < 4) return null;

  const { todayISO, addDaysISO } = require("./timeContext");
  const today = todayISO();

  let query = supabase
    .from("events")
    .select("id, name, date")
    .eq("archived", false)
    .gte("date", today);

  if (eventDate) {
    // Loose date band: title is sometimes given for a series and the
    // exact session isn't pinned. ±2d catches the same-week siblings
    // without over-broadening (next-month repeats stay out).
    query = query
      .gte("date", addDaysISO(eventDate, -2))
      .lte("date", addDaysISO(eventDate, 2));
  }

  // Order by date ascending so the result set is deterministic and
  // the LIMIT below truncates the FAR-END of the window rather than
  // a random ~50 rows. With a ±2-day window, 500 covers the densest
  // days we see in practice (a popular Saturday in Ramat Gan tops
  // out around 80 events). Without ilike pushdown — which would be
  // brittle for spelling variants WhatsApp sellers often introduce
  // — we just lift the cap.
  const { data, error } = await query.order("date", { ascending: true }).limit(500);
  if (error) {
    console.warn(`[TicketService] linkTicketToEvent query failed: ${error.message}`);
    return null;
  }

  const candidates = (data || []).filter((row) => {
    const hay = _normalizeForMatch(row.name);
    if (!hay) return false;
    return hay.includes(needle) || (needle.length >= 8 && needle.includes(hay));
  });

  if (!candidates.length) return null;

  // With a date hint, the band already narrowed the universe enough
  // that picking the FIRST candidate is safe — they're all the same
  // event-or-sibling.
  if (eventDate) return candidates[0].id;

  // Without a date hint we only commit when the title is unambiguous
  // (exactly one match). Multi-match without a date is the classic
  // "Cinderella runs three nights this week" case — better to leave
  // the link null than guess wrong.
  if (candidates.length === 1) return candidates[0].id;
  return null;
}

/**
 * For a freshly-inserted ticket linked to an event_id, return the
 * watchers who haven't been notified yet AND whose notified_at is
 * still null. Stamps notified_at on each as a side effect so a
 * concurrent fan-out (e.g. a duplicate WhatsApp message) doesn't
 * double-notify.
 *
 * Returns: Array<{ telegram_id, tickets_needed }>
 *
 * Callers must do the actual Telegram send — we keep IO out of this
 * module so it stays testable without a running bot.
 */
async function fanOutToWatchers(eventId) {
  if (!eventId) return [];
  const { getWatchersForEvent, markNotified } = require("./watchService");
  const watchers = await getWatchersForEvent(eventId);
  // Stamp them up-front. If the Telegram send later fails for one,
  // we accept the missed notification rather than retry forever —
  // the recap will surface the active ticket anyway.
  for (const w of watchers) {
    try {
      await markNotified(w.telegram_id, eventId);
    } catch (err) {
      console.warn(
        `[TicketService] markNotified failed for tg=${w.telegram_id} ev=${eventId}: ${err.message}`,
      );
    }
  }
  return watchers;
}

/**
 * Return all currently-active tickets for events that are still in
 * the future. Joins event metadata when the ticket is linked
 * (sql/044), otherwise falls back to ticket.event_title / event_date
 * (the WhatsApp free-text path). Output rows are sorted by event
 * date ascending so the recap reads chronologically.
 *
 * Shape per row:
 *   {
 *     id, source, status,                        ← from tickets
 *     event_title, event_date, event_time,       ← from tickets
 *     quantity, price, raw_text, image_url,      ← from tickets
 *     seller_phone, seller_name, seller_telegram_id,
 *     event_id, created_at, wa_message_id,
 *     event: { id, name, date, … } | null        ← from events (if linked)
 *   }
 */
async function getActiveRecap() {
  const { todayISO } = require("./timeContext");
  const today = todayISO();

  // We pull tickets where EITHER:
  //   - event_date IS NULL (free-text WhatsApp where we couldn't
  //     parse a date) — the operator still wants to see these; OR
  //   - event_date >= today.
  // PostgREST's .or() takes a comma-separated filter list.
  const { data, error } = await supabase
    .from("tickets")
    .select(
      "id, source, status, event_id, event_title, event_date, event_time, " +
        "quantity, price, raw_text, image_url, seller_phone, seller_name, " +
        "seller_telegram_id, wa_message_id, created_at, " +
        "events(id, name, date, start_time)",
    )
    .eq("status", "active")
    .or(`event_date.is.null,event_date.gte.${today}`)
    .order("event_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`getActiveRecap failed: ${error.message}`);
  }
  return (data || []).map((row) => ({
    ...row,
    event: row.events || null,
  }));
}

module.exports = {
  insertTicket,
  markSoldById,
  markSoldByWaMessage,
  updateQuantity,
  getTicket,
  getActiveTickets,
  expirePastEvents,
  isStillActive,
  getDistinctCategories,
  linkTicketToEvent,
  fanOutToWatchers,
  getActiveRecap,
};
