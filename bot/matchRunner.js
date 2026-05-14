require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const { Telegraf } = require("telegraf");
const { runMatchingForAllUsers } = require("./matchingService");

async function main() {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) {
    console.error("[MatchRunner] TELEGRAM_TOKEN not set");
    process.exit(1);
  }

  const bot = new Telegraf(token);

  console.log("[MatchRunner] Starting match cycle...");
  const result = await runMatchingForAllUsers(bot.telegram);

  console.log(`[MatchRunner] Complete:`, result);
  process.exit(0);
}

main().catch((err) => {
  console.error("[MatchRunner] Fatal:", err.message);
  process.exit(1);
});
