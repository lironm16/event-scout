require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const { Telegraf } = require("telegraf");
const { flushDueNotifications } = require("../lib/scheduleService");

async function main() {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) {
    console.error("[Flush] TELEGRAM_TOKEN not set");
    process.exit(1);
  }

  const tg = new Telegraf(token).telegram;
  const sent = await flushDueNotifications(tg);
  console.log(`[Flush] Sent ${sent} queued notification(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[Flush] Fatal:", err.message);
    process.exit(1);
  });
