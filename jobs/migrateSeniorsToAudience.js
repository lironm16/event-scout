// One-off: retire the community-seniors access scope.
//
// Seniors (60+) is an ordinary age audience, not an access-restricted
// community. For every event currently restricted to community-seniors:
//   - drop community-seniors from access (→ ["open"] if nothing else left)
//   - set audience = 'ותיקים'
// They stay visible to everyone but surface only to users who target
// ותיקים (the audience axis does the filtering, not a hard access block).
//
// Idempotent. DRY_RUN=1 to preview.

require("dotenv").config({ path: ".env.local" });
require("dotenv").config({ path: ".env" });
const supabase = require("./../lib/supabase");

(async () => {
  const dry = !!process.env.DRY_RUN;
  const { data, error } = await supabase
    .from("events")
    .select("id, audience, access")
    .contains("access", ["community-seniors"]);
  if (error) { console.error(error.message); process.exit(1); }

  console.log(`events restricted to community-seniors: ${(data || []).length}`);
  let updated = 0;
  for (const ev of data || []) {
    const rest = (Array.isArray(ev.access) ? ev.access : []).filter((s) => s !== "community-seniors");
    const access = rest.length ? rest : ["open"];
    const upd = { access, audience: "ותיקים" };
    if (dry) { updated++; continue; }
    const { error: uerr } = await supabase.from("events").update(upd).eq("id", ev.id);
    if (uerr) { console.warn(`#${ev.id} failed: ${uerr.message}`); continue; }
    updated++;
  }
  // Sanity: nothing should reference community-seniors afterwards.
  const { count } = await supabase
    .from("events").select("id", { count: "exact", head: true })
    .contains("access", ["community-seniors"]);
  console.log(`\n${dry ? "[DRY] " : ""}done: ${updated} event(s) ${dry ? "would be" : ""} updated. remaining community-seniors: ${dry ? "(dry)" : count}`);
  process.exit(0);
})();
