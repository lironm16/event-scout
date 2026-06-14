process.env.GEMINI_MODEL = "gemini-2.5-flash";
require("dotenv").config({ path: ".env.local" });require("dotenv").config({ path: ".env" });
const supabase=require("./lib/supabase");
const enricher=require("./lib/eventEnricher");
const { resolveBounds, formatAgeRangeLabel }=require("./lib/eventAge");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// diverse sample: babies range, לא-כולל, kids, teen-grade, seniors, community, parents, adult-range
const IDS=[22536,22571,22953,3711,84030343,3787,22597,22113];
(async()=>{
  console.log("model=gemini-2.5-flash  (DRY RUN — no writes)\n");
  const { data }=await supabase.from("events").select("id,name,description,umbrella_title,audience,category,access").in("id",IDS);
  const byId=new Map((data||[]).map(r=>[r.id,r]));
  for(const id of IDS){ const ev=byId.get(id); if(!ev){console.log(`#${id} not found\n`);continue;}
    try{ const r=await enricher.callGemini(ev.name,ev.description||"",[],ev.umbrella_title||null);
      const b=resolveBounds(r.age_range);
      console.log(`#${ev.id} "${(ev.name||"").slice(0,46)}"`);
      console.log(`   audience=${r.audience}  category=${r.category}  emoji=${r.emoji||"-"}`);
      console.log(`   age="${formatAgeRangeLabel(r.age_range)}" [${b.min_months}..${b.max_months}]  dev=${JSON.stringify(r.dev_stages)}`);
      console.log(`   access=${JSON.stringify(r.access)}  tags=${JSON.stringify(r.tags)}`);
      console.log(`   (DB: aud=${ev.audience} cat=${ev.category} access=${JSON.stringify(ev.access)})\n`);
    }catch(e){console.log(`#${id} ERR ${e.message.slice(0,70)}\n`);}
    await sleep(13000);
  }
})();
