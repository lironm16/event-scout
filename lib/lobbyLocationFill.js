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

// Smarticket titles sometimes carry a trailing date-range / code that the city
// lobby title omits ("החלקה על הקרח - 8-11.6.26" vs "החלקה על הקרח"). Strip a
// trailing " - <date-ish>" so the title still matches. Applied to BOTH sides.
function stripTitleNoise(title) {
  return String(title || "")
    .replace(/\s*[-–—]\s*\d{1,2}[.\-–/]\d{1,2}(?:[.\-–/]\d{2,4})?(?:\s*[-–—]\s*\d.*)?\s*$/u, "")
    .trim();
}
const titleKey = (title) => normalizeName(stripTitleNoise(title));
const matchKey = (title, date) => `${titleKey(title)}|${dayKey(date)}`;

// LAST-RESORT venue extraction from the title itself — deterministic, NO Gemini.
// Only well-known unambiguous place prefixes (libraries) → a venue string the
// geocoder can resolve. e.g. "שעת סיפור בספריית בורוכוב עם רחלי" → "ספריית בורוכוב".
function venueFromTitle(name) {
  const m = String(name || "").match(/ספריי[תה]\s+([֐-׿][֐-׿'"\-]*)/u);
  if (m) return `ספריית ${m[1]}`;
  return null;
}

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

// Only generic connectors — keep activity/descriptor words as tokens. The
// single-venue safety guard in fuzzyFacts makes loose tokens safe (a token that
// matches many events only fills when they ALL share one venue). Stripping
// 'סדנת'/'פתוחה' earlier collapsed 'סדנת נגרות פתוחה' to a single token so the
// ≥2-token fuzzy never fired — and 'סדנת' vs 'סדנאות' broke the exact match.
const STOP_TOKENS = new Set(["עם", "של", "את", "אל", "כל"]);
function sigTokens(title) {
  return new Set(
    titleKey(title).split(/\s+/).filter((w) => w.length >= 3 && !STOP_TOKENS.has(w)),
  );
}

/** Build lobby FACTS indexes: exact (title+date), byTitle, and entries (for fuzzy). */
function indexLobby(lobby) {
  const exact = new Map();      // titleKey+date → facts
  const titleVals = new Map();  // titleKey → Set<serialized facts>
  const titleFacts = new Map(); // titleKey → facts
  const entries = [];           // [{ tokens:Set, rawAddress, facts }] for fuzzy match
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    const title = o.title || o.shortTitle;
    const facts = entryFacts(o);
    if (title && facts) {
      const tk = titleKey(title);
      const sig = `${facts.rawAddress || ""}|${facts.image || ""}`;
      if (o.date) {
        const k = matchKey(title, o.date);
        if (!exact.has(k)) exact.set(k, facts);
      }
      if (!titleVals.has(tk)) { titleVals.set(tk, new Set()); titleFacts.set(tk, facts); }
      titleVals.get(tk).add(sig);
      if (facts.rawAddress) entries.push({ tokens: sigTokens(title), rawAddress: facts.rawAddress, facts });
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
  })(lobby);
  const byTitle = new Map();
  for (const [tk, set] of titleVals) if (set.size === 1) byTitle.set(tk, titleFacts.get(tk));
  return { exact, byTitle, entries };
}

// Fuzzy fallback: catch title variants (e.g. "סדנת" vs "סדנאות"). Find lobby
// entries sharing ≥2 significant tokens; only act when they ALL resolve to ONE
// venue (safe — no guessing between competing locations).
function fuzzyFacts(name, entries) {
  const t = sigTokens(name);
  if (t.size < 2) return null;
  const cands = entries.filter((e) => {
    let shared = 0;
    for (const tok of t) if (e.tokens.has(tok)) shared++;
    return shared >= 2;
  });
  if (!cands.length) return null;
  const addrs = new Set(cands.map((c) => c.rawAddress));
  return addrs.size === 1 ? cands[0].facts : null;
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
  const { exact, byTitle, entries } = indexLobby(lobby);
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
    // Match priority: exact title+date → unambiguous title → fuzzy token
    // overlap (single-venue safe) → library venue parsed from the title.
    const f =
      exact.get(matchKey(ev.name, ev.date)) ||
      byTitle.get(titleKey(ev.name)) ||
      fuzzyFacts(ev.name, entries);
    let rawAddress = f?.rawAddress || null;
    if (!ev.location_key && !rawAddress) {
      const v = venueFromTitle(ev.name);
      if (v) rawAddress = `${v}, רמת גן`;
    }
    if (!f && !rawAddress) continue;
    const upd = {};
    if (!ev.location_key && rawAddress) {
      if (dryRun) { upd.location_key = "(pending)"; }
      else {
        try { const key = await ensureLocationKey(rawAddress); if (key) upd.location_key = key; }
        catch (e) { logger.warn(`[LobbyFill] #${ev.id} loc ${String(e.message).slice(0, 50)}`); }
      }
    }
    if (!ev.image && f?.image) upd.image = f.image;
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
