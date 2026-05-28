// Semantic match for proactive event delivery (newsletter / digest).
//
// Background:
// -----------
// The buffer flush gathers events that pass hard filters (audience,
// age, location, access, dedup, feedback). Among those, some events
// have labels the user already follows in `interests` — those are
// "strict matches" and ship as regular cards. Other events have only
// novel labels (the user never opted into them). For that second
// bucket, we ask Gemini per-user: "given this profile, do any of
// these events fit you?"
//
// A positive answer attaches an `_semanticMatch` annotation to the
// event (the surfaced novel label id + name). The renderer adds a
// "🆕 חדש בקטלוג: <label>" subtitle + two inline buttons:
//   ➕ עוד כמו זה   (sem:add  → push label name to interests)
//   📭 לא רלוונטי   (sem:supp → push label name to suppressed_labels)
//
// A negative answer (or no novel labels at all) leaves the event as
// a plain card. We never DROP events here — that's the user's
// preference: silence ≠ rejection, only explicit "📭" rejects.
//
// Cost shape:
// -----------
// One Gemini call per (user × flush cycle), batching every
// novel-label event for that user into a single prompt. Typical
// shape: ≤10 events per call, prompt ≤2KB, response ≤500 bytes.

const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");

const PER_CALL_TIMEOUT_MS = 12_000;
const MAX_EVENTS_PER_CALL = 20; // safety bound to keep prompts compact

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    fits: {
      type: SchemaType.ARRAY,
      description:
        "Array of event ids that match the user's broader interests/profile. " +
        "Only include events that genuinely fit; omit borderline matches.",
      items: { type: SchemaType.INTEGER },
    },
  },
  required: ["fits"],
};

const SYSTEM_PROMPT = `אַת מודל שיפוט. אַת מקבלת פרופיל של משתמש/ת ורשימת אירועים שלא תויגו בתחומי העניין המפורשים שלהם. את צריכה להחזיר תת-קבוצה של מזהי האירועים שמתאימים סמנטית לפרופיל.

קריטריונים:
- שייכות תחומית רחבה: "חוגים" בפרופיל ↔ "שחייה לילדים" באירוע ↔ "סדנת DIY" באירוע. הסיכוי שיוזרית עם interest "חוגים" תאהב חוג ספציפי גבוה.
- התאמת אודיינס/גילאים: לא להציע אירוע מבוגרים למשתמשת שכל החיים שלה ילדים, וההפך.
- מיקום וזמן: כבר נבדקו, אל תסנני שוב.
- היה ב-vacuum רק עם הפרופיל. אל תמציאי קונטקסט.
- במקרה ספק → לא לכלול. עדיף לפספס התאמה רכה מאשר להציק.
- אם הפרופיל ריק או חסר signal → תחזירי מערך ריק.

החזירי JSON בלבד, בפורמט { "fits": [event_id1, event_id2, ...] }. ערכים שאינם מזהי קלט תקפים — להתעלם.`;

// Lazy-init the model — keep the singleton at module scope but defer
// construction until first call so a missing GEMINI_API_KEY doesn't
// crash the bot at require-time (the rest of the flow still works).
let _model = null;
const { isGeminiAllowed } = require("./geminiPolicy");

function getModel() {
  if (_model) return _model;
  if (!isGeminiAllowed("semantic")) return null;
  if (!process.env.GEMINI_API_KEY) return null;
  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  _model = genai.getGenerativeModel({
    model: "gemini-flash-latest",
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });
  return _model;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`${label} timeout`)), ms),
    ),
  ]);
}

// Compact a profile down to the signals Gemini cares about. We
// stringify everything to a tight Hebrew brief — sending the full
// JSON balloons the prompt without adding decisional signal.
function summarizeProfile(profile) {
  const ctx = profile?.user_context || {};
  const lines = [];
  if (ctx.gender) lines.push(`מין: ${ctx.gender}`);
  const interests = Array.isArray(ctx.interests) ? ctx.interests : [];
  if (interests.length) lines.push(`תחומי עניין: ${interests.join(", ")}`);
  const suppressed = Array.isArray(ctx.suppressed_labels)
    ? ctx.suppressed_labels
    : [];
  if (suppressed.length) {
    lines.push(`לא להציע (היוזר/ת סימן/ה כלא רלוונטי): ${suppressed.join(", ")}`);
  }
  if (Array.isArray(ctx.kids) && ctx.kids.length) {
    const kidsBrief = ctx.kids
      .map((k) => {
        const age = k.age_years != null ? `${k.age_years}y` : k.age_months != null ? `${k.age_months}m` : "?";
        return `${k.name || "ילד"} (${age})`;
      })
      .join(", ");
    lines.push(`ילדים: ${kidsBrief}`);
  }
  if (ctx.partner?.name) {
    const ageBit = ctx.partner.age ? `, ${ctx.partner.age}` : "";
    lines.push(`בן/בת זוג: ${ctx.partner.name}${ageBit}`);
  }
  const { memberKeysForCommunityPicker } = require("./communityAccess");
  const memberships = memberKeysForCommunityPicker(ctx.communities || {});
  if (memberships.length) lines.push(`קהילות (רשום/ה): ${memberships.join(", ")}`);
  return lines.length ? lines.join("\n") : "(פרופיל ריק)";
}

// Compact event row for the prompt. We include only fields that
// help judgement: id, name, tags (Hebrew names), audience, age
// range (months → years), and a 200-char description trim if
// available. Anything else (location, image, time) is irrelevant
// here.
function summarizeEvent(event) {
  const parts = [`id=${event.id}: "${event.name || "(ללא שם)"}"`];
  if (Array.isArray(event.tags) && event.tags.length) {
    parts.push(`tags=${event.tags.join("|")}`);
  }
  if (event.audience) parts.push(`audience=${event.audience}`);
  if (event.min_months != null || event.max_months != null) {
    const lo = event.min_months != null ? `${Math.round(event.min_months / 12 * 10) / 10}y` : "?";
    const hi = event.max_months != null ? `${Math.round(event.max_months / 12 * 10) / 10}y` : "?";
    parts.push(`age=${lo}-${hi}`);
  }
  return parts.join(" | ");
}

// Main entry. Returns Set<eventId> of events that fit the user.
//
// `events` is the slice of candidates that DIDN'T match by strict
// label intersection. The caller is expected to have already
// stripped events whose novel labels are all in suppressed_labels
// (those have no surface to offer, so no need to spend a Gemini
// call on them).
async function evaluateSemanticFits(profile, events) {
  if (!events?.length) return new Set();
  const model = getModel();
  if (!model) return new Set(); // no API key → silently disable feature

  // Bound prompt size. If we have more than the cap, do multiple
  // calls. This is rare in practice but defends against a flood of
  // novel-label events all hitting one user's flush.
  const fits = new Set();
  for (let i = 0; i < events.length; i += MAX_EVENTS_PER_CALL) {
    const slice = events.slice(i, i + MAX_EVENTS_PER_CALL);
    const eventLines = slice.map(summarizeEvent).join("\n");
    const payload =
      `פרופיל:\n${summarizeProfile(profile)}\n\n` +
      `אירועים מועמדים (בחרי את המתאימים סמנטית):\n${eventLines}`;
    try {
      const result = await withTimeout(
        model.generateContent({
          contents: [{ role: "user", parts: [{ text: payload }] }],
        }),
        PER_CALL_TIMEOUT_MS,
        "semantic-match",
      );
      const text = result?.response?.text?.() || "";
      const parsed = JSON.parse(text);
      const ids = Array.isArray(parsed?.fits) ? parsed.fits : [];
      const validIds = new Set(slice.map((e) => e.id));
      for (const id of ids) {
        if (validIds.has(id)) fits.add(id);
      }
    } catch (err) {
      // Soft-fail per slice. Other slices still get a chance. The
      // worst-case outcome is "no semantic decoration on these
      // events", which is the same as the pre-feature behavior.
      console.warn(`[SemanticMatch] slice ${i} failed: ${err.message}`);
    }
  }
  return fits;
}

module.exports = {
  evaluateSemanticFits,
  // exported for unit tests
  summarizeProfile,
  summarizeEvent,
  MAX_EVENTS_PER_CALL,
};
