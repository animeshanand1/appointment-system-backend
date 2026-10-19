// Zod building blocks for user-supplied text. Every free-text field goes
// through these so stored data has no control, zero-width or bidi-override
// characters (used to hide or disguise text), is Unicode-normalized, trimmed
// and length-capped.
import { z } from "zod";
import { isValidTimeZone } from "./time.js";

// C0/C1 controls except tab, newline and carriage return, plus zero-width and
// bidi-override characters.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const LINE_BREAKS = /[\t\r\n]+/g;

export function cleanText(value, { multiline = false } = {}) {
  const text = value.normalize("NFC").replace(UNSAFE_CHARS, "");
  return (multiline ? text : text.replace(LINE_BREAKS, " ")).trim();
}

// A single-line text field: cleaned, then checked against min/max.
export const text = ({ min = 0, max }) =>
  z
    .string()
    .max(max * 4)
    .transform((value) => cleanText(value))
    .pipe(z.string().min(min).max(max));

// A multi-line text field (notes, bios): keeps line breaks.
export const multilineText = ({ min = 0, max }) =>
  z
    .string()
    .max(max * 4)
    .transform((value) => cleanText(value, { multiline: true }))
    .pipe(z.string().min(min).max(max));

// Letters in any script, spaces and the punctuation real names use. No digits,
// angle brackets or other markup characters.
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} .,'-]*$/u;

export const personName = text({ min: 2, max: 100 }).refine((value) => NAME_PATTERN.test(value), {
  message: "Name may only contain letters, spaces and . , ' -",
});

export const timeZone = z.string().max(64).refine(isValidTimeZone, "Expected an IANA time zone such as Asia/Kolkata");

// 8-128 characters with at least one letter and one number. The upper bound
// also caps the work argon2 does per request.
export const newPassword = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be at most 128 characters")
  .refine((value) => /\p{L}/u.test(value) && /\d/.test(value), "Password must include a letter and a number");

export const email = z.string().trim().toLowerCase().max(254).email();
