// Backfill missing event locations from the Ramat-Gan municipal LOBBY.
//
// Some events (mostly source="ramat-gan", the Smarticket tenant — e.g. the
// "המרכז הגאה" department) are ingested WITHOUT a location: the Smarticket
// calendar JSON carries no venue, and their detail page has no structured
// address. But the SAME event appears in the city lobby (api-m.ramat-gan.muni.il)
// with a structured `eventLocation { name, address }`.
//
// The city slug id (`web-site-event-<N>`) is the CITY's id, NOT ours, so we
// match by normalized TITLE + DATE. For each of our events lacking a location,
// if the lobby has a same-title-same-date entry with an eventLocation, we
// resolve it via ensureLocationKey (the same path the scraper uses) and set
// events.location_key. NO Gemini, NO regex classification — pure structured
// cross-source location fill. (Contrast jobs/backfillCityLocations.js, which
// uses Gemini on rg-muni descriptions.)
//
//   DRY_RUN=1 node jobs/backfillLocationsFromLobby.js   # show matches, no writes
//   node jobs/backfillLocationsFromLobby.js             # apply

require("dotenv").config({ path: ".env.local" });
require("dotenv").config({ path: ".env" });

const supabase = require("../lib/supabase");
const cityApi = require("../lib/cityApi");
const { ensureLocationKey } = require("../lib/locationResolver");
const { normalizeName } = require("../lib/labelStore");

const DRY = !!process.env.DRY_RUN;
const dayKey = (d) => String(d || "").slice(0, 10);
const matchKey = (title, date) => `${normalizeName(title)}|${dayKey(date)}`;

// Recursively collect lobby entries that carry a structured eventLocation.
//   exact:  normalizeName(title)+date → { name, address }
//   byTitle: normalizeName(title) → { name, address } ONLY when every lobby
//            entry with that title resolves to the SAME venue (safe fallback
//            for fixed-venue series whose other occurrences aren't in the
//            current lobby window). Ambiguous titles (multiple venues) are
//            dropped from byTitle so we never guess wrong.
function indexLobby(lobby) {
  const exact = new Map();
  const titleAddrs = new Map(); // titleKey → Set<rawAddress>
  const titleLoc = new Map();   // titleKey → { name, address }
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
  for (const [tk, set] of titleAddrs) if (set.size === 1) byTitle.set(tk, titleLoc.get(tk));
  return { exact, byTitle };
}

function buildRawAddress(loc) {
  const name = (loc.name || "").trim();
  const addr = (loc.address || "").trim();
  if (name && addr) return `${name}, ${addr}`;
  return name || addr || null;
}

(async () => {
  const lobby = await cityApi.fetchLobby();
  const { exact, byTitle } = indexLobby(lobby);
  console.log(`lobby locations: ${exact.size} by title+date, ${byTitle.size} unambiguous by title${DRY ? "  (DRY RUN)" : ""}`);

  const { data: rows, error } = await supabase
    .from("events")
    .select("id, name, date, source")
    .eq("archived", false)
    .is("location_key", null);
  if (error) { console.error("query failed:", error.message); process.exit(1); }
  console.log(`events without location: ${(rows || []).length}`);

  let matched = 0, filled = 0;
  for (const ev of rows || []) {
    const hit = exact.get(matchKey(ev.name, ev.date)) || byTitle.get(normalizeName(ev.name));
    if (!hit) continue;
    const rawAddress = buildRawAddress(hit);
    if (!rawAddress) continue;
    matched++;
    if (DRY) {
      console.log(`#${ev.id} [${ev.source}] "${(ev.name || "").slice(0, 36)}" → "${rawAddress}"`);
      continue;
    }
    try {
      const key = await ensureLocationKey(rawAddress);
      if (!key) continue;
      const { error: uerr } = await supabase.from("events").update({ location_key: key }).eq("id", ev.id);
      if (uerr) { console.warn(`#${ev.id} update failed: ${uerr.message}`); continue; }
      filled++;
      console.log(`✓ #${ev.id} "${(ev.name || "").slice(0, 36)}" → ${key}`);
    } catch (e) {
      console.warn(`#${ev.id} ${String(e.message).slice(0, 60)}`);
    }
  }
  console.log(`\nmatched=${matched}${DRY ? "" : ` filled=${filled}`}`);
  process.exit(0);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
