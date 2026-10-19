// Request-level defences applied to every /api route: CSRF checks, JSON-only
// bodies and no caching of API responses.
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// The session cookie is SameSite=Lax, which already keeps it off cross-site
// POSTs. These checks are the second layer: a state-changing request must not
// come from another site, judged by Origin when the browser sends it and by
// Fetch Metadata (Sec-Fetch-Site) otherwise.
export function requireSameOrigin(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.headers.origin;
  if (origin && origin !== env.APP_ORIGIN) {
    return next(new AppError("FORBIDDEN", "Origin not allowed", { status: 403 }));
  }
  if (req.headers["sec-fetch-site"] === "cross-site") {
    return next(new AppError("FORBIDDEN", "Cross-site requests are not allowed", { status: 403 }));
  }
  next();
}

function hasBody(req) {
  const length = Number(req.headers["content-length"] ?? 0);
  return length > 0 || req.headers["transfer-encoding"] !== undefined;
}

// The API only speaks JSON. Rejecting other content types up front blocks
// form-encoded CSRF payloads and any attempt to upload files (multipart) to
// endpoints that were never meant to receive them.
export function requireJsonBody(req, res, next) {
  if (SAFE_METHODS.has(req.method) || !hasBody(req)) return next();
  if (!req.is("application/json")) {
    return next(new AppError("UNSUPPORTED_MEDIA_TYPE", "Request body must be application/json", { status: 415 }));
  }
  next();
}

// API responses carry personal and clinical data; never let a browser or a
// shared proxy cache them.
export function noStore(req, res, next) {
  res.set("Cache-Control", "no-store");
  next();
}
