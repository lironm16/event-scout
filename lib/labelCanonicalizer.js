// Gemini gate for NEW label creation.
//
// When getOrCreateLabel is about to mint a BRAND-NEW label (no mechanical
// normalize/alias match in the dictionary), we first ask Gemini whether the
// candidate is really the SAME CONCEPT as an existing label — catching the
// semantic duplicates that mechanical normalization can't (ה' הידיעה,
// "מחלקת …" prefixes, spelling variants, clear synonyms like מוסיקה↔מוזיקה).
//
// Design principles:
//   • FAIL-OPEN: any error / missing key / rate-limit / timeout → return null
//     so the caller just creates the label. We never BLOCK enrichment on this.
//   • Validated output: Gemini must return an EXISTING name verbatim (we check
//     it against the dictionary) or "NEW" — no hallucinated names get through.
//   • Conservative: the prompt says "when in doubt → NEW" so we don't merge
//     genuinely-distinct concepts (e.g. ריקוד vs תנועה).
//   • Toggle: LABEL_CANONICALIZE_GEMINI=0 disables it (e.g. during a heavy
//     backfill where you'd rather not spend the per-label call).

const { isGeminiAllowed } = require("./geminiPolicy");

let _model = null;
function getModel() {
  if (_model !== null) return _model || null;
  if (!process.env.GEMINI_API_KEY) {
    _model = false;
    return null;
  }
  const { GoogleGenerativeAI } = require("@google/generative-ai");
  _model = new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({
    model: "gemini-flash-latest",
  });
  return _model;
}

function enabled() {
  const v = (process.env.LABEL_CANONICALIZE_GEMINI ?? "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no";
}

const TIMEOUT_MS = 8000;

/**
 * @param {string} candidate     the cleaned candidate label name
 * @param {string[]} existingNames  current dictionary label names
 * @returns {Promise<string|null>}  an EXISTING name to reuse, or null (= create new)
 */
async function canonicalizeNewLabel(candidate, existingNames) {
  if (!candidate || !Array.isArray(existingNames) || !existingNames.length) return null;
  if (!enabled()) return null;
  if (!isGeminiAllowed("enricher")) return null;
  const model = getModel();
  if (!model) return null;

  const list = existingNames.map((n) => `- ${n}`).join("\n");
  const prompt =
    `אתה אחראי על איחוד תגיות בקטלוג אירועים. נתונה תגית מועמדת חדשה ורשימת התגיות הקיימות.\n\n` +
    `כלל: אם המועמדת היא בעצם **אותו מושג** כמו תגית קיימת — כולל הבדלי ה' הידיעה, קידומת "מחלקת"/"מינהל"/"אגף", כתיב שונה, או מילה נרדפת ברורה — החזר את שם התגית הקיימת **מילה במילה**.\n` +
    `אם זה מושג חדש שאין לו מקבילה — החזר בדיוק: NEW\n` +
    `אסור למזג מושגים שונים (למשל "ריקוד" ≠ "תנועה", "יוגה" ≠ "התעמלות"). במקרה של ספק — NEW.\n` +
    `החזר שורה אחת בלבד, בלי הסבר.\n\n` +
    `תגית מועמדת: "${candidate}"\n\nתגיות קיימות:\n${list}`;

  try {
    const res = await Promise.race([
      model.generateContent(prompt),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), TIMEOUT_MS)),
    ]);
    let out = (res?.response?.text?.() || "").trim();
    out = out.replace(/^["'״׳`]+|["'״׳`]+$/g, "").trim();
    if (!out || /^new$/i.test(out)) return null;
    // Only accept an answer that is genuinely one of the existing names.
    const norm = (s) => String(s).replace(/\s+/g, " ").trim();
    const match =
      existingNames.find((n) => n === out) ||
      existingNames.find((n) => norm(n) === norm(out));
    if (match && match !== candidate) {
      console.log(`[Labels] Gemini canonicalised "${candidate}" → existing "${match}"`);
      return match;
    }
    return null;
  } catch (err) {
    // FAIL-OPEN — never block label creation on the Gemini check.
    if (!/timeout/i.test(err.message || "")) {
      console.warn(`[Labels] canonicalize check failed ("${candidate}"): ${err.message}`);
    }
    return null;
  }
}

module.exports = { canonicalizeNewLabel };
