// All rate limiters in one place so limits are easy to review. The in-memory
// store is per process: with several instances behind a load balancer, plug in
// a shared store (e.g. rate-limit-redis) so the limits hold across them.
import { rateLimit } from "express-rate-limit";
import { AppError } from "../lib/errors.js";

const MINUTE = 60 * 1000;

function limiter({ windowMs, limit, message, ...options }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    // Same error envelope as every other API error (Retry-After is already set).
    handler: (req, res, next) => next(new AppError("RATE_LIMITED", message, { status: 429 })),
    ...options,
  });
}

// Coarse per-IP ceiling for the whole API: absorbs scraping and request floods
// before they reach the database.
export const apiLimiter = limiter({
  windowMs: MINUTE,
  limit: 300,
  message: "Too many requests. Please slow down.",
});

// Per-IP limit shared by login and register.
export const authLimiter = limiter({
  windowMs: MINUTE,
  limit: 5,
  message: "Too many attempts. Please wait a minute and try again.",
});

// Per-account brute-force protection: failed logins for one email are capped
// no matter how many IPs they come from. Successful logins don't count.
export const loginAccountLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 254) : "";
    return email ? `login:${email}` : `login-ip:${req.ip}`;
  },
  message: "Too many failed sign-in attempts for this account. Please try again in 15 minutes.",
});

// Stops mass account creation from one address.
export const registerHourlyLimiter = limiter({
  windowMs: 60 * MINUTE,
  limit: 20,
  message: "Too many accounts created from this network. Please try again later.",
});

const emailKey = (prefix) => (req) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 254) : "";
  return email ? `${prefix}:${email}` : `${prefix}-ip:${req.ip}`;
};

// Password reset requests: per IP, and per target account so nobody can flood
// someone's inbox with reset emails.
export const forgotPasswordLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 5,
  message: "Too many reset requests. Please try again in 15 minutes.",
});

export const forgotPasswordAccountLimiter = limiter({
  windowMs: 60 * MINUTE,
  limit: 3,
  keyGenerator: emailKey("forgot"),
  message: "Too many reset requests for this account. Please try again later.",
});

export const resetPasswordLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 10,
  message: "Too many attempts. Please try again in 15 minutes.",
});

// Runs after authenticate: wrong current-password guesses per user.
export const changePasswordLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 5,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => req.auth.userId,
  message: "Too many attempts. Please try again in 15 minutes.",
});

export const slotsLimiter = limiter({
  windowMs: MINUTE,
  limit: 60,
  message: "Too many requests. Please wait a moment and try again.",
});

// The next two run after authenticate, so the limit is per user rather than per IP.
export const doctorWritesLimiter = limiter({
  windowMs: MINUTE,
  limit: 20,
  keyGenerator: (req) => req.auth.userId,
  message: "Too many changes in a short time. Please wait a moment.",
});

export const bookingLimiter = limiter({
  windowMs: MINUTE,
  limit: 10,
  keyGenerator: (req) => req.auth.userId,
  message: "Too many booking attempts. Please wait a minute and try again.",
});

// Any authenticated mutation: per user, so a stolen session can't be used to
// hammer the write endpoints.
export const userWritesLimiter = limiter({
  windowMs: MINUTE,
  limit: 30,
  keyGenerator: (req) => req.auth.userId,
  message: "Too many changes in a short time. Please wait a moment.",
});
