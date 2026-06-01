/**
 * Apply mergeContentBasedTags to events that already have a description
 * but are missing obvious topic tags (e.g. enriched before sql/053).
 */
require("dotenv").config();
const supabase = require("../lib/supabase");
const {
  mergeContentBasedTags,
  applyContentBasedTagsToEvent,
} = require("../lib/eventEnricher");
const labelStore = require("../lib/labelStore");

(async () => {
  const { data: events, error } = await supabase
    .from("events")
    .select("id, name, description, tag_ids, audience, category")
    .eq("archived", false)
    .not("description", "is", null)
    .order("id", { ascending: false })
    .limit(5000);

  if (error) {
    console.error(error);
    process.exit(1);
  }

  let updated = 0;
  for (const ev of events || []) {
    if (!String(ev.description || "").trim()) continue;
    const dict = await labelStore.fetchLabelDict(ev.tag_ids || []);
    const expanded = labelStore.expandWithDict(ev, dict);
    const merged = mergeContentBasedTags(
      { tags: expanded.tags },
      { name: ev.name, description: ev.description },
    );
    const before = new Set(
      (expanded.tags || []).map((t) => labelStore.normalizeName(String(t))),
    );
    const added = merged.tags.some(
      (t) => !before.has(labelStore.normalizeName(String(t))),
    );
    if (!added) continue;
    const ok = await applyContentBasedTagsToEvent(
      ev.id,
      ev.name,
      ev.description,
    );
    if (ok) updated++;
  }
  console.log(`Updated ${updated} events with content-based tags`);
})();
