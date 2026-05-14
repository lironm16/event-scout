/**
 * One-shot migration to populate `locations` from `events.location` and
 * backfill `events.location_key`. Designed to be safe to re-run.
 *
 * Workflow:
 *   1. PRE-DDL: run this SQL once in Supabase SQL editor:
 *        ALTER TABLE public.events
 *          ADD COLUMN IF NOT EXISTS location_key TEXT
 *          REFERENCES public.locations(key) ON DELETE SET NULL ON UPDATE CASCADE;
 *
 *   2. node jobs/migrate013.js
 *      → inserts stubs into locations + sets events.location_key
 *
 *   3. POST-DDL: run this SQL once:
 *        CREATE INDEX IF NOT EXISTS idx_events_location_key
 *          ON public.events (location_key);
 *        ALTER TABLE public.events DROP COLUMN IF EXISTS location;
 *        NOTIFY pgrst, 'reload schema';
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const supabase = require("../lib/supabase");
const { normalizeKey } = require("../lib/locationStore");

async function preflight() {
  // Probe events.location_key — if it doesn't exist, user hasn't run PRE-DDL.
  const { error } = await supabase
    .from("events")
    .select("id, location_key")
    .limit(1);
  if (error && /location_key/.test(error.message)) {
    console.error("\n✗ events.location_key column is missing.\n");
    console.error("  Run this SQL in Supabase SQL Editor first:\n");
    console.error("  ALTER TABLE public.events");
    console.error("    ADD COLUMN IF NOT EXISTS location_key TEXT");
    console.error("    REFERENCES public.locations(key) ON DELETE SET NULL ON UPDATE CASCADE;\n");
    process.exit(1);
  }
  if (error) throw error;
}

async function fetchEventsWithLocation() {
  const events = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("events")
      .select("id, location, location_key")
      .not("location", "is", null)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    events.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return events;
}

async function existingLocationKeys() {
  const { data, error } = await supabase.from("locations").select("key");
  if (error) throw error;
  return new Set((data || []).map((r) => r.key));
}

async function insertStubs(stubs) {
  // Supabase has a default 1000-row limit per insert. Chunk to be safe.
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < stubs.length; i += CHUNK) {
    const slice = stubs.slice(i, i + CHUNK);
    const { error } = await supabase.from("locations").insert(slice);
    if (error) {
      // Race condition with another writer? Re-check and continue.
      console.warn(`  [insert chunk ${i / CHUNK + 1}] ${error.message}`);
      continue;
    }
    inserted += slice.length;
  }
  return inserted;
}

async function backfillEventKeys(events, missingOnly = true) {
  const CHUNK = 200;
  let updated = 0;
  const targets = events.filter((e) => {
    const key = normalizeKey(e.location);
    if (!key) return false;
    if (missingOnly && e.location_key) return false;
    return true;
  });
  for (let i = 0; i < targets.length; i += CHUNK) {
    const slice = targets.slice(i, i + CHUNK);
    await Promise.all(
      slice.map(async (e) => {
        const key = normalizeKey(e.location);
        const { error } = await supabase
          .from("events")
          .update({ location_key: key })
          .eq("id", e.id);
        if (!error) updated++;
        else console.warn(`  [event ${e.id}] ${error.message}`);
      })
    );
  }
  return updated;
}

async function main() {
  console.log("[Migrate013] Preflight...");
  await preflight();

  console.log("[Migrate013] Fetching events with non-null location...");
  const events = await fetchEventsWithLocation();
  console.log(`  → ${events.length} events`);

  const distinctRaw = new Map(); // key → first raw_address seen
  for (const e of events) {
    const key = normalizeKey(e.location);
    if (!key) continue;
    if (!distinctRaw.has(key)) distinctRaw.set(key, e.location);
  }
  console.log(`  → ${distinctRaw.size} distinct venue strings`);

  console.log("[Migrate013] Loading existing locations.key set...");
  const have = await existingLocationKeys();
  const stubs = [];
  for (const [key, raw] of distinctRaw.entries()) {
    if (have.has(key)) continue;
    stubs.push({
      key,
      raw_address: raw,
      source: "pending",
      found: null,
      kind: "unknown",
    });
  }
  console.log(`  → ${stubs.length} new stubs to insert`);

  if (stubs.length) {
    const inserted = await insertStubs(stubs);
    console.log(`[Migrate013] Inserted ${inserted}/${stubs.length} stubs`);
  }

  console.log("[Migrate013] Backfilling events.location_key...");
  const updated = await backfillEventKeys(events, true);
  console.log(`  → updated ${updated} event(s)`);

  console.log("\n[Migrate013] Data migration complete.\n");
  console.log("Now run this in Supabase SQL Editor to finish:\n");
  console.log("  CREATE INDEX IF NOT EXISTS idx_events_location_key");
  console.log("    ON public.events (location_key);");
  console.log("  ALTER TABLE public.events DROP COLUMN IF EXISTS location;");
  console.log("  NOTIFY pgrst, 'reload schema';\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[Migrate013] Fatal:", err.message);
    process.exit(1);
  });
