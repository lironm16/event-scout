// Central gate: when GEMINI_ONLY_ENRICHER=true (default), only eventEnricher may call Gemini.

function isGeminiOnlyEnricher() {
  const v = (process.env.GEMINI_ONLY_ENRICHER ?? "true").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no";
}

/** @param {"enricher"|"agent"|"matching"|"semantic"|"tickets"|"address"} scope */
function isGeminiAllowed(scope) {
  if (!isGeminiOnlyEnricher()) return true;
  return scope === "enricher";
}

module.exports = { isGeminiOnlyEnricher, isGeminiAllowed };
