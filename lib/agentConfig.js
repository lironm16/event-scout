// Feature flags for the Telegram agent loop vs deterministic search router.

const { isGeminiOnlyEnricher } = require("./geminiPolicy");

function isAgentEnabled() {
  const v = (process.env.AGENT_ENABLED || "false").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

module.exports = { isAgentEnabled, isGeminiOnlyEnricher };
