// Mini App catalog URL for bot menu button + /catalog.

function getMiniAppCatalogUrl() {
  return process.env.MINIAPP_URL?.trim() || null;
}

function getMiniAppPublicBaseUrl() {
  const url = getMiniAppCatalogUrl();
  if (!url) return null;
  return url.replace(/\/miniapp\/?$/, "");
}

/** Mini App profile page URL (MINIAPP_URL ".../miniapp" + /profile.html). */
function getMiniAppProfileUrl() {
  const url = getMiniAppCatalogUrl();
  if (!url) return null;
  return `${url.replace(/\/$/, "")}/profile.html`;
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
  catalogLaunchInlineKeyboard,
};
