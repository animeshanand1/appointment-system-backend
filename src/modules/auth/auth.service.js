import argon2 from "argon2";
import { createHash, timingSafeEqual } from "node:crypto";
import { User, Patient, Doctor, DoctorAvailability } from "../../db/models/index.js";
import { AppError } from "../../lib/errors.js";
import { env } from "../../config/env.js";

// hasAvailability is looked up by the caller (see withAvailabilityFlag): it
// lives in another collection, and the SPA uses it to send a first-time
// doctor to schedule setup.
function toUserDTO(user, { hasAvailability = false } = {}) {
  const dto = {
    id: String(user._id),
    role: user.role,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    timezone: user.timezone,
    createdAt: user.createdAt,
  };
  if (user.role === "doctor") {
    dto.doctorProfile = user.doctorProfile;
    dto.hasAvailability = hasAvailability;
  }
  return dto;
}

// Compares fixed-length digests so neither the content nor the length of the
// secret leaks through timing.
function safeCompare(a, b) {
  const digest = (value) => createHash("sha256").update(String(value)).digest();
  return timingSafeEqual(digest(a), digest(b));
}

// Verified against when the email is unknown, so a login for a missing account
// takes as long as one with a wrong password and can't be used to discover
// which emails are registered.
const dummyHash = argon2.hash("timing-equalizer-not-a-real-password", { type: argon2.argon2id });

const invalidCredentials = () => new AppError("INVALID_CREDENTIALS", "Invalid email or password", { status: 401 });

export async function registerUser(input) {
  if (input.role === "doctor" && !safeCompare(input.inviteCode, env.DOCTOR_INVITE_CODE)) {
    throw new AppError("INVALID_INVITE_CODE", "Invalid doctor invite code", { status: 403 });
  }

  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });

  try {
    const Model = input.role === "doctor" ? Doctor : Patient;
    const user = await Model.create({
      email: input.email,
      passwordHash,
      fullName: input.fullName,
      phone: input.phone,
      timezone: input.timezone,
      ...(input.role === "doctor" ? { doctorProfile: input.doctorProfile } : {}),
    });
    return toUserDTO(user);
  } catch (err) {
    if (err.code === 11000 && err.keyPattern?.email) {
      throw new AppError("EMAIL_ALREADY_REGISTERED", "This email is already registered", { status: 409 });
    }
    throw err;
  }
}

export async function withAvailabilityFlag(user) {
  const hasAvailability = user.role === "doctor" && Boolean(await DoctorAvailability.exists({ doctorId: user._id }));
  return toUserDTO(user, { hasAvailability });
}

export async function authenticateUser(email, password) {
  const user = await User.findOne({ email }).select("+passwordHash +tokenVersion");
  const isValid = await argon2.verify(user?.passwordHash ?? (await dummyHash), password).catch(() => false);
  // A deactivated account gets the same answer as a wrong password.
  if (!user || !isValid || !user.isActive) throw invalidCredentials();

  user.lastLoginAt = new Date();
  await user.save();

  return { dto: await withAvailabilityFlag(user), tokenVersion: user.tokenVersion };
}

export { toUserDTO };
