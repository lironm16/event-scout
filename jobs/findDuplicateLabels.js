// READ-ONLY: surface clusters of labels that are probably the SAME concept
// but stored as separate rows — they differ only by the definite-article "ה",
// a "מחלקת "/"מנהל " department prefix, quotes, or spacing.
//
// This aggressive fold (strips ALL leading/standalone "ה" + department words)
// is used ONLY for DETECTION — it's deliberately NOT how labels are normalised
// for storage (that would corrupt real words like "הצגה"/"הרצאה"). Review the
// output, then for each real cluster:
//   1. add the variants → canonical to LABEL_ALIASES in lib/labelStore.js
//   2. node jobs/mergeLabels.js <dupeId> <canonicalId>   (per dupe)
//
//   node jobs/findDuplicateLabels.js

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env.local"), override: true });
require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });

const supabase = require("../lib/supabase");

// Detection fold: drop quotes, "מחלקת "/"מינהל "/"אגף " prefixes, every "ה",
// and all whitespace, so phrasing/article variants collapse to one key.
function detectFold(s) {
  return String(s || "")
    .replace(/['"׳״‘’“”`]/g, "")
    .replace(/(מחלקת|מינהל|אגף|מדור)\s+/g, "") // no \b — JS \b is ASCII-only, fails before Hebrew
    .replace(/ה/g, "")
    .replace(/\s+/g, "")
    .trim();
}

(async () => {
  const { data: labels, error } = await supabase.from("labels").select("id, name, events_count");
  if (error) { console.error(error.message); process.exit(1); }
  const groups = new Map();
  for (const l of labels || []) {
    const k = detectFold(l.name);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }
  const dupes = [...groups.values()].filter((g) => g.length > 1)
    .sort((a, b) => b.reduce((s, l) => s + (l.events_count || 0), 0) - a.reduce((s, l) => s + (l.events_count || 0), 0));
  console.log(`Scanned ${labels.length} labels → ${dupes.length} likely-duplicate cluster(s):\n`);
  for (const g of dupes) {
    // canonical suggestion = most-used row in the cluster
    const sorted = [...g].sort((a, b) => (b.events_count || 0) - (a.events_count || 0));
    const canon = sorted[0];
    console.log(`  canonical → #${canon.id} "${canon.name}" (${canon.events_count} events)`);
    sorted.slice(1).forEach((l) => console.log(`     merge   ← #${l.id} "${l.name}" (${l.events_count})   →  node jobs/mergeLabels.js ${l.id} ${canon.id}`));
    console.log("");
  }
  if (!dupes.length) console.log("(no near-duplicate clusters found)");
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
