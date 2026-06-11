// One-off: migrate legacy target-audience chip ids/labels to the new model
// where chips ARE the audience_t enum values.
//
//   kids   ("ילדים ומשפחה")   → ילדים
//   babies ("תינוקות והורות")  → תינוקות
//   teens  ("נוער (12-18)")    → נוער
//   young  ("צעירים (18-35)")  → מבוגרים
//   religious ("קהל דתי")      → dropped (removed audience)
//
// Updates both user_context.target_audience_chip_ids (ids) and
// user_context.interests (labels, used by the by-label hydrate path).
// Idempotent. DRY_RUN=1 to preview.

require("dotenv").config({ path: ".env.local" });
require("dotenv").config({ path: ".env" });
const supabase = require("./../lib/supabase");

const ID_MAP = { kids: "ילדים", babies: "תינוקות", teens: "נוער", young: "מבוגרים", religious: null };
const LABEL_MAP = {
  "ילדים ומשפחה": "ילדים",
  "תינוקות והורות": "תינוקות",
  "נוער (12-18)": "נוער",
  "צעירים (18-35)": "מבוגרים",
  "קהל דתי": null,
};

function mapList(list, map) {
  if (!Array.isArray(list)) return { out: list, changed: false };
  const out = [];
  let changed = false;
  for (const v of list) {
    if (v in map) {
      changed = true;
      if (map[v] != null && !out.includes(map[v])) out.push(map[v]);
    } else {
      out.push(v);
    }
  }
  return { out: [...new Set(out)], changed };
}

(async () => {
  const dry = !!process.env.DRY_RUN;
  const { data, error } = await supabase.from("profiles").select("telegram_id, user_context");
  if (error) { console.error(error.message); process.exit(1); }

  let touched = 0;
  for (const p of data || []) {
    const c = p.user_context || {};
    const chips = mapList(c.target_audience_chip_ids, ID_MAP);
    const interests = mapList(c.interests, LABEL_MAP);
    if (!chips.changed && !interests.changed) continue;
    touched++;
    console.log(`${dry ? "[DRY] " : ""}${p.telegram_id}: chips ${JSON.stringify(c.target_audience_chip_ids)} → ${JSON.stringify(chips.out)} | interests changed=${interests.changed}`);
    if (dry) continue;
    const next = { ...c, target_audience_chip_ids: chips.out, interests: interests.out };
    const { error: uerr } = await supabase.from("profiles").update({ user_context: next }).eq("telegram_id", p.telegram_id);
    if (uerr) console.warn(`  update failed: ${uerr.message}`);
  }
  console.log(`\n${dry ? "[DRY] " : ""}done: ${touched} profile(s) ${dry ? "would be" : ""} updated.`);
  process.exit(0);
})();
