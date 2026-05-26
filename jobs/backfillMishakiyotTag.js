/**
 * One-time: add label 581 (משחקיות) to all events whose name contains "משחקיה".
 */
require("dotenv").config();
const supabase = require("../lib/supabase");

const MISHAKIYOT_LABEL_ID = 581;

(async () => {
  const { data: events, error } = await supabase
    .from("events")
    .select("id, name, tag_ids")
    .ilike("name", "%משחקיה%")
    .eq("archived", false);

  if (error) { console.error(error); process.exit(1); }
  console.log(`Found ${events.length} events with "משחקיה" in name`);

  let updated = 0;
  for (const ev of events) {
    const tags = ev.tag_ids || [];
    if (tags.includes(MISHAKIYOT_LABEL_ID)) continue; // already has it
    const newTags = [...tags, MISHAKIYOT_LABEL_ID];
    const { error: ue } = await supabase
      .from("events")
      .update({ tag_ids: newTags })
      .eq("id", ev.id);
    if (ue) console.error(`  ✗ ${ev.id}`, ue.message);
    else updated++;
  }
  console.log(`Updated ${updated} events with tag משחקיות`);
})();
