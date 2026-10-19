import argon2 from "argon2";
import mongoose from "mongoose";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { User, Patient, Doctor, DoctorAvailability } from "../../db/models/index.js";
import { AppError } from "../../lib/errors.js";
import { env } from "../../config/env.js";
import { notifyPasswordChanged, notifyPasswordReset } from "../notifications/notifications.service.js";
import { claimInviteCode, completeInviteClaim, releaseInviteClaim } from "../admin/invites.js";

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
  if (user.role === "patient") {
    dto.patientProfile = {
      dateOfBirth: user.patientProfile?.dateOfBirth ?? null,
      gender: user.patientProfile?.gender ?? null,
    };
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

// A doctor needs either a per-doctor code issued by an admin (single use) or,
// when configured, the legacy shared DOCTOR_INVITE_CODE.
async function checkDoctorInvite(input) {
  const invite = await claimInviteCode(input.inviteCode, input.email);
  if (invite) return invite;
  if (env.DOCTOR_INVITE_CODE && safeCompare(input.inviteCode, env.DOCTOR_INVITE_CODE)) return null;
  throw new AppError("INVALID_INVITE_CODE", "Invalid doctor invite code", { status: 403 });
}

export async function registerUser(input) {
  const invite = input.role === "doctor" ? await checkDoctorInvite(input) : null;

  try {
    const user = await createAccount(input);
    if (invite) await completeInviteClaim(invite._id, user.id);
    return user;
  } catch (err) {
    if (invite) await releaseInviteClaim(invite._id);
    throw err;
  }
}

async function createAccount(input) {
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

// ---------------------------------------------------------------------------
// Password reset, password change and profile edits
// ---------------------------------------------------------------------------

const RESET_TOKEN_MINUTES = 30;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * Starts a reset for an active account. Callers always answer the same way
 * whether or not the email exists, so this can't be used to probe accounts.
 */
export async function requestPasswordReset(email) {
  const token = randomBytes(32).toString("hex");
  const user = await User.findOneAndUpdate(
    { email, isActive: true },
    {
      $set: {
        passwordReset: { tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TOKEN_MINUTES * 60 * 1000) },
      },
    },
    { new: true }
  ).lean();
  if (!user) return;

  const url = `${env.APP_ORIGIN}/reset-password?token=${token}`;
  notifyPasswordReset(user, url, RESET_TOKEN_MINUTES);
}

async function setPassword(filter, password, extra = {}) {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  // Bumping tokenVersion signs out every existing session.
  return User.findOneAndUpdate(
    filter,
    { $set: { passwordHash, passwordChangedAt: new Date(), ...extra.$set }, $unset: { passwordReset: "" }, $inc: { tokenVersion: 1 } },
    { new: true }
  )
    .select("+tokenVersion")
    .lean();
}

export async function resetPassword(token, password) {
  const user = await setPassword(
    { "passwordReset.tokenHash": sha256(token), "passwordReset.expiresAt": mongoose.trusted({ $gt: new Date() }), isActive: true },
    password
  );
  if (!user) throw new AppError("INVALID_RESET_TOKEN", "This reset link is invalid or has expired", { status: 400 });
  notifyPasswordChanged(user);
}

export async function changePassword(actor, { currentPassword, newPassword }) {
  const current = await User.findById(actor.userId).select("+passwordHash");
  const isValid = current && (await argon2.verify(current.passwordHash, currentPassword).catch(() => false));
  if (!isValid) {
    throw new AppError("INVALID_CREDENTIALS", "Your current password is incorrect", {
      status: 401,
      details: [{ path: "currentPassword", message: "Incorrect password" }],
    });
  }

  const user = await setPassword({ _id: actor.userId, isActive: true }, newPassword);
  if (!user) throw new AppError("UNAUTHENTICATED", "Session is no longer valid", { status: 401 });
  notifyPasswordChanged(user);
  return { dto: await withAvailabilityFlag(user), tokenVersion: user.tokenVersion };
}

export async function updateMe(actor, input) {
  if (input.patientProfile && actor.role !== "patient") {
    throw new AppError("VALIDATION_FAILED", "Request validation failed", {
      status: 400,
      details: [{ path: "patientProfile", message: "Only patients have a patient profile" }],
    });
  }

  const $set = {};
  const $unset = {};
  const assign = (path, value) => {
    if (value === null) $unset[path] = "";
    else $set[path] = value;
  };
  for (const field of ["fullName", "phone", "timezone"]) if (field in input) assign(field, input[field]);
  for (const [field, value] of Object.entries(input.patientProfile ?? {})) assign(`patientProfile.${field}`, value);

  const Model = actor.role === "patient" ? Patient : actor.role === "doctor" ? Doctor : User;
  const user = await Model.findOneAndUpdate(
    { _id: actor.userId, isActive: true },
    { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) },
    { new: true, runValidators: true }
  ).lean();
  if (!user) throw new AppError("UNAUTHENTICATED", "Session is no longer valid", { status: 401 });
  return withAvailabilityFlag(user);
}

export { toUserDTO };
