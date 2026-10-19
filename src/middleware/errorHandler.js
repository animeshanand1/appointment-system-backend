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

// Errors raised by express.json() before a route runs. Without this they'd fall
// through to the generic handler and come back as a 500.
const BODY_PARSER_ERRORS = {
  "entity.parse.failed": { status: 400, code: "MALFORMED_JSON", message: "Request body is not valid JSON" },
  "entity.too.large": { status: 413, code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" },
  "encoding.unsupported": { status: 415, code: "UNSUPPORTED_MEDIA_TYPE", message: "Unsupported content encoding" },
  "charset.unsupported": { status: 415, code: "UNSUPPORTED_MEDIA_TYPE", message: "Unsupported charset" },
  "request.aborted": { status: 400, code: "VALIDATION_FAILED", message: "Request was aborted" },
};

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

  const bodyError = BODY_PARSER_ERRORS[err?.type];
  if (bodyError) {
    return res.status(bodyError.status).json({ error: { code: bodyError.code, message: bodyError.message, requestId } });
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
