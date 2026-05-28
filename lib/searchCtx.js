// Shared search-hit cache for agent + deterministic router.

const SEARCH_HIT_CAP = 200;

function rememberSearchHits(ctx, events, cap = SEARCH_HIT_CAP) {
  const ids = Array.isArray(events)
    ? events.map((e) => e?.id).filter((id) => id != null)
    : [];
  ctx.lastSearchResultIds = new Set(ids);

  if (!Array.isArray(events) || !events.length) return;
  const prev = Array.isArray(ctx.lastSearchHits) ? ctx.lastSearchHits : [];
  const map = new Map(prev.map((e) => [e.id, e]));
  for (const e of events) {
    if (!e || e.id == null) continue;
    const existing = map.get(e.id);
    if (existing) {
      for (const key of Object.keys(existing)) {
        if (key.startsWith("_") && e[key] === undefined) {
          e[key] = existing[key];
        }
      }
    }
    map.set(e.id, e);
  }
  const all = [...map.values()];
  ctx.lastSearchHits = all.length > cap ? all.slice(-cap) : all;
  if (ctx.telegramId) {
    const sessionStore = require("./agent/sessionStore");
    sessionStore.setLastSearchHits(ctx.telegramId, ctx.lastSearchHits);
  }
}

module.exports = { rememberSearchHits, SEARCH_HIT_CAP };
