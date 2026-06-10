// One-off / cron: backfill missing event locations from the Ramat-Gan municipal
// lobby. The same logic runs automatically inside scrapeCityApi after every city
// scrape (see lib/lobbyLocationFill.js); this script is for a manual run.
//
//   DRY_RUN=1 node jobs/backfillLocationsFromLobby.js   # count matches, no writes
//   node jobs/backfillLocationsFromLobby.js             # apply

require("dotenv").config({ path: ".env.local" });
require("dotenv").config({ path: ".env" });

const { fetchLobby } = require("../lib/cityApi");
const { fillMissingLocationsFromLobby } = require("../lib/lobbyLocationFill");

(async () => {
  const dryRun = !!process.env.DRY_RUN;
  const lobby = await fetchLobby();
  const { matched, filled } = await fillMissingLocationsFromLobby(lobby, { dryRun });
  console.log(`matched=${matched}${dryRun ? "  (DRY RUN — no writes)" : ` filled=${filled}`}`);
  process.exit(0);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
