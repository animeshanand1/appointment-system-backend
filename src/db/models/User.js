import mongoose from "mongoose";

const { Schema, model } = mongoose;

// See docs/architecture/02-data-model.md §2.1
const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      unique: true,
    },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ["patient", "doctor"], required: true, immutable: true },
    fullName: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    // Digits only, max 10 (Zod is primary; this is the backstop).
    phone: { type: String, match: [/^\d{1,10}$/, "Phone number must contain at most 10 digits"] },
    timezone: { type: String },
    isActive: { type: Boolean, default: true },
    tokenVersion: { type: Number, default: 0, min: 0, select: false },
    lastLoginAt: { type: Date },
  },
  {
    timestamps: true,
    strict: "throw",
    discriminatorKey: "role",
  }
);

userSchema.index(
  { role: 1, "doctorProfile.isAcceptingAppointments": 1, "doctorProfile.specialization": 1, fullName: 1 },
  { name: "doctor_directory", partialFilterExpression: { role: "doctor" } }
);

export const User = model("User", userSchema, "users");

const patientProfileSchema = new Schema(
  {
    dateOfBirth: { type: String }, // YYYY-MM-DD, never a Date (see docs §3.4)
    gender: { type: String, enum: ["female", "male", "other", "prefer_not_to_say"] },
  },
  { _id: false }
);

export const Patient = User.discriminator(
  "patient",
  new Schema({ patientProfile: { type: patientProfileSchema, default: undefined } }, { strict: "throw" })
);

const doctorProfileSchema = new Schema(
  {
    specialization: { type: String, required: true },
    qualifications: { type: [String], default: [] },
    experienceYears: { type: Number, min: 0, max: 70 },
    bio: { type: String, maxlength: 1000 },
    clinicName: { type: String, maxlength: 120 },
    clinicAddress: { type: String, maxlength: 300 },
    isAcceptingAppointments: { type: Boolean, default: false },
  },
  { _id: false }
);

export const Doctor = User.discriminator(
  "doctor",
  new Schema({ doctorProfile: { type: doctorProfileSchema, required: true } }, { strict: "throw" })
);
