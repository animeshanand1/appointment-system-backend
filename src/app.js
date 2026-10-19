import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import { rateLimit } from "express-rate-limit";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { requestId } from "./middleware/requestId.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { AppError } from "./lib/errors.js";
import { healthRouter } from "./modules/health/health.routes.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { doctorsRouter } from "./modules/doctors/doctors.routes.js";
import { appointmentsRouter } from "./modules/appointments/appointments.routes.js";

export const app = express();

app.use(helmet());
app.use(requestId);
app.use(pinoHttp({ logger, customLogLevel: (req, res) => (res.statusCode >= 500 ? "error" : "info") }));
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

app.use((req, res, next) => {
  const isMutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (isMutating && req.path.startsWith("/api") && req.headers.origin && req.headers.origin !== env.APP_ORIGIN) {
    return next(new AppError("FORBIDDEN", "Origin not allowed", { status: 403 }));
  }
  next();
});

const authLimiter = rateLimit({ windowMs: 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });

app.use("/api/health", healthRouter);
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/auth", authRouter);
app.use("/api/doctors", doctorsRouter);
app.use("/api/appointments", appointmentsRouter);

app.use(notFoundHandler);
app.use(errorHandler);
