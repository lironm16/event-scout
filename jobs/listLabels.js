require('dotenv').config();
const supabase = require('../lib/supabase');

(async () => {
  const { data, error } = await supabase.from('labels').select('id, name, emoji').order('name');
  if (error) { console.error(error); return; }
  for (const l of data) console.log(l.id, l.emoji, l.name);
})();
