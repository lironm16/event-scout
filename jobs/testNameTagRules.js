require('dotenv').config();
const { extractTagNames } = require('../lib/cityApi');

const testCases = [
  { title: 'סדנת הכנה להורות', audienceType: [{ name: 'צעירים (18-35)' }, { name: 'מבוגרים (35-60)' }] },
  { title: 'גינת רדלר', audienceType: [{ name: 'לכל המשפחה' }] },
  { title: 'גינת השקדיה', audienceType: [{ name: 'לכל המשפחה' }] },
  { title: 'הפעלה בנושא טבע וקיימות', audienceType: [{ name: 'לכל המשפחה' }] },
  { title: 'קורס חוגי ריקוד', audienceType: [{ name: 'צעירים (18-35)' }] },
  { title: 'הרצאת גיל הזהב', audienceType: [{ name: 'גיל הזהב (60+)' }] },
];

for (const tc of testCases) {
  const lobbyEntry = { title: tc.title, audienceType: tc.audienceType, cluster: [], category: null };
  const tags = extractTagNames(lobbyEntry, {});
  console.log(`"${tc.title}" → [${tags.join(', ') || 'ללא'}]`);
}
