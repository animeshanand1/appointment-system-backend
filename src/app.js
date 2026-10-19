import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { requestId } from "./middleware/requestId.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { noStore, requireJsonBody, requireSameOrigin } from "./middleware/security.js";
import {
  apiLimiter,
  authLimiter,
  loginAccountLimiter,
  registerHourlyLimiter,
} from "./middleware/rateLimits.js";
import { healthRouter } from "./modules/health/health.routes.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { doctorsRouter } from "./modules/doctors/doctors.routes.js";
import { appointmentsRouter } from "./modules/appointments/appointments.routes.js";
import { adminRouter } from "./modules/admin/admin.routes.js";

export const app = express();

// Without this, behind a proxy every client shares the proxy's IP and one
// abuser rate-limits everyone. See TRUST_PROXY in .env.example.
app.set("trust proxy", env.TRUST_PROXY);
app.disable("x-powered-by");

// A JSON API never renders HTML, so the policy can deny everything.
app.use(
  helmet({
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: "same-origin" },
    strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
    referrerPolicy: { policy: "no-referrer" },
  })
);
app.use(requestId);
app.use(pinoHttp({ logger, customLogLevel: (req, res) => (res.statusCode >= 500 ? "error" : "info") }));

app.use("/api", apiLimiter, noStore, requireSameOrigin, requireJsonBody);
// The largest legitimate body (a weekly schedule) is a few KB.
app.use(express.json({ limit: "16kb", strict: true }));
app.use(cookieParser());

app.use("/api/health", healthRouter);
app.use("/api/auth/login", authLimiter, loginAccountLimiter);
app.use("/api/auth/register", authLimiter, registerHourlyLimiter);
app.use("/api/auth", authRouter);
app.use("/api/doctors", doctorsRouter);
app.use("/api/appointments", appointmentsRouter);
app.use("/api/admin", adminRouter);

app.use(notFoundHandler);
app.use(errorHandler);
