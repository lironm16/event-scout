// Parse free-text kid updates (Hebrew) for profile.kids[].

const {
  parseBirthDateInput,
  normalizeBirthDate,
  validateBirthDate,
  kidAgeYears,
} = require("./kidAge");

const AGE_PHRASES = [
  [/שנתיים|שניים(?!\s*ו)/u, 2],
  [/שנה\s*וחצי|שנה\s*ו[\u05BE\u2013-]?\s*חצי|בן\s*שנה\s*וחצי|בת\s*שנה\s*וחצי/u, 1.5],
  [/בן\s*שנה|בת\s*שנה|גיל\s*שנה(?!\s*ו)|^שנה$/u, 1],
  [/מלידה|יילוד/u, 0],
  [/שלוש|3\s*שנ/u, 3],
  [/ארבע|4\s*שנ/u, 4],
  [/חמש|5\s*שנ/u, 5],
];

function parseAgeYears(fragment) {
  const t = String(fragment || "").trim();
  if (!t) return null;
  for (const [re, age] of AGE_PHRASES) {
    if (re.test(t)) return age;
  }
  const num = t.match(/(\d+(?:[.,]\d+)?)/);
  if (num) return parseFloat(num[1].replace(",", "."));
  return null;
}

function estimateBirthDateFromAgeYears(age) {
  if (!Number.isFinite(age) || age < 0) return null;
  const today = new Date();
  const est = new Date(today);
  const whole = Math.floor(age);
  const fracMonths = Math.round((age - whole) * 12);
  est.setFullYear(est.getFullYear() - whole);
  est.setMonth(est.getMonth() - fracMonths);
  const y = est.getFullYear();
  const m = est.getMonth() + 1;
  const d = est.getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * @returns {{ name: string, birth_date?: string, age?: number }[]}
 */
function parseKidsCaptureMessage(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];

  const parts = raw
    .split(/[,،\n]|(?:\s+ו\s+)/u)
    .map((s) => s.trim())
    .filter(Boolean);

  const kids = [];
  for (const part of parts) {
    let birth_date = parseBirthDateInput(part);
    if (birth_date && !validateBirthDate(birth_date)) birth_date = null;

    const age = birth_date ? null : parseAgeYears(part);
    if (!birth_date && age == null) continue;

    if (!birth_date && age != null) {
      birth_date = estimateBirthDateFromAgeYears(age);
    }

    const nameMatch = part.match(/^([א-תa-zA-Z][א-תa-zA-Z\s]{0,20}?)\s+(?:בן|בת|גיל|\d)/u)
      || part.match(/^([א-תa-zA-Z]{2,})\s+\d/u)
      || part.match(/^([א-תa-zA-Z]{2,})\s+\d{1,2}[./]/u);
    const name = nameMatch
      ? nameMatch[1].trim()
      : kids.length === 0
        ? "ילד/ה"
        : `ילד/ה ${kids.length + 1}`;

    const entry = { name, birth_date };
    if (!birth_date && age != null) entry.age = Math.round(age * 10) / 10;
    kids.push(entry);
  }
  return kids;
}

module.exports = { parseAgeYears, parseKidsCaptureMessage, estimateBirthDateFromAgeYears };
