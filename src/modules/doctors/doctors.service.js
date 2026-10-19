// Public doctor directory and profile, plus the doctor's own profile edits.
// See docs/architecture/04-api-specification.md §4.4 and §4.5.
import mongoose from "mongoose";
import { z } from "zod";
import { Doctor, DoctorAvailability } from "../../db/models/index.js";
import { AppError, ErrorCodes } from "../../lib/errors.js";
import { addDaysToLocalDate, formatHHmm, localDateOf } from "../../lib/time.js";
import { workingWindows } from "../slots/slot.engine.js";
import { loadActiveDoctor } from "../slots/slot.service.js";

const { trusted } = mongoose;

export const listDoctorsQuerySchema = z
  .object({
    specialization: z.string().trim().toLowerCase().min(1).max(60).optional(),
    q: z.string().trim().min(2, "Search needs at least 2 characters").max(100).optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toDirectoryDTO(doctor, availability) {
  return {
    id: String(doctor._id),
    fullName: doctor.fullName,
    specialization: doctor.doctorProfile.specialization,
    experienceYears: doctor.doctorProfile.experienceYears ?? null,
    clinicName: doctor.doctorProfile.clinicName ?? null,
    timezone: availability?.timezone ?? null,
    slotDurationMinutes: availability?.slotDurationMinutes ?? null,
  };
}

/**
 * @param query output of listDoctorsQuerySchema
 * @returns { doctors: DirectoryDTO[], meta: { page, limit, total } }
 */
export async function listDoctors(query) {
  const filter = { isActive: true, "doctorProfile.isAcceptingAppointments": true };
  if (query.specialization) filter["doctorProfile.specialization"] = query.specialization;
  // "Dr." is part of stored names, so match the prefix on either form.
  if (query.q) {
    filter.fullName = trusted({ $regex: `^(Dr\\.?\\s+)?${escapeRegex(query.q)}`, $options: "i" });
  }

  const [doctors, total] = await Promise.all([
    Doctor.find(filter)
      .sort({ fullName: 1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    Doctor.countDocuments(filter),
  ]);

  const availabilities = await DoctorAvailability.find({ doctorId: trusted({ $in: doctors.map((d) => d._id) }) })
    .select("doctorId timezone slotDurationMinutes")
    .lean();
  const byDoctor = new Map(availabilities.map((a) => [String(a.doctorId), a]));

  return {
    doctors: doctors.map((d) => toDirectoryDTO(d, byDoctor.get(String(d._id)))),
    meta: { page: query.page, limit: query.limit, total },
  };
}

// ---------------------------------------------------------------------------
// GET /api/doctors/:id and PATCH /api/doctors/me/profile
// ---------------------------------------------------------------------------

function toDoctorDTO(doctor, availability, now) {
  const profile = doctor.doctorProfile;
  const today = availability ? localDateOf(now, availability.timezone) : null;

  return {
    id: String(doctor._id),
    fullName: doctor.fullName,
    specialization: profile.specialization,
    qualifications: profile.qualifications ?? [],
    experienceYears: profile.experienceYears ?? null,
    bio: profile.bio ?? null,
    clinicName: profile.clinicName ?? null,
    clinicAddress: profile.clinicAddress ?? null,
    timezone: availability?.timezone ?? null,
    slotDurationMinutes: availability?.slotDurationMinutes ?? null,
    isAcceptingAppointments: Boolean(profile.isAcceptingAppointments),
    // One entry per weekday so a date picker can grey out the days off.
    weeklyHours: availability
      ? [...availability.weeklySchedule]
          .sort((a, b) => a.isoWeekday - b.isoWeekday)
          .map((day) => ({
            isoWeekday: day.isoWeekday,
            windows: day.isWorking
              ? workingWindows(day).map((w) => ({ start: formatHHmm(w.start), end: formatHHmm(w.end) }))
              : [],
          }))
      : [],
    bookingWindow: availability
      ? { today, lastBookableDate: addDaysToLocalDate(today, availability.bookingPolicy.horizonDays) }
      : null,
  };
}

export async function getDoctorById(doctorId) {
  const doctor = await loadActiveDoctor(doctorId);
  const availability = await DoctorAvailability.findOne({ doctorId: doctor._id }).lean();
  return toDoctorDTO(doctor, availability, new Date());
}

/**
 * @param actor req.auth ({ userId, role: "doctor" })
 * @param input output of updateProfileSchema (null or "" clears an optional field)
 * @returns DoctorDTO
 */
export async function updateMyProfile(actor, input) {
  if (input.isAcceptingAppointments === true && !(await DoctorAvailability.exists({ doctorId: actor.userId }))) {
    throw new AppError("DOCTOR_NOT_ACCEPTING", "Save your weekly schedule before you start accepting appointments", {
      status: ErrorCodes.DOCTOR_NOT_ACCEPTING,
    });
  }

  const $set = {};
  const $unset = {};
  for (const [field, value] of Object.entries(input)) {
    const path = `doctorProfile.${field}`;
    if (value === null || value === "") $unset[path] = "";
    else $set[path] = value;
  }

  const doctor = await Doctor.findOneAndUpdate(
    { _id: actor.userId, isActive: true },
    { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) },
    { new: true, runValidators: true }
  ).lean();
  if (!doctor) throw new AppError("DOCTOR_NOT_FOUND", "Doctor not found", { status: 404 });

  const availability = await DoctorAvailability.findOne({ doctorId: doctor._id }).lean();
  return toDoctorDTO(doctor, availability, new Date());
}
