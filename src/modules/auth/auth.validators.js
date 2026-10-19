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

export const forgotPasswordSchema = z.object({ email }).strict();

export const resetPasswordSchema = z
  .object({
    token: z.string().regex(/^[a-f\d]{64}$/i, "Invalid or expired reset link"),
    password: newPassword,
  })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword,
  })
  .strict()
  .refine((input) => input.currentPassword !== input.newPassword, {
    message: "Choose a password you haven't used here before",
    path: ["newPassword"],
  });

const pastDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value) && date < new Date() && value >= "1900-01-01";
  }, "Enter a real date in the past");

// Partial update of the signed-in user's own profile. Email and role can't
// change here; null clears an optional field.
export const updateMeSchema = z
  .object({
    fullName: personName,
    phone: z.string().trim().regex(/^\d{10}$/, "Phone number must be 10 digits").nullable(),
    timezone: timeZone,
    patientProfile: z
      .object({
        dateOfBirth: pastDate.nullable(),
        gender: z.enum(["female", "male", "other", "prefer_not_to_say"]).nullable(),
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, "Provide at least one field to update");

export const logoutSchema = z
  .object({
    allDevices: z.boolean().optional(),
  })
  .strict();
