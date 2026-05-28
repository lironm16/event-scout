// Parse free-text kid age updates (Hebrew) for profile.kids[].

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

/**
 * @returns {{ name: string, age: number }[]}
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
    const age = parseAgeYears(part);
    if (age == null || !Number.isFinite(age)) continue;
    const nameMatch = part.match(/^([א-תa-zA-Z][א-תa-zA-Z\s]{0,20}?)\s+(?:בן|בת|גיל|\d)/u)
      || part.match(/^([א-תa-zA-Z]{2,})\s+\d/u);
    const name = nameMatch
      ? nameMatch[1].trim()
      : kids.length === 0
        ? "ילד/ה"
        : `ילד/ה ${kids.length + 1}`;
    kids.push({ name, age: Math.round(age * 10) / 10 });
  }
  return kids;
}

module.exports = { parseAgeYears, parseKidsCaptureMessage };
