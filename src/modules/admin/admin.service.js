// Hospital administration: account oversight, per-doctor invite codes and a
// read-only view of all appointments.
import mongoose from "mongoose";
import { Appointment, InviteCode, User } from "../../db/models/index.js";
import { AppError } from "../../lib/errors.js";
import { generateInviteCode, hashInviteCode } from "./invites.js";

const { trusted } = mongoose;
const DAY_MS = 24 * 60 * 60 * 1000;

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function toAdminUserDTO(user) {
  return {
    id: String(user._id),
    role: user.role,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone ?? null,
    isActive: user.isActive !== false,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt ?? null,
    ...(user.role === "doctor"
      ? {
          specialization: user.doctorProfile?.specialization ?? null,
          isAcceptingAppointments: Boolean(user.doctorProfile?.isAcceptingAppointments),
        }
      : {}),
  };
}

function inviteStatus(invite, now) {
  if (invite.revokedAt) return "revoked";
  if (invite.usedAt) return "used";
  if (invite.expiresAt <= now) return "expired";
  return "active";
}

function toInviteDTO(invite, now = new Date()) {
  return {
    id: String(invite._id),
    label: invite.label,
    email: invite.email ?? null,
    codeHint: invite.codeHint,
    status: inviteStatus(invite, now),
    expiresAt: invite.expiresAt,
    usedAt: invite.usedAt ?? null,
    usedBy: invite.usedBy?._id
      ? { id: String(invite.usedBy._id), fullName: invite.usedBy.fullName, email: invite.usedBy.email }
      : null,
    revokedAt: invite.revokedAt ?? null,
    createdBy: invite.createdBy?._id ? { id: String(invite.createdBy._id), fullName: invite.createdBy.fullName } : null,
    createdAt: invite.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export async function getStats(now = new Date()) {
  const last30 = trusted({ $gte: new Date(now.getTime() - 30 * DAY_MS) });
  const [patients, doctors, acceptingDoctors, inactiveUsers, upcoming, next24h, booked7d, byStatus30d, activeInvites] =
    await Promise.all([
      User.countDocuments({ role: "patient", isActive: true }),
      User.countDocuments({ role: "doctor", isActive: true }),
      User.countDocuments({ role: "doctor", isActive: true, "doctorProfile.isAcceptingAppointments": true }),
      User.countDocuments({ isActive: false }),
      Appointment.countDocuments({ status: "booked", startAt: trusted({ $gt: now }) }),
      Appointment.countDocuments({ status: "booked", startAt: trusted({ $gt: now, $lte: new Date(now.getTime() + DAY_MS) }) }),
      Appointment.countDocuments({ createdAt: trusted({ $gte: new Date(now.getTime() - 7 * DAY_MS) }) }),
      Appointment.aggregate([
        { $match: { startAt: last30 } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      InviteCode.countDocuments({ usedAt: null, revokedAt: null, expiresAt: trusted({ $gt: now }) }),
    ]);

  const last30Days = { booked: 0, completed: 0, cancelled: 0, no_show: 0 };
  for (const row of byStatus30d) last30Days[row._id] = row.count;

  return {
    users: { patients, doctors, acceptingDoctors, inactive: inactiveUsers },
    appointments: { upcoming, next24h, bookedLast7Days: booked7d, last30Days },
    invites: { active: activeInvites },
    generatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function listUsers(query) {
  const filter = {};
  if (query.role) filter.role = query.role;
  if (query.status) filter.isActive = query.status === "active";
  if (query.q) {
    const pattern = escapeRegex(query.q);
    filter.$or = trusted([
      { fullName: { $regex: `(^|\\s)${pattern}`, $options: "i" } },
      { email: { $regex: `^${pattern}`, $options: "i" } },
    ]);
  }

  const [users, total] = await Promise.all([
    User.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    User.countDocuments(filter),
  ]);
  return { users: users.map(toAdminUserDTO), meta: { page: query.page, limit: query.limit, total } };
}

export async function setUserActive(actor, userId, isActive) {
  if (userId === actor.userId) {
    throw new AppError("FORBIDDEN", "You can't change your own account status", { status: 403 });
  }
  const target = await User.findById(userId).lean();
  if (!target) throw new AppError("USER_NOT_FOUND", "User not found", { status: 404 });
  if (target.role === "admin") {
    throw new AppError("FORBIDDEN", "Admin accounts can only be changed from the server", { status: 403 });
  }

  // Deactivating also revokes every session the user has.
  const update = isActive ? { $set: { isActive: true } } : { $set: { isActive: false }, $inc: { tokenVersion: 1 } };
  const user = await User.findByIdAndUpdate(userId, update, { new: true }).lean();
  return toAdminUserDTO(user);
}

// ---------------------------------------------------------------------------
// Invite codes
// ---------------------------------------------------------------------------

export async function createInvite(actor, { label, email, expiresInDays }) {
  const code = generateInviteCode();
  const invite = await InviteCode.create({
    codeHash: hashInviteCode(code),
    codeHint: code.slice(-4),
    label,
    ...(email ? { email } : {}),
    createdBy: actor.userId,
    expiresAt: new Date(Date.now() + expiresInDays * DAY_MS),
  });
  // The only time the plain code is ever returned.
  return { invite: toInviteDTO(invite.toObject()), code };
}

export async function listInvites(query, now = new Date()) {
  const filter = {};
  if (query.status === "revoked") filter.revokedAt = trusted({ $ne: null });
  if (query.status === "used") Object.assign(filter, { revokedAt: null, usedAt: trusted({ $ne: null }) });
  if (query.status === "active") Object.assign(filter, { revokedAt: null, usedAt: null, expiresAt: trusted({ $gt: now }) });
  if (query.status === "expired") Object.assign(filter, { revokedAt: null, usedAt: null, expiresAt: trusted({ $lte: now }) });

  const [invites, total] = await Promise.all([
    InviteCode.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .populate("usedBy", "fullName email")
      .populate("createdBy", "fullName")
      .lean(),
    InviteCode.countDocuments(filter),
  ]);
  return { invites: invites.map((i) => toInviteDTO(i, now)), meta: { page: query.page, limit: query.limit, total } };
}

export async function revokeInvite(inviteId) {
  const invite = await InviteCode.findOneAndUpdate(
    { _id: inviteId, usedAt: null, revokedAt: null },
    { $set: { revokedAt: new Date() } },
    { new: true }
  ).lean();
  if (!invite) {
    const exists = await InviteCode.exists({ _id: inviteId });
    if (!exists) throw new AppError("INVITE_NOT_FOUND", "Invite not found", { status: 404 });
    throw new AppError("CONFLICT", "This invite was already used or revoked", { status: 409 });
  }
  return toInviteDTO(invite);
}

// ---------------------------------------------------------------------------
// Appointments (read-only overview)
// ---------------------------------------------------------------------------

export async function listAllAppointments(query) {
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.doctorId) filter.doctorId = query.doctorId;
  if (query.from || query.to) {
    filter.localDate = trusted({ ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) });
  }

  const [appointments, total] = await Promise.all([
    Appointment.find(filter)
      .sort({ startAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .populate("doctorId", "fullName doctorProfile.specialization")
      .populate("patientId", "fullName email phone")
      .lean(),
    Appointment.countDocuments(filter),
  ]);

  return {
    appointments: appointments.map((a) => ({
      id: String(a._id),
      status: a.status,
      startAt: a.startAt,
      endAt: a.endAt,
      timezone: a.timezone,
      localDate: a.localDate,
      localStartTime: a.localStartTime,
      localEndTime: a.localEndTime,
      doctor: a.doctorId?._id
        ? { id: String(a.doctorId._id), fullName: a.doctorId.fullName, specialization: a.doctorId.doctorProfile?.specialization ?? null }
        : null,
      patient: a.patientId?._id
        ? { id: String(a.patientId._id), fullName: a.patientId.fullName, email: a.patientId.email, phone: a.patientId.phone ?? null }
        : null,
      cancellation: a.cancellation ? { byRole: a.cancellation.byRole, reason: a.cancellation.reason ?? null } : null,
      hasPendingReschedule: a.rescheduleRequest?.status === "pending",
    })),
    meta: { page: query.page, limit: query.limit, total },
  };
}
