require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const { resolvePending } = require("../lib/locationResolver");

resolvePending({ logger: console })
  .then((stats) => {
    console.log(
      `[WarmLocations] Done — pending=${stats.pending} resolved=${stats.resolved} failed=${stats.failed}`
    );
    process.exit(0);
  })
  .catch((err) => {
    console.error("[WarmLocations] Fatal:", err.message);
    process.exit(1);
  });
