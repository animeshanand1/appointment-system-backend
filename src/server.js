import mongoose from "mongoose";
import { env } from "./config/env.js";
import { app } from "./app.js";
import { connectDB } from "./db/connection.js";
import { assertCriticalIndexes } from "./db/assertIndexes.js";
import { logger } from "./lib/logger.js";
import { startReminderJob } from "./jobs/reminders.js";
import { flushNotifications } from "./modules/notifications/notifications.service.js";

// Bounded timeouts so slow or idle connections (slowloris-style attacks)
// can't hold sockets open indefinitely.
const SERVER_TIMEOUTS = {
  requestTimeout: 30_000,
  headersTimeout: 15_000,
  keepAliveTimeout: 5_000,
  maxHeadersCount: 100,
};

async function main() {
  await connectDB();
  await assertCriticalIndexes();

  const server = app.listen(env.PORT, () => {
    logger.info(`API listening on port ${env.PORT}`);
  });
  Object.assign(server, SERVER_TIMEOUTS);
  const stopReminders = env.DISABLE_REMINDERS === "true" ? () => {} : startReminderJob();
  server.maxRequestsPerSocket = 1000;

  const shutdown = (signal) => {
    logger.info({ signal }, "Shutting down");
    stopReminders();
    server.close(async () => {
      await flushNotifications().catch(() => {});
      await mongoose.disconnect().catch(() => {});
      process.exit(0);
    });
    // Don't hang forever on stuck connections.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

process.on("unhandledRejection", (err) => {
  logger.error({ err }, "Unhandled promise rejection");
});

main().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
