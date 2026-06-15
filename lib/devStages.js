// Single source of truth for the developmental-stage READINESS model.
//
// Replaces the old binary dev_stages ("kid has/hasn't reached X"), which both
// spammed newborns (no stage set → matched every "prep" event) and couldn't
// tell "preparing for X" from "already doing X". Now each stage has a 4-level
// readiness, set per kid and targeted per event, so matching is precise:
//
//   profile kid:  kids[].dev_stages = { solids: "before", crawl: "during", … }
//   event:        dev_targets = [{ stage: "solids", level: "before" }, …]
//   match:        kid.dev_stages[stage] === target.level   (see kidMatchesDevTargets)
//
// Levels (ordered) and stages below are the closed vocabularies everything
// else (enricher schema, prompt, profile UI, matching) imports from here.

// Readiness levels. The old "before" (prep / not-yet-started) level was dropped
// (2026-06): it risked filtering OUT useful events, and the product rule is
// "anyone IN PROCESS gets that stage's events" (a kid learning to crawl should
// see crawling workshops). So "before" is collapsed into "during" everywhere —
// see normalizeLevel(). Legacy profile values / event targets tagged "before"
// are normalized to "during" on read.
const LEVELS = [
  { id: "na",          label: "עדיין לא רלוונטי" },
  { id: "during",      label: "בתהליך" },
  { id: "established", label: "מבוסס היטב" },
];
const LEVEL_IDS = new Set(LEVELS.map((l) => l.id));

// Collapse the retired "before" level into "during" (back-compat for stored
// profiles + already-enriched event dev_targets).
function normalizeLevel(level) {
  return level === "before" ? "during" : level;
}
const LEVEL_LABEL = Object.fromEntries(LEVELS.map((l) => [l.id, l.label]));

// Stages + their TYPICAL age window (months) — used only to decide which stages
// to SHOW in the profile for a kid of a given age (friction reducer); the
// readiness itself is set manually. min/max are generous bounds of the
// before→during window; outside it the stage defaults to its age-implied level.
const STAGES = [
  { id: "solids", label: "אכילת מוצקים", fromM: 3,  toM: 18 },
  { id: "crawl",  label: "זחילה",         fromM: 4,  toM: 14 },
  { id: "walk",   label: "הליכה",         fromM: 8,  toM: 20 },
  { id: "talk",   label: "דיבור",         fromM: 10, toM: 36 },
  { id: "wean",   label: "גמילה מחיתולים", fromM: 18, toM: 48 },
];
const STAGE_IDS = new Set(STAGES.map((s) => s.id));
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.id, s.label]));

/** Stages worth SHOWING for a kid of the given age (months) — the window ±a
 *  margin. Returns all stages when age is unknown. */
function relevantStagesForAge(months) {
  if (months == null || !Number.isFinite(months)) return STAGES.map((s) => s.id);
  const M = 4; // months of margin around the window
  return STAGES.filter((s) => months >= s.fromM - M && months <= s.toM + M).map((s) => s.id);
}

/** Age-implied default level for a stage when the parent hasn't set one. */
function ageDefaultLevel(stageId, months) {
  const s = STAGES.find((x) => x.id === stageId);
  if (!s || months == null || !Number.isFinite(months)) return "na";
  if (months < s.fromM) return "na";
  if (months <= s.toM) return "during";
  return "established";
}

/** Validate a profile kid's dev_stages object → { stage: level } (drops junk). */
function sanitizeKidDevStages(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const lv = normalizeLevel(v);
    if (STAGE_IDS.has(k) && LEVEL_IDS.has(lv) && lv !== "na") out[k] = lv;
  }
  return out;
}

/** Validate an event's dev_targets → [{ stage, level }] (drops junk / na). */
function sanitizeDevTargets(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const stage = t.stage;
    const level = normalizeLevel(t.level);
    if (!STAGE_IDS.has(stage) || !LEVEL_IDS.has(level) || level === "na") continue;
    const key = `${stage}:${level}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ stage, level });
  }
  return out;
}

// Age in whole months from a YYYY-MM-DD birth_date (no external dep → no cycle).
function monthsFromBirth(birthDate) {
  if (!birthDate) return null;
  const d = new Date(birthDate);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let m = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
  if (now.getDate() < d.getDate()) m -= 1;
  return m < 0 ? null : m;
}

// Effective level for a kid+stage: explicit profile value wins, else age-implied
// (from _ageMonths if the caller set it, else computed from birth_date).
function effectiveKidLevel(kid, stageId) {
  const explicit = normalizeLevel(kid?.dev_stages?.[stageId]);
  if (explicit && LEVEL_IDS.has(explicit)) return explicit;
  const months = kid?._ageMonths ?? monthsFromBirth(kid?.birth_date);
  return ageDefaultLevel(stageId, months);
}

/**
 * True when a household kid matches the event's developmental targets.
 * A kid matches a target {stage, level} when the kid's effective level for that
 * stage equals the target level (both already normalized — "before"→"during").
 * Never matches "na".
 */
function kidMatchesDevTargets(devTargets, kidsProfiles) {
  const targets = sanitizeDevTargets(devTargets);
  if (!targets.length || !Array.isArray(kidsProfiles) || !kidsProfiles.length) return false;
  for (const kid of kidsProfiles) {
    for (const t of targets) {
      const lvl = effectiveKidLevel(kid, t.stage);
      if (lvl === "na") continue;
      if (lvl === t.level) return true;
    }
  }
  return false;
}

module.exports = {
  LEVELS, LEVEL_IDS, LEVEL_LABEL, normalizeLevel,
  STAGES, STAGE_IDS, STAGE_LABEL,
  relevantStagesForAge, ageDefaultLevel, monthsFromBirth,
  sanitizeKidDevStages, sanitizeDevTargets,
  effectiveKidLevel, kidMatchesDevTargets,
};
