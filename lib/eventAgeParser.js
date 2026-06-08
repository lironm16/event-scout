// Deterministic Hebrew age-phrase parser for EVENT NAMES.
//
// Why this exists
// ---------------
// The Gemini enricher prompt documents exactly how to read Hebrew age phrases
// ("זחילה"→6mo, "הליכה עד שלוש"→12–36mo, …) but that only works when Gemini
// actually RUNS. In practice many events get their classification from the
// sibling/hash CACHE or the rule-based fallback, so a wrong audience (almost
// always the נוער default-bucket) propagates and never self-corrects.
//
// This module re-derives age + audience from the NAME with pure regex — no
// LLM, no rate limit, fully reproducible. It is used:
//   • as a post-Gemini reconcile (prevent recurrence), and
//   • for a one-time retroactive backfill of non-archived events.
//
// Design: PRECISION over recall. We only fire when there is a real age signal
// (גיל/גילאי/מגיל, a developmental stage word, "+N", explicit חודשים/שנים, or a
// teen/senior keyword). A bare "8-11" with no age context (e.g. a date range)
// is intentionally ignored. When unsure → return null (leave the event alone).

// Developmental-stage anchors → months.
const STAGE_MONTHS = [
  { re: /לידה/, m: 0 },
  { re: /זחיל|זוחל/, m: 6 },   // crawling ≈ 6 mo
  { re: /הליכ|הולכ/, m: 12 },  // walking ≈ 12 mo
];

// Hebrew number-words → YEARS (compounds first so "שתים עשרה" wins over "עשר").
const WORD_YEARS = [
  [/שלוש\s*עשרה/, 13],
  [/(?:שתים|שתיים)\s*עשרה/, 12],
  [/אחת\s*עשרה/, 11],
  [/עשרה|עשר/, 10],
  [/תשע/, 9],
  [/שמונה/, 8],
  [/שבע/, 7],
  [/שש|שיש/, 6],
  [/חמש/, 5],
  [/ארבע/, 4],
  [/שלושה|שלוש/, 3],
];

function normalize(name) {
  return String(name || "")
    .replace(/[״"'`׳]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// Resolve a single endpoint token (already isolated as part of an age phrase)
// to months, or null.
function tokenToMonths(t) {
  t = String(t || "").trim();
  if (!t) return null;
  for (const s of STAGE_MONTHS) if (s.re.test(t)) return s.m;
  if (/חצי\s*שנה/.test(t)) return 6;
  if (/שנה\s*וחצי/.test(t)) return 18;
  if (/שנתיים/.test(t)) return 24;
  for (const [re, y] of WORD_YEARS) if (re.test(t)) return y * 12;
  if (/\bשנה\b|שנת/.test(t)) return 12;
  const d = t.match(/(\d+(?:\.\d+)?)/);
  if (d) {
    const n = parseFloat(d[1]);
    if (!Number.isFinite(n)) return null;
    if (/חודש|ח'/.test(t)) return Math.round(n);        // explicit months
    if (n > 18) return null;                             // a bare big number isn't a kid age
    return Math.round(n * 12);                           // years → months
  }
  return null;
}

// Endpoint matcher used to scan an age-context segment.
const ENDPOINT_RE =
  /(לידה|זחיל\w*|זוחל\w*|הליכ\w*|הולכ\w*|שנה\s*וחצי|חצי\s*שנה|שנתיים|שלוש\s*עשרה|(?:שתים|שתיים)\s*עשרה|אחת\s*עשרה|עשרה|עשר|תשעה?|שמונה|שבעה?|שישה?|שש|חמישה?|חמש|ארבעה?|ארבע|שלושה?|שלוש|שנה|\d+(?:\.\d+)?\s*(?:חודשים|חודש|ח')?)/g;

function endpointsIn(seg) {
  const eps = [];
  let m;
  ENDPOINT_RE.lastIndex = 0;
  while ((m = ENDPOINT_RE.exec(seg)) !== null) {
    const months = tokenToMonths(m[1]);
    if (months != null) eps.push({ text: m[1], months, idx: m.index });
  }
  return eps;
}

/**
 * Parse an age RANGE (months) from an event name.
 * @returns {{min:number|null, max:number|null}|null}
 */
function parseAgeRangeFromName(name) {
  const s = normalize(name);
  if (!s) return null;

  // Build the age-context segment: prefer text after an age marker, else a
  // region anchored on a developmental-stage word.
  let seg = null;
  const marker = s.match(/(?:לגילאים|לגילאי|גילאי|לגיל|מגיל|בגיל|גיל)\s*(.{0,28})/);
  if (marker && endpointsIn(marker[1]).length) seg = marker[1];
  if (!seg) {
    const stage = s.match(
      /((?:לידה|זחיל\w*|זוחל\w*|הליכ\w*|הולכ\w*)[^,.;:()]{0,24})/,
    );
    if (stage) seg = stage[1];
  }

  if (seg) {
    const eps = endpointsIn(seg);
    if (eps.length) {
      const hasAd = /עד/.test(seg);
      const hasDash = /-/.test(seg);
      const hasFrom = /(^|[^א-ת])מ|מגיל/.test(s) || /(מזחיל|מהליכ|מלידה)/.test(s);
      const hasPlus = /\+|ומעלה|ומ?על\b/.test(seg);

      if (eps.length >= 2 && (hasAd || hasDash)) {
        const a = eps[0].months;
        const b = eps[1].months;
        return { min: Math.min(a, b), max: Math.max(a, b) };
      }
      const v = eps[0].months;
      if (hasPlus) return { min: v, max: null };
      if (hasAd && !hasFrom) return { min: 0, max: v };           // "עד X"
      if (hasFrom) return { min: v, max: null };                  // "מ-X" / "מזחילה"
      if (/לידה|זחיל|זוחל|הליכ|הולכ/.test(eps[0].text)) return { min: v, max: null };
      // a lone explicit-months/number point
      return { min: v, max: v };
    }
  }

  // standalone "גיל הרך" (early childhood) with no explicit range
  if (/גיל\s*הרך/.test(s)) return { min: 0, max: 36 };

  return null;
}

// Parent-directed talks/clinics → audience "הורים". These are inherently for
// the PARENT even when they mention the baby ("הרצאת שינה בגיל הרך",
// "קליניקת הנקה"), so this takes PRIORITY over the child-age logic. Guarded by
// FAMILY_RE so "להורים וילדים" stays a family event, not a parents-only one.
const PARENT_TALK_RE =
  /קפה.{0,8}(?:עם|פסיכולוג)|פסיכולוג|הרצאת?\s*שינה|סדנת\s*שינה|יועצת\s*שינה|קליניקת?\s*הנקה|יועצת\s*הנקה|הנקה|הכנה ללידה|מעגל\s*(?:אמהות|אימהות|הורים|נשים)|הדרכת הורים|סדנת הורים|הרצאה להורים|ייעוץ הור|צוהר לעולם הרגשי|גמילה מחיתולים/;
const FAMILY_RE = /וילדים|ולילדים|הורים וילד|כל המשפחה|משפחתי/;

/**
 * Derive a confident audience from an age range (months). Returns null when
 * not confident (caller should then leave the event unchanged).
 */
function deriveAudience(min, max) {
  if (max != null && max <= 36) return "תינוקות";
  if (max != null && max <= 144 && (min == null || min < 144)) return "ילדים";
  if (min != null && min >= 144 && (max == null || max <= 216)) return "נוער";
  if (min != null && min >= 600) return "ותיקים";
  return null;
}

/**
 * Full deterministic classification from a name.
 * @returns {{min_months:number|null, max_months:number|null, audience:string|null, reason:string}}
 */
function classifyFromName(name) {
  const n = normalize(name);
  const range = parseAgeRangeFromName(name);
  let min = range ? range.min : null;
  let max = range ? range.max : null;
  let audience = null;
  let reason = "";

  if (PARENT_RE.test(n) && !CHILD_ACTIVITY_RE.test(n)) {
    audience = "הורים";
    reason = "parent-focused phrase";
  } else if (min != null || max != null) {
    audience = deriveAudience(min, max);
    reason = `age ${min}..${max}`;
  } else if (/ותיקים|גיל הזהב|גיל ה?שלישי|60\s*\+|אזרחים ותיקים/.test(n)) {
    audience = "ותיקים";
    min = 720;
    reason = "senior keyword";
  } else if (/(?:^|[^א-ת])לנוער(?:$|[^א-ת])|(?:^|[^א-ת])נוער(?:$|[^א-ת])|teens?\b/.test(n)) {
    audience = "נוער";
    min = 144;
    max = 216;
    reason = "teen keyword";
  }

  return { min_months: min, max_months: max, audience, reason };
}

module.exports = {
  normalize,
  tokenToMonths,
  parseAgeRangeFromName,
  deriveAudience,
  classifyFromName,
};
