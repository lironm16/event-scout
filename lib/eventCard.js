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

const { isCityWideLocation } = require("./locationStore");
const { getLocationModes } = require("./locationPrefs");

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
//   1..9 tickets    → "🎫 N כרטיסים אחרונים" + LOW_STOCK_URGENCY (RLM+❗️, no gap)
//   catalog (Mini App) → "🎫 N כרטיסים אחרונים" (no ❗️)
//   >9 tickets      → "🎫 N כרטיסים"
//   tickets_left==null → null   (free city events — caller omits the line)
//
// Why a SINGLE helper instead of caller-side string assembly: every
// surface (search card, newsletter, watcher list, saved-search push,
// low-stock notification) was previously building its own variant of
// this logic, often with subtle drift (one used "!", another "❗️",
// the newsletter forgot the sold-out case…). Centralising avoids the
// next round of cosmetic-but-visible inconsistencies.
const LOW_STOCK_THRESHOLD = 9;

// Telegram RTL can insert a visual gap between Hebrew and trailing ❗️.
// No ASCII space in source — U+2060 (word joiner) + U+200F (RLM) glue the mark.
const LOW_STOCK_URGENCY = "\u2060\u200f❗️";

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
    return `🎫 ${ticketsLeft} כרטיסים אחרונים${LOW_STOCK_URGENCY}`;
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
  return `🎫 ${ticketsLeft} כרטיסים אחרונים${LOW_STOCK_URGENCY}`;
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

/** Text the user sees on the card — preferred for Maps search links. */
function pickNavSearchQuery(event) {
  const shown = event?.location && String(event.location).trim();
  if (
    shown &&
    shown !== "ברחבי העיר" &&
    !/^מתקיים במספר מיקומים/u.test(shown)
  ) {
    return shown;
  }
  return pickVenueText(event);
}

/** Home origin from profile — typed address first (what the user entered). */
function homeOriginFromProfile(profile) {
  const c = profile?.user_context?.constraints || profile?.constraints || {};
  const addr = c.home_address;
  if (addr && String(addr).trim()) return { address: String(addr).trim() };
  if (c.home_coordinates?.lat != null && c.home_coordinates?.lng != null) {
    return {
      lat: Number(c.home_coordinates.lat),
      lng: Number(c.home_coordinates.lng),
    };
  }
  return null;
}

/** Google Maps travelmode from location_modes (+ event proximity when both set). */
function travelModeFromProfile(profile, event = null) {
  const c = profile?.user_context?.constraints || profile?.constraints || {};
  const modes = getLocationModes(c);
  if (!modes.length || modes.includes("any")) return null;
  const hasWalk = modes.includes("walk");
  const hasDrive = modes.includes("drive");
  if (hasWalk && !hasDrive) return "walking";
  if (hasDrive && !hasWalk) return "driving";
  if (event?._proximity?.requires_car === true) return "driving";
  if (event?._proximity?.requires_car === false) return "walking";
  return "walking";
}

/** `{ home, travelMode }` for buildMapsNavUrl / buildNavButtons. */
function navOptsFromProfile(profile, event = null) {
  const opts = {};
  const home = homeOriginFromProfile(profile);
  if (home) opts.home = home;
  const travelMode = travelModeFromProfile(profile, event);
  if (travelMode) opts.travelMode = travelMode;
  return opts;
}

function formatMapsOriginParam(origin) {
  if (!origin) return null;
  if (origin.lat != null && origin.lng != null) {
    return `${origin.lat},${origin.lng}`;
  }
  if (origin.address) return encodeURIComponent(origin.address);
  return null;
}

function resolveMapsDestination(event) {
  const query = pickNavSearchQuery(event);
  const cityWide = isCityWideLocation(event?.location_key);
  if (query && !cityWide) return { kind: "query", value: query };
  const coords = pickCoords(event);
  if (coords && Number.isFinite(Number(coords.lat)) && Number.isFinite(Number(coords.lng))) {
    return { kind: "coords", lat: Number(coords.lat), lng: Number(coords.lng) };
  }
  if (query) return { kind: "query", value: query };
  return null;
}

/**
 * Google Maps URL for nav buttons and inline location links.
 * With home origin → directions route; otherwise venue search / pin.
 */
function buildMapsNavUrl(event, opts = {}) {
  if (event?._proximity?.reason === "virtual") return null;
  if (event?.online_url && !event?.location_key) return null;

  const dest = resolveMapsDestination(event);
  if (!dest) return null;

  const origin = opts.home || null;
  const originParam = formatMapsOriginParam(origin);
  const modeQ =
    opts.travelMode && ["walking", "driving", "bicycling", "transit"].includes(opts.travelMode)
      ? `&travelmode=${opts.travelMode}`
      : "";
  if (originParam) {
    if (dest.kind === "query") {
      return (
        "https://www.google.com/maps/dir/?api=1" +
        `&origin=${originParam}&destination=${encodeURIComponent(dest.value)}${modeQ}`
      );
    }
    return (
      "https://www.google.com/maps/dir/?api=1" +
      `&origin=${originParam}&destination=${dest.lat},${dest.lng}${modeQ}`
    );
  }

  // No home — still open the walking/driving tab when the user set a mode.
  if (modeQ) {
    if (dest.kind === "query") {
      return (
        "https://www.google.com/maps/dir/?api=1" +
        `&destination=${encodeURIComponent(dest.value)}${modeQ}`
      );
    }
    return (
      "https://www.google.com/maps/dir/?api=1" +
      `&destination=${dest.lat},${dest.lng}${modeQ}`
    );
  }

  if (dest.kind === "query") {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(dest.value)}`;
  }
  return `https://www.google.com/maps?q=${dest.lat},${dest.lng}`;
}

// Build the three deep-link URLs we offer in the picker. Exposed
// for the bot's callback handler — keeps the URL construction in
// one place so a missing param (e.g. trailing `?` vs `&`) doesn't
// silently produce broken Waze / Maps links.
function buildNavPickerLinks(lat, lng, home = null) {
  const dest = `${lat},${lng}`;
  const origin = formatMapsOriginParam(home);
  if (origin) {
    return {
      waze: `https://www.waze.com/ul?from=${origin}&to=${dest}&navigate=yes`,
      gmaps: `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}`,
      apple: `https://maps.apple.com/?saddr=${origin}&daddr=${dest}`,
    };
  }
  return {
    waze: `https://www.waze.com/ul?ll=${dest}&navigate=yes`,
    gmaps: `https://www.google.com/maps?q=${dest}`,
    apple: `https://maps.apple.com/?q=${dest}`,
  };
}

function buildNavigateButton(event, opts = {}) {
  const url = buildMapsNavUrl(event, opts);
  if (!url) return null;
  return { text: "🧭 ניווט", url };
}

// Returns 0 or 1 buttons. We keep the ARRAY shape (not a bare button
// or null) so the call-sites that do `const top = [...nav, details]`
// don't need to change — they get a clean empty-array spread when
// nav isn't available (virtual events) and a single-element spread
// otherwise.
function buildNavButtons(event, opts = {}) {
  const btn = buildNavigateButton(event, opts);
  return btn ? [btn] : [];
}

// ────────────────────────────────────────────────────────────────────
// Event description snippets for cards
//
// Cards always carry the event description when we have one. The body
// shows a short excerpt with an inline "קרא עוד" link at the end when
// truncated (Telegram HTML <a href> → bot deep-link `evmore_<id>`).
const DESCRIPTION_SNIPPET_MAX = 120;
const READ_MORE_START_PREFIX = "evmore_";
/** /start payload — opens the normal event card (not full-description mode). */
const EVENT_CARD_START_PREFIX = "ev_";

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

/** Deep-link for inline "קרא עוד" (opens full description via /start handler). */
function buildReadMoreDeepLink(botUsername, eventId) {
  if (!botUsername || eventId == null) return null;
  return `https://t.me/${botUsername}?start=${READ_MORE_START_PREFIX}${eventId}`;
}

/**
 * Mini App deep-link for inline "קרא עוד" — opens the bot's Main Mini App
 * (the catalog) with start_param ev_<id>; the catalog redirects to the
 * single-event page (event.html?ev=<id>). Unlike a plain https link this
 * keeps the Telegram WebApp context (initData), so the event page loads
 * authenticated. Requires the bot's Main Mini App to be enabled in BotFather.
 */
function buildMiniAppReadMoreLink(botUsername, eventId) {
  if (!botUsername || eventId == null) return null;
  return `https://t.me/${botUsername}?startapp=ev_${eventId}`;
}

/** Deep-link for grouped-list titles → the representative event card. */
function buildEventCardDeepLink(botUsername, eventId) {
  if (!botUsername || eventId == null) return null;
  return `https://t.me/${botUsername}?start=${EVENT_CARD_START_PREFIX}${eventId}`;
}

function parseReadMoreStartPayload(payload) {
  const m = new RegExp(`^${READ_MORE_START_PREFIX}(\\d+)$`).exec(
    String(payload || "").trim(),
  );
  return m ? parseInt(m[1], 10) : null;
}

function parseEventCardStartPayload(payload) {
  const m = new RegExp(`^${EVENT_CARD_START_PREFIX}(\\d+)$`).exec(
    String(payload || "").trim(),
  );
  return m ? parseInt(m[1], 10) : null;
}

/**
 * HTML-safe description for event cards (parse_mode HTML).
 * Appends linked "קרא עוד" when the text is truncated.
 */
function formatDescriptionForCard(
  description,
  { fullDescription = false, readMoreHref = null, escapeHtml } = {},
) {
  if (typeof escapeHtml !== "function") {
    throw new Error("formatDescriptionForCard: escapeHtml required");
  }
  const norm = normalizeDescription(description);
  if (!norm) return null;
  if (fullDescription) return escapeHtml(norm);
  const snippet = formatDescriptionSnippet(description);
  if (!snippet) return null;
  if (descriptionNeedsReadMore(description) && readMoreHref) {
    return `${escapeHtml(snippet)} <a href="${escapeHtml(readMoreHref)}">קרא עוד</a>`;
  }
  return escapeHtml(snippet);
}

/** @deprecated Legacy callback button — prefer inline link via buildReadMoreDeepLink. */
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
  buildMapsNavUrl,
  homeOriginFromProfile,
  travelModeFromProfile,
  navOptsFromProfile,
  buildNavButtons,
  buildNavPickerLinks,
  DESCRIPTION_SNIPPET_MAX,
  normalizeDescription,
  formatDescriptionSnippet,
  formatDescriptionForCard,
  descriptionNeedsReadMore,
  buildReadMoreDeepLink,
  buildMiniAppReadMoreLink,
  buildEventCardDeepLink,
  parseReadMoreStartPayload,
  parseEventCardStartPayload,
  READ_MORE_START_PREFIX,
  EVENT_CARD_START_PREFIX,
  buildReadMoreButton,
};
