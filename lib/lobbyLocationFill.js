// Cross-source location fill from the Ramat-Gan municipal lobby.
//
// source="ramat-gan" (Smarticket) events frequently lack a venue — the
// Smarticket calendar JSON carries none and their detail page has no structured
// address. The SAME event appears in the city lobby with a structured
// `eventLocation { name, address }`. The city slug id (`web-site-event-<N>`) is
// the CITY's id, not ours, so we match by normalized TITLE + DATE, with a safe
// title-only fallback when a title resolves to a single venue across the lobby.
//
// Used by:
//   • lib/cityApiScraper.js (scrapeCityApi) — runs on every city scrape, right
//     after the Smarticket scrape, to enrich the duplicate (skipped) events.
//   • jobs/backfillLocationsFromLobby.js — one-off / cron.
//
// NO Gemini, NO regex classification — pure structured cross-source fill.

const supabase = require("./supabase");
const { ensureLocationKey } = require("./locationResolver");
const { normalizeName } = require("./labelStore");
const { normalizeImageUrl } = require("./imageUrl");

const dayKey = (d) => String(d || "").slice(0, 10);
const matchKey = (title, date) => `${normalizeName(title)}|${dayKey(date)}`;

// FACTUAL fields harvested from the city lobby (not classification — audience/
// category/access stay with the Gemini enricher). Currently: location + image.
function entryFacts(o) {
  const loc = o.eventLocation;
  const name = (loc?.name || "").trim();
  const addr = (loc?.address || "").trim();
  const rawAddress = name && addr ? `${name}, ${addr}` : (name || addr || null);
  // Lobby image is a city /media/ path → store the FULL city URL so it renders
  // regardless of the (smarticket) source's image base. normalizeImageUrl
  // passes absolute URLs through; for a /media/ path it prefixes the city host.
  const imgPath = o.eventBackground?.link || o.eventBackground?.linkMobile || null;
  const image = imgPath ? normalizeImageUrl(imgPath, "rg-muni") : null;
  return (rawAddress || image) ? { rawAddress, image } : null;
}

/** Build { exact, byTitle } indexes of lobby FACTS (location + image). */
function indexLobby(lobby) {
  const exact = new Map();      // normalizeName(title)+date → facts
  const titleVals = new Map();  // titleKey → Set<serialized facts>
  const titleFacts = new Map(); // titleKey → facts
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    const title = o.title || o.shortTitle;
    const facts = entryFacts(o);
    if (title && facts) {
      const tk = normalizeName(title);
      const sig = `${facts.rawAddress || ""}|${facts.image || ""}`;
      if (o.date) {
        const k = matchKey(title, o.date);
        if (!exact.has(k)) exact.set(k, facts);
      }
      if (!titleVals.has(tk)) { titleVals.set(tk, new Set()); titleFacts.set(tk, facts); }
      titleVals.get(tk).add(sig);
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
  })(lobby);
  const byTitle = new Map();
  // Only unambiguous titles (single fact set) → safe fallback.
  for (const [tk, set] of titleVals) if (set.size === 1) byTitle.set(tk, titleFacts.get(tk));
  return { exact, byTitle };
}

/**
 * Fill missing FACTUAL fields (location, image) on active duplicate events from
 * the city lobby. Match by title+date (city slug id != ours), title-only
 * fallback for single-venue titles. NO Gemini, NO regex classification.
 * @returns {Promise<{matched:number, locations:number, images:number}>}
 */
async function fillMissingFieldsFromLobby(lobby, opts = {}) {
  const dryRun = !!opts.dryRun;
  const logger = opts.logger || console;
  const { exact, byTitle } = indexLobby(lobby);
  if (!exact.size && !byTitle.size) return { matched: 0, locations: 0, images: 0 };

  // Smarticket tenants whose duplicates appear in the city lobby.
  const { data: rows, error } = await supabase
    .from("events")
    .select("id, name, date, location_key, image")
    .eq("archived", false)
    .in("source", ["ramat-gan", "mbe-rg"])
    .or("location_key.is.null,image.is.null");
  if (error) {
    logger.warn(`[LobbyFill] event query failed: ${error.message}`);
    return { matched: 0, locations: 0, images: 0 };
  }

  let matched = 0, locations = 0, images = 0;
  for (const ev of rows || []) {
    const f = exact.get(matchKey(ev.name, ev.date)) || byTitle.get(normalizeName(ev.name));
    if (!f) continue;
    const upd = {};
    if (!ev.location_key && f.rawAddress) {
      if (dryRun) { upd.location_key = "(pending)"; }
      else {
        try { const key = await ensureLocationKey(f.rawAddress); if (key) upd.location_key = key; }
        catch (e) { logger.warn(`[LobbyFill] #${ev.id} loc ${String(e.message).slice(0, 50)}`); }
      }
    }
    if (!ev.image && f.image) upd.image = f.image;
    if (!Object.keys(upd).length) continue;
    matched++;
    if (upd.location_key) locations++;
    if (upd.image) images++;
    if (dryRun) continue;
    const { error: uerr } = await supabase.from("events").update(upd).eq("id", ev.id);
    if (uerr) logger.warn(`[LobbyFill] #${ev.id} update failed: ${uerr.message}`);
  }
  return { matched, locations, images };
}

module.exports = { fillMissingFieldsFromLobby, indexLobby };
