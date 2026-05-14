// Merge two `locations` rows. Every event referencing the source key
// is rewritten to point at the destination key, every venue alias is
// likewise redirected, and the orphaned source row is deleted. Use
// when two rows describe the same physical place but their text
// differs by something we DON'T fold into the cache key (different
// trailing whitespace was just rolled into normalizeKey but other
// cosmetic drift can still slip in).
//
// Usage:
//   node jobs/mergeLocations.js <from_key> <to_key> [--dry-run]
//
// The script:
//   1. Verifies both rows exist.
//   2. Counts referencers (events.location_key, venue_aliases.location_key).
//   3. Rewrites events.location_key from <from_key> → <to_key>.
//   4. Rewrites venue_aliases.location_key the same way (this avoids
//      the ON DELETE CASCADE wiping aliases we'd want to keep — the
//      learned confidence on those aliases is hard-won).
//   5. Deletes the now-unreferenced source row.
//
// --dry-run prints the plan without writing anything.

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length !== 2) {
    console.error("Usage: node jobs/mergeLocations.js <from_key> <to_key> [--dry-run]");
    process.exit(2);
  }
  const [from, to] = positional;
  if (!from || !to || from === to) {
    console.error("from_key and to_key must be distinct, non-empty strings.");
    process.exit(2);
  }
  return { from, to, dryRun };
}

async function loadLocation(key) {
  const { data, error } = await supabase
    .from("locations")
    .select("key, raw_address, lat, lng, source, found, kind")
    .eq("key", key)
    .maybeSingle();
  if (error) throw new Error(`locations lookup failed: ${error.message}`);
  return data;
}

// Probe once whether `venue_aliases` exists. The migration that
// introduces it (sql/023) is optional in some installs — when the
// table is absent we silently skip alias redirection and just rely
// on the events FK + locations row deletion. The probe is cached at
// module level so the same merge run doesn't spam the schema cache.
let _aliasTableProbed = null;
async function aliasTableExists() {
  if (_aliasTableProbed != null) return _aliasTableProbed;
  const { error } = await supabase
    .from("venue_aliases")
    .select("id")
    .limit(1);
  // PostgREST surfaces "table not in schema" errors with a specific
  // message. Anything else is a real error we should re-raise.
  if (error && /Could not find the table/i.test(error.message)) {
    _aliasTableProbed = false;
    return false;
  }
  if (error) throw new Error(`venue_aliases probe failed: ${error.message}`);
  _aliasTableProbed = true;
  return true;
}

async function findReferencers(key) {
  // events.location_key — direct FK.
  const events = await supabase
    .from("events")
    .select("id, name", { count: "exact" })
    .eq("location_key", key);
  if (events.error) throw new Error(`events scan failed: ${events.error.message}`);

  // venue_aliases.location_key — also references locations(key). The
  // FK has ON DELETE CASCADE, so if we just deleted the source row
  // these aliases would die with it. We redirect explicitly to
  // preserve their confidence counters. Table is optional.
  let aliases = [];
  if (await aliasTableExists()) {
    const r = await supabase
      .from("venue_aliases")
      .select("id, alias_norm, scope, telegram_id, confidence, hit_count")
      .eq("location_key", key);
    if (r.error) throw new Error(`venue_aliases scan failed: ${r.error.message}`);
    aliases = r.data || [];
  }

  return { events: events.data || [], aliases };
}

async function rewriteEvents(fromKey, toKey) {
  const { error } = await supabase
    .from("events")
    .update({ location_key: toKey })
    .eq("location_key", fromKey);
  if (error) throw new Error(`update events.location_key failed: ${error.message}`);
}

async function rewriteAliases(fromKey, toKey) {
  if (!(await aliasTableExists())) return;
  // venue_aliases has UNIQUE (alias_norm, location_key, scope, telegram_id).
  // If a parallel alias to `toKey` with the same shape already exists,
  // the update will collide. Handle by per-row update with conflict
  // detection: if the destination row already exists, merge counters
  // into it and drop the source row instead of updating.
  const { data: srcRows, error: srcErr } = await supabase
    .from("venue_aliases")
    .select("id, alias_norm, scope, telegram_id, confidence, hit_count, last_used_at")
    .eq("location_key", fromKey);
  if (srcErr) throw new Error(`alias source fetch failed: ${srcErr.message}`);

  for (const row of srcRows || []) {
    const dstQuery = supabase
      .from("venue_aliases")
      .select("id, confidence, hit_count, last_used_at")
      .eq("location_key", toKey)
      .eq("alias_norm", row.alias_norm)
      .eq("scope", row.scope);
    // telegram_id is nullable — for global aliases it must be NULL,
    // for user aliases it must equal. Use `.is(null)` vs `.eq` accordingly.
    const dstRes = row.telegram_id == null
      ? await dstQuery.is("telegram_id", null).maybeSingle()
      : await dstQuery.eq("telegram_id", row.telegram_id).maybeSingle();
    if (dstRes.error && dstRes.error.code !== "PGRST116") {
      throw new Error(`alias dest probe failed: ${dstRes.error.message}`);
    }

    if (dstRes.data) {
      // Both source and destination aliases exist. Merge confidence
      // (sum, capped at 1.0 — that's the threshold the runtime uses
      // for auto-skip-confirmation) and hit counts; pick the latest
      // last_used_at; delete the source.
      const merged = {
        confidence: Math.min(1.0, (dstRes.data.confidence || 0) + (row.confidence || 0)),
        hit_count: (dstRes.data.hit_count || 0) + (row.hit_count || 0),
        last_used_at: row.last_used_at && row.last_used_at > (dstRes.data.last_used_at || "")
          ? row.last_used_at
          : dstRes.data.last_used_at,
      };
      const { error: upErr } = await supabase
        .from("venue_aliases")
        .update(merged)
        .eq("id", dstRes.data.id);
      if (upErr) throw new Error(`alias merge update failed: ${upErr.message}`);
      const { error: delErr } = await supabase
        .from("venue_aliases")
        .delete()
        .eq("id", row.id);
      if (delErr) throw new Error(`alias source delete failed: ${delErr.message}`);
    } else {
      // No conflict — straight redirect.
      const { error: upErr } = await supabase
        .from("venue_aliases")
        .update({ location_key: toKey })
        .eq("id", row.id);
      if (upErr) throw new Error(`alias redirect failed: ${upErr.message}`);
    }
  }
}

async function deleteLocation(key) {
  const { error } = await supabase.from("locations").delete().eq("key", key);
  if (error) throw new Error(`delete locations[${key}] failed: ${error.message}`);
}

async function main() {
  const { from, to, dryRun } = parseArgs();

  const [src, dst] = await Promise.all([loadLocation(from), loadLocation(to)]);
  if (!src) throw new Error(`Source location key "${from}" not found.`);
  if (!dst) throw new Error(`Destination location key "${to}" not found.`);

  console.log(`Merging  "${src.key}"  →  "${dst.key}"`);
  console.log(`  source: lat=${src.lat}, lng=${src.lng}, source=${src.source}, kind=${src.kind}`);
  console.log(`  dest:   lat=${dst.lat}, lng=${dst.lng}, source=${dst.source}, kind=${dst.kind}`);

  const refs = await findReferencers(from);
  console.log(`References to "${from}":`);
  console.log(`  events:        ${refs.events.length}`);
  console.log(`  venue_aliases: ${refs.aliases.length}`);

  if (dryRun) {
    console.log("\n--dry-run: no changes written.");
    return;
  }

  if (refs.events.length) {
    console.log(`Rewriting events.location_key on ${refs.events.length} row(s)...`);
    await rewriteEvents(from, to);
  }
  if (refs.aliases.length) {
    console.log(`Rewriting venue_aliases.location_key on ${refs.aliases.length} row(s)...`);
    await rewriteAliases(from, to);
  }

  await deleteLocation(from);
  console.log(`Deleted locations["${from}"]. Done.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[MergeLocations] Fatal:", err.message);
    process.exit(1);
  });
