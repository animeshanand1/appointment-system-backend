import pino from "pino";
import { env } from "../config/env.js";

export const logger = pino({
  level: { production: "info", test: "silent" }[env.NODE_ENV] ?? "debug",
  redact: {
    paths: [
      "req.headers.cookie",
      "req.headers.authorization",
      // pino-http logs response headers, and Set-Cookie carries the session token.
      'res.headers["set-cookie"]',
      "password",
      "passwordHash",
      "inviteCode",
      "*.password",
      "*.passwordHash",
      "*.inviteCode",
    ],
    censor: "[redacted]",
  },
});
