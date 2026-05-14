// Static, deterministic replies for trivial greetings/acknowledgements.
// Bypassing the agent loop on these saves a Gemini round-trip every time
// somebody sends "תודה" or "בוקר טוב" — adds up across users.
//
// Kept tight on purpose: we deliberately don't try to handle "תודה רבה
// בקשר לקודם" intelligently here — anything past a 25-char single phrase
// goes to the agent.

const STATIC_REPLIES = {
  hi: "שלום! 👋 איך אפשר לעזור?",
  hello: "שלום! 👋 איך אפשר לעזור?",
  hey: "היי! 👋",
  yo: "היי! 👋",
  הי: "היי! 👋",
  שלום: "שלום! 👋 איך אפשר לעזור?",
  אהלן: "אהלן! 👋",
  "אהלן אהלן": "אהלן! 👋",
  "מה נשמע": "סבבה, ואצלך? 😊",
  "מה קורה": "סבבה, ואצלך? 😊",
  "בוקר טוב": "בוקר אור! ☀️",
  "בוקר אור": "בוקר טוב! ☀️",
  "ערב טוב": "ערב טוב! 🌙",
  "לילה טוב": "לילה טוב! 🌙",
  תודה: "בכיף! 😊",
  "תודה רבה": "בכיף, בכל שאלה אני כאן! 😊",
  thanks: "בכיף! 😊",
  "thank you": "בכיף! 😊",
  ok: "👍",
  okay: "👍",
  אוקי: "👍",
  אוקיי: "👍",
  סבבה: "👍",
  מעולה: "🙌",
  יופי: "🙌",
};

function getStaticReply(message) {
  if (!message) return null;
  let trimmed = message.trim().toLowerCase();
  if (trimmed.length < 2 || trimmed.length > 25) return null;
  trimmed = trimmed.replace(/[.!?…]+$/, "").trim();
  // Collapse repeated yuds in Hebrew greetings: "הייי" → "הי".
  const collapsed = trimmed.startsWith("ה") ? trimmed.replace(/י{2,}/g, "י") : trimmed;
  return STATIC_REPLIES[collapsed] || STATIC_REPLIES[trimmed] || null;
}

module.exports = { getStaticReply };
