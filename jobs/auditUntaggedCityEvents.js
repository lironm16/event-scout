require('dotenv').config();
const supabase = require('../lib/supabase');

(async () => {
  const { data, error } = await supabase
    .from('events')
    .select('id, name, audience, category, tag_ids, umbrella_slug')
    .eq('source', 'rg-muni')
    .eq('archived', false)
    .order('name');

  if (error) { console.error(error); return; }

  const untagged = data.filter(e => !e.tag_ids || e.tag_ids.length === 0);
  const tagged = data.filter(e => e.tag_ids && e.tag_ids.length > 0);

  console.log(`Total rg-muni: ${data.length}, tagged: ${tagged.length}, untagged: ${untagged.length}`);
  console.log('\n--- Untagged by audience+category ---');

  const groups = {};
  for (const e of untagged) {
    const key = `${e.audience} | ${e.category}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(e.name);
  }
  for (const [k, names] of Object.entries(groups).sort()) {
    console.log(`\n[${k}] (${names.length} events)`);
    names.slice(0, 5).forEach(n => console.log('  -', n));
    if (names.length > 5) console.log(`  ... +${names.length - 5} more`);
  }
})();
