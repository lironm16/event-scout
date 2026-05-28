// Telegram flow: capture kids' ages via free text → profile.user_context.kids

const { saveProfile, getProfile } = require("../bot/profileService");
const { parseKidsCaptureMessage } = require("./kidsProfile");

const PROMPT =
  "כתבי גילאי כל הילדים (ילד אחד או כמה):\n" +
  "• ילד אחד: «בן שנה וחצי»\n" +
  "• שניים: «תומר 1.5, מיה 4»\n" +
  "• שלושה: «אמה 6, תומר 1.5, מיה 4»\n" +
  "• גם עם «ו»: «תומר בן שנה ומיה בת ארבע»\n\n" +
  "בחיפוש — אירוע מתאים אם *לפחות אחד* מהילדים בגיל הנכון.\n\n" +
  "_הגיל לא מתעדכן לבד — כשמישהו גדל, עדכני שוב כאן או ב-/profile._";

function startKidsCapture(session, telegramId) {
  session.pendingKidsCapture = { telegramId: String(telegramId) };
}

async function handlePendingKidsCaptureText(ctx, message, sessionStore) {
  const session = sessionStore.ensureSession(ctx.from.id);
  if (!session.pendingKidsCapture) return false;

  delete session.pendingKidsCapture;
  const parsed = parseKidsCaptureMessage(message);
  if (!parsed.length) {
    await ctx.reply(
      "לא הצלחתי להבין. נסי שוב, למשל: «תומר 1.5, מיה 4» או «בן שנה וחצי».",
    );
    return true;
  }

  try {
    const existing = await getProfile(ctx.from.id);
    const prev = existing?.user_context?.kids || [];
    const byName = new Map(prev.map((k) => [String(k.name).trim(), k]));
    for (const k of parsed) {
      byName.set(k.name, { name: k.name, age: k.age });
    }
    const kids = [...byName.values()];
    await saveProfile(ctx.from.id, { kids }, existing);
    const summary = kids.map((k) => `${k.name} (${k.age})`).join(", ");
    await ctx.reply(`✅ עדכנתי: 👧 ${summary}\n\nאשתמש בזה לסינון אירועים לפי גיל.`);
  } catch (err) {
    console.error("[KidsCapture]", err.message);
    await ctx.reply("⚠️ לא הצלחתי לשמור. נסי שוב.");
  }
  return true;
}

module.exports = {
  PROMPT,
  startKidsCapture,
  handlePendingKidsCaptureText,
};
