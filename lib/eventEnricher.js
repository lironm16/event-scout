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
const { GEMINI_MODEL } = require("./geminiModel");
const { classifyAllAccessForEvent } = require("./access");
const { sanitizeAgeRange } = require("./eventAge");
const cheerio = require("cheerio");
const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");
const supabase = require("./supabase");
const labelStore = require("./labelStore");
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
const PER_CALL_TIMEOUT_MS = parseInt(process.env.ENRICH_TIMEOUT_MS, 10) || 15_000;

// ── Enrichment failure / retry policy (sql/072) ─────────────────────────────
// Transient Gemini outages get exponential backoff; permanent give-up only
// after ENRICHMENT_MAX_FAILS. Rows with enrichment_failed_at set are skipped
// by fetchPendingEvents until backfillEnrichmentRetry or manual reset.
const ENRICHMENT_MAX_FAILS = 5;
const ENRICHMENT_RETRY_DELAYS_MS = [
  1 * 60 * 60 * 1000,
  4 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
  3 * 24 * 60 * 60 * 1000,
];
const ENRICHMENT_FAIL_REASONS = Object.freeze({
  GEMINI_TIMEOUT: "gemini_timeout",
  GEMINI_RATE_LIMIT: "gemini_rate_limit",
  GEMINI_DAILY_LIMIT: "gemini_daily_limit",
  GEMINI_BAD_JSON: "gemini_bad_json",
  GEMINI_ERROR: "gemini_error",
  INPUT_FETCH: "input_fetch",
  INPUT_EMPTY: "input_empty",
});

// ── Daily Gemini rate cap ────────────────────────────────────────────────────
// Hard ceiling on Gemini calls per calendar day (resets at midnight local time).
// Prevents runaway costs from bugs (e.g. stuck events that keep re-enriching).
// Default: 300 calls/day ≈ max 15 full cron-cycles of 20 events each.
// Override via ENRICHER_DAILY_GEMINI_LIMIT env var.
const DAILY_GEMINI_LIMIT = parseInt(process.env.ENRICHER_DAILY_GEMINI_LIMIT || "300", 10);
let _dailyCallCount = 0;
let _dailyResetDate = ""; // YYYY-MM-DD in local time

function _checkDailyLimit() {
  const today = new Date().toLocaleDateString("en-CA"); // "2026-05-26"
  if (today !== _dailyResetDate) {
    _dailyCallCount = 0;
    _dailyResetDate = today;
  }
  if (_dailyCallCount >= DAILY_GEMINI_LIMIT) {
    throw new Error(
      `[Enricher] Daily Gemini limit reached (${_dailyCallCount}/${DAILY_GEMINI_LIMIT}). ` +
      "Resets at midnight. Set ENRICHER_DAILY_GEMINI_LIMIT to raise.",
    );
  }
}

function _countGeminiCall(n = 1) {
  _dailyCallCount += n;
}

// ─────────────────────────────────────────────────────────────────────
// Closed enums. Mirror sql/026 seed data exactly — values are matched
// case-and-quote-insensitively in labelStore but the LLM is asked to
// return them verbatim.
// ─────────────────────────────────────────────────────────────────────
const AUDIENCES = ["תינוקות", "ילדים", "נוער", "הורים", "מבוגרים", "ותיקים", "לכל המשפחה"];
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

// access_t scopes (sql/039+). A HARD visibility filter (array): a user only
// sees an event if their profile's community scopes intersect the event's.
// Distinct from `audience` (which is SOFT age/life-stage targeting).
// Default ["open"] = open to the general public.
const ACCESS_SCOPES = [
  "open",
  "community-lgbtq",
  "community-russian",
  "community-seniors",
  "community-miluim",
  "community-olim",
  "community-disabilities",
  "community-women",
];

// Developmental READINESS targeting (events.dev_targets) — [{stage, level}],
// matched against each profile kid's per-stage readiness. See lib/devStages.js
// (single source of truth for the stage + level vocabularies).
const { sanitizeDevTargets, STAGE_IDS: DEV_STAGE_IDS, LEVEL_IDS: DEV_LEVEL_IDS } = require("./devStages");

// Tags that merely echo a concept owned by a structured field (audience value
// or access community) are dropped from results in reconcileLabels — and
// refused as labels in labelStore. Shared rule: lib/coveredConcepts.js.
// (Event CATEGORIES like "ספורט"/"מסיבה" are intentionally NOT covered — they
// double as useful topic tags.)
const { isCoveredConcept: isCoveredTagConcept } = require("./coveredConcepts");

// Typed, lossless age range (events.age_range) — preserves the original wording
// ("זחילה עד שלוש") for display. value is a STRING (stage name OR number-as-text)
// so one schema covers both; lib/eventAge.js parses + validates it.
const AGE_ENDPOINT_SCHEMA = {
  type: SchemaType.OBJECT,
  nullable: true,
  properties: {
    kind: { type: SchemaType.STRING, format: "enum", enum: ["stage", "months", "years"] },
    value: { type: SchemaType.STRING },
    inclusive: { type: SchemaType.BOOLEAN },
  },
  // required + nullable: the endpoint object may be null (open side), but when
  // present it MUST carry all three fields — no half-built endpoints.
  required: ["kind", "value", "inclusive"],
};
const AGE_RANGE_SCHEMA = {
  type: SchemaType.OBJECT,
  nullable: true,
  properties: { min: AGE_ENDPOINT_SCHEMA, max: AGE_ENDPOINT_SCHEMA },
  // CRITICAL: both keys required (each still nullable). Forces the model to
  // consciously emit max=<value|null> instead of silently dropping it — the
  // root cause of "min captured, max null" on two-ended ranges.
  required: ["min", "max"],
};

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
    // HARD visibility filter (array of community scopes). Default ["open"].
    // Distinct from `audience` (soft age targeting): access GATES who can
    // even see the event. See ACCESS_SCOPES above.
    access: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING, format: "enum", enum: ACCESS_SCOPES },
    },
    // One representative emoji for the event's CONTENT — used as the fallback
    // for the deterministic icon rules. Optional; sanitizeEmoji handles junk.
    emoji: { type: SchemaType.STRING, nullable: true },
    age_range: AGE_RANGE_SCHEMA,
    // Developmental READINESS targeting: which stage + readiness level the event
    // addresses. Empty unless the event explicitly targets a stage. A "prep"
    // event → level "before"; an event for kids already doing X → "during".
    dev_targets: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          stage: { type: SchemaType.STRING, format: "enum", enum: ["solids", "crawl", "walk", "talk", "wean"] },
          level: { type: SchemaType.STRING, format: "enum", enum: ["before", "during", "established"] },
        },
        required: ["stage", "level"],
      },
    },
  },
  // access intentionally NOT required: a malformed/omitted access must not
  // break the whole classification — sanitizeAccess defaults it to ["open"].
  // age_range + numeric bounds REQUIRED (each nullable) so the model always
  // emits them rather than dropping max on terse ranges.
  required: ["audience", "category", "tags", "min_months", "max_months", "age_range", "dev_targets"],
};

const SYSTEM_PROMPT = `את מנתחת אירועים קהילתיים. עבור כל אירוע שאני אתן לך, החזירי אובייקט JSON עם המפתחות הבאים בלבד:

- min_months / max_months: טווח גיל בחודשים. אינטיגרים, או null אם אין מידע. אסור לערב שנים — תמיד חודשים.
- audience: ערך יחיד מהאניום הסגור: תינוקות | ילדים | נוער | הורים | מבוגרים | ותיקים | לכל המשפחה (גיל/שלב-חיים בלבד; "נשים בלבד" אינו audience אלא access — ראי כלל 12)
- category: ערך יחיד מהאניום הסגור: סדנה | הצגה | הופעה | הפעלה | הרצאה | משחקייה | מסיבה | ארוחה | מפגש | סיור | ספורט | אחר
- tags: מערך תגיות חופשיות (אפשר להחזיר מערך ריק). דוגמאות: "מוזיקה", "סדרת מפגשים", "הפנינג", "חינם", "ל״ג בעומר", "שבועות". **אל תחזירי כתגית מושג שכבר מיוצג ב-audience או ב-access** — "נוער"/"תינוקות"/"קהילה גאה"/"עולים חדשים"/"דוברי רוסית" אינם תגיות (הם קהל/קהילה).
- access: מערך scopes מהאניום הסגור (open | community-lgbtq | community-russian | community-seniors | community-miluim | community-olim | community-disabilities | community-women). ברירת מחדל ["open"]. זה מסנן נראוּת קשיח — ראי כלל 12.
- emoji: אימוג'י בודד אחד שמייצג את תוכן האירוע (ראי כלל 13). אופציונלי.
- age_range: ייצוג הטווח ב**מילים המקוריות** (לתצוגה), **בנוסף** ל-min/max_months (שנשארים לפי כללי החודשים למטה). אובייקט {min, max}; כל קצה {kind:"stage"|"months"|"years", value (כמחרוזת), inclusive}. stage ∈ birth|crawl|walk (לידה/זחילה/הליכה). value מספרי ביחידה המקורית (לא להמיר). קצה null = פתוח; כל השדה null אם אין מידע גיל.
  **חובה — שני קצוות:** אם בטקסט יש טווח עם שני קצוות (תבניות "X-Y", "X עד Y", "מ-X עד Y", "X–Y", או שלב→שלב/שלב→מספר כמו "זחילה-שלוש", "לידה עד זחילה") — **חובה למלא גם min וגם max**. אסור להחזיר max=null כשבטקסט מופיע קצה עליון. max=null מותר אך ורק כשבאמת אין תקרה ("מגיל X ומעלה", "X+", "from age X").
  **חובה — inclusive:** המילים "לא כולל" / "(לא כולל)" / "עד ולא כולל" / "מתחת ל" / "טרום" (כמו "טרום הליכה") על קצה כלשהו → inclusive=false **על אותו קצה**. אחרת inclusive=true. אסור להתעלם מ"לא כולל".
  דוגמאות: "זחילה עד שלוש" → {min:{kind:"stage",value:"crawl",inclusive:true}, max:{kind:"years",value:"3",inclusive:true}} ; "לגילאי 3-6" → {min:{kind:"years",value:"3",inclusive:true}, max:{kind:"years",value:"6",inclusive:true}} ; "3-6 חודשים" → kind:"months" שני הקצוות ; "4 חודשים-זחילה (לא כולל)" → {min:{kind:"months",value:"4",inclusive:true}, max:{kind:"stage",value:"crawl",inclusive:false}} ; "לידה-זחילה לא כולל" → {min:{kind:"stage",value:"birth",inclusive:true}, max:{kind:"stage",value:"crawl",inclusive:false}} ; "זחילה-הליכה לא כולל" → {min:{kind:"stage",value:"crawl",inclusive:true}, max:{kind:"stage",value:"walk",inclusive:false}} ; "עד זחילה לא כולל" → {min:null, max:{kind:"stage",value:"crawl",inclusive:false}}.
- dev_targets: מערך של {stage, level} — לאיזה שלב התפתחותי **ובאיזו רמת מוכנות** האירוע מכוון. stage ∈ solids (מוצקים) | crawl (זחילה) | walk (הליכה) | talk (דיבור) | wean (גמילה מחיתולים). level ∈ before (הכנה — הילד עוד לא בשלב, מתכונן/מתחיל) | during (תוך כדי — הילד כבר בתהליך) | established (כבר מבוסס). ברירת מחדל [] (רוב האירועים). מלאי **רק** כשהאירוע ממש מדבר על שלב, והבחיני בין הכנה לבין תוך-כדי:
  • "סדנת מעבר/הכנה למוצקים" / "גמילה מחיתולים" → level **before** (למי שעוד לא שם, מתכונן). דוגמה: [{stage:"solids",level:"before"}] ; [{stage:"wean",level:"before"}].
  • "פעילות לזוחלים" / "לתינוקות שכבר זוחלים" → [{stage:"crawl",level:"during"}].
  • "התפתחות שפה / טרום-מילולי" → [{stage:"talk",level:"before"}] (לפני שמדברים).
  • אירוע גיל רגיל בלי אזכור שלב התפתחותי → [].

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

3. **רמזים התפתחותיים** (שלבי תינוק — בכותרת או בתיאור):
   - "מזחילה" → 6 (התחלה)
   - "מהליכה" → 12 (התחלה)
   - "לידה-זחילה" → 0 ל-6
   - "זחילה-שנתיים" → 6 ל-24
   - "זחילה-שלוש" / "מזחילה-שלוש" → 6 ל-36 (טווח גיל בכותרת — לא שלב «זוחלים» בלבד)
   - "גמול" / "גימול" / "הפרדה מחלב" → בדרך כלל מגיל ~6 חודשים; max_months לפי הקשר
   - "אוכל מוצקים" / "מעבר למוצקים" → בדרך כלל מגיל ~6–12 חודשים

4. **טווח נומרי "X-Y" — עוקף תמיד את כללי הקהל הכלליים מ-Rule 2**:
   - אם בטקסט מופיע טווח גילאים מפורש בצורה "X-Y" / "ages X-Y" / "X-Y years" / "גילאי X עד Y" / "מגיל X עד Y" — **חובה** להחזיר את שניהם: min ו-max המדויקים. אסור להחזיר רק min ולהשאיר max=null. אסור לוותר על המספרים לטובת ברירת המחדל של Rule 2 (216 לאדולטס).
   - דוגמה מכריעה: "intended for participants ages 20-40" + "adults / young adults" באותו טקסט → min=240, max=480. אסור 216. אסור null על max. Rule 4 גובר על Rule 2 כל פעם שיש מספרים בטקסט.
   - איך לפרש את היחידה:
     • אירוע ילדים/משפחה (סדנה, הופעת ילדים, משחקייה) — היחידה היא שנים. "3-6" → min=36, max=72.
     • אירוע מבוגרים (ארוחת שישי, הרצאה מקצועית, מסיבת רווקים, "young adults", אירוע ערב) ו-X≥13 — היחידה היא **שנים**. "ages 20-40" / "20-40" → min=240, max=480.
     • **חודשים** — כשמופיע «חודש»/«חודשים»/«months» אחרי המספרים, היחידה היא חודשים (לא שנים). דוגמה: "לגילאי 3-6 חודשים" → min=3, max=6. אסור 36–72.
     • בלי מילת חודשים — באירועי תינוקות/משפחה "3-6" לרוב שנים (min=36, max=72); "6 חודשים", "0-12 months" → חודשים.
     • כלל אגודל: אם הטווח חוצה את גיל 18 (216 חודשים) — ודאי שזה שנים. תינוק לא נצמד לטווח של 20 שנה.
   - אם מצוין רק קצה אחד (למשל "from age 25" בלי תקרה) → min=300, max=null. רק במקרה הזה max=null מותר.

5. **חוק קהל יחיד** — audience מתאר את המשתתף הראשי. בחרי ערך אחד בלבד:
   - פעילות שבה הילד/התינוק הוא המשתתף (מוזיקה/תנועה/יוגה/משחק/חוג/"גן יחד" לפעוטות, גם אם הורה מלווה) → סווגי **לפי גיל הילד**: "תינוקות" (עד גיל ~3) או "ילדים". נוכחות ההורה כמלווה אינה הופכת את זה ל"לכל המשפחה". דוגמה: "פעילות מוסיקלית לגילאי הליכה עד שלוש" → "תינוקות", לא "לכל המשפחה".
   - "לכל המשפחה" שמור לאירוע שבאמת פתוח לכל הגילאים יחד (מופע/פסטיבל/הפנינג משפחתי, או טווח גיל רחב שחוצה ילדוּת ובגרוּת) — **לא** לפעילות פעוטות/ילדים ממוקדת-גיל.
   - הרצאה/סדנה/מפגש שההורה (או האם) הוא המשתתף, גם אם תינוק נוכח כמלווה ("מעגל אמהות", "קבוצת הורות", "הרצאה להורים", "יועצת") → "הורים" — לא "תינוקות".
   - הרצאה / סדנה / מפגש המיועד **במפורש להורים בלבד** (ללא נוכחות ילדים, למשל "הרצאה מקוונת להורים", "מפגש הורים", "קבוצת הורות") → "הורים".
   - הופעות ערב, הרצאות מקצועיות בלי ילדים נוכחים ובלי ציון "הורים" → "מבוגרים".
   - אירוע "young adults" / ארוחה קהילתית בערב / ערב הכרויות / "secular lifestyle" → "מבוגרים".
   - אירועים ל-60+ / "אזרחים ותיקים" / "הגיל השלישי" / "גיל הזהב" / מועדון ותיקים / הרצאות לגיל 60+ → חובה "ותיקים" (אסור "מבוגרים"). min_months לפחות 720 (60 שנה) כשיש סימן גיל; בלי תקרה — max_months=null.
   - אירועים **לנשים בלבד** / "לנשים" / "סדנה לנשים" / "מרחב לנשים" / "נשים צעירות" / "אחיות" / קבוצת נשים → **access=["community-women"]**, ואת audience קבעי לפי הגיל בפועל (בד״כ "מבוגרים"). "נשים בלבד" הוא הגבלת-קהל (access), לא audience. אזהרה קריטית: "נשים צעירות" / "צעירות" זה נשים מבוגרות צעירות — **לא** "נוער"! "נוער" שמור לבני 12–18 בלבד. אירוע *על* נשים (למשל "נשים בתנ״ך" כהרצאה לקהל כללי) הוא **לא** מוגבל-נשים — audience לפי הקהל בפועל (מבוגרים/ותיקים) ו-access=["open"].
   - במקרי ספק לגבי ילדים — "לכל המשפחה" עדיף על "מבוגרים". אבל אם יש סימן ברור למבוגרים בלבד (גילאי 18+, אלכוהול, ערב חברתי, "young adults"), בחרי "מבוגרים" ולא "לכל המשפחה".

6. **תגיות מתוקננות** — בכתיב הסטנדרטי. אם תגית כבר נשמעת מוכרת, השתמשי באותו כתיב מילה במילה:
   - "ל״ג בעומר" (לא "לג בעומר" או "ל'ג בעומר")
   - "משחקייה" (לא "משחקיה")
   - "מוזיקה", "אומנות", "תיאטרון", "ספורט"
   - **בלי ה' הידיעה ובלי קידומת ארגונית** — התגית היא הנושא בלבד: "קהילה גאה" (לא "הקהילה הגאה" ולא "מחלקת הקהילה הגאה"), "נוער" (לא "מחלקת הנוער"). אסור להתחיל תגית ב"מחלקת"/"מינהל"/"אגף".
   - תגית של חג: "ל״ג בעומר", "שבועות", "פסח", "יום העצמאות", "חנוכה"
   - תגית מבנית: "סדרת מפגשים", "מנוי", "הפנינג", "חינם"
   - **אסור** להוסיף תגית "גיל הזהב" — זה לא נושא. לאירועי 60+ השתמשי ב-audience="ותיקים" בלבד; אל תסבירי שוב בגיל בתגיות.
   - מונחים שכיחים נשארים כפי שהם בשיח של היוזרים: "AI" (לא "בינה מלאכותית"), "DIY" (לא "יצירה ביד").
   - כותרת/תיאור עם "גן יחד" (גן עם הורה + תינוק, גננת מוסמכת) → תגית "גן יחד". זה נושא ספציפי — לא להחליף ב"התפתחות" בלבד; אפשר גם שתי תגיות אם שני הנושאים באמת רלוונטיים.

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

12. **access (זכאות/קהילה — קשיח, מסנן נראוּת)** — מערך scopes מהאניום הסגור: open | community-lgbtq | community-russian | community-seniors | community-miluim | community-olim | community-disabilities | community-women.
   - ברירת מחדל: ["open"] (פתוח לקהל הרחב). זה שונה מ-audience: audience הוא מיקוד-גיל **רך**, ואילו access **מסנן** מי בכלל רואה את האירוע.
   - החזירי scope של קהילה **רק** כשהאירוע מאורגן ע"י / מיועד / מוגבל לקהילה ספציפית:
     * community-lgbtq — הקהילה הגאה / pride / להט"ב / "מחלקת הקהילה הגאה".
     * community-seniors — ל-60+ **בלבד** (מועדון ותיקים, "אזרחים ותיקים", הגיל השלישי). שים לב: audience=ותיקים זה מיקוד-גיל רגיל — access=community-seniors זה הגבלה לחברי המועדון בלבד.
     * community-russian — הקהילה דוברת הרוסית (טקסט בקירילית, "דוברי רוסית", "לעולים מרוסיה").
     * community-miluim — מילואימניקים / משפחות מילואים.
     * community-olim — עולים חדשים.
     * community-disabilities — אנשים עם מוגבלות / צרכים מיוחדים.
     * community-women — אירועים לנשים בלבד (סדנאות / מרחבים / קבוצות לנשים). "נשים צעירות" נכלל; אירוע *על* נשים לקהל כללי — לא.
   - אפשר כמה scopes יחד (אירוע בקירילית לקהילה הגאה → ["community-lgbtq","community-russian"]).
   - בספק או אירוע כללי → ["open"]. **אל** תגבילי אירוע כללי בטעות — זה יסתיר אותו מכולם.

13. **emoji** — אימוג'י **בודד אחד** שמייצג בצורה הטובה ביותר את *תוכן* האירוע (הפעילות/הנושא), לפי הכותרת והתיאור:
   - אימוג'י אחד בלבד — בלי טקסט, בלי כמה אימוג'ים, בלי מירכאות.
   - בחרי את ה**ספציפי והמזהה ביותר** לפעילות. דוגמאות: סדנת אפייה → 🧁, בישול → 👨‍🍳, רובוטיקה → 🤖, מדע → 🔬, אסטרונומיה → 🔭, טבע/טיול → 🌳, גינון → 🪴, משחקי קופסה → 🎲, קסמים → 🎩, בעלי חיים → 🐾, אופניים → 🚲, חלל → 🚀, ים/שייט → 🌊, אוכל → 🍽️, ספרים → 📚.
   - העדיפי אימוג'י של ה**נושא/הפעילות** — **לא** של קהל היעד (אל תבחרי 👶/🧒 רק כי האירוע לילדים).
   - הימנעי מאימוג'ים גנריים (📌, 🎪, ⭐, ✨) ומדגלים / סמלים פוליטיים-דתיים רגישים — אלא אם זו ממש מהות האירוע.
   - אם אין משהו ספציפי שמתאים — בחרי אימוג'י ניטרלי וידידותי שתואם לאווירה (אירוע חגיגי → 🎉, אירוע כללי → 🗓️).

14. החזירי JSON תקין בלבד. אל תוסיפי שדות מעבר ל-9 המפתחות. כל המפתחות חייבים להופיע — כולל age_range עם min ו-max (כל קצה הוא אובייקט או null; אסור להשמיט את max), ו-dev_targets (מערך, ריק אם אין שלב).`;

const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genai.getGenerativeModel({
  model: GEMINI_MODEL,
  systemInstruction: SYSTEM_PROMPT,
  generationConfig: {
    temperature: 0,
    responseMimeType: "application/json",
    responseSchema: RESPONSE_SCHEMA,
  },
});

// ── Batch model ─────────────────────────────────────────────────────────────
// For enrichment cycles with multiple cache-miss events we send up to 5
// events in a single Gemini call, sharing one system-prompt overhead instead
// of paying it N times. The response schema is an array of the same per-event
// objects, returned in the same order as the input.
//
// System prompt is identical to the single-event prompt with one extra line
// that tells the model to return a parallel array. The rules for individual
// events are unchanged.
const BATCH_RESPONSE_SCHEMA = {
  type: SchemaType.ARRAY,
  items: RESPONSE_SCHEMA,
};
const BATCH_SIZE = 5;

const batchModel = genai.getGenerativeModel({
  model: GEMINI_MODEL,
  systemInstruction:
    SYSTEM_PROMPT +
    "\n\n**מצב אצווה**: אני מעביר לך מספר אירועים ממוספרים (--- אירוע 1 ---, --- אירוע 2 --- וכו׳). החזירי מערך JSON שבו כל אלמנט מתאים לאירוע המקביל לפי הסדר (אלמנט 0 לאירוע 1, אלמנט 1 לאירוע 2 וכו׳). מספר האלמנטים חייב להיות שווה למספר האירועים שהעברתי.",
  generationConfig: {
    temperature: 0,
    responseMimeType: "application/json",
    responseSchema: BATCH_RESPONSE_SCHEMA,
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
// Send Gemini the FULL in-use tag vocabulary each call (events_count>0) so it
// can self-dedupe semantically against everything — not just the top tags.
// 300 is comfortably above the live label count; raise if it ever approaches.
const POPULAR_TAGS_LIMIT = 300;
const POPULAR_TAGS_TTL_MS = 5 * 60 * 1000;
let _popularTags = { fetchedAt: 0, names: [] };

// Canonical community / audience names that Gemini should prefer when the
// event is thematically about one of these groups. Appended to the vocabulary
// so the model picks "קהילה גאה" rather than "גאה" / "להט"בק" / etc.
const { AUDIENCE_CATEGORIES: _AUD_CATS } = require("./audienceTargets");
const CANONICAL_VOCAB_NAMES = _AUD_CATS
  .filter((a) => a.community) // only community-scoped entries need anchoring
  .map((a) => a.label);       // e.g. ["קהילה גאה","נשים","ותיקים (60+)",…]

async function getPopularTagsForPrompt() {
  const now = Date.now();
  if (now - _popularTags.fetchedAt < POPULAR_TAGS_TTL_MS && _popularTags.names.length) {
    return _popularTags.names;
  }
  try {
    const names = await labelStore.getPopularLabelNames(POPULAR_TAGS_LIMIT);
    // Append canonical community/audience names at the end so Gemini always
    // sees the exact label it should emit for thematic community content, even
    // if those labels have events_count=0 (newly seeded / rare).
    const merged = [...new Set([...names, ...CANONICAL_VOCAB_NAMES])];
    _popularTags = { fetchedAt: now, names: merged };
    return merged;
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
  if (!m) {
    // No 📍 marker — last-resort venue-noun scan for the common case
    // where the curator names a landmark venue in prose without the pin
    // (e.g. "...האירוע יתקיים בכיכר אורדע."). Kept deliberately narrow:
    // only a small set of unambiguous venue nouns (כיכר / רחבת / מתחם /
    // היכל / אולם / פארק) followed by a proper-name token. Anything
    // looser pollutes geocoding for the whole corpus.
    const venue = description.match(
      /(?:^|[\s.,;:(])(?:ב|ל|מ|ה)?((?:כיכר|רחבת|מתחם|היכל|אולם)\s+[א-ת][א-ת׳'"\s]{1,28}?)(?=[.,;:!?)\n]|\s[-–|]|\s📍|$)/u,
    );
    if (!venue) return null;
    const cleanedVenue = venue[1].trim().replace(/[.,;:|·•\-–—\s]+$/u, "").trim();
    return cleanedVenue.length >= 4 && cleanedVenue.length <= 60 ? cleanedVenue : null;
  }
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
// v10 (2026-06): audience Rule 5 rewrite — a child/toddler activity (the
//                child is the participant, even with an accompanying parent)
//                is classified by the CHILD's age ("תינוקות"/"ילדים"), NOT
//                "לכל המשפחה". "לכל המשפחה" is reserved for genuinely all-ages
//                events; parent-as-participant ("מעגל אמהות") → "הורים".
//                Bumping invalidates v9 hashes so re-enriched toddler classes
//                (דן דן הנגן, גן יחד, etc.) move out of "לכל המשפחה".
const SCHEMA_VERSION = 10;

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
// Validate Gemini's `access` array against the closed enum. Community scopes
// win (an event positively flagged for a community is RESTRICTED to it);
// fall back to ["open"] only when no valid community scope is present.
function sanitizeAccess(value) {
  const arr = Array.isArray(value) ? value : value ? [value] : [];
  const valid = [...new Set(arr.filter((v) => ACCESS_SCOPES.includes(v)))];
  const community = valid.filter((v) => v !== "open");
  return community.length ? community : ["open"];
}

// Keep only the FIRST emoji grapheme (incl. ZWJ sequences / variation
// selectors). Rejects text, ASCII, or multiple emojis → null.
function sanitizeEmoji(value) {
  if (typeof value !== "string") return null;
  const m = value.match(
    /\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic})*/u,
  );
  return m ? m[0] : null;
}

async function callGemini(title, description, labels = [], department = null) {
  _checkDailyLimit();
  _countGeminiCall(1);
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
    access: sanitizeAccess(parsed.access),
    emoji: sanitizeEmoji(parsed.emoji),
    age_range: sanitizeAgeRange(parsed.age_range),
    dev_targets: sanitizeDevTargets(parsed.dev_targets),
  });
}

/**
 * Batch version of callGemini — send up to BATCH_SIZE events in one API call.
 * @param {Array<{title, description, siteLabels, department}>} events
 * @returns {Promise<Array<object>>} parallel array of reconciled label objects
 */
async function callGeminiBatch(events) {
  if (events.length === 1) {
    const ev = events[0];
    return [await callGemini(ev.title, ev.description, ev.siteLabels, ev.department)];
  }

  _checkDailyLimit();
  _countGeminiCall(events.length); // counts as N events even though it's 1 API call

  const popularTags = await getPopularTagsForPrompt();
  const popularLine = popularTags.length
    ? `תגיות קיימות במערכת (לפי פופולריות, השתמשי בהן במקום להמציא וריאנטים): ${popularTags.join(" | ")}\n\n`
    : "";

  const sections = events.map((ev, i) => {
    const labelLine = ev.siteLabels?.length
      ? `תגיות מהאתר: ${ev.siteLabels.join(" | ")}\n\n`
      : "";
    const deptLine = ev.department ? `מחלקה (מהאתר): ${ev.department}\n\n` : "";
    return (
      `--- אירוע ${i + 1} ---\n` +
      `כותרת: ${ev.title || "(no title)"}\n\n` +
      deptLine +
      labelLine +
      `תיאור: ${ev.description || "(no description on page)"}`
    );
  });

  const payload = popularLine + sections.join("\n\n");

  const result = await withTimeout(
    batchModel.generateContent({
      contents: [{ role: "user", parts: [{ text: payload }] }],
    }),
    PER_CALL_TIMEOUT_MS * 2,
    "enrich-batch",
  );
  const text = result?.response?.text?.() || "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Bad JSON from Gemini batch: ${err.message} (raw="${text.slice(0, 120)}")`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Gemini batch did not return an array (got ${typeof parsed})`);
  }
  if (parsed.length !== events.length) {
    throw new Error(`Gemini batch returned ${parsed.length} items, expected ${events.length}`);
  }
  return parsed.map((item, i) =>
    reconcileLabels(
      {
        min_months: sanitizeMonths(item.min_months),
        max_months: sanitizeMonths(item.max_months),
        audience: AUDIENCES.includes(item.audience) ? item.audience : "לכל המשפחה",
        category: CATEGORIES.includes(item.category) ? item.category : "אחר",
        tags: filterStringArray(item.tags),
        access: sanitizeAccess(item.access),
        emoji: sanitizeEmoji(item.emoji),
        age_range: sanitizeAgeRange(item.age_range),
        dev_targets: sanitizeDevTargets(item.dev_targets),
      },
      {
        name: events[i]?.title,
        description: events[i]?.description,
      },
    ),
  );
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
const { normalizeSeniorLabels } = require("./seniorAudience");

function reconcileLabels(labels, context = null) {
  const lo = labels.min_months;
  const hi = labels.max_months;
  const childRange =
    typeof hi === "number" && hi <= 144 && (typeof lo !== "number" || lo < 144);
  let out = labels;
  if (childRange && labels.audience === "מבוגרים") {
    out = { ...labels, audience: "לכל המשפחה" };
  }
  if (context) {
    out = normalizeSeniorLabels(out, context);
  }
  // Strip tags that merely echo a concept already captured by audience/access
  // (e.g. "נוער", "קהילה גאה") — keep tags as a clean topical layer only.
  if (Array.isArray(out.tags) && out.tags.some(isCoveredTagConcept)) {
    out = { ...out, tags: out.tags.filter((t) => !isCoveredTagConcept(t)) };
  }
  return out;
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
async function applyLabels(eventId, labels, hash, { preserveAudienceCategory = true } = {}) {
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
      "audience, category, access, age_range, dev_targets, emoji, name, umbrella_title, description, umbrella_id, umbrellas:umbrella_id(default_category)",
    )
    .eq("id", eventId)
    .maybeSingle();

  const hinted = reconcileLabels(labels, existing);

  // access (HARD visibility filter): union of (existing community scopes —
  // never downgrade), the high-precision regex on name+description, and
  // Gemini's access. sanitizeAccess dedupes, drops "open" when a community
  // scope is present, and defaults to ["open"].
  const access = sanitizeAccess(
    [].concat(
      Array.isArray(existing?.access) ? existing.access : [],
      classifyAllAccessForEvent({ name: existing?.name, description: existing?.description }) || [],
      Array.isArray(labels.access) ? labels.access : [],
    ),
  );

  const { error } = await supabase
    .from("events")
    .update({
      min_months: hinted.min_months,
      max_months: hinted.max_months,
      description_hash: hash,
      access,
      // typed source-of-truth for display; preserve existing on a null from Gemini
      age_range: hinted.age_range ?? existing?.age_range ?? null,
      // developmental targeting; preserve existing when Gemini returns empty
      dev_targets: (hinted.dev_targets && hinted.dev_targets.length)
        ? hinted.dev_targets
        : (existing?.dev_targets ?? []),
      // LLM-chosen content emoji; preserve existing on a null/empty from Gemini.
      emoji: hinted.emoji || existing?.emoji || null,
    })
    .eq("id", eventId);
  if (error) {
    throw new Error(`Save labels (events row) failed: ${error.message}`);
  }

  // Category fallback: Gemini's category → prior DB value → the umbrella's
  // STRUCTURED default_category (FK join). No regex text-scan of
  // name/description/umbrella_title — classification is the LLM's job.
  const inferredCategory = existing?.umbrella_id
    ? existing?.umbrellas?.default_category || null
    : null;
  await labelStore.setEventLabels(eventId, {
    audience: preserveAudienceCategory
      ? hinted.audience || existing?.audience || null
      : hinted.audience,
    category: preserveAudienceCategory
      ? labels.category || existing?.category || inferredCategory || null
      : labels.category,
    tags: hinted.tags,
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
    .select("min_months, max_months, description_hash, audience, category, tag_ids, access, age_range, dev_targets, emoji, description")
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
      "audience, category, access, age_range, dev_targets, emoji, name, umbrella_title, description, umbrella_id, umbrellas:umbrella_id(default_category)",
    )
    .eq("id", dstEventId)
    .maybeSingle();

  // Same child-first fallback chain as applyLabels (see comment
  // block there) — duplicated rather than extracted to a helper
  // because the slot ordering (source-first vs. labels-first)
  // differs between the two call sites and a shared signature
  // would obscure that. Order:
  //   name strict → description → name loose → umbrella FK / text
  // Category fallback: source/Gemini → dst prior value → umbrella's STRUCTURED
  // default_category (FK). No regex text-scan — classification is the LLM's job.
  const inferredCategory = dst?.umbrella_id
    ? dst?.umbrellas?.default_category || null
    : null;

  const { error: wrErr } = await supabase
    .from("events")
    .update({
      min_months: full.min_months,
      max_months: full.max_months,
      description_hash: full.description_hash,
      // Cache hits previously copied only structured labels, leaving the
      // prose `description` null on every sibling that skipped the detail
      // fetch (e.g. the 7 "סיור בחווה השיקומית" rows sharing one hash).
      // Inherit the source's prose too — same hash means identical
      // title+description, so it's the correct text. Never blank out a
      // description the destination already has.
      description: dst?.description || full.description || null,
      audience: full.audience || dst?.audience || null,
      category:
        full.category || dst?.category || inferredCategory || null,
      tag_ids: full.tag_ids || [],
      // access: union of dst's existing community scopes, the regex on dst's
      // name+description, and the source's access. Community wins; ["open"]
      // only when nothing positive — never downgrades a community scope.
      access: sanitizeAccess(
        [].concat(
          Array.isArray(dst?.access) ? dst.access : [],
          classifyAllAccessForEvent({ name: dst?.name, description: dst?.description }) || [],
          Array.isArray(full.access) ? full.access : [],
        ),
      ),
      age_range: full.age_range ?? dst?.age_range ?? null,
      dev_targets: (Array.isArray(full.dev_targets) && full.dev_targets.length)
        ? full.dev_targets
        : (dst?.dev_targets ?? []),
      emoji: full.emoji || dst?.emoji || null,
    })
    .eq("id", dstEventId);
  if (wrErr) {
    throw new Error(`copyFromSource update failed: ${wrErr.message}`);
  }
}

// Minimal fallback when Gemini fails. Callers merge rule-based hints
// (content tags, audience/category inference) before persisting.
function unclassifiedFallback() {
  return {
    min_months: null,
    max_months: null,
    audience: null,
    category: null,
    tags: [],
  };
}

function isTimeoutError(err) {
  return err && /timeout/i.test(err.message || "");
}

function classifyEnrichmentError(err) {
  const msg = (err?.message || "").toLowerCase();
  if (/timeout/i.test(msg)) return ENRICHMENT_FAIL_REASONS.GEMINI_TIMEOUT;
  if (/429|rate.?limit|resource exhausted|too many requests/i.test(msg)) {
    return ENRICHMENT_FAIL_REASONS.GEMINI_RATE_LIMIT;
  }
  if (/daily gemini limit/i.test(msg)) {
    return ENRICHMENT_FAIL_REASONS.GEMINI_DAILY_LIMIT;
  }
  if (/bad json/i.test(msg)) return ENRICHMENT_FAIL_REASONS.GEMINI_BAD_JSON;
  if (/detail fetch failed|city enrich|proceeding with title-only/i.test(msg)) {
    return ENRICHMENT_FAIL_REASONS.INPUT_FETCH;
  }
  return ENRICHMENT_FAIL_REASONS.GEMINI_ERROR;
}

function computeNextRetryAt(failCount, reason) {
  const now = Date.now();
  if (reason === ENRICHMENT_FAIL_REASONS.GEMINI_DAILY_LIMIT) {
    const d = new Date();
    d.setHours(24, 0, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  if (reason === ENRICHMENT_FAIL_REASONS.INPUT_FETCH) {
    return new Date(now + 30 * 60 * 1000);
  }
  if (reason === ENRICHMENT_FAIL_REASONS.GEMINI_RATE_LIMIT) {
    return new Date(now + 2 * 60 * 60 * 1000);
  }
  const idx = Math.min(Math.max(failCount - 1, 0), ENRICHMENT_RETRY_DELAYS_MS.length - 1);
  return new Date(now + ENRICHMENT_RETRY_DELAYS_MS[idx]);
}

let _retryColumnsOk = null;

async function checkRetryColumns() {
  if (_retryColumnsOk !== null) return _retryColumnsOk;
  const { error } = await supabase
    .from("events")
    .select("enrichment_fail_count, enrichment_next_retry_at")
    .limit(1);
  if (error && isMissingColumnError(error)) {
    _retryColumnsOk = false;
    return false;
  }
  _retryColumnsOk = true;
  return true;
}

async function markEnrichmentSuccess(eventId) {
  if (!(await checkRetryColumns())) return;
  const { error } = await supabase
    .from("events")
    .update({
      enrichment_fail_count: 0,
      enrichment_fail_reason: null,
      enrichment_next_retry_at: null,
      enrichment_failed_at: null,
    })
    .eq("id", eventId);
  if (error) {
    console.warn(`[Enricher] #${eventId} markEnrichmentSuccess failed: ${error.message}`);
  }
}

/**
 * Record a classified failure and schedule retry (or permanent give-up).
 * Never clears audience/category/tags — only metadata columns.
 */
async function recordEnrichmentFailure(eventId, reason) {
  if (!(await checkRetryColumns())) {
    await markEnrichmentFailedLegacy(eventId);
    return { permanent: true, failCount: 1, nextRetryAt: null };
  }
  const { data: row } = await supabase
    .from("events")
    .select("enrichment_fail_count")
    .eq("id", eventId)
    .maybeSingle();
  const prev = row?.enrichment_fail_count || 0;
  const failCount = prev + 1;
  const permanent = failCount >= ENRICHMENT_MAX_FAILS;
  const nextRetryAt = permanent ? null : computeNextRetryAt(failCount, reason);
  const patch = {
    enrichment_fail_count: failCount,
    enrichment_fail_reason: reason,
    enrichment_next_retry_at: nextRetryAt ? nextRetryAt.toISOString() : null,
    enrichment_failed_at: permanent ? new Date().toISOString() : null,
  };
  const { error } = await supabase.from("events").update(patch).eq("id", eventId);
  if (error) {
    console.warn(`[Enricher] #${eventId} recordEnrichmentFailure failed: ${error.message}`);
  }
  return { permanent, failCount, nextRetryAt: nextRetryAt?.toISOString() || null };
}

/** Legacy binary stamp when sql/072 is not applied yet. */
async function markEnrichmentFailedLegacy(eventId) {
  const { error } = await supabase
    .from("events")
    .update({ enrichment_failed_at: new Date().toISOString() })
    .eq("id", eventId);
  if (error) {
    console.warn(`[Enricher] #${eventId} failed to stamp enrichment_failed_at: ${error.message}`);
  }
}

/** @deprecated use recordEnrichmentFailure */
async function markEnrichmentFailed(eventId) {
  return recordEnrichmentFailure(eventId, ENRICHMENT_FAIL_REASONS.GEMINI_TIMEOUT);
}

function applyRuleBasedAudienceCategory(labels) {
  // Audience + category are classified by Gemini (structured, required enums),
  // NOT by regex on the text. Pass-through kept only so the non-Gemini fallback
  // path keeps the same shape — when Gemini is unavailable the event stays
  // unclassified (audience/category null) and is retried later, rather than
  // guessed by brittle keyword regex.
  return { ...labels, audience: labels?.audience || null, category: labels?.category || null };
}

function buildRuleBasedLabels(ctx) {
  let labels = unclassifiedFallback();
  labels = withPreservedClusters(labels, ctx.preservedClusters);
  labels = mergeContentBasedTags(labels, {
    name: ctx.name,
    description: ctx.description,
  });
  labels = applyRuleBasedAudienceCategory(labels, {
    name: ctx.name,
    description: ctx.description,
  });
  return labels;
}

async function rowHasUsefulLabels(eventId) {
  const { data: row } = await supabase
    .from("events")
    .select("audience, category, tag_ids")
    .eq("id", eventId)
    .maybeSingle();
  if (!row) return false;
  const hasTags = Array.isArray(row.tag_ids) && row.tag_ids.length > 0;
  const hasAudience = !!row.audience;
  const hasCategory = !!row.category;
  return hasTags || (hasAudience && hasCategory);
}

/**
 * Gemini (or prep) failed: apply rule-based labels without wiping DB,
 * then schedule retry or permanent give-up.
 */
async function handleEnrichmentFailure(ctx, err, { hash = null } = {}) {
  const reason = classifyEnrichmentError(err);
  const labels = buildRuleBasedLabels(ctx);
  if (hash) {
    await applyLabels(ctx.id, labels, hash, { preserveAudienceCategory: true });
  } else {
    await labelStore.setEventLabels(ctx.id, {
      audience: labels.audience,
      category: labels.category,
      tags: labels.tags,
    });
  }
  const useful = await rowHasUsefulLabels(ctx.id);
  const meta = await recordEnrichmentFailure(ctx.id, reason);
  return { reason, useful, ...meta };
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
    // Smarticket (mbe-rg / ramat-gan): the homepage scraper sets a bare venue
    // NAME first ("אשכול אופק"), which often geocodes to the wrong city. The
    // detail page carries a Google-Maps link with the real street address
    // (extractEventAddress prefers it), so for those sources we DON'T early-
    // return on an already-set key — we re-extract and let the detail address
    // override the bare-name guess.
    const SMARTICKET = source === "mbe-rg" || source === "ramat-gan";
    if (row?.location_key && !isAddressSentinel(currentRawAddress) && !SMARTICKET) return;

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
    if (!key || key === row?.location_key) return; // unchanged → no churn

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
      const { data: rowAfterSib } = await supabase
        .from("events")
        .select("description")
        .eq("id", id)
        .maybeSingle();
      await applyContentBasedTagsToEvent(id, name, rowAfterSib?.description);
      await markEnrichmentSuccess(id);
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
      .select("external_slug, tag_ids, description, umbrella_title")
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
    // City events have no breadcrumb "department", but umbrella_title is the
    // equivalent identity/context slot — e.g. "הרצאות במועדונים לוותיקים" tells
    // Gemini the age (60+) the per-event title/description omit. Without it an
    // umbrella child like "האומנם יבואו ימים" has no age signal → defaults 18+.
    department = row?.umbrella_title || null;
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
      await applyContentBasedTagsToEvent(id, name, description);
      await markEnrichmentSuccess(id);
      return { source: "hash_cache", source_event_id: hit.id };
    }
  }

  // 4. Cache miss → Gemini. On failure: rule-based labels (preserve DB),
  //    backoff retry, permanent give-up only after ENRICHMENT_MAX_FAILS.
  const preservedClusters =
    source === "rg-muni" ? siteLabels : smarticketCluster;
  let labels;
  try {
    labels = await callGemini(name, description, siteLabels, department);
  } catch (err) {
    if (!isTimeoutError(err) && !/429|rate.?limit|daily gemini limit/i.test(err.message || "")) {
      throw err;
    }
    const fail = await handleEnrichmentFailure(
      { id, name, description, preservedClusters },
      err,
      { hash },
    );
    console.warn(
      `[Enricher] #${id} Gemini failed (${fail.reason}) — rule-based fallback, ` +
        `retry ${fail.permanent ? "exhausted" : fail.nextRetryAt || "scheduled"}`,
    );
    return { source: "fallback_failure", labels: buildRuleBasedLabels({ id, name, description, preservedClusters }), needsReview: !fail.useful };
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
  labels = withPreservedClusters(labels, preservedClusters);
  labels = mergeContentBasedTags(labels, { name, description });
  await applyLabels(id, labels, hash);
  await markEnrichmentSuccess(id);
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

// ─────────────────────────────────────────────────────────────────────
// Content-based tag injection (name + description) — applied AFTER
// Gemini / cache copy so obvious topics are present even when the model
// skipped them or enrichment ran before `description` was persisted.
//
// Tag names must match an existing `labels` row — unresolvable names
// are silently dropped by labelStore.
// ─────────────────────────────────────────────────────────────────────
// DISABLED — Gemini now owns topical tagging: it receives the full in-use tag
// vocabulary every call and self-dedupes semantically. These regex→tag rules
// became redundant AND contradictory with the structured fields — they forced
// נוער/חינוך מיוחד/מילואים (now audience/access communities) and סדנה/הרצאה/הצגה
// (now the category field) as tags. Emptied to a no-op (mergeContentBasedTags
// returns early on a 0-length list). The dead list below is kept for reference
// and can be deleted with its now-unused functions/call-sites in a follow-up.
const ENRICHER_CONTENT_TAG_RULES = [];
const _DEAD_CONTENT_TAG_RULES = [
  { re: /משחקיה|משחקייה/u, fields: ["name"], tags: ["משחקיות"] },
  // Books / book fairs — title-only events (no description) were getting NO
  // tags from Gemini; this guarantees a topical tag from the name.
  { re: /ספרים|רכישת\s+ספר|יריד\s+ספר|ספרי[יה]ה|ספרות|חודש\s+הקריאה/u, fields: ["name", "description"], tags: ["ספרים"] },
  { re: /גן\s+יחד/u, fields: ["name", "description"], tags: ["גן יחד"] },
  { re: /החוג\s+של\s+קרן|קרן\s+אלנתן/u, fields: ["name"], tags: ["מוזיקה", "התפתחות"] },
  { re: /גיטר/u, fields: ["name", "description"], tags: ["גיטרה", "מוזיקה"] },
  { re: /שירה|שירים|נגינ|מקצב/u, fields: ["name", "description"], tags: ["מוזיקה"] },
  { re: /ריקוד/u, fields: ["name", "description"], tags: ["ריקוד"] },
  { re: /הור[יי]ם/u, fields: ["name", "description"], tags: ["הורות"] },
  {
    re: /חינוך\s*מיוחד|צרכים\s*מיוחדים/u,
    fields: ["name", "description"],
    tags: ["חינוך מיוחד"],
  },
  {
    re: /מילואים|מילואימניק|משרת[יי]\.?\s*ות?\s*מילואים/u,
    fields: ["name", "description"],
    tags: ["מילואימניקים"],
  },
  { re: /סרטון|וידאו|טיקטוק|יוטיוב/u, fields: ["name", "description"], tags: ["סרטון"] },
  { re: /סדנ[הת](?=\s|$)|אומן(?=\s|$)/u, fields: ["name", "description"], tags: ["סדנה"] },
  { re: /נוער|כיתות\s*ז/u, fields: ["name", "description"], tags: ["נוער"] },
  { re: /יצירה|DIY|מייקר/u, fields: ["name", "description"], tags: ["יצירה"] },
  { re: /הרצא[הת](?=\s|$)/u, fields: ["name", "description"], tags: ["הרצאה"] },
  { re: /הצג[הת](?=\s|$)|תיאטרון/u, fields: ["name", "description"], tags: ["הצגה"] },
  // "שעת סיפור" — canonical kids storytelling activity. Kept as a
  // multi-word phrase (סיפור alone shows up in prose too often). Was
  // only an `activity` category keyword before, so events like
  // "שעת סיפור בנווה" never got a "שעת סיפור" content tag.
  { re: /שעת\s+סיפור/u, fields: ["name", "description"], tags: ["שעת סיפור"] },
];

function mergeContentBasedTags(labels, { name = "", description = "" } = {}) {
  if (!ENRICHER_CONTENT_TAG_RULES.length) return labels;
  const texts = {
    name: String(name || ""),
    description: String(description || "").replace(/\s+/g, " "),
  };
  const existing = Array.isArray(labels?.tags) ? labels.tags : [];
  const seen = new Set(existing.map((t) => labelStore.normalizeName(String(t))));
  const merged = [...existing];
  for (const { re, tags, fields } of ENRICHER_CONTENT_TAG_RULES) {
    const hay = (fields || ["name"])
      .map((f) => texts[f] || "")
      .filter(Boolean)
      .join(" ");
    if (!hay || !re.test(hay)) continue;
    for (const t of tags) {
      const norm = labelStore.normalizeName(t);
      if (!seen.has(norm)) {
        seen.add(norm);
        merged.push(t);
      }
    }
  }
  return { ...labels, tags: merged };
}

/** @deprecated use mergeContentBasedTags */
function withNameBasedTags(labels, name) {
  return mergeContentBasedTags(labels, { name });
}

async function applyContentBasedTagsToEvent(eventId, name, description) {
  const { data: row, error } = await supabase
    .from("events")
    .select("audience, category, tag_ids")
    .eq("id", eventId)
    .maybeSingle();
  if (error || !row) return false;
  const dict = await labelStore.fetchLabelDict(row.tag_ids || []);
  const expanded = labelStore.expandWithDict(row, dict);
  const before = new Set(
    (expanded.tags || []).map((t) => labelStore.normalizeName(String(t))),
  );
  let merged = mergeContentBasedTags({ tags: expanded.tags }, { name, description });
  merged = applyRuleBasedAudienceCategory(
    { audience: row.audience, category: row.category, tags: merged.tags },
    { name, description },
  );
  const tagsAdded = merged.tags.some(
    (t) => !before.has(labelStore.normalizeName(String(t))),
  );
  const categoryAdded = !row.category && !!merged.category;
  const audienceAdded = !row.audience && !!merged.audience;
  if (!tagsAdded && !categoryAdded && !audienceAdded) return false;
  await labelStore.setEventLabels(eventId, {
    audience: merged.audience || row.audience,
    category: merged.category || row.category,
    tags: merged.tags,
  });
  return true;
}

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
  // Selection criteria (sql/072 when applied):
  //   1. Never-enriched: description_hash IS NULL
  //   2. Partial crash: hash set but audience AND category both null
  //   3. Transient retry: enrichment_next_retry_at <= now, fail_count < MAX
  //   4. Tag completion: hash set, tag_ids empty, retry window open
  //
  // Permanent give-up: enrichment_failed_at IS NOT NULL (skipped entirely).
  // We do NOT sweep "audience null alone" — May-2026 infinite-loop guard.
  const retryOk = await checkRetryColumns();
  const nowIso = new Date().toISOString();
  let orClause =
    "description_hash.is.null," +
    "and(description_hash.not.is.null,audience.is.null,category.is.null)";
  if (retryOk) {
    orClause +=
      `,and(enrichment_next_retry_at.lte.${nowIso},enrichment_fail_count.lt.${ENRICHMENT_MAX_FAILS})` +
      `,and(description_hash.not.is.null,tag_ids.eq.{},or(enrichment_next_retry_at.is.null,enrichment_next_retry_at.lte.${nowIso}))`;
  } else {
    // sql/072 not applied yet — still complete tag-less enriched rows.
    orClause += ",and(description_hash.not.is.null,tag_ids.eq.{})";
  }
  const { data, error } = await supabase
    .from("events")
    .select("id, name, source")
    .eq("archived", false)
    .is("enrichment_failed_at", null)
    .or(orClause)
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Pending events fetch failed: ${error.message}`);
  return data || [];
}

// ── Two-phase batch enrichment helpers ──────────────────────────────────────
//
// Phase 1 — `_collectGeminiInput`: runs all the cheap/cached steps for a
//   single event and returns either a cache-hit result or the inputs needed
//   to call Gemini.
//
// Phase 2 — `enrichPendingEvents`: collects phase-1 outputs, groups the
//   Gemini-needed items into batches of BATCH_SIZE, calls callGeminiBatch
//   once per batch, then applies the returned labels.
//
// This reduces Gemini system-prompt overhead from O(N) to O(N/BATCH_SIZE):
// for 20 events with 5 cache misses we pay 1 system prompt instead of 5.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Runs steps 1–3 of the enrichment pipeline (sibling cache, description
 * fetch, hash cache) WITHOUT calling Gemini.
 *
 * Returns one of:
 *   { cached: true,  result }  — cache hit; caller should record it directly.
 *   { cached: false, ctx    }  — cache miss; ctx carries everything needed for
 *                                callGeminiBatch / callGemini.
 */
async function _collectGeminiInput({ id, name, source }) {
  const { data: descRow } = await supabase
    .from("events")
    .select("description")
    .eq("id", id)
    .maybeSingle();
  const persistedDescription = descRow?.description || "";

  // 0. Hash present but no tags — try content rules before Gemini.
  if (await tryCompleteWithContentTags(id, name, persistedDescription)) {
    return { cached: true, result: { source: "content_tags" } };
  }

  // 1. Sibling cache
  if (name) {
    const sib = await findSibling(name, id);
    if (sib) {
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
      if (preCopyTagIds.length) await mergeBackTagIds(id, preCopyTagIds);
      const { data: rowAfterSib } = await supabase
        .from("events")
        .select("description")
        .eq("id", id)
        .maybeSingle();
      await applyContentBasedTagsToEvent(id, name, rowAfterSib?.description);
      await markEnrichmentSuccess(id);
      return { cached: true, result: { source: "sibling_cache", source_event_id: sib.id } };
    }
  }

  // 2. Fetch description, site labels, department
  let description, siteLabels, department, smarticketCluster = null;
  if (source === "rg-muni") {
    const { data: row, error } = await supabase
      .from("events")
      .select("external_slug, tag_ids, description, umbrella_title")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`city enrich: row fetch failed for #${id}: ${error.message}`);
    if (!row?.external_slug) {
      console.warn(`[Enricher] #${id} (rg-muni) row missing external_slug; falling back to title-only.`);
      description = "";
    } else if (typeof row.description === "string" && row.description.trim()) {
      description = row.description;
    } else {
      try {
        const detail = await cityApi.fetchEventDetail(row.external_slug);
        description = cityApi.extractCityDescription(detail);
      } catch (err) {
        console.warn(`[Enricher] #${id} (rg-muni) detail fetch failed: ${err.message}; proceeding with title-only.`);
        description = "";
      }
    }
    const tagIds = row?.tag_ids || [];
    const dict = await labelStore.fetchLabelDict(tagIds);
    siteLabels = labelStore.expandWithDict(row || { tag_ids: [] }, dict).tags;
    // City events have no breadcrumb "department", but umbrella_title is the
    // equivalent identity/context slot — e.g. "הרצאות במועדונים לוותיקים" tells
    // Gemini the age (60+) the per-event title/description omit. Without it an
    // umbrella child like "האומנם יבואו ימים" has no age signal → defaults 18+.
    department = row?.umbrella_title || null;
  } else {
    const { html, finalUrl } = await fetchDetailHtml(id, name, source);
    description = extractDescription(html);
    if (description) {
      await supabase.from("events").update({ description }).eq("id", id).is("description", null);
    }
    siteLabels = extractSmarticketLabels(html);
    smarticketCluster = extractSmarticketCluster(html);
    department = extractDepartment(html);
    await maybeFillLocationKey(id, html, source);
    const parentSlug = extractParentSlug(finalUrl);
    if (parentSlug) {
      const { smarticketGroupBySlug } = require("./smarticketUmbrellaService");
      await supabase.from("events").update({ external_slug: parentSlug }).eq("id", id).is("external_slug", null);
      smarticketGroupBySlug(source, parentSlug).catch((err) =>
        console.warn(`[Enricher] #${id} umbrella grouping failed: ${err.message}`),
      );
    }
  }

  const hash = hashDescription(description, name, siteLabels, department);

  // 3. Hash cache
  if (hash) {
    const hit = await findCacheHitByHash(hash, id);
    if (hit) {
      await copyFromSource(hit, id);
      if (source === "rg-muni" && siteLabels && siteLabels.length) {
        const ids = await labelStore.resolveMany(siteLabels);
        await mergeBackTagIds(id, ids);
      }
      await applyContentBasedTagsToEvent(id, name, description);
      await markEnrichmentSuccess(id);
      return { cached: true, result: { source: "hash_cache", source_event_id: hit.id } };
    }
  }

  // Cache miss — return inputs for the Gemini call
  return {
    cached: false,
    ctx: {
      id,
      name,
      source,
      title: name,
      description,
      siteLabels,
      department,
      hash,
      preservedClusters: source === "rg-muni" ? siteLabels : smarticketCluster,
    },
  };
}

/**
 * Apply a Gemini-returned label object to a single event (post-batch step).
 * Mirrors the tail of enrichEventData (withPreservedClusters → withNameBasedTags → applyLabels).
 */
async function _applyGeminiResult(ctx, labels) {
  labels = withPreservedClusters(labels, ctx.preservedClusters);
  labels = mergeContentBasedTags(labels, {
    name: ctx.name,
    description: ctx.description,
  });
  await applyLabels(ctx.id, labels, ctx.hash);
  await markEnrichmentSuccess(ctx.id);
  return { source: "gemini", labels };
}

/** Content-tag pass for rows that already have a hash but empty tag_ids. */
async function tryCompleteWithContentTags(id, name, description) {
  const { data: row } = await supabase
    .from("events")
    .select("description_hash, tag_ids")
    .eq("id", id)
    .maybeSingle();
  if (!row?.description_hash) return false;
  if (Array.isArray(row.tag_ids) && row.tag_ids.length > 0) return false;
  const added = await applyContentBasedTagsToEvent(id, name, description);
  if (added) await markEnrichmentSuccess(id);
  return added;
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

  console.log(`[Enricher] Processing ${events.length} event(s) (batch size: ${BATCH_SIZE})…`);
  let classified = 0;
  let cacheHits = 0;
  let siblingHits = 0;
  let errors = 0;
  const fallbackEvents = []; // events that timed out — audience=null, needs manual review

  // ── Phase 1: prep all events (sibling cache / HTML fetch / hash cache) ──
  const geminiBatch = []; // items that need Gemini: { ev, ctx }
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    try {
      const prep = await _collectGeminiInput(ev);
      if (prep.cached) {
        classified++;
        if (prep.result.source === "hash_cache") cacheHits++;
        if (prep.result.source === "sibling_cache") siblingHits++;
        const src = prep.result.source;
        const via = prep.result.source_event_id
          ? `#${prep.result.source_event_id}`
          : "";
        console.log(
          `[Enricher] #${ev.id} "${(ev.name || "").slice(0, 40)}" → ${src}${via ? ` ${via}` : ""}`,
        );
      } else {
        geminiBatch.push({ ev, ctx: prep.ctx });
      }
    } catch (err) {
      errors++;
      console.error(`[Enricher] #${ev.id} prep failed: ${err.message}`);
      try {
        await recordEnrichmentFailure(ev.id, classifyEnrichmentError(err));
      } catch {
        /* best-effort */
      }
    }
    if (i + 1 < events.length) {
      await new Promise((r) => setTimeout(r, DETAIL_FETCH_GAP_MS));
    }
  }

  // ── Phase 2: batch Gemini calls (BATCH_SIZE events per call) ──
  for (let b = 0; b < geminiBatch.length; b += BATCH_SIZE) {
    const chunk = geminiBatch.slice(b, b + BATCH_SIZE);
    const inputs = chunk.map((c) => ({
      title: c.ctx.title,
      description: c.ctx.description,
      siteLabels: c.ctx.siteLabels,
      department: c.ctx.department,
    }));

    let results;
    try {
      results = await callGeminiBatch(inputs);
    } catch (err) {
      // Batch failed — fall back to individual calls so one bad event
      // doesn't block the whole chunk.
      console.warn(`[Enricher] batch call failed (${err.message}); falling back to single calls`);
      results = null;
    }

    for (let j = 0; j < chunk.length; j++) {
      const { ev, ctx } = chunk[j];
      try {
        let labels;
        if (results) {
          labels = results[j];
        } else {
          try {
            labels = await callGemini(ctx.title, ctx.description, ctx.siteLabels, ctx.department);
          } catch (err) {
            const retryable =
              isTimeoutError(err) ||
              /429|rate.?limit|daily gemini limit/i.test(err.message || "");
            if (!retryable) throw err;
            const fail = await handleEnrichmentFailure(ctx, err, { hash: ctx.hash });
            classified++;
            fallbackEvents.push({ id: ctx.id, name: ev.name, reason: fail.reason });
            console.log(
              `[Enricher] #${ctx.id} "${(ev.name || "").slice(0, 40)}" → fallback (${fail.reason}, ` +
                `retry ${fail.permanent ? "exhausted" : fail.nextRetryAt || "scheduled"})`,
            );
            continue;
          }
        }
        if (!labels) {
          const fail = await handleEnrichmentFailure(
            ctx,
            new Error("Gemini batch returned no labels for this event"),
            { hash: ctx.hash },
          );
          classified++;
          fallbackEvents.push({ id: ctx.id, name: ev.name, reason: fail.reason });
          continue;
        }
        const result = await _applyGeminiResult(ctx, labels);
        classified++;
        const labelStr = `${result.labels.audience || "—"}/${result.labels.category}/${result.labels.min_months}-${result.labels.max_months}m`;
        const batchTag = results ? `gemini-batch[${b / BATCH_SIZE}]` : "gemini";
        console.log(`[Enricher] #${ctx.id} "${(ev.name || "").slice(0, 40)}" → ${labelStr} (${batchTag})`);
      } catch (err) {
        errors++;
        console.error(`[Enricher] #${ctx.id} Gemini apply failed: ${err.message}`);
        try {
          await recordEnrichmentFailure(ctx.id, classifyEnrichmentError(err));
        } catch {
          /* best-effort */
        }
      }
    }
  }

  return { processed: events.length, classified, cacheHits, siblingHits, errors, fallbackEvents };
}

module.exports = {
  enrichEventData,
  enrichPendingEvents,
  callGemini, // exposed for fresh-classification experiments / diagnostics
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
  mergeContentBasedTags,
  applyContentBasedTagsToEvent,
  recordEnrichmentFailure,
  markEnrichmentSuccess,
  classifyEnrichmentError,
  ENRICHMENT_FAIL_REASONS,
  ENRICHMENT_MAX_FAILS,
  // exported for tests / introspection
  AUDIENCES,
  CATEGORIES,
  SCHEMA_VERSION,
};
