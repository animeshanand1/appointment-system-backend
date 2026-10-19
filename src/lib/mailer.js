// Outgoing email. With SMTP_URL set, mail goes out through that server.
// Without it (development, tests), messages are kept in an in-memory outbox
// and logged, so flows like password reset still work locally.
import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

const transport = env.SMTP_URL
  ? nodemailer.createTransport(env.SMTP_URL, {
      // Templates are plain strings; never let a message pull in files or URLs.
      disableFileAccess: true,
      disableUrlAccess: true,
    })
  : null;

const OUTBOX_LIMIT = 100;
const outbox = [];

if (!transport && env.NODE_ENV === "production") {
  logger.warn("SMTP_URL is not set: emails will be logged, not delivered");
}

export async function sendMail({ to, subject, text, html }) {
  if (transport) {
    await transport.sendMail({ from: env.MAIL_FROM, to, subject, text, html });
    return;
  }
  outbox.push({ to, subject, text, html, at: new Date() });
  if (outbox.length > OUTBOX_LIMIT) outbox.shift();
  // The body can hold a password-reset link, so it's only printed in development.
  logger.info({ to, subject, ...(env.NODE_ENV === "development" ? { text } : {}) }, "Email (not sent: SMTP_URL unset)");
}

// For tests: what would have been sent.
export function sentMail() {
  return [...outbox];
}

export function clearSentMail() {
  outbox.length = 0;
}
