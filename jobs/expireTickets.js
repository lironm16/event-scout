require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const { expirePastEvents } = require("../lib/ticketService");

async function main() {
  console.log("[Expire] Checking for past events...");
  const count = await expirePastEvents();
  console.log(`[Expire] Marked ${count} ticket(s) as expired`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[Expire] Fatal:", err.message);
    process.exit(1);
  });
