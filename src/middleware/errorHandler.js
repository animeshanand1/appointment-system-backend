import { ZodError } from "zod";
import { AppError, ErrorCodes } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

const TRANSIENT_DB_ERRORS = new Set([
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoServerSelectionError",
  "MongooseServerSelectionError",
  "MongoNotConnectedError",
  "MongoWaitQueueTimeoutError",
]);

function isTransientDbError(err) {
  return TRANSIENT_DB_ERRORS.has(err?.name) || err?.hasErrorLabel?.("RetryableWriteError") === true;
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: "Route not found", requestId: req.id },
  });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const requestId = req.id;

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_FAILED",
        message: "Request validation failed",
        details: err.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        requestId,
      },
    });
  }

  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, requestId },
    });
  }

  // Safe for clients to retry: booking replays make a repeated POST harmless.
  if (isTransientDbError(err)) {
    logger.warn({ err, requestId }, "Transient database error");
    return res.status(503).json({
      error: { code: "SERVICE_UNAVAILABLE", message: "Service temporarily unavailable, please retry", requestId },
    });
  }

  logger.error({ err, requestId }, "Unhandled error");
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Something went wrong", requestId },
  });
}

export { ErrorCodes };
