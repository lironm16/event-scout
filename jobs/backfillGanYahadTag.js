/**
 * One-time: add tag "התפתחות" to active events whose name contains "גן יחד".
 */
require("dotenv").config();
const supabase = require("../lib/supabase");
const labelStore = require("../lib/labelStore");

(async () => {
  const [hitufutId] = await labelStore.resolveMany(["התפתחות"]);
  if (!hitufutId) {
    console.error('Label "התפתחות" not found in labels table');
    process.exit(1);
  }

  const { data: events, error } = await supabase
    .from("events")
    .select("id, name, tag_ids")
    .ilike("name", "%גן יחד%")
    .eq("archived", false);

  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log(`Found ${events.length} events with "גן יחד" in name`);

  let updated = 0;
  for (const ev of events) {
    const tags = ev.tag_ids || [];
    if (tags.includes(hitufutId)) continue;
    const { error: ue } = await supabase
      .from("events")
      .update({ tag_ids: [...tags, hitufutId] })
      .eq("id", ev.id);
    if (ue) console.error(`  ✗ ${ev.id}`, ue.message);
    else updated++;
  }
  console.log(`Updated ${updated} events with tag התפתחות`);
})();
