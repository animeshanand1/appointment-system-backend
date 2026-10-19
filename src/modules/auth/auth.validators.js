import { z } from "zod";
import { email, multilineText, newPassword, personName, text, timeZone } from "../../lib/sanitize.js";

const baseRegisterSchema = z.object({
  fullName: personName,
  email,
  phone: z.string().trim().regex(/^\d{1,10}$/, "Phone number must contain at most 10 digits").optional(),
  password: newPassword,
  timezone: timeZone.optional(),
}).strict();

const patientRegisterSchema = baseRegisterSchema.extend({
  role: z.literal("patient"),
});

const doctorRegisterSchema = baseRegisterSchema.extend({
  role: z.literal("doctor"),
  inviteCode: z.string().min(1).max(128),
  doctorProfile: z
    .object({
      specialization: text({ min: 1, max: 60 }),
      qualifications: z.array(text({ min: 1, max: 100 })).max(10).optional(),
      experienceYears: z.number().int().min(0).max(70).optional(),
      bio: multilineText({ max: 1000 }).optional(),
      clinicName: text({ max: 120 }).optional(),
      clinicAddress: text({ max: 300 }).optional(),
    })
    .strict(),
});

export const registerSchema = z
  .preprocess(
    (data) => (typeof data === "object" && data !== null && !("role" in data) ? { ...data, role: "patient" } : data),
    z.discriminatedUnion("role", [patientRegisterSchema, doctorRegisterSchema])
  )
  .refine((data) => data.password !== data.email, {
    message: "Password must not be the same as the email",
    path: ["password"],
  });

// Bounded so an oversized password can't make argon2 burn CPU.
export const loginSchema = z
  .object({
    email,
    password: z.string().min(1).max(128),
  })
  .strict();

export const logoutSchema = z
  .object({
    allDevices: z.boolean().optional(),
  })
  .strict();
