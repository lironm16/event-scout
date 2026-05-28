require('dotenv').config();
const supabase = require('../lib/supabase');

const IDS = [99208855, 50084727, 51318204, 69309972];

(async () => {
  const { data: evs, error } = await supabase
    .from('events')
    .select('id, name, audience, source, meta')
    .in('id', IDS);

  if (error) { console.error('DB error:', error); return; }
  console.log('Found', evs?.length, 'events');
  for (const e of (evs || [])) {
    console.log('\n---', e.id, e.name);
    console.log('audience:', e.audience);
    console.log('meta:', JSON.stringify(e.meta, null, 2));
  }
})();
