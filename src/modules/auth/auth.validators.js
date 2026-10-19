import { z } from "zod";

const baseRegisterSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().max(254).email(),
  phone: z.string().trim().regex(/^\d{1,10}$/, "Phone number must contain at most 10 digits").optional(),
  password: z.string().min(8).max(128),
  timezone: z.string().min(1).optional(),
});

const patientRegisterSchema = baseRegisterSchema.extend({
  role: z.literal("patient"),
});

const doctorRegisterSchema = baseRegisterSchema.extend({
  role: z.literal("doctor"),
  inviteCode: z.string().min(1),
  doctorProfile: z.object({
    specialization: z.string().min(1),
    qualifications: z.array(z.string().max(100)).max(10).optional(),
    experienceYears: z.number().int().min(0).max(70).optional(),
    bio: z.string().max(1000).optional(),
    clinicName: z.string().max(120).optional(),
    clinicAddress: z.string().max(300).optional(),
  }),
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

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export const logoutSchema = z.object({
  allDevices: z.boolean().optional(),
});
