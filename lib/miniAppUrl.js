// Mini App catalog URL for bot menu button + /catalog.

// Telegram REJECTS web_app / url inline buttons whose URL isn't a valid
// https:// link — and rejecting one button rejects the WHOLE message. A
// MINIAPP_URL set without the scheme (e.g. "host/miniapp") therefore made
// EVERY teaser/newsletter card fail to send (the "🆕 אירוע חדש with no event"
// bug). So we only return the URL when it's a well-formed https URL; otherwise
// null → callers fall back to bot-native buttons and the card still sends.
function getMiniAppCatalogUrl() {
  const raw = process.env.MINIAPP_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") {
      console.warn(`[MiniApp] MINIAPP_URL is not https (${raw}) — ignoring so cards still send. Fix the env to a full https:// URL.`);
      return null;
    }
    return raw;
  } catch {
    console.warn(`[MiniApp] MINIAPP_URL is malformed (${raw}) — ignoring.`);
    return null;
  }
}

function getMiniAppPublicBaseUrl() {
  const url = getMiniAppCatalogUrl();
  if (!url) return null;
  return url.replace(/\/miniapp\/?$/, "");
}

/**
 * Mini App profile URL → opens the CATALOG with ?view=profile, which reveals
 * the profile as an in-page overlay OVER the catalog (no separate page/reload),
 * matching the in-app saved view. (profile.html still exists as a fallback.)
 */
function getMiniAppProfileUrl() {
  const url = getMiniAppCatalogUrl();
  if (!url) return null;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}view=profile`;
}

/**
 * Mini App event link → opens the CATALOG with ?ev=<id>, which shows the event
 * as an in-app modal (single, reusable, "← חזרה") OVER the catalog — instead of
 * a separate event.html window. Tapping another event swaps the same popup, so
 * no stacking windows. (event.html still exists for old links.)
 */
function getMiniAppEventUrl(eventId) {
  const url = getMiniAppCatalogUrl();
  if (!url || eventId == null) return null;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}ev=${encodeURIComponent(eventId)}`;
}

/** ⭐ Review window URL → opens review.html?ev=<id> in the Web App. */
function getMiniAppReviewUrl(eventId) {
  const url = getMiniAppCatalogUrl();
  if (!url || eventId == null) return null;
  const base = url.replace(/\/$/, "");
  return `${base}/review.html?ev=${encodeURIComponent(eventId)}`;
}

/** Inline button — opens Mini App with Telegram initData (preferred over reply keyboard). */
function catalogLaunchInlineKeyboard(url) {
  if (!url) return null;
  return {
    inline_keyboard: [[{ text: "📅 פתיחת קטלוג", web_app: { url } }]],
  };
}

module.exports = {
  getMiniAppCatalogUrl,
  getMiniAppPublicBaseUrl,
  getMiniAppProfileUrl,
  getMiniAppEventUrl,
  getMiniAppReviewUrl,
  catalogLaunchInlineKeyboard,
};
