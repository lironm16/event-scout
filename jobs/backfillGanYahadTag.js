/**
 * Add tag "גן יחד" to active events whose name/description signals parent-child garden.
 * Does not remove "התפתחות" if already present — the two tags are independent.
 */
require("dotenv").config();
const supabase = require("../lib/supabase");
const labelStore = require("../lib/labelStore");

const GAN_RE = /גן\s+יחד/u;

(async () => {
  const [ganId] = await labelStore.resolveMany(["גן יחד"]);
  if (!ganId) {
    console.error('Label "גן יחד" not found — create it in labels or run enrichment once');
    process.exit(1);
  }

  const { data: events, error } = await supabase
    .from("events")
    .select("id, name, description, tag_ids")
    .eq("archived", false);

  if (error) {
    console.error(error);
    process.exit(1);
  }

  const hits = (events || []).filter((ev) => {
    const hay = `${ev.name || ""} ${ev.description || ""}`;
    return GAN_RE.test(hay);
  });
  console.log(`Found ${hits.length} events matching "גן יחד"`);

  let updated = 0;
  for (const ev of hits) {
    const tags = ev.tag_ids || [];
    if (tags.includes(ganId)) continue;
    const { error: ue } = await supabase
      .from("events")
      .update({ tag_ids: [...tags, ganId] })
      .eq("id", ev.id);
    if (ue) console.error(`  ✗ ${ev.id}`, ue.message);
    else updated++;
  }
  console.log(`Updated ${updated} events with tag «גן יחד»`);
})();
