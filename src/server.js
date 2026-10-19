import { env } from "./config/env.js";
import { app } from "./app.js";
import { connectDB } from "./db/connection.js";
import { assertCriticalIndexes } from "./db/assertIndexes.js";
import { logger } from "./lib/logger.js";

async function main() {
  await connectDB();
  await assertCriticalIndexes();

  app.listen(env.PORT, () => {
    logger.info(`API listening on port ${env.PORT}`);
  });
}

main().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
