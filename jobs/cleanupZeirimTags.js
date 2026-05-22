/**
 * One-time cleanup: remove the "צעירים" tag from events that should never
 * have had it:
 *
 *  1. Events with audience = "לכל המשפחה" / "ילדים" / "נוער" / "תינוקות" /
 *     "הורים" — the extractAudienceSubtypeTags guard was broken (compared
 *     "adults" instead of "מבוגרים"), so old events slipped through.
 *
 *  2. Events whose name matches parenting / pregnancy / baby-care patterns —
 *     the CMS ticks "צעירים (18-35)" for these because young parents attend,
 *     but the content is parenting skills, not young-adult life.
 */
"use strict";
require("dotenv").config();
const supabase = require("../lib/supabase");

const PARENTING_RE = /הורים|הורות|הריון|לידה|הנקה|תינוק|אמהות|אבהות|הכנה\s*ל/u;

const WRONG_AUDIENCES = new Set([
  "לכל המשפחה", "ילדים", "נוער", "תינוקות", "הורים",
]);

(async () => {
  // 1. Fetch צעירים label id
  const { data: lbl, error: lblErr } = await supabase
    .from("labels").select("id").eq("name", "צעירים").single();
  if (lblErr || !lbl) { console.error("label not found:", lblErr); process.exit(1); }
  const tzeirimId = lbl.id;
  console.log("צעירים label id:", tzeirimId);

  // 2. Fetch all active rg-muni events that have the tag
  const { data: events, error: evErr } = await supabase
    .from("events")
    .select("id, name, audience, tag_ids")
    .eq("archived", false)
    .eq("source", "rg-muni")
    .not("tag_ids", "is", null);
  if (evErr) { console.error(evErr); process.exit(1); }

  const toFix = events.filter(e => {
    if (!(e.tag_ids || []).includes(tzeirimId)) return false;
    if (WRONG_AUDIENCES.has(e.audience)) return true;
    if (PARENTING_RE.test(e.name || "")) return true;
    return false;
  });

  console.log(`Events to clean: ${toFix.length}`);
  toFix.forEach(e => console.log(" ", e.id, `[${e.audience}]`, e.name.slice(0, 60)));

  if (!toFix.length) { console.log("Nothing to do."); return; }

  let updated = 0, errors = 0;
  for (const ev of toFix) {
    const newTags = ev.tag_ids.filter(id => id !== tzeirimId);
    const { error } = await supabase
      .from("events")
      .update({ tag_ids: newTags })
      .eq("id", ev.id);
    if (error) { console.error(`  ✗ #${ev.id}:`, error.message); errors++; }
    else { console.log(`  ✓ #${ev.id} ${ev.name.slice(0, 40)}`); updated++; }
  }
  console.log(`\nDone: updated=${updated} errors=${errors}`);
})();
