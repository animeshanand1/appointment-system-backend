import { z } from "zod";
import { isTickAligned, isValidLocalDate } from "../../lib/time.js";

const STATUSES = ["booked", "cancelled", "completed", "no_show"];

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Expected a 24-character hex id");

const slotStart = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value))
  .refine(isTickAligned, "startAt must fall on a 5-minute boundary with zero seconds");

const optionalText = (max) => z.string().trim().max(max).optional();

// endAt, patientId and status are derived by the server; strict() rejects them.
export const bookAppointmentSchema = z
  .object({
    doctorId: objectId,
    startAt: slotStart,
    patientNotes: z
      .string()
      .trim()
      .max(500)
      .transform((value) => value || undefined)
      .optional(),
  })
  .strict();

export const listAppointmentsQuerySchema = z
  .object({
    scope: z.enum(["upcoming", "past", "all"]).default("upcoming"),
    status: z
      .string()
      .transform((value) => value.split(",").map((s) => s.trim()).filter(Boolean))
      .pipe(z.array(z.enum(STATUSES)).min(1))
      .optional(),
    date: z.string().refine(isValidLocalDate, "Expected a real calendar date in YYYY-MM-DD format").optional(),
    reschedule: z.enum(["pending"]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export const updateStatusSchema = z
  .object({
    status: z.enum(["cancelled", "completed", "no_show"]),
    reason: optionalText(300),
  })
  .strict();

// Doctor moves the appointment directly. The reason's minimum length is a
// business rule (422 REASON_REQUIRED), checked by the policy.
export const rescheduleSchema = z.object({ startAt: slotStart, reason: optionalText(300) }).strict();

// Patient proposes a new slot for the doctor to approve.
export const rescheduleRequestSchema = z.object({ startAt: slotStart, reason: optionalText(300) }).strict();

// `requestId` pins the decision to the request the doctor actually saw.
export const rescheduleDecisionSchema = z
  .object({
    requestId: objectId,
    decision: z.enum(["approve", "reject"]),
    note: optionalText(300),
  })
  .strict();
