import pino from "pino";
import { env } from "../config/env.js";

export const logger = pino({
  level: { production: "info", test: "silent" }[env.NODE_ENV] ?? "debug",
  redact: ["req.headers.cookie", "req.headers.authorization", "password", "passwordHash"],
});
