// Telegram flow: capture kids via free text → profile.user_context.kids

const { saveProfile, getProfile } = require("../bot/profileService");
const { parseKidsCaptureMessage } = require("./kidsProfile");
const { formatKidProfileSuffix, BIRTH_DATE_PROMPT } = require("./kidAge");

const PROMPT =
  `${BIRTH_DATE_PROMPT}\n\n` +
  "אפשר גם בשורה אחת לכמה ילדים:\n" +
  "• `תומר 15.3.2022, מיה 4.8.2019`\n" +
  "• `תומר בן שנה ומיה בת ארבע` (מומר לתאריך משוער)\n\n" +
  "בחיפוש — אירוע מתאים אם *לפחות אחד* מהילדים בגיל הנכון.";

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
      "לא הצלחתי להבין. נסי שוב, למשל: «תומר 15.3.2022» או «15.3.2022».",
    );
    return true;
  }

  try {
    const existing = await getProfile(ctx.from.id);
    const prev = existing?.user_context?.kids || [];
    const byName = new Map(prev.map((k) => [String(k.name).trim(), k]));
    for (const k of parsed) {
      byName.set(k.name, {
        name: k.name,
        ...(k.birth_date ? { birth_date: k.birth_date } : {}),
        ...(k.stages?.length ? { stages: k.stages } : {}),
      });
    }
    const kids = [...byName.values()];
    await saveProfile(ctx.from.id, { kids }, existing);
    const summary = kids
      .map((k) => `${k.name} (${formatKidProfileSuffix(k) || "—"})`)
      .join(", ");
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
