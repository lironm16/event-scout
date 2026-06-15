// Typed age-range model (events.age_range JSONB) — the lossless source of truth
// for an event's target age, set by the Gemini enricher in one call.
//
// Shape:
//   { min: <endpoint>|null, max: <endpoint>|null }
//   endpoint = { kind: "stage"|"months"|"years", value: <enum|number>, inclusive: <bool> }
//     stage  → value ∈ "birth"|"crawl"|"walk"   (לידה / זחילה / הליכה)
//     months → value = months   ·   years → value = years   (kept in its own unit)
//     inclusive defaults true; false = "עד X (לא כולל)".
//   a null endpoint = open-ended.
//
// This module does TWO deterministic jobs (no LLM):
//   • resolveBounds()      → inclusive numeric { min_months, max_months } for
//                            kid-age matching/filtering (the indexed columns).
//   • formatAgeRangeLabel() → the Hebrew display string ("זחילה עד שלוש").

// Developmental stages are NOT converted to a guessed month count — a baby
// crawls anywhere from ~6 to ~10 months, so any fixed number is wrong for some
// children. We keep the stage as the source of truth for DISPLAY, and leave the
// numeric matching bound null on a stage endpoint (better unknown than wrong).
const STAGES = new Set(["birth", "crawl", "walk"]);
const STAGE_LABEL = { birth: "לידה", crawl: "זחילה", walk: "הליכה" };
const VALID_KINDS = new Set(["stage", "months", "years"]);

// Childhood ages read naturally as Hebrew words (שנה / שנתיים / שלוש …); teen+
// ages read better as digits ("18", "35"). So we keep words only for 1–10 and
// fall back to the bare numeral above that. yearLabel() applies this.
const YEAR_WORD = {
  1: "שנה", 1.5: "שנה וחצי", 2: "שנתיים", 2.5: "שנתיים וחצי",
  3: "שלוש", 4: "ארבע", 5: "חמש", 6: "שש", 7: "שבע", 8: "שמונה",
  9: "תשע", 10: "עשר",
};

/** Year value → label: small kid ages as words, larger as the bare numeral. */
function yearLabel(y) {
  return YEAR_WORD[y] || `${y}`;
}

/** Validate + normalize one endpoint from raw (Gemini) input → endpoint|null. */
function sanitizeEndpoint(ep) {
  if (!ep || typeof ep !== "object") return null;
  const kind = ep.kind;
  if (!VALID_KINDS.has(kind)) return null;
  let value = ep.value;
  if (kind === "stage") {
    if (!STAGES.has(value)) return null;
  } else {
    value = typeof value === "number" ? value : parseFloat(value);
    if (!Number.isFinite(value) || value < 0) return null;
  }
  return { kind, value, inclusive: ep.inclusive !== false };
}

/** Validate + normalize a raw age_range → { min, max } | null. */
function sanitizeAgeRange(raw) {
  if (!raw || typeof raw !== "object") return null;
  const min = sanitizeEndpoint(raw.min);
  const max = sanitizeEndpoint(raw.max);
  if (!min && !max) return null;
  return { min, max };
}

/** One endpoint → months (years×12 / months as-is), or null. Stages return
 *  null on purpose — we never fabricate a month count for a developmental stage. */
function endpointMonths(ep) {
  if (!ep) return null;
  if (ep.kind === "stage") return null; // no guessed number — display keeps the stage word
  if (ep.kind === "years") return Math.round(ep.value * 12);
  if (ep.kind === "months") return Math.round(ep.value);
  return null;
}

/**
 * Derive the INCLUSIVE numeric bounds used for matching/filtering. Exclusive
 * endpoints shift by one month so "עד זחילה (לא כולל)" (crawl=6, exclusive)
 * becomes max_months=5 (i.e. age < 6 mo).
 * @returns {{ min_months: number|null, max_months: number|null }}
 */
function resolveBounds(ageRange) {
  const ar = sanitizeAgeRange(ageRange);
  if (!ar) return { min_months: null, max_months: null };
  let lo = endpointMonths(ar.min);
  let hi = endpointMonths(ar.max);
  if (ar.min && ar.min.inclusive === false && lo != null) lo += 1;
  if (ar.max && ar.max.inclusive === false && hi != null) hi -= 1;
  return { min_months: lo, max_months: hi };
}

function endpointLabel(ep) {
  if (!ep) return null;
  if (ep.kind === "stage") return STAGE_LABEL[ep.value] || ep.value;
  if (ep.kind === "years") return yearLabel(ep.value);
  if (ep.kind === "months") {
    // Clean year / half-year counts read better as words than raw months:
    // 12→"שנה", 18→"שנה וחצי", 24→"שנתיים", 30→"שנתיים וחצי", 36→"שלוש".
    if (ep.value >= 12 && ep.value % 6 === 0) {
      const y = ep.value / 12;
      if (YEAR_WORD[y]) return YEAR_WORD[y];        // word exists (incl. 1.5 / 2.5)
      if (Number.isInteger(y)) return yearLabel(y); // whole year beyond the word map → numeral
    }
    return ep.value === 1 ? "חודש" : `${ep.value} חודשים`;
  }
  return null;
}

/**
 * Hebrew display label for the age range, preserving the original wording
 * ("זחילה עד שלוש", "עד זחילה (לא כולל)", "מ-3 שנים"). Returns null when empty.
 */
function formatAgeRangeLabel(ageRange) {
  const ar = sanitizeAgeRange(ageRange);
  if (!ar) return null;
  const minL = endpointLabel(ar.min);
  const maxL = endpointLabel(ar.max);
  const tail = (ep) => (ep && ep.inclusive === false ? " (לא כולל)" : "");
  if (minL && maxL) return `${minL} עד ${maxL}${tail(ar.max)}`;
  if (maxL) return `עד ${maxL}${tail(ar.max)}`;
  if (minL) return `מ${minL} ומעלה`;
  return null;
}

module.exports = {
  STAGE_LABEL,
  sanitizeAgeRange,
  resolveBounds,
  formatAgeRangeLabel,
};
