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

const dayKey = (d) => String(d || "").slice(0, 10);
const matchKey = (title, date) => `${normalizeName(title)}|${dayKey(date)}`;

/** Build { exact: Map, byTitle: Map } indexes of lobby locations. */
function indexLobby(lobby) {
  const exact = new Map();        // normalizeName(title)+date → { name, address }
  const titleAddrs = new Map();   // titleKey → Set<rawAddress>
  const titleLoc = new Map();     // titleKey → { name, address }
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    const loc = o.eventLocation;
    const title = o.title || o.shortTitle;
    const date = o.date;
    if (loc && (loc.name || loc.address) && title) {
      const val = { name: loc.name || null, address: loc.address || null };
      const raw = `${val.name || ""}|${val.address || ""}`;
      const tk = normalizeName(title);
      if (date) {
        const k = matchKey(title, date);
        if (!exact.has(k)) exact.set(k, val);
      }
      if (!titleAddrs.has(tk)) { titleAddrs.set(tk, new Set()); titleLoc.set(tk, val); }
      titleAddrs.get(tk).add(raw);
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
  })(lobby);
  const byTitle = new Map();
  // Only unambiguous titles (single venue) → safe fallback.
  for (const [tk, set] of titleAddrs) if (set.size === 1) byTitle.set(tk, titleLoc.get(tk));
  return { exact, byTitle };
}

function buildRawAddress(loc) {
  const name = (loc.name || "").trim();
  const addr = (loc.address || "").trim();
  if (name && addr) return `${name}, ${addr}`;
  return name || addr || null;
}

/**
 * Fill location_key for active events that have none, using the city lobby.
 * @param {object} lobby  the lobby JSON (already fetched by the caller)
 * @param {object} [opts] { dryRun, logger }
 * @returns {Promise<{matched:number, filled:number}>}
 */
async function fillMissingLocationsFromLobby(lobby, opts = {}) {
  const dryRun = !!opts.dryRun;
  const logger = opts.logger || console;
  const { exact, byTitle } = indexLobby(lobby);
  if (!exact.size && !byTitle.size) return { matched: 0, filled: 0 };

  const { data: rows, error } = await supabase
    .from("events")
    .select("id, name, date")
    .eq("archived", false)
    .is("location_key", null);
  if (error) {
    logger.warn(`[LobbyLoc] event query failed: ${error.message}`);
    return { matched: 0, filled: 0 };
  }

  let matched = 0, filled = 0;
  for (const ev of rows || []) {
    const hit = exact.get(matchKey(ev.name, ev.date)) || byTitle.get(normalizeName(ev.name));
    if (!hit) continue;
    const rawAddress = buildRawAddress(hit);
    if (!rawAddress) continue;
    matched++;
    if (dryRun) continue;
    try {
      const key = await ensureLocationKey(rawAddress);
      if (!key) continue;
      const { error: uerr } = await supabase
        .from("events").update({ location_key: key }).eq("id", ev.id);
      if (!uerr) filled++;
      else logger.warn(`[LobbyLoc] #${ev.id} update failed: ${uerr.message}`);
    } catch (e) {
      logger.warn(`[LobbyLoc] #${ev.id} ${String(e.message).slice(0, 60)}`);
    }
  }
  return { matched, filled };
}

module.exports = { fillMissingLocationsFromLobby, indexLobby, buildRawAddress };
