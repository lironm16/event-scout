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
const { fetchDetailHtml } = require("../lib/eventEnricher");
// extractDescription is not exported — inline the same logic via require
const { extractDescription } = (() => {
  // We need the function but it's not exported, so we re-require the module
  // and reach into it via a small shim. Since node caches modules this is
  // just a reference lookup, not a re-parse.
  // eslint-disable-next-line global-require
  const mod = require("../lib/eventEnricher");
  // The function is not exported; use fetchDetailHtml + a local cheerio parse
  // as a fallback. For simplicity we just call enrichEventData's fetch path
  // and store the result, but since we don't want Gemini we use a direct
  // cheerio extraction here.
  return mod;
})();

const cheerio = require("cheerio");

const DESCRIPTION_CHAR_CAP = 2000;
const BATCH_SIZE = 30;
const GAP_MS = 300;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractDescriptionFromHtml(html) {
  if (!html || html.length < 200) return null;
  const $ = cheerio.load(html);
  $("style, nav, header, footer, .menu, .footer, .header, script").remove();

  const heading = $("#show_theater_txt").first();
  if (heading.length) {
    const container = heading.closest(".txt_container, section, div");
    if (container.length) {
      const txt = container.text().replace(/\s+/g, " ").trim();
      if (txt.length > 40) return txt.slice(0, DESCRIPTION_CHAR_CAP);
    }
  }

  // JSON-LD
  $("script[type='application/ld+json']").each(function () {
    try {
      const parsed = JSON.parse($(this).html() || "{}");
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item?.["@type"] === "Event" && typeof item.description === "string") {
          const txt = item.description.replace(/\s+/g, " ").trim();
          if (txt.length > 40) return txt.slice(0, DESCRIPTION_CHAR_CAP);
        }
      }
    } catch {}
  });

  for (const sel of [".event_description", ".description", "#description",
    ".event-info", ".event_details", ".txt_container", "section.txt", "main"]) {
    const el = $(sel).first();
    if (el.length) {
      const txt = el.text().replace(/\s+/g, " ").trim();
      if (txt.length > 40) return txt.slice(0, DESCRIPTION_CHAR_CAP);
    }
  }
  return null;
}

async function main() {
  const smarticketSources = TENANTS.filter((t) => t.kind === "smarticket").map((t) => t.source);
  console.log("Smarticket sources:", smarticketSources);

  const { data: events, error } = await supabase
    .from("events")
    .select("id, name, source")
    .in("source", smarticketSources)
    .eq("archived", false)
    .is("description", null)
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
        const description = extractDescriptionFromHtml(html);

        if (!description) {
          console.log(`  #${ev.id} ${ev.name} — no description extracted`);
          skipped++;
        } else {
          const { error: writeErr } = await supabase
            .from("events")
            .update({ description })
            .eq("id", ev.id);
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
