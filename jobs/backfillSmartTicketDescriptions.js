#!/usr/bin/env node
/**
 * Backfill descriptions for Smarticket events.
 *
 * Fetches the HTML detail page for each Smarticket event that already has
 * a description_hash (was enriched) but is missing a description, then
 * writes the extracted description to events.description.
 *
 * Does NOT re-run Gemini — labels/categories are left unchanged.
 */

require("dotenv").config();

const supabase = require("../lib/supabase");
const { TENANTS } = require("../lib/sourceUrls");
const { fetchDetailHtml, extractDescription } = require("../lib/eventEnricher");

const BATCH_SIZE = 30;
const GAP_MS = 300;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const smarticketSources = TENANTS.filter((t) => t.kind === "smarticket").map((t) => t.source);
  console.log("Smarticket sources:", smarticketSources);

  // Process all enriched Smarticket events, overwriting existing descriptions
  // so that line-break fixes and prefix stripping are applied retroactively.
  const { data: events, error } = await supabase
    .from("events")
    .select("id, name, source")
    .in("source", smarticketSources)
    .eq("archived", false)
    .not("description_hash", "is", null)
    .order("id", { ascending: true });

  if (error) { console.error("Query failed:", error.message); process.exit(1); }
  console.log(`Found ${events.length} Smarticket events missing descriptions`);

  let updated = 0, skipped = 0, errors = 0;

  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    console.log(`\nBatch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(events.length / BATCH_SIZE)}`);

    for (const ev of batch) {
      try {
        const { html } = await fetchDetailHtml(ev.id, ev.name, ev.source);
        const description = extractDescription(html);

        if (!description) {
          console.log(`  #${ev.id} ${ev.name} — no description extracted`);
          skipped++;
        } else {
          const { error: writeErr } = await supabase
            .from("events")
            .update({ description })
            .eq("id", ev.id); // overwrite — re-extraction preserves line breaks
          if (writeErr) {
            console.warn(`  #${ev.id} write failed: ${writeErr.message}`);
            errors++;
          } else {
            console.log(`  #${ev.id} ✓ ${ev.name.slice(0, 50)} (${description.length}c)`);
            updated++;
          }
        }
        await sleep(GAP_MS);
      } catch (err) {
        console.warn(`  #${ev.id} error: ${err.message}`);
        errors++;
        await sleep(GAP_MS * 2);
      }
    }
  }

  console.log(`\nDone: updated=${updated} skipped=${skipped} errors=${errors}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
