// One-off backfill for `events.external_url` (sql/052).
//
// The scraper now captures `content.registerLink` and
// `schedule[].registerLink` into the new column, but rows that
// were ingested BEFORE sql/052 still have NULL. Running this
// once after applying the migration populates them all in one
// shot — no waiting for the next scrape cycle.
//
// Strategy: re-run the city scrape pipeline (`scrapeCityApi`),
// which builds fresh row payloads via buildCity{,Child}EventRow
// and upserts by (source, external_slug). The upsert overwrites
// the existing rows with the new payload INCLUDING external_url,
// so any row whose parent CMS now exposes a registerLink picks
// it up immediately.
//
// Usage:
//   node jobs/backfillExternalUrl.js          (live)
//   node jobs/backfillExternalUrl.js --dry    (no DB writes)
//
// Idempotent: re-runs are no-ops for unchanged data.

require("dotenv").config({
  path: require("path").resolve(__dirname, "..", ".env.local"),
  override: true,
});
require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });

const supabase = require("../lib/supabase");
const { scrapeCityApi } = require("../lib/cityApiScraper");

const dryRun = process.argv.includes("--dry");

(async () => {
  // Probe — does the column exist? A clear error if migration hasn't
  // been applied beats a silent upsert that drops the field.
  const probe = await supabase.from("events").select("external_url").limit(1);
  if (probe.error) {
    if (probe.error.code === "42703" || /column .* does not exist/i.test(probe.error.message || "")) {
      console.error(
        "❌ events.external_url column missing — apply sql/052 first.",
      );
      process.exit(2);
    }
    console.error("Probe failed:", probe.error.message);
    process.exit(1);
  }

  console.log("Running city-API scrape to backfill external_url…");
  const result = await scrapeCityApi({
    dryRun,
    logger: console,
  });
  console.log("Scrape result:", JSON.stringify(result, null, 2));

  // Quick summary — how many city rows now have a registration URL.
  const { count: withUrl } = await supabase
    .from("events")
    .select("*", { count: "exact", head: true })
    .eq("source", "rg-muni")
    .not("external_url", "is", null);
  const { count: totalCity } = await supabase
    .from("events")
    .select("*", { count: "exact", head: true })
    .eq("source", "rg-muni");
  console.log(
    `\nCity rows with external_url: ${withUrl}/${totalCity}` +
      (dryRun ? "  (dry-run — counts reflect pre-backfill state)" : ""),
  );
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
