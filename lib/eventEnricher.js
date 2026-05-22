// Event enrichment pipeline.
//
// For each event missing a `description_hash`:
//   1. Fetch the Smarticket detail page and extract a description blob.
//   2. MD5-hash (title + description). Title's in there so two
//      different events that happen to share boilerplate text don't
//      accidentally inherit each other's labels.
//   3. Sibling cache — if any other event with the SAME name has
//      already been enriched, copy its labels & age range over without
//      hitting Smarticket or Gemini. Big win for recurring weekly
//      shows; survives upstream DNS / rate-limit failures.
//   4. Hash cache — if the title+description hash matches an existing
//      enriched event, copy from there.
//   5. Cache miss → call Gemini with title + description. Returns:
//        { min_months, max_months, audience, category, tags[] }
//   6. Persist to the schema (sql/026 + sql/032):
//        - events.min_months, events.max_months, events.description_hash
//        - events.audience  (audience_t  ENUM)  passthrough
//        - events.category  (category_t  ENUM)  passthrough
//        - events.tag_ids[]                     resolved via lib/labelStore
//
// Audience and category are native Postgres ENUMs — the type itself
// rejects unknown values, so a hallucinated string from Gemini causes
// the UPDATE to fail loudly instead of polluting a dictionary. Tags
// stay in the `labels` dictionary because they're open-ended; new
// strings get inserted on first sight, after normalisation, so we
// don't end up with both "ל״ג בעומר" and "לג בעומר" in the same dict.

const crypto = require("crypto");
const axios = require("axios");
const cheerio = require("cheerio");
const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");
const supabase = require("./supabase");
const labelStore = require("./labelStore");
// Category inference helpers — used as a 3-tier last-resort fallback
// in `applyLabels` when both Gemini and the existing DB value left
// `category` null. Tier order = strictest first:
//   1. inferCategoryFromName            — leading word of `name`
//   2. inferCategoryFromUmbrellaTitle   — any word of umbrella title
//   3. inferCategoryFromDescription     — any word of description
// See the chain comment in applyLabels for the rationale.
const {
  inferCategoryFromName,
  inferCategoryFromUmbrellaTitle,
  inferCategoryFromDescription,
} = require("./categories");
// City-source enrichment fetches the prose description on demand from
// the municipal detail API (no DB persistence). We import the module
// rather than destructuring so the dependency is visible at the call
// site (cityApi.fetchEventDetail / cityApi.extractCityDescription).
const cityApi = require("./cityApi");

// Each Smarticket tenant hosts its event detail pages under its own
// origin. We resolve the right host PER EVENT via `lib/sourceUrls.js`
// (which is the single source of truth for tenant URLs); see
// `buildDetailUrl` below for the call site. A row without a `source`
// tag (legacy pre-sql/034) defaults to mbe-rg, matching the DB DEFAULT.
const { getSiteOrigin } = require("./sourceUrls");
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Soft cap so a single scrape cycle doesn't burn through Gemini quota
// when a large batch of new listings lands. Anything beyond this carries
// to the next cycle.
const MAX_PER_CYCLE = 20;
const DETAIL_FETCH_GAP_MS = 250;
const DESCRIPTION_CHAR_CAP = 2000;
const PER_CALL_TIMEOUT_MS = 15_000;

// ─────────────────────────────────────────────────────────────────────
// Closed enums. Mirror sql/026 seed data exactly — values are matched
// case-and-quote-insensitively in labelStore but the LLM is asked to
// return them verbatim.
// ─────────────────────────────────────────────────────────────────────
const AUDIENCES = ["תינוקות", "ילדים", "נוער", "הורים", "מבוגרים", "לכל המשפחה"];
const CATEGORIES = [
  "סדנה",
  "הצגה",
  "הופעה",
  "הפעלה",
  "הרצאה",
  "משחקייה",
  "מסיבה",
  "ארוחה",
  "מפגש",
  "סיור",
  "ספורט",
  "אחר",
];

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    // Numeric age range. Null when the description is silent on age.
    // Convention: 0 = from birth; 1200 (= 100y) is our "no upper bound"
    // sentinel for family / all-ages events.
    min_months: { type: SchemaType.INTEGER, nullable: true },
    max_months: { type: SchemaType.INTEGER, nullable: true },
    // Single primary audience. The numeric range above already conveys
    // age precision, so the audience field is ONE value, not a list.
    // For events that genuinely span multiple buckets (e.g. parent +
    // baby workshops), use "לכל המשפחה" — the catch-all.
    audience: { type: SchemaType.STRING, format: "enum", enum: AUDIENCES },
    category: { type: SchemaType.STRING, format: "enum", enum: CATEGORIES },
    tags: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
    },
  },
  required: ["audience", "category", "tags"],
};

const SYSTEM_PROMPT = `את מנתחת אירועים קהילתיים. עבור כל אירוע שאני אתן לך, החזירי אובייקט JSON עם המפתחות הבאים בלבד:

- min_months / max_months: טווח גיל בחודשים. אינטיגרים, או null אם אין מידע. אסור לערב שנים — תמיד חודשים.
- audience: ערך יחיד מהאניום הסגור: תינוקות | ילדים | נוער | מבוגרים | לכל המשפחה
- category: ערך יחיד מהאניום הסגור: סדנה | הצגה | הופעה | הפעלה | הרצאה | משחקייה | מסיבה | ארוחה | מפגש | סיור | ספורט | אחר
- tags: מערך תגיות חופשיות (אפשר להחזיר מערך ריק). דוגמאות: "מוזיקה", "סדרת מפגשים", "הפנינג", "חינם", "ל״ג בעומר", "שבועות".

חוקים:

1. **מקורות מידע** — בקלט יש בדרך כלל ארבעה שדות: כותרת, "מחלקה (מהאתר)" (אופציונלי), "תגיות מהאתר" (אופציונלי), ותיאור. כולם תקפים. תיאור > כותרת > תגיות מהאתר ≈ מחלקה. אבל אם תיאור שותק לגבי גיל ובתגיות יש טווח גילאים מפורש (כמו "3-6", "0-3", "6-12"), קחי אותו מהתגיות. דוגמה: תגית "אחר-צהריים ר״גוע 3-6" → min_months=36, max_months=72. אזהרה: התגיות לעיתים מתארות אטמוספירה ("ר״גוע", "אחר-צהריים") או קטגוריה — אל תמירי טקסט כללי לתגית; השתמשי רק במידע גיל מפורש.

   **המחלקה** (כשיש) היא דף הקטגוריה של האירוע באתר העירייה / המתנ"ס. דוגמאות חשובות:
   - "מחלקת הקהילה הגאה" → הוסיפי תגית "קהילה גאה" (האירוע מיועד באופן מובהק לחברי/ות הקהילה הגאה. גם אם הכותרת ניטרלית — "פילאטיס", "סדנת בישול" — המחלקה קובעת שזה מיועד לקהילה).
   - "מחלקת הספריה העירונית" / "ספריה מרכזית" / "ספריית X" → תגית "ספרייה".
   - "מייקרס" → תגית "מייקרס" וגם תגית "DIY".
   - "מחלקת נוער וצעירים" → תגית "צעירים".
   - department כללי כמו "ר״געים משחקייה התפתחותית" → אל תוסיפי תגית מילולית מהמחלקה אם הכותרת עצמה כבר אומרת את אותו דבר.

2. **המרה לחודשים**:
   - "מלידה" / "מ-0" / "מגיל לידה" / "from birth" → 0
   - "חצי שנה" → 6
   - "שנה" / "1 year" / "age 1" → 12
   - "שנה וחצי" → 18
   - "שנתיים" → 24
   - "כיתה א'" → 72; "כיתה ו'" → 132
   - "12+" / "נוער" / "teens" → 144
   - "18+" / "מבוגר" / "adults" / "young adults" → 216
   - "לכל המשפחה" / "לכל הגילאים" / "all ages" / "family-friendly" → min=0, max=1200

3. **רמזים התפתחותיים**:
   - "מזחילה" → 6 (התחלה)
   - "מהליכה" → 12 (התחלה)
   - "לידה-זחילה" → 0 ל-6
   - "זחילה-שנתיים" → 6 ל-24

4. **טווח נומרי "X-Y" — עוקף תמיד את כללי הקהל הכלליים מ-Rule 2**:
   - אם בטקסט מופיע טווח גילאים מפורש בצורה "X-Y" / "ages X-Y" / "X-Y years" / "גילאי X עד Y" / "מגיל X עד Y" — **חובה** להחזיר את שניהם: min ו-max המדויקים. אסור להחזיר רק min ולהשאיר max=null. אסור לוותר על המספרים לטובת ברירת המחדל של Rule 2 (216 לאדולטס).
   - דוגמה מכריעה: "intended for participants ages 20-40" + "adults / young adults" באותו טקסט → min=240, max=480. אסור 216. אסור null על max. Rule 4 גובר על Rule 2 כל פעם שיש מספרים בטקסט.
   - איך לפרש את היחידה:
     • אירוע ילדים/משפחה (סדנה, הופעת ילדים, משחקייה) — היחידה היא שנים. "3-6" → min=36, max=72.
     • אירוע מבוגרים (ארוחת שישי, הרצאה מקצועית, מסיבת רווקים, "young adults", אירוע ערב) ו-X≥13 — היחידה היא **שנים**. "ages 20-40" / "20-40" → min=240, max=480.
     • חודשים מצוינים אך ורק לטווחי תינוקות (X≤24 וברור מההקשר שזה חודשים: "6 חודשים", "6 months", "0-12 months").
     • כלל אגודל: אם הטווח חוצה את גיל 18 (216 חודשים) — ודאי שזה שנים. תינוק לא נצמד לטווח של 20 שנה.
   - אם מצוין רק קצה אחד (למשל "from age 25" בלי תקרה) → min=300, max=null. רק במקרה הזה max=null מותר.

5. **חוק קהל יחיד** — audience מתאר את המשתתף הראשי. בחרי ערך אחד בלבד:
   - סדנת הורה-תינוק / הרצאה התפתחותית עם תינוקות בחדר → "לכל המשפחה" (גם תינוק וגם הורה משתתפים יחד).
   - אירוע שמכוון לטווח גילאים שחוצה כמה דליים (תינוק+ילד, ילד+נוער) → "לכל המשפחה".
   - סדנה לתינוקות בלבד (גם אם הורה נוכח כמלווה פסיבי) → "תינוקות".
   - הרצאה / סדנה / מפגש המיועד **במפורש להורים בלבד** (ללא נוכחות ילדים, למשל "הרצאה מקוונת להורים", "מפגש הורים", "קבוצת הורות") → "הורים".
   - הופעות ערב, הרצאות מקצועיות בלי ילדים נוכחים ובלי ציון "הורים" → "מבוגרים".
   - אירוע "young adults" / ארוחה קהילתית בערב / ערב הכרויות / "secular lifestyle" → "מבוגרים".
   - במקרי ספק לגבי ילדים — "לכל המשפחה" עדיף על "מבוגרים". אבל אם יש סימן ברור למבוגרים בלבד (גילאי 18+, אלכוהול, ערב חברתי, "young adults"), בחרי "מבוגרים" ולא "לכל המשפחה".

6. **תגיות מתוקננות** — בכתיב הסטנדרטי. אם תגית כבר נשמעת מוכרת, השתמשי באותו כתיב מילה במילה:
   - "ל״ג בעומר" (לא "לג בעומר" או "ל'ג בעומר")
   - "משחקייה" (לא "משחקיה")
   - "מוזיקה", "אומנות", "תיאטרון", "ספורט"
   - תגית של חג: "ל״ג בעומר", "שבועות", "פסח", "יום העצמאות", "חנוכה"
   - תגית מבנית: "סדרת מפגשים", "מנוי", "הפנינג", "חינם"
   - מונחים שכיחים נשארים כפי שהם בשיח של היוזרים: "AI" (לא "בינה מלאכותית"), "DIY" (לא "יצירה ביד").

7. **שם עצם, לא שם תואר** — תעדיפי את שם העצם:
   - "התפתחות" (לא "התפתחותי")
   - "מוזיקה" (לא "מוזיקלי")
   - "יצירה" (לא "יצירתי")

8. **תגיות = נושא, לא סוג פעילות** — שדה ה-category כבר תופס את סוג הפעילות (סדנה / סיור / הופעה / וכו׳). תגיות תתארנה את הנושא בלבד. אסור לחבר את שניהם:
   - אירוע "סדנת עששיות" → category="סדנה", tags=["עששיות"] (לא "סדנת עששיות").
   - אירוע "סיור עששיות" → category="סיור", tags=["עששיות"] (לא "סיור עששיות").
   - אירוע "מסיבת חנוכה" (אם זו מסיבה ממש לפי Rule 9) → category="מסיבה", tags=["חנוכה"] (לא "מסיבת חנוכה").
   - אירוע "ארוחת שישי קהילתית" → category="ארוחה", tags=["שבת"] (לא "ארוחת שישי").
   - אירוע "מפגש הורים" → category="מפגש", tags=["הורים"] (לא "מפגש הורים").

9. **שלוש הקטגוריות החברתיות — מסיבה / ארוחה / מפגש**. כל אירוע שבו האינטראקציה בין המשתתפים היא העיקר (ולא מופע של אמן/מרצה לקהל פסיבי) נופל לאחת מהשלוש. בחרי בסדר הבא:

   **א. category="מסיבה"** — *אווירת מסיבה ממש*. סימני זיהוי (לפחות אחד מהותי):
   - בר/אלכוהול כעיקר, ריקודים, מוזיקה רמה, DJ, רחבה.
   - "rooftop party" / "club night" / "מסיבת רחבה" / "ליין מסיבות".
   - "מסיבת חנוכה" / "מסיבת פורים" / "מסיבת יום הולדת קהילתית" כאשר התיאור מדגיש חגיגה (לא ארוחת חג משפחתית).
   - דוגמאות: "SHAVUOT PARTY בלבן על הגג" (בר + מוזיקה), "מסיבת רווקות", "club night לעולים".

   **ב. category="ארוחה"** — *מפגש שהמרכז שלו ארוחה*. הסועדים יושבים, אוכלים יחד, הארוחה היא העילה לאירוע. סימני זיהוי:
   - "ארוחת שישי" / "Shabbat dinner" / "community dinner" / "ארוחה קהילתית" / "Friday night dinner" / "ארוחת חג קהילתית" / "פוטלאך".
   - "kosher meal" / "menu" / "אנחנו מארחים אתכם לארוחה" / "האוכל עלינו" / תפריט קונקרטי.
   - גם אם יש שירה, סיפורים, ברכת המזון, kiddush — כל עוד הארוחה היא במרכז (לא דקורציה), זו "ארוחה".
   - דוגמאות: "RamatGanim Community Shabbat Dinner" (full kosher meal במרכז), "ארוחת שישי חברתית בקומה" (אוכל ביתי במרכז).

   **ג. category="מפגש"** — *מפגש חברתי בלי ארוחה כמרכז*. הקבוצה נפגשת לדבר, להכיר, לחלוק, ליצור. האוכל, אם קיים, הוא אטרקציה צדדית (קפה, כיבוד, מנה משותפת קלה, "wine & cheese tasting"):
   - "ערב הכרויות" / "mixer" / "social meetup" / "young adults night" כאשר אין ארוחה מובהקת.
   - "Wine & Cheese Night" / "tasting" / "ערב טעימות" — טעימה, לא ארוחה.
   - מועדון קריאה, חוג שיחה, קבוצת תמיכה, פורום קהילתי, מפגש שכונתי, "מפגש הורים", "ערב חברתי" כללי בלי ציון ארוחה.
   - דוגמאות: "Shavuot Wine & Cheese Night" (טעימה, לא ארוחה → מפגש), "ערב הכרויות לעולים".

   **כלל הכרעה בספק** (במצב של ביניים):
   1. *אם יש סימני מסיבה מובהקים* (בר/ריקודים/מוזיקה רמה/DJ) → "מסיבה". מסיבה גוברת.
   2. *אחרת — האם הארוחה היא העילה לאירוע?* (התפריט מתואר, סועדים יושבים סביב שולחן, "dinner" / "ארוחת..."): "ארוחה".
   3. *אחרת — מפגש חברתי בלי ארוחה במרכז*: "מפגש".

   **הבחנה מ-"הופעה"**: "הופעה" = אמן על הבמה, קהל יושב/מקשיב פסיבית. אם יש אמן מובהק עם תוכן מוזיקלי/בידורי מתוכנן וקהל ישוב מולו — "הופעה", גם אם יש שתייה ברקע.

   **הבחנה מ-"אחר"**: "אחר" נשאר אך ורק לאירועים שבאמת לא נכנסים לאף קטגוריה — טקסים רשמיים, אירועי זיכרון, פגישות מנהליות. אם זה אירוע חברתי כלשהו — בחרי בין מסיבה/ארוחה/מפגש, לא ב-"אחר".

10. **תגיות זכאות / קהילה** — לצד תגיות נושא רגילות, יש להוסיף גם תגית שמתארת מי **זכאי** לאירוע כשהאירוע מוגבל / מועדף לקבוצה ספציפית. זה ערך חיפוש חשוב: יוזרים מחפשים "אירועים לעולים חדשים" / "סטודנטים" וכו׳. כללי שילוב:
   - "עולים חדשים" / "new olim" / "olim hadashim" / "priority for new olim" → הוסיפי תגית "עולים חדשים".
   - "תושבי X בלבד" / "residents of X only" (כשהאירוע מוגבל לתושבים בלבד) → תגית "תושבי בלבד".
   - "סטודנטים" / "students" → תגית "סטודנטים".
   - "נשים בלבד" / "women only" → תגית "נשים בלבד".
   - "גברים בלבד" / "men only" → תגית "גברים בלבד".
   - חשוב: גם "priority" / "עדיפות ל-" סופרת. אם בטקסט כתוב "Priority will be given to new Olim" — זה אומר שהאירוע מכוון לעולים חדשים גם אם הוא לא בלעדי. הוסיפי את התגית.
   - תגיות הזכאות חיות בצד תגיות הנושא — לא במקומן. אירוע "Wine & Cheese Night for new Olim על שבועות" → tags=["שבועות", "יין וגבינות", "עולים חדשים"].
   - הערה: זה שונה מ-access ENUM (community-disabilities / community-lgbtq) שמטופל על ידי המחלקה (Rule 1) — תגיות זכאות הן מידע **רך** ופתוח, בעוד access הוא **קשיח** ומסנן.

11. **תגית קיימת > תגית חדשה** — אם הקלט כולל שדה "תגיות קיימות במערכת" (רשימה ממוינת לפי פופולריות), חובה לתעדף אותה לפני המצאת תגית חדשה:
   - לכל תגית שאת מתכוונת להחזיר — סרקי קודם את הרשימה הקיימת. אם יש שם פריט שמתאר את **אותה משמעות** (גם אם הכתיב/הניסוח שונה) — החזירי אותו **בדיוק כפי שכתוב ברשימה** (העתק-הדבק, אופי אחרי אופי).
   - דוגמאות:
     * אם ברשימה "קהילה גאה" ונטית להחזיר "מחלקת הקהילה הגאה" / "גאווה" / "להט״ב" → החזירי "קהילה גאה".
     * אם ברשימה "ל״ג בעומר" ונטית "לג בעומר" / "ל'ג בעומר" → החזירי "ל״ג בעומר".
     * אם ברשימה "משחקייה" ונטית "משחקיה" → החזירי "משחקייה".
     * אם ברשימה "עולים חדשים" ונטית "new olim" → החזירי "עולים חדשים".
   - תוסיפי תגית חדשה רק כשאין ברשימה הקיימת מקבילה סמנטית. כשבספק — קודם הסתכלי שוב ברשימה. עדיף שיהיו תגיות פחות מדויקות מאשר 5 וריאנטים של אותה תגית.

12. החזירי JSON תקין בלבד. אל תוסיפי שדות נוספים מעבר ל-5 הנדרשים.`;

const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genai.getGenerativeModel({
  model: "gemini-flash-latest",
  systemInstruction: SYSTEM_PROMPT,
  generationConfig: {
    temperature: 0,
    responseMimeType: "application/json",
    responseSchema: RESPONSE_SCHEMA,
  },
});

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout`)), ms)),
  ]);
}

// ─────────────────────────────────────────────────────────────────────
// Existing-tags context. We feed Gemini the current popular tag
// dictionary at every call so the model can pick an existing string
// over inventing a near-duplicate (the "מחלקת הקהילה הגאה" vs
// "קהילה גאה" failure mode that motivated this). Refreshed at most
// once per TTL window — a few KB per call is fine but hammering the
// labels table once per event isn't.
// ─────────────────────────────────────────────────────────────────────
const POPULAR_TAGS_LIMIT = 100;
const POPULAR_TAGS_TTL_MS = 5 * 60 * 1000;
let _popularTags = { fetchedAt: 0, names: [] };

async function getPopularTagsForPrompt() {
  const now = Date.now();
  if (now - _popularTags.fetchedAt < POPULAR_TAGS_TTL_MS && _popularTags.names.length) {
    return _popularTags.names;
  }
  try {
    const names = await labelStore.getPopularLabelNames(POPULAR_TAGS_LIMIT);
    _popularTags = { fetchedAt: now, names };
    return names;
  } catch (err) {
    console.warn("[Enricher] popular tags fetch failed:", err.message);
    return _popularTags.names; // serve stale rather than empty
  }
}

// ─────────────────────────────────────────────────────────────────────
// Description scraping.
//
// Smarticket renders the curated description under "פרטים נוספים",
// anchored by `#show_theater_txt` inside `.txt_container`. We strip
// the heading and pull the surrounding text. JSON-LD is a secondary
// source (less rich but always present); body text is the last-ditch
// fallback.
// ─────────────────────────────────────────────────────────────────────
// Strip boilerplate prefixes that Smarticket consistently prepends to
// every description block (e.g. the heading "פרטים נוספים" rendered as
// plain text before the actual content).
function cleanDescription(txt) {
  if (!txt) return txt;
  return txt
    .replace(/^פרטים\s+נוספים[\s:–\-–—]*/u, "")
    .replace(/^\s+/, "");
}

// Extract text from a cheerio element while preserving paragraph/line breaks.
// Block-level elements (p, div, br, li) are replaced with \n before text
// extraction so the prose structure is retained. Inline whitespace is
// collapsed to a single space; sequences of blank lines are collapsed to
// one blank line.
function cheerioText($el) {
  const clone = $el.clone();
  // <br> → explicit newline so it survives the text() call.
  // NOTE: do NOT use cheerio.load(el) inside an .each() callback on this
  // clone — sharing the underlying DOM causes the callback to silently wipe
  // text nodes on the original clone (cheerio internals mutation side-effect).
  clone.find("br").replaceWith("\n");
  return clone
    .text()
    .replace(/[^\S\n]+/g, " ")   // collapse inline whitespace, keep \n
    .replace(/\n{3,}/g, "\n\n")  // max two consecutive newlines
    .trim();
}

function extractDescription(html) {
  const $ = cheerio.load(html);
  $("style, nav, header, footer, .menu, .footer, .header").remove();

  const heading = $("#show_theater_txt").first();
  if (heading.length) {
    const container = heading.closest(".txt_container").length
      ? heading.closest(".txt_container")
      : heading.parent();
    if (container.length) {
      const clone = container.clone();
      clone.find("h1, h2, h3, h4, h5, h6, script, style").remove();
      const txt = cleanDescription(cheerioText(clone));
      if (txt.length > 40) return txt.slice(0, DESCRIPTION_CHAR_CAP);
    }
  }

  const ldNodes = $("script[type='application/ld+json']").toArray();
  for (const node of ldNodes) {
    try {
      const raw = $(node).contents().text();
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item && item["@type"] === "Event" && typeof item.description === "string") {
          // JSON-LD descriptions are already plain text — just collapse spaces.
          const txt = cleanDescription(item.description.replace(/[^\S\n]+/g, " ").trim());
          if (txt.length > 40) return txt.slice(0, DESCRIPTION_CHAR_CAP);
        }
      }
    } catch {
      /* bad JSON-LD blob — try next */
    }
  }

  $("script").remove();
  for (const sel of [".event_description", ".description", "#description", ".event-info", ".event_details", ".txt_container", "section.txt"]) {
    const el = $(sel).first();
    if (el.length) {
      const txt = cleanDescription(cheerioText(el));
      if (txt.length > 40) return txt.slice(0, DESCRIPTION_CHAR_CAP);
    }
  }

  // Intentionally no body-text fallback: Smarticket pages with no structured
  // description block have no real prose — the body contains only navigation
  // chrome, date/price metadata, and ticket-purchase UI. Returning that as a
  // "description" produces garbage like "דף הבית … לרכישת כרטיסים לחץ כאן".
  // Better to return null and show nothing.
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Smarticket-native category labels.
//
// Smarticket organises events into curator-defined "categories" that
// often encode age info the description leaves out. Concrete example:
// event 22082's prose description never says how old the kids should
// be ("הפעילות לילדים בגיל המצוין"...), but the page tag is
// "אחר-צהריים ר\"גוע 3-6" — clearly 3-6 years.
//
// Two redundant DOM locations carry these tags. We collect both and
// dedupe — Smarticket ships them as anchor links with the literal
// classname `category` (so any selector containing it picks them up),
// AND duplicates the same string into the `<title>` / og:title meta.
// We prefer the anchor copies because the meta tag concatenates
// venue + event name + label with " • " separators and we'd have to
// undo the join.
// ─────────────────────────────────────────────────────────────────────
function extractSmarticketLabels(html) {
  const $ = cheerio.load(html);
  const out = new Set();
  $('[class*="category"] a, a[class*="category"], [class*="category"]').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    // Skip absurdly long matches — `[class*="category"]` is permissive
    // enough to grab unrelated wrapper divs in some templates.
    if (t && t.length > 0 && t.length <= 80) out.add(t);
  });
  return [...out].slice(0, 6);
}

// Extract the smarticket *cluster* — the curator-defined page the event
// is grouped under (e.g. "שבת משפחה קהילה" → /page/34). Two redundant
// DOM nodes carry the same text:
//
//   <li class="breadcrumb_category"><a>שבת משפחה קהילה</a></li>
//   <div class="category"><a href="page/<n>">שבת משפחה קהילה</a></div>
//
// Either is fine; we prefer breadcrumb_category because its semantic
// role is unambiguous. Returns the cluster name, or null when the page
// has no cluster (rare — most events are clustered).
//
// Critically, this is NOT mixed back into siteLabels (which Gemini may
// or may not echo into the final tags). We persist the cluster name
// SEPARATELY, as a tag the user can search for verbatim — see
// `enrichEvent` below. Why: users describe events by the cluster
// they saw on the smarticket landing page ("שבת קהילה"), not by the
// semantic tags Gemini derives from the prose ("שבועות", "מוזיקה").
// Both indexes are useful; we keep both.
function extractSmarticketCluster(html) {
  const $ = cheerio.load(html);
  // Try breadcrumb first — it's the most reliable. Fall back to the
  // inline `div.category > a` (same text, different DOM placement
  // depending on Smarticket template version).
  for (const sel of ['li.breadcrumb_category a', 'div.category > a']) {
    const t = $(sel).first().text().replace(/\s+/g, " ").trim();
    if (t && t.length > 1 && t.length <= 80) return t;
  }
  return null;
}

/**
 * Pull the venue address from the detail page. Returns null when no
 * useful address candidate is found.
 *
 * Strategy:
 *   1. JSON-LD Event.location.streetAddress is the gold standard —
 *      structured, complete, includes city. ramat-gan exposes it.
 *      Returns "ביאליק 42, רמת גן" verbatim — perfect for geocoding.
 *   2. JSON-LD Event.location.name is the secondary signal — venue
 *      name only ("המרכז הגאה"), but the geocoder can usually
 *      resolve it once city-aware geocoding (sql/031) appends the
 *      tenant's default city.
 *   3. `.theater_name` text is the last-resort fallback for tenants
 *      that don't emit Event JSON-LD (mbe-rg's detail pages don't —
 *      they only carry the bare WebSite block). The string usually
 *      ends with "(מפת הגעה)" / "(directions)" which we strip.
 *
 * mbe-rg's detail pages don't expose any of these reliably; their
 * venue text comes from the homepage (api/enrich.js handles that).
 * For mbe-rg this function returns null and we leave the existing
 * homepage-extracted location_key intact — see the call site.
 */
// Sentinel "no real venue" values Smarticket curators leave in the
// JSON-LD `Place.name` slot when they didn't fill in a real address.
// Treating these as legitimate names buckets the event under a generic
// "כללי" location_key — hiding the actual venue (which usually exists
// further down in the prose description, captured by the 📍 fallback).
//
// Match is case-insensitive and accepts the bare word OR
// "כללי -" / "general venue" style suffixes. We intentionally do NOT
// list every possible curator typo — keep the list short, add as
// observed in production.
const ADDRESS_SENTINELS = new Set([
  "כללי",
  "general",
  "n/a",
  "tbd",
  "tba",
]);

function isAddressSentinel(s) {
  if (!s) return true;
  const lower = String(s).trim().toLocaleLowerCase("he-IL");
  return ADDRESS_SENTINELS.has(lower);
}

function extractEventAddress(html) {
  const $ = cheerio.load(html);

  // 1+2. JSON-LD walk
  const ldNodes = $('script[type="application/ld+json"]').toArray();
  for (const node of ldNodes) {
    try {
      const raw = $(node).contents().text();
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || item["@type"] !== "Event") continue;
        const loc = item.location;
        if (!loc) continue;
        const rawStreet = typeof loc.streetAddress === "string" ? loc.streetAddress.trim() : "";
        const rawName = typeof loc.name === "string" ? loc.name.trim() : "";
        // Filter out sentinel placeholders (e.g. "כללי") so the
        // description-📍 fallback below can take over. Empty strings
        // also count as sentinel — we treat "no signal" and "literal
        // placeholder" identically.
        const street = isAddressSentinel(rawStreet) ? "" : rawStreet;
        const name = isAddressSentinel(rawName) ? "" : rawName;
        // Prefer streetAddress; fall back to "<name>, <streetAddress>"
        // composite when both exist; bare name when only that exists.
        if (street && name) return `${name}, ${street}`;
        if (street) return street;
        if (name) return name;
      }
    } catch {
      /* bad JSON-LD — try next */
    }
  }

  // 3. .theater_name — prefer the Google Maps href over the visible text.
  //    Smarticket renders: <a href="maps.google.com/?q=קרניצי+1+רמת+גן+-+גג+מלון+רוקסון">(מפת הגעה)</a>
  //    The `q=` parameter already contains the full address (street + number +
  //    city) in a Google-ready format — better than anything we'd reconstruct
  //    from the label text. Fall back to text for the rare case where the link
  //    is absent or the q param is too short to be meaningful.
  const theaterEl = $(".theater_name").first();
  const mapsHref = theaterEl.find("a[href*='maps.google']").attr("href");
  if (mapsHref) {
    try {
      const qParam = new URL(mapsHref).searchParams.get("q");
      const decoded = qParam ? decodeURIComponent(qParam).replace(/\+/g, " ").trim() : "";
      if (decoded.length > 2) return decoded;
    } catch {
      // malformed URL — fall through to text
    }
  }
  const t = theaterEl.text().replace(/\s+/g, " ").trim();
  if (t) {
    const cleaned = t.replace(/\s*\([^)]+\)\s*$/u, "").trim();
    if (cleaned.length > 1) return cleaned;
  }

  // 4. Description 📍 fallback (May-2026). Some Smarticket events
  //    are uploaded WITHOUT structured location markup — no JSON-LD
  //    `Event.location` and no `.theater_name` block. The curator
  //    still spells the venue out in the prose description with a
  //    location-pin emoji, e.g. "📍 גג מלון רוקסן, קריניצי 1".
  //    Without this fallback those rows land on the generic "כללי"
  //    bucket, hiding them from proximity / navigation features.
  //
  //    We deliberately scan the prose AFTER the structured paths
  //    above: when both exist, the structured one is always more
  //    reliable (curated, geocodable, immune to copy-paste
  //    typos). Description text is the rescue ladder.
  const description = extractDescription(html);
  const fromDesc = extractAddressFromDescription(description);
  if (fromDesc) return fromDesc;

  return null;
}

// ─────────────────────────────────────────────────────────────────────
// extractAddressFromDescription
//
// Parse a Hebrew event description for the "📍 <venue text>" line that
// the Smarticket curators commonly use when they didn't fill the
// structured location field. The description we receive has already
// been normalised by `extractDescription` (whitespace collapsed to a
// single line) so we can't rely on real line breaks — instead we
// terminate the capture at the next leading-emoji "field marker"
// (📅 / 🕐 / 👥 / 💰 / 🎵 / …) that the same curators consistently
// place between metadata bullets.
//
// Conservative bounds:
//   - 4..200 chars after trimming. Below 4 is almost always a stray
//     punctuation tail ("📍 -"); above 200 means we accidentally
//     swallowed neighbouring prose because no marker followed.
//   - Trim trailing connective punctuation/whitespace.
//
// Returns the venue text, or null when no usable match. Caller routes
// the text through `ensureLocationKey` exactly like the structured
// extractors — same canonicalisation downstream, no special-casing.
function extractAddressFromDescription(description) {
  if (!description || typeof description !== "string") return null;
  // 📍 followed by venue text. Stop at the next pictographic / emoji
  // block (BMP misc symbols + most emoji ranges). We don't need to
  // exhaustively enumerate Unicode emoji ranges — the curators use a
  // small palette (📅 🕐 👥 💰 🎵 📞 ⏰ 🎟️ 🎫 etc.) all of which
  // fall inside the two ranges below.
  const m = description.match(
    /📍\s*([^\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]+)/u,
  );
  if (!m) return null;
  // Trim trailing connectives the curators sometimes leave dangling
  // before the next marker (",", "|", "•", em/en-dashes, etc.). The
  // leading whitespace was already consumed by `\s*`.
  const cleaned = m[1]
    .trim()
    .replace(/[.,;:|·•\-–—\s]+$/u, "")
    .trim();
  if (cleaned.length < 4 || cleaned.length > 200) return null;
  return cleaned;
}

/**
 * Pull the "department" label from the breadcrumb. Both Smarticket
 * tenants emit a breadcrumb of the shape:
 *
 *   דף הבית  →  <department>  →  <event name>  →  <date+time>
 *
 * (each item rendered twice: once as link, once as text — index-3 of
 *  the unique items is the department).
 *
 * Examples observed live (2026-05):
 *   - mbe-rg event #22024     →  "ר"געים משחקייה התפתחותית"
 *   - ramat-gan event #3529   →  "מחלקת הקהילה הגאה"
 *   - ramat-gan event #3361   →  "מייקרס"
 *
 * For ramat-gan in particular the department often carries identity-
 * relevant information (LGBTQ community / library / makerspace) that
 * the event title alone doesn't expose. We pass it to Gemini as an
 * additional context slot so the labels reflect it ("קהילה גאה" tag,
 * "ספרייה" tag, etc.) — see the LABELS_FROM_DEPARTMENT prompt rule.
 *
 * Returns null when the breadcrumb structure isn't present (pages
 * without a category tree, or upstream HTML changes).
 */
function extractDepartment(html) {
  const $ = cheerio.load(html);
  const items = [];
  // The breadcrumb container varies between tenants; this selector
  // matches both seen-in-the-wild forms (`.breadcrumb li`, anchors
  // under `[class*="breadcrumb"]`). We dedupe by text since each
  // visible item is rendered twice.
  $(".breadcrumb li, [class*=breadcrumb] a, [class*=breadcrumb] li").each(
    (_, el) => {
      const t = $(el).text().replace(/\s+/g, " ").trim();
      if (t && !items.includes(t)) items.push(t);
    },
  );
  // Layout: items[0] = "דף הבית", items[1] = department, items[2] = event name.
  if (items.length < 3) return null;
  const dept = items[1];
  if (!dept || dept === "דף הבית" || dept.length > 80) return null;
  return dept;
}

// Build the Smarticket detail-page URL.
//
// We always use `<origin>/event/<id>` and let Smarticket redirect us
// to whatever canonical slug it currently uses. This is simpler and
// more robust than constructing the slug ourselves.
//
// HISTORY (worth preserving — each iteration was driven by a real
// observed failure, and reverting to slug-construction without these
// notes will reintroduce the same bugs):
//
//   - Slug-form URLs were originally introduced because `/event/<id>`
//     appeared to redirect-loop on Smarticket. That symptom was
//     actually two separate bugs: (a) cookies dropped between hops by
//     axios, (b) Latin-1 mojibake of the Hebrew Location header. Both
//     are fixed in `fetchDetailHtml` below; `/event/<id>` now
//     resolves in 1 redirect.
//
//   - Hand-constructed slugs are inherently fragile. Smarticket
//     occasionally appends a numeric disambiguation suffix to the
//     canonical slug (e.g. mbe-rg #20862 →
//     "...חינוכית_מומחית_6786"), which we have no way to predict.
//     Hitting the suffix-less URL returns 404. The `/event/<id>`
//     route always works because Smarticket maintains the redirect.
//
//   - Even when our slug DID match canonical, edge cases (events
//     20001, 20743, 15693, etc.) needed bespoke truncation /
//     trailing-whitespace handling that drifted out of sync as
//     Smarticket's templating evolved.
//
// `name` and `source` were kept on the signature for API stability
// — there are tests / callers that pass them. Source decides which
// tenant origin we hit.
function buildDetailUrl(eventId, name, source) {
  return `${getSiteOrigin(source)}/event/${eventId}`;
}

// Manual redirect-follower that preserves cookies and patches a
// known Smarticket bug.
//
// Smarticket's flow:
//   1. First request → 301/302 + `Set-Cookie: website_access_token=...`
//   2. The redirect target only succeeds if the cookie is replayed.
//   3. Cookie value rotates on every hop.
//
// `axios.get(..., { maxRedirects: 5 })` strips Set-Cookie between
// hops, so each hop looks like a fresh visitor and Smarticket bounces
// the request through the redirect chain again — infinitely. The
// symptom was every detail page reporting "Maximum number of
// redirects exceeded" (`fetchDetailHtml` caught this and returned ""
// before, hiding the issue but losing all detail-page data).
//
// curl with `-L` works because it maintains a per-call cookie jar by
// default. We replicate that minimal behavior here: capture the most
// recent Set-Cookie name=value pairs and forward them as `Cookie:`
// on the next hop. No real cookie jar (no domain/path/expiry rules)
// — we only ever talk to one Smarticket host per call.
//
// Bonus fix: Smarticket's slug URL → `/event/<id>` redirect emits a
// malformed `Location: //event/3625` (double leading slash). Resolved
// against the base, that becomes `https://event/3625` — wrong host.
// We normalize `//path` → `/path` before resolving.
async function fetchDetailHtml(eventId, name, source) {
  const MAX_HOPS = 6;
  let url = buildDetailUrl(eventId, name, source);
  let cookieHeader = "";

  try {
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const res = await axios.get(url, {
        headers: {
          "User-Agent": BROWSER_UA,
          ...(cookieHeader && { Cookie: cookieHeader }),
        },
        timeout: 10_000,
        maxRedirects: 0,
        validateStatus: (s) => s < 500,
      });

      // Capture cookies from this response (replaces, not merges —
      // Smarticket rotates the same name on every hop, so the latest
      // value is always the one to send next).
      const setCookies = res.headers["set-cookie"];
      if (Array.isArray(setCookies) && setCookies.length) {
        cookieHeader = setCookies.map((c) => String(c).split(";", 1)[0]).join("; ");
      }

      if (res.status >= 200 && res.status < 300) return { html: res.data, finalUrl: url };

      const rawLoc = res.headers.location;
      if (!rawLoc) {
        if (res.status === 404) {
          // The event was deleted on Smarticket's side. Archive it so
          // it stops appearing to users without waiting for its date
          // to pass.
          await supabase
            .from("events")
            .update({ archived: true })
            .eq("id", eventId);
          console.warn(`[Enricher] #${eventId} returned 404 — archived.`);
          return { html: "", finalUrl: null };
        }
        throw new Error(`unexpected status ${res.status} with no Location`);
      }
      // Smarticket's URLs are Hebrew slugs and the Location header
      // ships raw UTF-8 bytes (not RFC 3986 percent-encoding). Node's
      // HTTP parser decodes header values as Latin-1, so what we see
      // is mojibake like "×©×¢××ª_×¡××¤××¨". Resolving that against
      // the base produces a URL the server can't recognize and it
      // bounces us through a rescue redirect — leading to an
      // infinite loop. We re-encode Latin-1 → UTF-8 to recover the
      // original bytes (curl's transparent header passthrough does
      // the same thing, which is why curl works here and axios
      // doesn't).
      const loc = Buffer.from(rawLoc, "latin1").toString("utf8");
      // Patch the `//event/3625` → `/event/3625` Smarticket bug.
      const cleaned = loc.startsWith("//") ? loc.slice(1) : loc;
      url = new URL(cleaned, url).toString();
    }
    throw new Error("Maximum number of redirects exceeded");
  } catch (err) {
    // Some events bounce permanently (deleted on Smarticket's side
    // but still listed in the calendar API, internal/test events
    // with broken canonical URLs, etc.). Treat detail-page
    // unreachability as "no description"; Gemini still gets the
    // title, and downstream callers fall back to the unclassified
    // default if the title isn't enough.
    const msg = err && (err.message || "");
    if (/maximum number of redirects/i.test(msg) || err?.code === "ENOTFOUND") {
      console.warn(`[Enricher] #${eventId} detail page unreachable (${msg.slice(0, 80)}); proceeding with title only.`);
      return { html: "", finalUrl: null };
    }
    throw err;
  }
}

/**
 * Extract the parent slug from a Smarticket canonical URL.
 *
 * Smarticket canonical URLs look like:
 *   https://ramat-gan.smarticket.co.il/רמאנגה_2_2026/?id=3684
 *   https://mbe-rg.smarticket.co.il/לידה_עד_גיל_שנה_5977/?id=22273
 *
 * The "parent slug" is the URL path segment — the same text that
 * appears on the parent show page which lists all sessions.
 * Stripping leading/trailing slashes and decoding percent-encoding
 * produces a stable string suitable for storage in `external_slug`.
 *
 * Returns null when finalUrl is absent or has no useful path.
 */
function extractParentSlug(finalUrl) {
  if (!finalUrl) return null;
  try {
    const { pathname } = new URL(finalUrl);
    // Strip leading and trailing slashes → "רמאנגה_2_2026"
    const slug = decodeURIComponent(pathname.replace(/^\/+|\/+$/g, "")).trim();
    // Ignore path segments that look like internal Smarticket routes
    // (e.g. "/event/1234") rather than user-visible slug pages.
    if (!slug || /^event\/\d+$/.test(slug)) return null;
    return slug;
  } catch {
    return null;
  }
}

// Bumped each time the response schema changes in a way that makes old
// cache entries unsafe to reuse. Mixed into the hash so a schema bump
// invalidates every previous label automatically — events get re-
// enriched on the next pass instead of inheriting stale records.
//
// v3 (2026-05-05): normalized labels schema (sql/026). min_months /
//                  max_months replace the age_group bucket; labels
//                  are stored as id columns on events.
// v4 (2026-05-05): single audience_id (sql/027) — collapsed from the
//                  earlier audience_ids[] array. Bump invalidates v3
//                  hashes so the cache doesn't accidentally surface
//                  rows that referenced the dropped column.
// v5 (2026-05-06): Smarticket-native category labels are now part of
//                  the LLM input. The labels often carry the age range
//                  (e.g. "אחר-צהריים ר\"גוע 3-6") even when the prose
//                  description doesn't — bumping invalidates v4 hashes
//                  so events that came back with null ages get a fresh
//                  Gemini pass with the new context.
// v6 (2026-05-09): Multi-tenant scraping (ramat-gan added). Department
//                  breadcrumb (e.g. "מחלקת הקהילה הגאה", "מייקרס") is
//                  now passed to Gemini; bumping invalidates v5 hashes
//                  so existing rows get re-classified with the
//                  identity-aware tags.
// v7 (2026-05-11): Added 'מסיבה' to category_t (sql/040). Wine &
//                  cheese nights, community mixers, holiday parties
//                  previously bucketed under 'אחר' should now land in
//                  'מסיבה'. Bumping invalidates v6 hashes so existing
//                  social-event rows get re-classified instead of
//                  permanently inheriting the wrong category.
// v8 (2026-05-11): Two prompt tightenings driven by event 22299
//                  ("Wine & Cheese Night, ages 20-40, priority for
//                  new olim"):
//                  (a) Rule 4 now explicitly OVERRIDES Rule 2 when
//                      a numeric X-Y range appears in the text, so
//                      "ages 20-40" yields min=240/max=480 instead
//                      of the adults-tier default (216/null).
//                  (b) New Rule 10 introduces eligibility/community
//                      tags ("עולים חדשים", "סטודנטים", "תושבי
//                      בלבד", "נשים בלבד", "גברים בלבד") that live
//                      alongside topic tags. Re-enriching invalidated
//                      rows surfaces these in search.
//                  Bumping invalidates v7 hashes so events enriched
//                  with the older prompt get re-classified.
// v9 (2026-05-11): Rule 9 split into three social categories:
//                  - 'מסיבה'  — true party vibe (bar, dancing, DJ).
//                  - 'ארוחה'  — gathering with a meal as centerpiece
//                              (community Shabbat dinner, ארוחת שישי
//                              חברתית, kosher meal events).
//                  - 'מפגש'   — social gathering without a meal
//                              centerpiece (Wine & Cheese tasting,
//                              ערב הכרויות, book club, support group).
//                  Tiebreaker: party-atmosphere wins → 'מסיבה';
//                  otherwise meal-as-centerpiece wins → 'ארוחה';
//                  otherwise → 'מפגש'.
//                  Driven by: 22297 (RamatGanim Community Shabbat
//                  Dinner) and 3586 (ארוחת שישי חברתית) landed in
//                  'מסיבה' under v8 — vibe mismatch. Bumping
//                  invalidates v8 hashes so social events get
//                  re-classified into the right of the three.
//                  Requires sql/042 to be applied before the bot is
//                  restarted, otherwise writes of 'ארוחה'/'מפגש'
//                  fail with `invalid input value for enum`.
const SCHEMA_VERSION = 9;

function hashDescription(text, title = null, labels = null, department = null) {
  if (!text && !title && !(labels && labels.length) && !department) return null;
  const labelStr = Array.isArray(labels) ? labels.join("|") : "";
  const composite =
    `v${SCHEMA_VERSION}\n${title || ""}\n---\n${text || ""}\n---\n${labelStr}\n---\n${department || ""}`;
  return crypto.createHash("md5").update(composite, "utf8").digest("hex");
}

// ─────────────────────────────────────────────────────────────────────
// Cache lookups.
//
// Two layers, both cheap:
//   - findCacheHitByHash: another event with the same MD5(title+desc)
//     that has already been enriched. Lets a fresh sibling skip Gemini.
//   - findSibling: another event with the SAME `name` that's been
//     enriched. Doesn't even require fetching Smarticket — useful when
//     the upstream site is flaky and we'd otherwise error out.
// ─────────────────────────────────────────────────────────────────────
async function findCacheHitByHash(hash, excludeId) {
  if (!hash) return null;
  // `category IS NOT NULL` is our post-sql/032 "this row was
  // processed by the new pipeline" marker. The Gemini prompt always
  // returns SOME category (even 'אחר'), so a populated category
  // guarantees we won't propagate empty labels from a stale row that
  // still carries a matching hash from before the migration.
  const { data, error } = await supabase
    .from("events")
    .select("id, min_months, max_months, description_hash, category")
    .eq("description_hash", hash)
    .neq("id", excludeId)
    .not("category", "is", null)
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingColumnError(error)) return null;
    console.warn("[Enricher] hash cache lookup failed:", error.message);
    return null;
  }
  return data || null;
}

async function findSibling(name, excludeId) {
  if (!name) return null;
  // Same `category IS NOT NULL` "is processed" marker — see
  // findCacheHitByHash for why. We additionally require a populated
  // description_hash so we never copy from a row that hasn't been
  // through Gemini at all.
  const { data, error } = await supabase
    .from("events")
    .select("id, min_months, max_months, description_hash, category")
    .eq("name", name)
    .neq("id", excludeId)
    .not("description_hash", "is", null)
    .not("category", "is", null)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingColumnError(error)) return null;
    console.warn("[Enricher] sibling lookup failed:", error.message);
    return null;
  }
  return data || null;
}

// ─────────────────────────────────────────────────────────────────────
// Gemini call. Returns the validated label object — never throws on
// individual field issues, but does throw on transport / JSON failures
// so the batch driver can surface the failure for retry.
// ─────────────────────────────────────────────────────────────────────
async function callGemini(title, description, labels = [], department = null) {
  const labelLine = labels.length
    ? `תגיות מהאתר: ${labels.join(" | ")}\n\n`
    : "";
  // The department is the breadcrumb's category page — it carries
  // identity-relevant info that the title alone often hides
  // (e.g. "מחלקת הקהילה הגאה" → an LGBTQ-community event). We surface
  // it as its own input slot so the model can decide on the right
  // tag without us hard-coding a department→tag map in JS. The system
  // prompt's tag-rules section should already cover deriving e.g.
  // "קהילה גאה", "ספרייה", "מייקרס" from this.
  const deptLine = department ? `מחלקה (מהאתר): ${department}\n\n` : "";
  // Existing-tags dictionary: rule 11 in the system prompt tells the
  // model to prefer reusing an entry here over inventing a near-
  // duplicate. Cached for a few minutes so we don't query labels on
  // every event. Empty list → skip the line so the rule effectively
  // no-ops on a fresh install.
  const popularTags = await getPopularTagsForPrompt();
  const popularLine = popularTags.length
    ? `תגיות קיימות במערכת (לפי פופולריות, השתמשי בהן במקום להמציא וריאנטים): ${popularTags.join(" | ")}\n\n`
    : "";
  const payload =
    `כותרת: ${title || "(no title)"}\n\n` +
    deptLine +
    labelLine +
    popularLine +
    `תיאור: ${description || "(no description on page)"}`;
  const result = await withTimeout(
    model.generateContent({ contents: [{ role: "user", parts: [{ text: payload }] }] }),
    PER_CALL_TIMEOUT_MS,
    "enrich",
  );
  const text = result?.response?.text?.() || "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Bad JSON from Gemini: ${err.message} (raw="${text.slice(0, 80)}")`);
  }
  return reconcileLabels({
    min_months: sanitizeMonths(parsed.min_months),
    max_months: sanitizeMonths(parsed.max_months),
    audience: AUDIENCES.includes(parsed.audience) ? parsed.audience : "לכל המשפחה",
    category: CATEGORIES.includes(parsed.category) ? parsed.category : "אחר",
    tags: filterStringArray(parsed.tags),
  });
}

function sanitizeMonths(v) {
  if (v == null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n < 0 || n > 1200) return null;
  return n;
}

function filterStringArray(arr) {
  if (!Array.isArray(arr)) return [];
  const out = new Set();
  for (const v of arr) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (trimmed) out.add(trimmed);
  }
  return [...out].slice(0, 20); // hard cap so a misbehaving response can't blow up the labels table
}

// Sanity-check the audience/age combination. Caught the same case in
// the previous schema: an event tagged "מבוגרים" with a child-aged
// range is internally inconsistent — almost always a parent-and-baby
// workshop where the lecturer addresses adults but the babies are in
// the room. Rewrite to "לכל המשפחה" so a "events for my 1-year-old"
// search doesn't filter the row out.
function reconcileLabels(labels) {
  const lo = labels.min_months;
  const hi = labels.max_months;
  const childRange =
    typeof hi === "number" && hi <= 144 && (typeof lo !== "number" || lo < 144);
  if (childRange && labels.audience === "מבוגרים") {
    return { ...labels, audience: "לכל המשפחה" };
  }
  return labels;
}

// ─────────────────────────────────────────────────────────────────────
// Persistence. Two paths:
//
//   - applyLabels: write fresh Gemini output. Updates events.min_months
//     / events.max_months / events.description_hash directly, then
//     hands audience/category strings + tag names to labelStore which
//     writes them to events.audience (ENUM), events.category (ENUM),
//     and events.tag_ids[] (FK array into the labels dict).
//
//   - copyFromSource: clone the entire labels payload (numeric range +
//     audience + category + tag_ids) from another event in one UPDATE.
//     Used by both the hash cache and the sibling cache; saves Gemini
//     calls and survives Smarticket outages.
// Persist the structured labels Gemini (or the cache) produced for
// one event. We do NOT persist the prose description — it's purely
// enrichment-time fuel for the LLM, discarded after the call. Keeping
// it out of `events` saves several KB per row at scale and there are
// no read paths that need it (sql/043 dropped the column accordingly).
async function applyLabels(eventId, labels, hash) {
  // Read existing state once so we can preserve any audience/category
  // that's already populated. Gemini occasionally returns null for
  // these slots — typically under quota pressure or when the prompt
  // skirts the schema's enum — and silently writing that null over a
  // previously-correct value (e.g. category='הרצאה' from an earlier
  // pass) is the regression we've been chasing across the rg-muni
  // backfills. With this guard a null from the model now means "no
  // change", and the existing label sticks.
  //
  // We ALSO read `name`, `umbrella_title`, `description`, and JOIN
  // the umbrella's `default_category` so the category fallback
  // chain can fire `inferCategoryFromName` / description-based
  // inference and finally fall back to the umbrella's own default
  // — without text-scanning the umbrella title at every call.
  // See the chain assembly below.
  const { data: existing } = await supabase
    .from("events")
    .select(
      "audience, category, name, umbrella_title, description, umbrella_id, umbrellas:umbrella_id(default_category)",
    )
    .eq("id", eventId)
    .maybeSingle();

  const { error } = await supabase
    .from("events")
    .update({
      min_months: labels.min_months,
      max_months: labels.max_months,
      description_hash: hash,
    })
    .eq("id", eventId);
  if (error) {
    throw new Error(`Save labels (events row) failed: ${error.message}`);
  }

  // Category fallback chain — child-first ordering. The umbrella
  // title is the LAST resort because it's a parent-level signal
  // that can mislead: "מגוון הרצאות לאזרחים ותיקים" catches every
  // child as a lecture even when a child is actually a bingo
  // night or a Shavuot party. Only fall back to the parent when
  // the child has nothing to say about itself.
  //
  //   1. Gemini output (`labels.category`)              — child
  //   2. Prior DB value (`existing.category`)            — child (prior)
  //   3. Name leading-word match                         — child, STRICT
  //         (`inferCategoryFromName` — exact first-word
  //          match against keyword inflections, avoids
  //          mid-sentence false positives.)
  //   4. Description text scan                           — child, loose
  //         (`inferCategoryFromDescription` — prefix-aware,
  //          phrase-aware; catches "ההצגה X" / "בניהולו
  //          המוזיקלי" / "שעת סיפור" etc.)
  //   5. Name text scan                                  — child, loose
  //         (`inferCategoryFromDescription(name)` — same
  //          helper, applied to the event NAME instead of
  //          the description. Catches names like
  //          "שעת סיפור בזום" where the activity phrase
  //          isn't the first word and the description is
  //          empty.)
  //   6. Umbrella default                                — PARENT, last
  //         FK lookup: `umbrellas.default_category` via the
  //         JOIN above. This is the Phase 2 replacement for
  //         the pre-sql/058 text-scan over `umbrella_title`.
  //         When the row hasn't been linked yet (legacy
  //         pre-FK rows with `umbrella_id IS NULL` but
  //         `umbrella_title` populated), we fall back to the
  //         text-scan so the existing safety net still works.
  //
  // The chain stops at the first non-null hit; we never combine.
  // Order rationale (May-2026): user principle is "always prefer
  // the child's own signal over the umbrella's; only fall back
  // to the parent when nothing else fires." The umbrella stays
  // last; everything else is the child speaking.
  const inferredFromName =
    inferCategoryFromName(existing?.name);
  const inferredFromDescription = inferredFromName
    ? null
    : inferCategoryFromDescription(existing?.description);
  const inferredFromNameLoose =
    inferredFromName || inferredFromDescription
      ? null
      : inferCategoryFromDescription(existing?.name);
  const inferredFromUmbrella =
    inferredFromName || inferredFromDescription || inferredFromNameLoose
      ? null
      : existing?.umbrella_id
        ? existing?.umbrellas?.default_category || null
        : inferCategoryFromUmbrellaTitle(existing?.umbrella_title);
  const inferredCategory =
    inferredFromName ||
    inferredFromDescription ||
    inferredFromNameLoose ||
    inferredFromUmbrella;
  await labelStore.setEventLabels(eventId, {
    audience: labels.audience || existing?.audience || null,
    category:
      labels.category || existing?.category || inferredCategory || null,
    tags: labels.tags,
  });
}

// Re-add the destination's pre-existing cluster ids on top of an
// already-applied label payload. Used after both cache paths
// (sibling + hash) on rg-muni rows so that an umbrella child cloning
// labels from a standalone sibling — or matching an unrelated row by
// description-hash — doesn't lose its scrape-time cluster tag.
//
// Idempotent: ids already present after the copy are skipped. Cheap:
// one SELECT + one UPDATE, both keyed by primary key. Safe to call
// even when `extraIds` is empty (early-return).
async function mergeBackTagIds(eventId, extraIds) {
  if (!Array.isArray(extraIds) || extraIds.length === 0) return;
  const { data: cur } = await supabase
    .from("events")
    .select("tag_ids")
    .eq("id", eventId)
    .maybeSingle();
  const existing = Array.isArray(cur?.tag_ids) ? cur.tag_ids : [];
  const seen = new Set(existing);
  const merged = [...existing];
  for (const id of extraIds) {
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(id);
    }
  }
  if (merged.length === existing.length) return; // nothing to add
  const { error } = await supabase
    .from("events")
    .update({ tag_ids: merged })
    .eq("id", eventId);
  if (error) {
    console.warn(
      `[Enricher] #${eventId} cluster merge-back failed: ${error.message}`,
    );
  }
}

async function copyFromSource(srcEvent, dstEventId) {
  // Pull the full source row in one query so the destination update is
  // atomic — no race window where age columns are populated but the
  // label payload isn't yet.
  const { data: full, error: rdErr } = await supabase
    .from("events")
    .select("min_months, max_months, description_hash, audience, category, tag_ids")
    .eq("id", srcEvent.id)
    .maybeSingle();
  if (rdErr || !full) {
    throw new Error(`Source row fetch failed: ${rdErr?.message || "no row"}`);
  }

  // Don't blank-out the destination's already-populated label slots
  // when the source happens to have a hole in the same slot. Cache
  // hits exist to amortise Gemini calls, not to lossily downgrade
  // good data already on disk — if the source's audience/category is
  // null (e.g. it was enriched before that field landed in the
  // schema, or Gemini gave up on it under load), keep what we have.
  //
  // We ALSO read the destination's name + umbrella_title + description
  // so the same name/umbrella/description category fallbacks that
  // `applyLabels` uses can fire here when both source and destination
  // came up null. Without this mirror, a cache hit on a null-categorised
  // source would skip the inference path entirely — the May-2026
  // "מסיבת שבועות under senior-lectures umbrella" bug could resurface
  // for new rows whose Gemini call short-circuits via the hash cache.
  const { data: dst } = await supabase
    .from("events")
    .select(
      "audience, category, name, umbrella_title, description, umbrella_id, umbrellas:umbrella_id(default_category)",
    )
    .eq("id", dstEventId)
    .maybeSingle();

  // Same child-first fallback chain as applyLabels (see comment
  // block there) — duplicated rather than extracted to a helper
  // because the slot ordering (source-first vs. labels-first)
  // differs between the two call sites and a shared signature
  // would obscure that. Order:
  //   name strict → description → name loose → umbrella FK / text
  const inferredFromName = inferCategoryFromName(dst?.name);
  const inferredFromDescription = inferredFromName
    ? null
    : inferCategoryFromDescription(dst?.description);
  const inferredFromNameLoose =
    inferredFromName || inferredFromDescription
      ? null
      : inferCategoryFromDescription(dst?.name);
  const inferredFromUmbrella =
    inferredFromName || inferredFromDescription || inferredFromNameLoose
      ? null
      : dst?.umbrella_id
        ? dst?.umbrellas?.default_category || null
        : inferCategoryFromUmbrellaTitle(dst?.umbrella_title);
  const inferredCategory =
    inferredFromName ||
    inferredFromDescription ||
    inferredFromNameLoose ||
    inferredFromUmbrella;

  const { error: wrErr } = await supabase
    .from("events")
    .update({
      min_months: full.min_months,
      max_months: full.max_months,
      description_hash: full.description_hash,
      audience: full.audience || dst?.audience || null,
      category:
        full.category || dst?.category || inferredCategory || null,
      tag_ids: full.tag_ids || [],
    })
    .eq("id", dstEventId);
  if (wrErr) {
    throw new Error(`copyFromSource update failed: ${wrErr.message}`);
  }
}

// Minimal fallback used when Gemini consistently times out for an
// event (typically: empty/very sparse description + the structured
// schema make the model stall indefinitely). We write a row that's
// "marked as processed" — category IS NOT NULL — but with no real
// signal, so downstream filters treat it as "unknown audience / age"
// (permissive include) rather than re-retrying every cycle.
function unclassifiedFallback() {
  return {
    min_months: null,
    max_months: null,
    audience: null,
    category: "אחר",
    tags: [],
  };
}

function isTimeoutError(err) {
  return err && /timeout/i.test(err.message || "");
}

/**
 * Best-effort venue resolution from the detail page. Idempotent and
 * safe to call on every enrichment pass:
 *
 *   - If `events.location_key` is already set, do nothing. The
 *     homepage scraper (api/enrich.js) writes there too and we don't
 *     want a recurring detail-page pass to clobber a hand-curated or
 *     better-quality value with whatever the JSON-LD says today.
 *   - If `extractEventAddress` returns null (mbe-rg detail pages
 *     mostly do; their address comes from the homepage instead),
 *     don't write anything.
 *   - Otherwise, route the text through `ensureLocationKey` (creates
 *     a pending `locations` row if new, returns the existing key if
 *     this venue has been seen before) and write the FK to events.
 *
 * Errors are logged but not thrown — a flaky locations table write
 * shouldn't take down the whole enrichment of an event whose labels
 * succeeded.
 *
 * `source` is optional; when provided we use it to suppress noisy
 * "no address" warnings for mbe-rg (whose detail pages legitimately
 * don't expose a venue). Other tenants get a warning so a regression
 * in `extractEventAddress` or a Smarticket schema change surfaces in
 * the enrich log immediately instead of silently leaving rows null.
 */
async function maybeFillLocationKey(eventId, html, source = null) {
  try {
    const { data: row } = await supabase
      .from("events")
      .select("location_key, locations:location_key(raw_address)")
      .eq("id", eventId)
      .maybeSingle();
    // Skip when there's a REAL location_key already set. We treat
    // sentinel placeholders ("כללי" / "general" / …) as if the field
    // were null — they came from a JSON-LD `Place.name` curators left
    // as a default, and the description-📍 fallback in extractEventAddress
    // routinely produces a better real address for these rows. Without
    // this carve-out a row that landed on "כללי" on first scrape would
    // be stuck there forever, since the early-return below would skip
    // every subsequent enrichment pass.
    const currentRawAddress = row?.locations?.raw_address || null;
    if (row?.location_key && !isAddressSentinel(currentRawAddress)) return;

    // Empty/short HTML means `fetchDetailHtml` failed (404, redirect
    // loop, network error). Always loud — this is never expected and
    // historically masked our slug-URL bug for weeks.
    if (!html || html.length < 500) {
      console.warn(
        `[Enricher] #${eventId} location skipped: detail page unreachable (html=${html?.length || 0}B, source=${source || "?"})`,
      );
      return;
    }

    const address = extractEventAddress(html);
    if (!address) {
      // mbe-rg detail pages legitimately omit address — quiet there.
      // For other tenants this is a real signal worth investigating.
      if (source && source !== "mbe-rg") {
        console.warn(
          `[Enricher] #${eventId} location skipped: no address found in HTML (source=${source})`,
        );
      }
      return;
    }

    const { ensureLocationKey } = require("./locationResolver");
    const key = await ensureLocationKey(address);
    if (!key) return;

    const { error } = await supabase
      .from("events")
      .update({ location_key: key })
      .eq("id", eventId);
    if (error) {
      console.warn(`[Enricher] #${eventId} location_key write failed: ${error.message}`);
    } else {
      console.log(`[Enricher] #${eventId} location filled from detail page: "${address}"`);
    }
  } catch (err) {
    console.warn(`[Enricher] #${eventId} location extraction failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Public: enrich a single event. Returns {source, labels?} so the
// batch driver can log cache vs Gemini activity.
// ─────────────────────────────────────────────────────────────────────
async function enrichEventData({ id, name, source }) {
  // 1. Sibling cache — exact-name match. Free; runs even if upstream
  //    Smarticket is down. Big resilience win for recurring shows.
  //    Source-agnostic: a city event with the same name as another
  //    city event (or, theoretically, a Smarticket event) can share
  //    enrichment.
  if (name) {
    const sib = await findSibling(name, id);
    if (sib) {
      // The sibling we're about to clone may have been enriched as
      // a standalone (umbrella_slug=null) and so its tag_ids[] won't
      // include the cluster tag(s) this row was scraped under
      // (e.g. "שבועות 2026"). Snapshot the destination's CURRENT
      // tag_ids BEFORE the copy (which would overwrite them) and
      // merge them back on top after — same intent as the
      // `withPreservedClusters` pass that runs after a Gemini call.
      //
      // Only relevant for rg-muni (the city CMS hands us cluster
      // names via tag_ids at scrape time); Smarticket clusters are
      // recovered separately by the breadcrumb extractor on each
      // pass, so they're not affected by sibling copies.
      let preCopyTagIds = [];
      if (source === "rg-muni") {
        const { data: snap } = await supabase
          .from("events")
          .select("tag_ids")
          .eq("id", id)
          .maybeSingle();
        preCopyTagIds = Array.isArray(snap?.tag_ids) ? snap.tag_ids : [];
      }
      await copyFromSource(sib, id);
      if (preCopyTagIds.length) {
        await mergeBackTagIds(id, preCopyTagIds);
      }
      return { source: "sibling_cache", source_event_id: sib.id };
    }
  }

  // 2. Gather the inputs that feed Gemini: prose description, site-
  //    side topical hints ("תגיות מהאתר"), and an optional department
  //    breadcrumb. The path differs by tenant:
  //
  //    Smarticket (mbe-rg, ramat-gan): scrape the live detail page.
  //      The page has the canonical description + curated category
  //      labels + the breadcrumb department.
  //
  //    City municipality (rg-muni): the city CMS has no Smarticket-
  //      style detail page; the scraper (lib/cityApiScraper.js) has
  //      already persisted both the description (via
  //      extractCityDescription) AND the upstream cluster names (as
  //      tag_ids[], with audience-nav clusters filtered out by
  //      shouldFilterClusterName) at ingest. We read those back and
  //      hand them to Gemini just like Smarticket's hints — the
  //      system prompt's Rule 1 already treats "תגיות מהאתר" as a
  //      first-class hint slot, so the prompt itself doesn't need
  //      to change. Without this branch we'd be calling Gemini with
  //      title-only on every city event, which is exactly why the
  //      ~200 city rows currently come back with tag_ids=[].
  let description;
  let siteLabels;
  let department;
  // Smarticket cluster name (`breadcrumb_category`), persisted verbatim
  // as a tag alongside Gemini's semantic tags. Null for non-smarticket
  // tenants and for smarticket pages that don't expose a cluster.
  let smarticketCluster = null;
  if (source === "rg-muni") {
    // City events: re-fetch the detail JSON to read the prose body.
    // We intentionally do NOT persist the description on `events` —
    // it's pulled in just-in-time for Gemini and discarded after.
    // (The Smarticket path uses the same pattern via fetchDetailHtml,
    // so we're consistent: prose is enrichment-time fuel, not row
    // state.)
    //
    // We need the row's `external_slug` to call fetchEventDetail —
    // the city API is slug-keyed, not numeric. tag_ids is also read
    // here so we can hand the existing cluster names to Gemini as
    // "תגיות מהאתר" hints (same slot Smarticket uses for site labels).
    const { data: row, error } = await supabase
      .from("events")
      .select("external_slug, tag_ids, description")
      .eq("id", id)
      .maybeSingle();
    if (error) {
      throw new Error(
        `city enrich: row fetch failed for #${id}: ${error.message}`,
      );
    }
    if (!row?.external_slug) {
      // Defensive: every rg-muni row should have external_slug
      // (sql/038 + scraper invariant). If we hit a row without one,
      // we can still enrich on title alone — but log loudly so the
      // operator notices a likely data-integrity bug.
      console.warn(
        `[Enricher] #${id} (rg-muni) row missing external_slug; ` +
          `falling back to title-only enrichment.`,
      );
      description = "";
    } else if (typeof row.description === "string" && row.description.trim()) {
      // sql/053 path: the scraper persisted the prose at ingest time.
      // For SINGLES this is identical to what `fetchEventDetail` would
      // return (one less HTTP round-trip per enrichment cycle, ~1-2s
      // saved per row at scale). For CHILDREN of an umbrella this is
      // the ONLY way to see the per-child blurb — their synthetic
      // slugs (`parent__date__loc__hour`) don't resolve to any real
      // city URL, so the refetch fallback below would return the
      // parent's overall description and miss the child-specific
      // tags ("יצירה", "הפנינג", etc.).
      description = row.description;
    } else {
      // Back-compat fallback for rows ingested BEFORE sql/053 was
      // deployed (no `description` column populated yet). For
      // singles this still works — `external_slug` is a real city
      // slug, `fetchEventDetail` returns the prose. For children
      // this path effectively returns the PARENT's description,
      // which is the pre-fix behaviour: not great, but harmless
      // (no missing labels worse than the status quo). The next
      // re-scrape cycle will populate `description` and the
      // following enrichment pass will pick up the better text.
      try {
        const detail = await cityApi.fetchEventDetail(row.external_slug);
        description = cityApi.extractCityDescription(detail);
      } catch (err) {
        // City API hiccup — proceed with title-only. The next
        // enrichment pass (when description_hash is still null on
        // this row) will retry the fetch.
        console.warn(
          `[Enricher] #${id} (rg-muni) detail fetch failed: ${err.message}; ` +
            `proceeding with title-only.`,
        );
        description = "";
      }
    }
    // Expand stored cluster ids back to Hebrew names so Gemini sees
    // them as "תגיות מהאתר" hints rather than opaque integers. We use
    // the two-step helpers (fetchLabelDict + expandWithDict) because
    // they're the exported surface; the convenience one-call expander
    // (expandIds) is internal to labelStore.
    const tagIds = row?.tag_ids || [];
    const dict = await labelStore.fetchLabelDict(tagIds);
    siteLabels = labelStore.expandWithDict(row || { tag_ids: [] }, dict).tags;
    department = null;
    // No equivalent of `maybeFillLocationKey` here — the city scraper
    // resolves location_key via ensureLocationKey on every upsert,
    // so the row already has its canonical address by the time we
    // run.
  } else {
    // Smarticket path — `name` is required to hit the slug-based URL
    // (`/<slug>?id=<id>`); the bare `/event/<id>` URL redirect-loops
    // on Smarticket. `source` decides which tenant's host we hit —
    // pre-sql/034 rows default to mbe-rg via getSiteOrigin's fallback.
    const { html, finalUrl } = await fetchDetailHtml(id, name, source);
    description = extractDescription(html);
    // Persist description so the Mini App can display it. Write only when
    // the column is currently null — never overwrite a manually-set value.
    if (description) {
      await supabase
        .from("events")
        .update({ description })
        .eq("id", id)
        .is("description", null);
    }
    siteLabels = extractSmarticketLabels(html);
    smarticketCluster = extractSmarticketCluster(html);
    // Department is also factored into the hash so two events whose
    // prose+labels are identical but whose departments differ (rare
    // but possible across tenants) don't share cache entries.
    department = extractDepartment(html);
    // Address extraction — separate from labels because it has its own
    // write path (events.location_key via locations table). We do this
    // unconditionally per event since detail-page address might exist
    // even when the homepage card didn't (true for ramat-gan, where the
    // homepage paginates to ~20 events while every detail page has
    // structured JSON-LD with streetAddress).
    //
    // Conservative write: only fill location_key when it's currently
    // null. We never overwrite an address resolved from the homepage
    // (that path uses a different extractor and is generally cleaner
    // for mbe-rg). If the homepage scraper later finds a better match,
    // it'll write its own key — that's safe because both paths funnel
    // through `ensureLocationKey` which dedupes by normalized text.
    await maybeFillLocationKey(id, html, source);

    // Store the parent slug extracted from the canonical redirect URL.
    // This groups all sessions of the same show under a shared
    // `external_slug` so they can be presented as umbrella + children.
    const parentSlug = extractParentSlug(finalUrl);
    if (parentSlug) {
      const { smarticketGroupBySlug } = require("./smarticketUmbrellaService");
      // Write external_slug (idempotent — only sets when NULL so a
      // manually-curated value is never clobbered).
      await supabase
        .from("events")
        .update({ external_slug: parentSlug })
        .eq("id", id)
        .is("external_slug", null);
      // Fire-and-forget: detect + create umbrella grouping.
      smarticketGroupBySlug(source, parentSlug).catch((err) =>
        console.warn(`[Enricher] #${id} umbrella grouping failed: ${err.message}`),
      );
    }
  }

  const hash = hashDescription(description, name, siteLabels, department);

  // 3. Hash cache — different title, identical body.
  if (hash) {
    const hit = await findCacheHitByHash(hash, id);
    if (hit) {
      await copyFromSource(hit, id);
      // Same cluster-preservation rationale as the sibling-cache
      // branch above. For rg-muni, `siteLabels` was just read out of
      // the row's current tag_ids so we can resolve them back to ids
      // — we don't need a fresh DB snapshot here.
      if (source === "rg-muni" && siteLabels && siteLabels.length) {
        const ids = await labelStore.resolveMany(siteLabels);
        await mergeBackTagIds(id, ids);
      }
      return { source: "hash_cache", source_event_id: hit.id };
    }
  }

  // 4. Cache miss → Gemini. We allow one retry on timeout — the
  //    structured-output endpoint occasionally stalls under load and
  //    a second attempt usually goes through. Persistent timeouts
  //    are treated as "give up" and we write a minimal placeholder
  //    row so the event leaves the backfill queue.
  let labels;
  try {
    labels = await callGemini(name, description, siteLabels, department);
  } catch (err) {
    if (!isTimeoutError(err)) throw err;
    try {
      labels = await callGemini(name, description, siteLabels, department);
    } catch (err2) {
      if (!isTimeoutError(err2)) throw err2;
      console.warn(`[Enricher] #${id} Gemini timed out twice — writing unclassified fallback.`);
      labels = unclassifiedFallback();
      labels = withPreservedClusters(
        labels,
        source === "rg-muni" ? siteLabels : smarticketCluster,
      );
      await applyLabels(id, labels, hash);
      return { source: "fallback_timeout", labels };
    }
  }
  // Preserve the curator-defined cluster tags through the Gemini
  // pass. Smarticket has at most one (`breadcrumb_category`); the
  // city CMS hands us a small array of cluster + category names
  // (already filtered by `shouldFilterClusterName` at scrape time).
  // Without this step `setEventLabels` overwrites the existing
  // `tag_ids` with Gemini's output and we lose the cluster — the
  // 2026-05 shavuot-2026 children regression where every child
  // ended up with just `["שבועות 2026"]` from the scraper but no
  // semantic tags, while a freshly-enriched row had the inverse
  // problem (semantic tags but no cluster).
  const preservedClusters =
    source === "rg-muni" ? siteLabels : smarticketCluster;
  labels = withPreservedClusters(labels, preservedClusters);
  await applyLabels(id, labels, hash);
  return { source: "gemini", labels };
}

// Inject the curator-defined cluster tag(s) into the tag list AFTER
// Gemini has produced its semantic tags. Idempotent: clusters already
// present (by normalised name) are skipped, so re-running enrichment
// doesn't duplicate. Accepts either a single string or an array of
// strings so the same helper covers Smarticket's breadcrumb
// (one cluster per event) and the city CMS (a small array of cluster
// + category names per event).
//
// We do this OUTSIDE the model call deliberately — Gemini reliably
// produces semantic tags from the prose (שבועות, מוזיקה, …) but
// inconsistently echoes the navigation cluster name. The cluster
// matters because users describe events by it ("שבת קהילה",
// "שבועות 2026") even when the prose never mentions that phrase. By
// persisting it verbatim alongside Gemini's tags we guarantee both
// surface in `search_events({ tags: [...] })` and the labelStore
// fuzzy resolver.
function withPreservedClusters(labels, clusters) {
  if (!clusters) return labels;
  const arr = Array.isArray(clusters) ? clusters : [clusters];
  if (!arr.length) return labels;
  const existing = Array.isArray(labels?.tags) ? labels.tags : [];
  const seen = new Set(existing.map((t) => labelStore.normalizeName(String(t))));
  const merged = [...existing];
  for (const c of arr) {
    if (typeof c !== "string") continue;
    const trimmed = c.trim();
    if (!trimmed) continue;
    const norm = labelStore.normalizeName(trimmed);
    if (seen.has(norm)) continue;
    seen.add(norm);
    merged.push(trimmed);
  }
  return { ...labels, tags: merged };
}

// Backwards-compat alias for the previous single-cluster signature.
// Exported and used by `jobs/backfillSmarticketClusters.js`; the
// underlying helper now accepts arrays so we can keep one impl.
const withSmarticketCluster = withPreservedClusters;

// ─────────────────────────────────────────────────────────────────────
// Migration probe — sql/026 might not be applied yet.
// ─────────────────────────────────────────────────────────────────────
let _migrationOk = null;

function isMissingColumnError(error) {
  if (!error) return false;
  const code = error.code || "";
  const msg = error.message || "";
  return code === "42703" || /column .* does not exist/i.test(msg);
}

async function checkMigration() {
  if (_migrationOk !== null) return _migrationOk;
  if (!(await labelStore.isSchemaReady())) {
    _migrationOk = false;
    return false;
  }
  const { error } = await supabase.from("events").select("min_months").limit(1);
  if (error && isMissingColumnError(error)) {
    console.warn("[Enricher] sql/026 (min_months / max_months) not applied — enrichment disabled.");
    _migrationOk = false;
    return false;
  }
  _migrationOk = true;
  return true;
}

async function fetchPendingEvents(limit) {
  // We pull `source` so `enrichEventData` can hit the right tenant's
  // detail page. Without it every ramat-gan event would be fetched
  // from mbe-rg.smarticket.co.il and 404 silently.
  //
  // Selection criteria — pick up:
  //   1. Never-enriched rows: description_hash IS NULL.
  //   2. Partial-state rows: description_hash IS NOT NULL but EITHER
  //      audience OR category is null. This pattern shows up when a
  //      previous pass's labelStore.setEventLabels silently failed
  //      mid-way, OR — much more commonly on rg-muni — when the
  //      cityApiScraper write race that we hardened in May-2026 had
  //      already clobbered `category` back to null before the
  //      enricher's UPDATE landed. Without this branch the row is
  //      frozen forever: `description_hash IS NULL` skips it on
  //      every subsequent pass, and the previous (stricter) "BOTH
  //      audience AND category null" guard never matched because
  //      Gemini almost always returns a non-null audience even
  //      when category gets lost downstream.
  //
  // We deliberately don't sweep up rows with empty tag_ids or null
  // age range — those are valid Gemini outputs (e.g. an open-bound
  // adult lecture, or a description with no concrete age), and
  // re-enriching them would burn quota for no gain.
  const { data, error } = await supabase
    .from("events")
    .select("id, name, source")
    .eq("archived", false)
    .or(
      "description_hash.is.null," +
        "and(description_hash.not.is.null,audience.is.null)," +
        "and(description_hash.not.is.null,category.is.null)",
    )
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Pending events fetch failed: ${error.message}`);
  return data || [];
}

async function enrichPendingEvents(limit = MAX_PER_CYCLE) {
  if (!process.env.GEMINI_API_KEY) {
    return { processed: 0, classified: 0, errors: 0, skipped_no_key: true };
  }
  if (!(await checkMigration())) {
    return { processed: 0, classified: 0, errors: 0, skipped_no_migration: true };
  }
  const events = await fetchPendingEvents(limit);
  if (!events.length) return { processed: 0, classified: 0, errors: 0 };

  console.log(`[Enricher] Processing ${events.length} event(s)...`);
  let classified = 0;
  let cacheHits = 0;
  let siblingHits = 0;
  let errors = 0;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    try {
      const result = await enrichEventData(ev);
      classified++;
      if (result.source === "hash_cache") cacheHits++;
      if (result.source === "sibling_cache") siblingHits++;
      const labelStr = result.labels
        ? `${result.labels.audience || "—"}/${result.labels.category}/${result.labels.min_months}-${result.labels.max_months}m`
        : `← #${result.source_event_id}`;
      console.log(
        `[Enricher] #${ev.id} "${(ev.name || "").slice(0, 40)}" → ${labelStr} (${result.source})`,
      );
    } catch (err) {
      errors++;
      console.error(`[Enricher] #${ev.id} failed: ${err.message}`);
    }
    if (i + 1 < events.length) {
      await new Promise((r) => setTimeout(r, DETAIL_FETCH_GAP_MS));
    }
  }
  return { processed: events.length, classified, cacheHits, siblingHits, errors };
}

module.exports = {
  enrichEventData,
  enrichPendingEvents,
  hashDescription,
  // Exposed for the one-off `jobs/backfillLocations.js` driver. New
  // events get their address resolved during the regular enrichment
  // pass; this pair lets the backfill re-run JUST the address step
  // on already-classified events without re-paying for Gemini.
  fetchDetailHtml,
  extractDescription,
  extractParentSlug,
  maybeFillLocationKey,
  extractEventAddress,
  extractAddressFromDescription,
  // Exposed for `jobs/backfillSmarticketClusters.js` so existing rows
  // can have their breadcrumb cluster (e.g. "שבת משפחה קהילה") added
  // to tag_ids without re-paying for Gemini.
  extractSmarticketCluster,
  withSmarticketCluster,
  // exported for tests / introspection
  AUDIENCES,
  CATEGORIES,
  SCHEMA_VERSION,
};
