// Child birth dates → age in months/years (computed at read time).

const MAX_CHILD_AGE_YEARS = 18;

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** @returns {string|null} ISO YYYY-MM-DD */
function toIsoDate(y, m, d) {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d);
  if (
    dt.getFullYear() !== y ||
    dt.getMonth() !== m - 1 ||
    dt.getDate() !== d
  ) {
    return null;
  }
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/**
 * Parse Hebrew/Israeli date input → YYYY-MM-DD.
 * Supports: 15.3.2024, 15/3/24, 2024-03-15, 15-03-2024
 */
function parseBirthDateInput(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (m) return toIsoDate(+m[1], +m[2], +m[3]);

  m = /^(\d{1,2})[./\-\s](\d{1,2})[./\-\s](\d{2,4})$/.exec(raw);
  if (m) {
    let y = +m[3];
    if (y < 100) y += y >= 70 ? 1900 : 2000;
    return toIsoDate(y, +m[2], +m[1]);
  }

  return null;
}

function parseIsoDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").trim());
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  const dt = new Date(y, mo - 1, d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

/** @returns {string|null} normalized YYYY-MM-DD */
function normalizeBirthDate(value) {
  if (!value) return null;
  const iso = parseBirthDateInput(value) || (parseIsoDate(value) ? String(value).trim() : null);
  if (!iso) return null;
  return validateBirthDate(iso) ? iso : null;
}

/**
 * @param {string} iso YYYY-MM-DD
 * @param {Date} [asOf]
 */
function validateBirthDate(iso, asOf = new Date()) {
  const born = parseIsoDate(iso);
  if (!born) return false;
  const today = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
  if (born > today) return false;
  const min = new Date(today);
  min.setFullYear(min.getFullYear() - (MAX_CHILD_AGE_YEARS + 1));
  if (born < min) return false;
  return true;
}

function kidBirthDateIso(kid) {
  if (!kid || typeof kid !== "object") return null;
  const bd = normalizeBirthDate(kid.birth_date);
  if (bd) return bd;
  const age = kid.age != null ? Number(kid.age) : null;
  if (!Number.isFinite(age) || age < 0) return null;
  const today = new Date();
  const est = new Date(today);
  const whole = Math.floor(age);
  const fracMonths = Math.round((age - whole) * 12);
  est.setFullYear(est.getFullYear() - whole);
  est.setMonth(est.getMonth() - fracMonths);
  return toIsoDate(est.getFullYear(), est.getMonth() + 1, est.getDate());
}

/** Age in fractional years (for filters / agent). */
function kidAgeYears(kid, asOf = new Date()) {
  const months = kidAgeMonths(kid, asOf);
  if (months == null) return null;
  return Math.round((months / 12) * 10) / 10;
}

/** Age in whole months (for event min_months/max_months). */
function kidAgeMonths(kid, asOf = new Date()) {
  const iso = kidBirthDateIso(kid);
  if (!iso) return null;
  const born = parseIsoDate(iso);
  if (!born) return null;
  const ref = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
  let months =
    (ref.getFullYear() - born.getFullYear()) * 12 +
    (ref.getMonth() - born.getMonth());
  if (ref.getDate() < born.getDate()) months -= 1;
  if (months < 0) return null;
  return months;
}

function kidsAgesYears(kids, asOf = new Date()) {
  if (!Array.isArray(kids)) return [];
  return kids
    .map((k) => kidAgeYears(k, asOf))
    .filter((y) => y != null && Number.isFinite(y));
}

function formatBirthDateHe(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return iso || "";
  return `${+m[3]}.${+m[2]}.${m[1]}`;
}

/** Human age label for profile cards. */
function formatKidAgeLabel(kid, asOf = new Date()) {
  const months = kidAgeMonths(kid, asOf);
  if (months == null) return null;
  if (months < 24) {
    if (months === 0) return "לידה";
    if (months === 1) return "חודש";
    return `${months} חודשים`;
  }
  const years = kidAgeYears(kid, asOf);
  if (years == null) return null;
  if (Math.abs(years - Math.round(years)) < 0.05) {
    const y = Math.round(years);
    if (y === 1) return "שנה";
    if (y === 2) return "שנתיים";
    return `${y} שנים`;
  }
  return `${years} שנים`;
}

function formatKidProfileSuffix(kid, asOf = new Date()) {
  const iso = kidBirthDateIso(kid);
  const ageLabel = formatKidAgeLabel(kid, asOf);
  const parts = [];
  if (iso) parts.push(`נולד/ה ${formatBirthDateHe(iso)}`);
  if (ageLabel) parts.push(`גיל ${ageLabel}`);
  return parts.length ? parts.join(" · ") : "";
}

function kidHasBirthInfo(kid) {
  if (!kid || typeof kid !== "object") return false;
  if (normalizeBirthDate(kid.birth_date)) return true;
  const age = Number(kid.age);
  return Number.isFinite(age) && age >= 0 && age <= MAX_CHILD_AGE_YEARS;
}

function normalizeKidForStorage(kid) {
  if (!kid || typeof kid !== "object") return null;
  const name = kid.name != null ? String(kid.name).trim() : "";
  const birth_date = normalizeBirthDate(kid.birth_date);
  const out = {};
  if (name) out.name = name;
  else if (birth_date) out.name = "ילד/ה";
  if (birth_date) out.birth_date = birth_date;
  if (Array.isArray(kid.stages) && kid.stages.length) {
    out.stages = kid.stages.filter(Boolean);
  }
  if (!out.name && !out.birth_date) {
    const age = Number(kid.age);
    if (Number.isFinite(age) && age >= 0) {
      out.age = age;
      if (!out.name) out.name = "ילד/ה";
    }
  }
  if (!out.name && !out.birth_date && out.age == null) return null;
  return out;
}

const BIRTH_DATE_PROMPT =
  "📅 *תאריך לידה מלא*\n\n" +
  "כתבי יום.חודש.שנה (למשל `15.3.2024` או `2024-03-15`).\n" +
  "הגיל יחושב אוטומטית ויתעדכן לבד.";

module.exports = {
  MAX_CHILD_AGE_YEARS,
  parseBirthDateInput,
  normalizeBirthDate,
  validateBirthDate,
  kidBirthDateIso,
  kidAgeYears,
  kidAgeMonths,
  kidsAgesYears,
  formatBirthDateHe,
  formatKidAgeLabel,
  formatKidProfileSuffix,
  kidHasBirthInfo,
  normalizeKidForStorage,
  BIRTH_DATE_PROMPT,
};
