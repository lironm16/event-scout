require('dotenv').config({ path: '/Users/liron.matityahu/Projects/private/event-scout/.env' });
const supabase = require('/Users/liron.matityahu/Projects/private/event-scout/lib/supabase');

const IDS = [51318204,60995198,58818853,59908650,54679520,71924276,95978369,65021202,69309972,99208855,67118324,50084727,76242893,84814040];

(async () => {
  const { data: evs } = await supabase
    .from('events')
    .select('id, name, tag_ids, audience, source')
    .in('id', IDS);

  // Fetch all labels in one go
  const allTagIds = [...new Set(evs.flatMap(e => e.tag_ids || []))];
  let labelMap = {};
  if (allTagIds.length) {
    const { data: lbls } = await supabase.from('labels').select('id,name').in('id', allTagIds);
    (lbls || []).forEach(l => { labelMap[l.id] = l.name; });
  }

  for (const e of evs) {
    const names = (e.tag_ids || []).map(id => labelMap[id] || `#${id}`);
    console.log(e.id, `[${names.join(', ') || 'ללא תגיות'}]`, e.name.slice(0, 45));
  }
})();
