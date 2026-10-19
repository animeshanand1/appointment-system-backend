// Weekly schedule + time-off business logic (schedule invariants, revision
// checks, time-off conflict detection). See docs/architecture/02-data-model.md
// §2.2-2.3 and docs/architecture/04-api-specification.md §4.5.
//
// Existing bookings are never cancelled as a side effect of editing hours: a
// save reports the ones that no longer fit (outOfHoursBookings) and leaves the
// doctor to decide. Time-off can cancel them, but only when asked to.
import mongoose from "mongoose";
import { Appointment, Doctor, DoctorAvailability, TimeOff, User } from "../../db/models/index.js";
import { AppError, ErrorCodes } from "../../lib/errors.js";
import {
  MINUTE_MS,
  isValidTimeZone,
  isoWeekdayOf,
  localDateOf,
  localTimeOf,
  parseHHmm,
  startOfLocalDay,
  wallClockToInstant,
} from "../../lib/time.js";
import { workingWindows } from "../slots/slot.engine.js";
import { splitLocalDateTime } from "./availability.validators.js";

const { trusted } = mongoose;

const MAX_TIME_OFF_DAYS = 90;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_LISTED_APPOINTMENTS = 500;
const MAJORITY = { writeConcern: { w: "majority" } };
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

function appError(code, message, details) {
  return new AppError(code, message, { status: ErrorCodes[code], details });
}

function validationError(path, message) {
  return appError("VALIDATION_FAILED", "Request validation failed", [{ path, message }]);
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

function toAvailabilityDTO(availability) {
  return {
    revision: availability.revision,
    timezone: availability.timezone,
    slotDurationMinutes: availability.slotDurationMinutes,
    bookingPolicy: {
      horizonDays: availability.bookingPolicy.horizonDays,
      minNoticeMinutes: availability.bookingPolicy.minNoticeMinutes,
      lateCancelWindowMinutes: availability.bookingPolicy.lateCancelWindowMinutes,
    },
    weeklySchedule: [...availability.weeklySchedule]
      .sort((a, b) => a.isoWeekday - b.isoWeekday)
      .map((day) =>
        day.isWorking
          ? {
              isoWeekday: day.isoWeekday,
              isWorking: true,
              shiftStart: day.shiftStart,
              shiftEnd: day.shiftEnd,
              breaks: day.breaks.map(({ start, end }) => ({ start, end })),
            }
          : { isoWeekday: day.isoWeekday, isWorking: false, breaks: [] }
      ),
  };
}

// `appointment` is lean, with patientId populated for the name.
function toBookingSummary(appointment, { localDate, localStartTime, localEndTime } = appointment) {
  return {
    id: String(appointment._id),
    startAt: appointment.startAt,
    endAt: appointment.endAt,
    localDate,
    localStartTime,
    localEndTime,
    patientName: appointment.patientId?.fullName ?? null,
  };
}

function toTimeOffDTO(block, timezone) {
  const local = (instant) => `${localDateOf(instant, timezone)}T${localTimeOf(instant, timezone)}`;
  return {
    id: String(block._id),
    startAt: block.startAt,
    endAt: block.endAt,
    startLocal: local(block.startAt),
    endLocal: local(block.endAt),
    timezone,
    reason: block.reason ?? null,
  };
}

// ---------------------------------------------------------------------------
// GET / PUT /api/doctors/me/availability
// ---------------------------------------------------------------------------

/** @returns AvailabilityDTO, or null before the doctor's first save (setup). */
export async function getAvailability(actor) {
  const availability = await DoctorAvailability.findOne({ doctorId: actor.userId }).lean();
  return availability ? toAvailabilityDTO(availability) : null;
}

async function staleRevision(doctorId) {
  const current = await DoctorAvailability.findOne({ doctorId }).select("revision").lean();
  return appError("STALE_REVISION", "Your schedule was changed in another tab or device. Reload to see the latest.", {
    currentRevision: current?.revision ?? null,
  });
}

// Does the booking still sit inside a working window of the (new) schedule?
// Hours only: the slot grid is not part of the question.
function fitsSchedule(appointment, availability) {
  const tz = availability.timezone;
  const date = localDateOf(appointment.startAt, tz);
  if (localDateOf(appointment.endAt, tz) !== date) return false;

  const day = availability.weeklySchedule.find((d) => d.isoWeekday === isoWeekdayOf(date));
  if (!day?.isWorking) return false;

  const start = parseHHmm(localTimeOf(appointment.startAt, tz));
  const end = parseHHmm(localTimeOf(appointment.endAt, tz));
  return workingWindows(day).some((window) => window.start <= start && end <= window.end);
}

async function findOutOfHoursBookings(doctorId, availability, now) {
  const upcoming = await Appointment.find({ doctorId, status: "booked", startAt: trusted({ $gt: now }) })
    .select("patientId startAt endAt")
    .populate("patientId", "fullName")
    .sort({ startAt: 1 })
    .limit(MAX_LISTED_APPOINTMENTS)
    .lean();

  return upcoming
    .filter((appointment) => !fitsSchedule(appointment, availability))
    .map((appointment) =>
      toBookingSummary(appointment, {
        localDate: localDateOf(appointment.startAt, availability.timezone),
        localStartTime: localTimeOf(appointment.startAt, availability.timezone),
        localEndTime: localTimeOf(appointment.endAt, availability.timezone),
      })
    );
}

/**
 * Full replacement of the weekly schedule and booking policy.
 * @param actor req.auth ({ userId, role: "doctor" })
 * @param input output of availabilitySchema (revision: null on the first save)
 * @returns { availability: AvailabilityDTO, outOfHoursBookings: [] }
 */
export async function saveAvailability(actor, input) {
  const now = new Date();
  const { revision, ...fields } = input;
  let saved;

  if (revision === null) {
    try {
      saved = (await DoctorAvailability.create({ doctorId: actor.userId, ...fields, revision: 1 })).toObject();
    } catch (err) {
      // Either a second tab already did the first save, or the doctor has a
      // stored schedule (seeded, or saved elsewhere) and this form is stale.
      if (err?.code === 11000) throw await staleRevision(actor.userId);
      throw err;
    }
    // The first schedule is what makes a doctor bookable; later edits leave a
    // deliberate pause alone.
    await Doctor.updateOne({ _id: actor.userId }, { $set: { "doctorProfile.isAcceptingAppointments": true } });
  } else {
    // The revision in the filter is the optimistic lock: of two concurrent
    // saves from the same revision, only one update matches.
    saved = await DoctorAvailability.findOneAndUpdate(
      { doctorId: actor.userId, revision },
      { $set: fields, $inc: { revision: 1 } },
      { new: true, runValidators: true, ...MAJORITY }
    ).lean();
    if (!saved) throw await staleRevision(actor.userId);
  }

  return {
    availability: toAvailabilityDTO(saved),
    outOfHoursBookings: await findOutOfHoursBookings(actor.userId, saved, now),
  };
}

// ---------------------------------------------------------------------------
// Time-off
// ---------------------------------------------------------------------------

async function doctorTimezone(doctorId) {
  const availability = await DoctorAvailability.findOne({ doctorId }).select("timezone").lean();
  if (availability) return availability.timezone;
  const doctor = await User.findById(doctorId).select("timezone").lean();
  return isValidTimeZone(doctor?.timezone) ? doctor.timezone : null;
}

function localToInstant(local, tz, path) {
  const { date, minutes } = splitLocalDateTime(local);
  if (minutes % 5 !== 0) throw validationError(path, "Times must fall on a 5-minute boundary");
  const instant = wallClockToInstant(date, minutes, tz);
  if (!instant) throw validationError(path, "That local time doesn't exist (the clocks skip forward at that moment)");
  return instant;
}

// Future bookings that a block over [startAt, endAt) would cut into.
async function findConflicts(doctorId, startAt, endAt, now) {
  const overlapping = await Appointment.find({
    doctorId,
    status: "booked",
    startAt: trusted({ $gte: now, $lt: endAt }),
    endAt: trusted({ $gt: startAt }),
  })
    .select("patientId startAt endAt localDate localStartTime localEndTime")
    .populate("patientId", "fullName")
    .sort({ startAt: 1 })
    .limit(MAX_LISTED_APPOINTMENTS)
    .lean();
  return overlapping;
}

async function cancelForTimeOff(actor, conflicts, reason, now) {
  const cancelled = [];
  for (const appointment of conflicts) {
    // The status: "booked" precondition skips any that a patient cancelled a
    // moment ago, so nothing is cancelled (or recorded) twice.
    const updated = await Appointment.findOneAndUpdate(
      { _id: appointment._id, doctorId: actor.userId, status: "booked" },
      {
        $set: {
          status: "cancelled",
          cancellation: {
            byUserId: actor.userId,
            byRole: "doctor",
            reason: reason ? `Doctor unavailable: ${reason}` : "Doctor unavailable",
            at: now,
            isLate: false,
          },
        },
        $push: { statusHistory: { status: "cancelled", at: now, byUserId: actor.userId, byRole: "doctor" } },
      },
      { ...MAJORITY }
    ).select("_id");
    if (updated) cancelled.push(String(updated._id));
  }
  return cancelled;
}

/**
 * @param actor req.auth
 * @param input output of createTimeOffSchema
 * @returns { timeOff: DTO | null, conflicts: [], cancelledAppointmentIds?: [], dryRun: boolean }
 */
export async function createTimeOff(actor, input) {
  const now = new Date();
  const tz = await doctorTimezone(actor.userId);
  if (!tz) throw validationError("startLocal", "Save your weekly schedule before adding time off");

  const startAt = localToInstant(input.startLocal, tz, "startLocal");
  const endAt = localToInstant(input.endLocal, tz, "endLocal");
  if (endAt <= startAt) throw validationError("endLocal", "The end must be after the start");
  if (endAt - startAt > MAX_TIME_OFF_DAYS * DAY_MS) {
    throw validationError("endLocal", `Time off can span at most ${MAX_TIME_OFF_DAYS} days`);
  }
  if (endAt <= now) throw validationError("endLocal", "Time off can't be entirely in the past");

  if (input.dryRun) {
    const conflicts = await findConflicts(actor.userId, startAt, endAt, now);
    return { timeOff: null, conflicts: conflicts.map((c) => toBookingSummary(c)), dryRun: true };
  }

  // Written before conflicts are read: a booking that commits concurrently is
  // then either blocked by the new block or found by the query below.
  const block = await TimeOff.create({ doctorId: actor.userId, startAt, endAt, reason: input.reason });

  const conflicts = await findConflicts(actor.userId, startAt, endAt, now);
  const result = {
    timeOff: toTimeOffDTO(block.toObject(), tz),
    conflicts: conflicts.map((c) => toBookingSummary(c)),
    dryRun: false,
  };
  if (input.cancelConflictingAppointments) {
    result.cancelledAppointmentIds = await cancelForTimeOff(actor, conflicts, input.reason, now);
  }
  return result;
}

/**
 * @param actor req.auth
 * @param query { from?: "YYYY-MM-DD" } (doctor-local; defaults to today)
 * @returns TimeOffDTO[] whose end is on or after the start of `from`, soonest first
 */
export async function listTimeOff(actor, { from } = {}) {
  const tz = (await doctorTimezone(actor.userId)) ?? "UTC";
  const since = startOfLocalDay(from ?? localDateOf(new Date(), tz), tz);

  const blocks = await TimeOff.find({ doctorId: actor.userId, endAt: trusted({ $gte: since }) })
    .sort({ startAt: 1 })
    .limit(MAX_LISTED_APPOINTMENTS)
    .lean();
  return blocks.map((block) => toTimeOffDTO(block, tz));
}

export async function deleteTimeOff(actor, timeOffId) {
  const removed = OBJECT_ID_PATTERN.test(timeOffId)
    ? await TimeOff.findOneAndDelete({ _id: timeOffId, doctorId: actor.userId }).select("_id").lean()
    : null;
  // Missing and not-yours look the same from outside.
  if (!removed) throw appError("TIME_OFF_NOT_FOUND", "Time off not found");
}
