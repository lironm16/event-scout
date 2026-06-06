// Single source of truth for which Gemini model the whole app uses.
//
// We PIN to a stable model rather than the `gemini-flash-latest` alias.
// That alias floats to the newest Flash model (currently `gemini-3.5-flash`),
// and the newest models get the stingiest FREE-tier limits: only 20 requests
// /day + 5/min. `gemini-2.5-flash` gives ~250/day (≈12× more) at the same
// quality we need for enrichment + label canonicalisation.
//
// Override per-environment with GEMINI_MODEL (e.g. gemini-2.5-flash-lite for
// ~1,000/day, or gemini-flash-latest to ride the newest model on a paid key).
const GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();

module.exports = { GEMINI_MODEL };
