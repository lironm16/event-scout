// Shared event-card fragments — pieces of card rendering that get
// reused across the main bot's `sendEventCard`, the watcher list
// rendering, the saved-search notifier's "I found something" cards,
// the newsletter delivery, and the low-stock push.
//
// We deliberately keep this module Telegram-AGNOSTIC: it returns plain
// strings and plain Telegram inline-button objects (no Telegraf
// `Markup.button.url` wrapping). Callers wrap them in whatever shape
// their keyboard expects. Why: the saved-search notifier builds
// keyboards as raw `{ inline_keyboard: [...] }` objects, while
// telegramBot.js uses Telegraf's `Markup.inlineKeyboard`. Returning the
// lowest common denominator (`{ text, url }`) plays with both.

// ────────────────────────────────────────────────────────────────────
// Ticket-count line
//
// Spec rule (May-2026 revamp): the "few tickets left" warning is
// merged into the same line as the ticket count instead of getting
// its own line. The warning triangle (⚠️) felt alarmist on every
// near-sold-out event; a trailing ❗️ reads as urgent without
// stop-the-presses energy. Layout:
//
//   sold out        → "🚫 אזלו הכרטיסים"
//   1..10 tickets   → "🎫 N כרטיסים אחרונים❗️" (no space before ❗️)
//   catalog (Mini App) → "🎫 N כרטיסים אחרונים" (no ❗️)
//   >10 tickets     → "🎫 N כרטיסים"
//   tickets_left==null → null   (free city events — caller omits the line)
//
// Why a SINGLE helper instead of caller-side string assembly: every
// surface (search card, newsletter, watcher list, saved-search push,
// low-stock notification) was previously building its own variant of
// this logic, often with subtle drift (one used "!", another "❗️",
// the newsletter forgot the sold-out case…). Centralising avoids the
// next round of cosmetic-but-visible inconsistencies.
const LOW_STOCK_THRESHOLD = 10;

function isLowStock(ticketsLeft) {
  return (
    ticketsLeft != null &&
    Number.isFinite(ticketsLeft) &&
    ticketsLeft > 0 &&
    ticketsLeft <= LOW_STOCK_THRESHOLD
  );
}

function formatTicketsLine(ticketsLeft, { forCatalog = false } = {}) {
  if (ticketsLeft == null) return null;
  if (!Number.isFinite(ticketsLeft)) return null;
  if (ticketsLeft <= 0) return "🚫 אזלו הכרטיסים";
  if (isLowStock(ticketsLeft)) {
    if (forCatalog) return `🎫 ${ticketsLeft} כרטיסים אחרונים`;
    return `🎫 ${ticketsLeft} כרטיסים אחרונים❗️`;
  }
  return `🎫 ${ticketsLeft} כרטיסים`;
}

// For surfaces where the ENTIRE message is the urgency signal
// (low-stock push notification, watcher "back-in-stock" alert) —
// callers want the short formatted line WITHOUT collapsing the
// "tickets remaining" case into a no-op. Returns null when there's
// nothing low-stock to say (count is 0, null, or >10).
function formatLowStockBadge(ticketsLeft) {
  if (!isLowStock(ticketsLeft)) return null;
  return `🎫 ${ticketsLeft} כרטיסים אחרונים❗️`;
}

// ────────────────────────────────────────────────────────────────────
// Navigation button (single + per-app picker)
//
// Spec rule (May-2026 revamp v2): every card gets ONE "🧭 ניווט"
// button. Tapping it opens a follow-up message with a tiny inline
// keyboard offering Waze / Google Maps / Apple Maps — so users with
// a strong preference can pick their app rather than be forced into
// Google Maps. This is the closest UX to an "OS picker" achievable
// from a Telegram bot (Telegram URL buttons require http(s) and
// don't trigger Android's geo: intent chooser).
//
// Two button shapes returned by this helper, depending on data:
//
//   A. Coords available  → CALLBACK button `nav:lat,lng`. The bot
//      handler (bot/telegramBot.js -> bot.action(/^nav:.../)) emits
//      a 3-button picker, each a deep link built from the same
//      coords. Coords are encoded in callback_data (24-30 bytes,
//      well under the 64-byte cap) so we don't need a server-side
//      cache that would expire on restart.
//
//   B. Venue text only  → URL button straight to Google Maps search.
//      No picker — Waze / Apple Maps need real coords to be useful,
//      and a text-only query lands best when the user's default
//      maps app handles it directly. This is the fallback for
//      events whose location hasn't been geocoded yet.
//
// Coordinate fallbacks (highest priority first):
//   1. event._coords.{lat,lng}     — set by the matchingService /
//      proximity calculator after a successful geocode
//   2. event._proximity.venue_coords — alternative shape used by some
//      tools (e.g. the agent's events_tool result)
//   3. event.lat / event.lng        — bare top-level fields used by
//      "all occurrences" cached payloads
//
// Virtual events (`event._proximity.reason === "virtual"`) skip nav
// entirely — there's nothing to navigate to.
function pickCoords(event) {
  if (event?._coords?.lat != null && event._coords?.lng != null) {
    return { lat: event._coords.lat, lng: event._coords.lng };
  }
  if (
    event?._proximity?.venue_coords?.lat != null &&
    event._proximity?.venue_coords?.lng != null
  ) {
    return {
      lat: event._proximity.venue_coords.lat,
      lng: event._proximity.venue_coords.lng,
    };
  }
  if (event?.lat != null && event?.lng != null) {
    return { lat: event.lat, lng: event.lng };
  }
  return null;
}

function pickVenueText(event) {
  return (
    event?._proximity?.navigate_address ||
    event?.location ||
    event?.venue ||
    null
  );
}

// Build the three deep-link URLs we offer in the picker. Exposed
// for the bot's callback handler — keeps the URL construction in
// one place so a missing param (e.g. trailing `?` vs `&`) doesn't
// silently produce broken Waze / Maps links.
function buildNavPickerLinks(lat, lng) {
  const ll = `${lat},${lng}`;
  return {
    waze: `https://www.waze.com/ul?ll=${ll}&navigate=yes`,
    gmaps: `https://www.google.com/maps?q=${ll}`,
    apple: `https://maps.apple.com/?q=${ll}`,
  };
}

function buildNavigateButton(event) {
  if (event?._proximity?.reason === "virtual") return null;
  // Pure online event — no physical venue to navigate to.
  // We suppress nav when online_url is set AND there is no physical
  // location_key (meaning the city stored a Zoom/Meet link but no venue).
  // Hybrid events (both online_url and location_key) keep the nav button.
  if (event?.online_url && !event?.location_key) return null;
  // Use a direct Google Maps URL — the OS shows its own app picker
  // on mobile (Android/iOS), and the browser opens on desktop.
  // No custom picker needed from our side.
  const coords = pickCoords(event);
  if (coords && Number.isFinite(Number(coords.lat)) && Number.isFinite(Number(coords.lng))) {
    const lat = Number(coords.lat).toFixed(6);
    const lng = Number(coords.lng).toFixed(6);
    return { text: "🧭 ניווט", url: `https://maps.google.com/?q=${lat},${lng}` };
  }
  // No coords → text-search fallback.
  const venueText = pickVenueText(event);
  if (venueText) {
    return {
      text: "🧭 ניווט",
      url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venueText)}`,
    };
  }
  return null;
}

// Returns 0 or 1 buttons. We keep the ARRAY shape (not a bare button
// or null) so the call-sites that do `const top = [...nav, details]`
// don't need to change — they get a clean empty-array spread when
// nav isn't available (virtual events) and a single-element spread
// otherwise.
function buildNavButtons(event) {
  const btn = buildNavigateButton(event);
  return btn ? [btn] : [];
}

// ────────────────────────────────────────────────────────────────────
// Event description snippets for cards
//
// Cards always carry the event description when we have one. The body
// shows a short excerpt; a "קרא עוד" callback opens the full card with
// the complete text (see bot/telegramBot.js `ev:more:` handler).
const DESCRIPTION_SNIPPET_MAX = 120;

function normalizeDescription(description) {
  if (typeof description !== "string") return "";
  return description.replace(/\s+/g, " ").trim();
}

function formatDescriptionSnippet(description, maxLen = DESCRIPTION_SNIPPET_MAX) {
  const norm = normalizeDescription(description);
  if (!norm) return null;
  if (norm.length <= maxLen) return norm;
  return `${norm.slice(0, maxLen).trimEnd()}…`;
}

function descriptionNeedsReadMore(description, maxLen = DESCRIPTION_SNIPPET_MAX) {
  return normalizeDescription(description).length > maxLen;
}

/** Plain `{ text, callback_data }` button — works with Telegraf and raw keyboards. */
function buildReadMoreButton(eventId) {
  if (eventId == null) return null;
  return { text: "📖 קרא עוד", callback_data: `ev:more:${eventId}` };
}

module.exports = {
  LOW_STOCK_THRESHOLD,
  isLowStock,
  formatTicketsLine,
  formatLowStockBadge,
  buildNavigateButton,
  buildNavButtons,
  buildNavPickerLinks,
  DESCRIPTION_SNIPPET_MAX,
  normalizeDescription,
  formatDescriptionSnippet,
  descriptionNeedsReadMore,
  buildReadMoreButton,
};
