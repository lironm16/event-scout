// Mini App catalog URL for bot menu button + /catalog.

function getMiniAppCatalogUrl() {
  return process.env.MINIAPP_URL?.trim() || null;
}

function getMiniAppPublicBaseUrl() {
  const url = getMiniAppCatalogUrl();
  if (!url) return null;
  return url.replace(/\/miniapp\/?$/, "");
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
  catalogLaunchInlineKeyboard,
};
