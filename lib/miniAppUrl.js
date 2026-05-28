// Mini App catalog URL for bot menu button + /catalog.

function getMiniAppCatalogUrl() {
  return process.env.MINIAPP_URL?.trim() || null;
}

function getMiniAppPublicBaseUrl() {
  const url = getMiniAppCatalogUrl();
  if (!url) return null;
  return url.replace(/\/miniapp\/?$/, "");
}

module.exports = { getMiniAppCatalogUrl, getMiniAppPublicBaseUrl };
