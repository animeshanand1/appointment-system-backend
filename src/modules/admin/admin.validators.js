import { z } from "zod";
import { email, text } from "../../lib/sanitize.js";
import { isValidLocalDate } from "../../lib/time.js";

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Expected a 24-character hex id");

const page = z.coerce.number().int().min(1).max(1000).default(1);
const limit = z.coerce.number().int().min(1).max(100).default(25);

export const listUsersQuerySchema = z
  .object({
    role: z.enum(["patient", "doctor", "admin"]).optional(),
    status: z.enum(["active", "inactive"]).optional(),
    q: text({ min: 2, max: 100 }).optional(),
    page,
    limit,
  })
  .strict();

export const updateUserSchema = z.object({ isActive: z.boolean() }).strict();

export const createInviteSchema = z
  .object({
    label: text({ min: 2, max: 120 }),
    email: email.optional(),
    expiresInDays: z.number().int().min(1).max(30).default(7),
  })
  .strict();

export const listInvitesQuerySchema = z
  .object({
    status: z.enum(["active", "used", "expired", "revoked"]).optional(),
    page,
    limit,
  })
  .strict();

const date = z.string().refine(isValidLocalDate, "Expected a real calendar date in YYYY-MM-DD format");

export const listAppointmentsQuerySchema = z
  .object({
    status: z.enum(["booked", "cancelled", "completed", "no_show"]).optional(),
    doctorId: objectId.optional(),
    from: date.optional(),
    to: date.optional(),
    page,
    limit,
  })
  .strict()
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: "from must be on or before to",
    path: ["to"],
  });
