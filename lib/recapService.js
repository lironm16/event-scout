// WhatsApp ticket recap.
//
// The operator scans WhatsApp groups daily-ish for tickets they'd
// otherwise miss. The scraper already auto-ingests new posts into
// the `tickets` table; the recap surfaces what's STILL ACTIVE so the
// operator can:
//
//   - Spot tickets they remember seeing posted that haven't been
//     marked sold (operator may know the deal closed via a side
//     channel — WhatsApp DM, in-person, etc.).
//   - Reach out to sellers via phone for tickets the operator
//     wants to escalate / promote.
//
// Output is one Telegram message per recap (paged when over the
// 4096-char limit), formatted top-down by event date. Phone numbers
// are surfaced verbatim — the operator asked for them explicitly.
// We tap-tap-tap-pause between sends so a 200-ticket recap doesn't
// trip Telegram's flood limit.

const { getActiveRecap } = require("./ticketService");
const { formatHebrewDate } = require("./eventFormat");

// Telegram's hard message limit is 4096 chars. We page well below it
// (3500) to leave headroom for the header line and any Markdown
// escape inflation.
const PAGE_CHAR_LIMIT = 3500;

// Recap entries truncate raw_text at this length to keep individual
// items scannable. The operator gets a "…" suffix when truncated,
// and a tap on the row shows nothing further — they can search
// WhatsApp directly using the phone number. Free-form messages
// average ~150 chars in the wild so 240 catches almost everything
// without exploding a single entry.
const RAW_TEXT_SNIPPET = 240;

function _snippet(s, n = RAW_TEXT_SNIPPET) {
  if (!s) return "";
  const trimmed = String(s).replace(/\s+/g, " ").trim();
  return trimmed.length > n ? trimmed.slice(0, n - 1).trimEnd() + "…" : trimmed;
}

function _daysAgo(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/**
 * Render a single ticket row for the recap. Returns a multi-line
 * Markdown-safe string. Caller composes them with "\n\n" between
 * rows.
 *
 *   N. <icon> <event title>
 *      📅 <date>  🕐 <time>
 *      💺 <quantity>  💰 <price>
 *      📱 <seller phone> · 👤 <seller name>  (when present)
 *      💬 "<raw text snippet>"
 *      🔗 https://wa.me/<phone>   (deep link to start WhatsApp chat)
 *      _<source> · נשלח לפני N ימים_
 */
function _formatRow(ticket, idx) {
  const lines = [];
  // 1) Header
  const titleSource =
    (ticket.event && ticket.event.name) || ticket.event_title || "(ללא כותרת)";
  lines.push(`*${idx}. ${titleSource}*`);

  // 2) Date + time
  const date =
    (ticket.event && ticket.event.date) || ticket.event_date || null;
  const time = ticket.event_time || (ticket.event && ticket.event.start_time);
  const dateLine = [];
  if (date) dateLine.push(`📅 ${formatHebrewDate(date)}`);
  if (time) dateLine.push(`🕐 ${String(time).slice(0, 5)}`);
  if (dateLine.length) lines.push(dateLine.join("   "));

  // 3) Quantity + price
  const qtyLine = [];
  if (ticket.quantity != null) qtyLine.push(`💺 ${ticket.quantity}`);
  if (ticket.price) qtyLine.push(`💰 ${ticket.price}`);
  if (qtyLine.length) lines.push(qtyLine.join("   "));

  // 4) Contact (phone + name) — only for WhatsApp source. For
  // telegram_user tickets we deliberately don't expose phone here
  // (it might not be set; and if it is, the recap is operator-only
  // so privacy isn't a concern, but we still keep the channels
  // visually distinct).
  const contactLine = [];
  if (ticket.seller_phone) contactLine.push(`📱 \`${ticket.seller_phone}\``);
  if (ticket.seller_name) contactLine.push(`👤 ${ticket.seller_name}`);
  if (contactLine.length) lines.push(contactLine.join("   "));

  // 5) Snippet of the raw WhatsApp message — quoted so the operator
  // sees what the seller actually wrote. Free-text only — never
  // present for telegram_user tickets (which have no raw_text).
  if (ticket.raw_text) {
    lines.push(`💬 _${_snippet(ticket.raw_text)}_`);
  }

  // 6) Quick-action: tap-to-open WhatsApp with the seller. Telegram
  // auto-converts the URL to a tappable link. wa.me wants the phone
  // without leading 0 and with the country code, which most Israeli
  // numbers in this dataset already have ("972…") — we add the
  // prefix when missing.
  if (ticket.seller_phone) {
    const intl = String(ticket.seller_phone).startsWith("0")
      ? "972" + ticket.seller_phone.slice(1)
      : ticket.seller_phone;
    lines.push(`🔗 https://wa.me/${intl}`);
  }

  // 7) Source + age footer
  const age = _daysAgo(ticket.created_at);
  const sourceLabel =
    ticket.source === "telegram_user" ? "מהבוט" : "מווסטאפ";
  if (age != null) {
    lines.push(
      `_${sourceLabel} · ${age === 0 ? "פורסם היום" : `לפני ${age} ימים`}_`,
    );
  } else {
    lines.push(`_${sourceLabel}_`);
  }

  return lines.join("\n");
}

/**
 * Build the full recap as an array of Telegram-ready pages. Each
 * page is a string under PAGE_CHAR_LIMIT; the caller sends them
 * sequentially.
 *
 * Returns: { pages: string[], total: number }
 *
 * When `total === 0` the caller should send a "nothing to recap"
 * message rather than calling sendMessage("") (Telegram rejects
 * empty bodies).
 */
async function buildRecap() {
  const tickets = await getActiveRecap();
  const total = tickets.length;

  if (total === 0) {
    return { pages: [], total };
  }

  const header = `📋 *${total} כרטיסים פעילים*\nסקירה של כרטיסים שטרם נסגרו.`;
  const rows = tickets.map((t, i) => _formatRow(t, i + 1));

  // Pack rows into pages, never splitting a row across pages. The
  // first page gets the header; subsequent pages get a continuation
  // marker so the operator knows the list continues.
  const pages = [];
  let current = header;
  for (const row of rows) {
    const candidate = current + "\n\n" + row;
    if (candidate.length > PAGE_CHAR_LIMIT) {
      pages.push(current);
      current = `*המשך* (${pages.length + 1})\n\n` + row;
    } else {
      current = candidate;
    }
  }
  if (current) pages.push(current);

  return { pages, total };
}

module.exports = { buildRecap };
