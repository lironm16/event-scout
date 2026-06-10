// Audience line helpers — multi-segment hints + kid ↔ grade fit.

const { detectGradeRange, formatGradeAudienceLabel } = require("./eventFormat");

const AUDIENCE_LINE_ICON = "🎯";
const { kidsAgesYears, kidNounHe } = require("./kidAge");

/** City/CMS + title signals that collapse to one ENUM but should read as several. */
const AUDIENCE_HINT_RULES = [
  { re: /תלמיד(?:י|ות)?\s*תיכון|בתיכון|תיכון(?!\s*ל)/u, label: "תיכון" },
  { re: /חטיב(?:ה|ת)|תלמיד(?:י|ות)?\s*חטיב/u, label: "חטיבה" },
  {
    re: /משרת[יי].*מילואים|מילואימניק|מילואים(?!\s*פעיל)/u,
    label: "מילואים",
  },
  { re: /אזרחים\s*ותיקים|הגיל\s*השלישי|גיל\s*הזהב|ותיקים/u, label: "ותיקים" },
  { re: /צעירים\s*\(?\s*18|צעירים(?:\s|\(|$)/u, label: "צעירים" },
];

function extractAudienceHintSegments(event) {
  if (!event) return [];
  const hay = `${event.name || ""} ${event.description || ""}`;
  const out = [];
  for (const { re, label } of AUDIENCE_HINT_RULES) {
    if (re.test(hay) && !out.includes(label)) out.push(label);
  }
  const acc = event.access;
  const scopes = Array.isArray(acc) ? acc : acc ? [acc] : [];
  if (scopes.includes("community-miluim") && !out.includes("מילואים")) {
    out.push("מילואים");
  }
  if (scopes.includes("community-seniors") && !out.includes("ותיקים")) {
    out.push("ותיקים");
  }
  return out;
}

function parseHebrewGradeNumber(token) {
  const t = String(token || "").trim();
  if (t === "יב") return 12;
  if (t === "יא") return 11;
  if (t === "י") return 10;
  const map = { א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9 };
  return map[t[0]] || null;
}

/** Rough Israeli grade ↔ age (school year; not exact cutover). */
function estimatedGradeFromAgeYears(years) {
  if (years == null || !Number.isFinite(years)) return null;
  return Math.max(1, Math.min(12, Math.round(years) - 5));
}

function gradeLabelToRange(gradeLabel) {
  if (!gradeLabel) return null;
  const range = /כיתות?\s+([א-ת]{1,2})[׳']?\s*[-–—]\s*([א-ת]{1,2})/u.exec(gradeLabel);
  if (range) {
    const lo = parseHebrewGradeNumber(range[1]);
    const hi = parseHebrewGradeNumber(range[2]);
    if (lo != null && hi != null) return { lo, hi };
  }
  const single = /כיתה\s+([א-ת]{1,2})/u.exec(gradeLabel);
  if (single) {
    const g = parseHebrewGradeNumber(single[1]);
    if (g != null) return { lo: g, hi: g };
  }
  if (/ו[׳']?\s*[-–—]\s*יב/u.test(gradeLabel)) return { lo: 6, hi: 12 };
  return null;
}

/**
 * @returns {{ fit: boolean, detail: string } | null}
 */
function kidGradeFitForEvent(event, profile) {
  const kids = profile?.user_context?.kids;
  if (!Array.isArray(kids) || !kids.length) return null;
  const name = event?.name || "";
  const desc = event?.description || "";
  const gradeStr = detectGradeRange(name, desc);
  if (!gradeStr) return null;
  const range = gradeLabelToRange(gradeStr);
  if (!range) return null;

  const ages = kidsAgesYears(kids);
  const matching = [];
  const mismatching = [];
  for (let i = 0; i < kids.length; i++) {
    const y = ages[i];
    if (y == null || !Number.isFinite(y)) continue;
    const g = estimatedGradeFromAgeYears(y);
    const label = kids[i]?.name || kidNounHe(kids[i]?.gender) || `ילד/ה ${i + 1}`;
    if (g >= range.lo && g <= range.hi) matching.push(label);
    else mismatching.push(label);
  }
  if (!matching.length && !mismatching.length) return null;
  if (matching.length) {
    const who = matching.length === 1 ? matching[0] : matching.join(", ");
    return { fit: true, detail: `מתאים בערך לגיל ${who} (${gradeStr})` };
  }
  const who = mismatching.length === 1 ? mismatching[0] : mismatching.join(", ");
  return { fit: false, detail: `כנראה לא מתאים לגיל ${who} (${gradeStr})` };
}

/**
 * Build primary audience line; when several segments exist, show all of them.
 */
function formatAudienceLineWithHints(event, options = {}) {
  const hints = extractAudienceHintSegments(event);
  const name = event?.name || "";
  const desc = event?.description || "";
  const gradeStr = detectGradeRange(name, desc);
  const gradeLabel = formatGradeAudienceLabel(gradeStr, event?.audience === "הורים");
  const parts = [];
  if (gradeLabel) {
    parts.push(gradeLabel.replace(new RegExp(`^${AUDIENCE_LINE_ICON}\\s*`), "").trim());
  }
  for (const h of hints) {
    if (!parts.some((p) => p.includes(h))) parts.push(h);
  }
  if (parts.length > 1) {
    return `${AUDIENCE_LINE_ICON} ${parts.join(" · ")}`;
  }

  const { formatAudienceLine } = require("./eventFormat");
  const base = formatAudienceLine(event);
  if (!base) return null;

  const fit = options.profile ? kidGradeFitForEvent(event, options.profile) : null;
  if (!fit) return base;
  return `${base} (${fit.detail})`;
}

module.exports = {
  extractAudienceHintSegments,
  kidGradeFitForEvent,
  formatAudienceLineWithHints,
  estimatedGradeFromAgeYears,
  gradeLabelToRange,
};
