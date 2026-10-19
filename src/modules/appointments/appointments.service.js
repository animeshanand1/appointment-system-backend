// Atomic booking + queries. See docs/architecture/03-core-algorithms.md §3.2
// for the booking algorithm and the E11000 -> error-code translation table.
//
// The pre-checks only produce good error messages. The unique tick indexes on
// Appointment are the guarantee: two requests can both pass every pre-check,
// but only one insert can win.
import mongoose from "mongoose";
import { Appointment, DoctorAvailability, User } from "../../db/models/index.js";
import { AppError, ErrorCodes } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { addMinutes, localDateOf, localDayWindow, localTimeOf, ticksBetween } from "../../lib/time.js";
import { generateDayForDoctor, loadActiveDoctor, loadBookingAvailability } from "../slots/slot.service.js";
import { allowedActions, checkRescheduleAction, checkStatusTransition } from "./appointment.policy.js";

const { trusted } = mongoose;

const MAX_UPCOMING_PER_PATIENT = 5;
const MAX_UPCOMING_PER_PATIENT_AND_DOCTOR = 2;
const DEFAULT_LATE_CANCEL_WINDOW_MINUTES = 240;
const MAJORITY = { writeConcern: { w: "majority" } };
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

const DOCTOR_SUMMARY_FIELDS = "fullName doctorProfile.specialization doctorProfile.clinicName";
const PATIENT_SUMMARY_FIELDS = "fullName phone";

const TRANSITION_MESSAGES = {
  INVALID_STATUS_TRANSITION: "This appointment can no longer change to that status",
  CANCELLATION_CLOSED: "This appointment can no longer be cancelled",
  REASON_REQUIRED: "Please give a reason of at least 5 characters when cancelling",
  FORBIDDEN_TRANSITION: "You can't set this status on an appointment",
  TRANSITION_TOO_EARLY: "It's too early to mark this appointment with that status",
  RESCHEDULE_CLOSED: "This appointment can no longer be rescheduled",
  RESCHEDULE_NOT_PENDING: "There is no pending reschedule request on this appointment",
};

const RESCHEDULE_MESSAGES = {
  ...TRANSITION_MESSAGES,
  INVALID_STATUS_TRANSITION: "Only booked appointments can be rescheduled",
  FORBIDDEN_TRANSITION: "You can't perform this reschedule action",
  REASON_REQUIRED: "Please give a reason of at least 5 characters when rescheduling",
};

function appError(code, message, details) {
  return new AppError(code, message, { status: ErrorCodes[code], details });
}

const notFound = () => appError("APPOINTMENT_NOT_FOUND", "Appointment not found");
const slotUnavailable = () =>
  appError("SLOT_UNAVAILABLE", "This time slot was just booked by someone else. Please choose another.");

// Derived-field rule (docs/architecture/02-data-model.md §2.4): endAt, the
// ticks and the local snapshots all come from this one function.
export function buildAppointmentFields({ startAt, slotDurationMinutes, timezone }) {
  const endAt = addMinutes(startAt, slotDurationMinutes);
  return {
    startAt,
    endAt,
    occupiedTicks: ticksBetween(startAt, endAt),
    timezone,
    localDate: localDateOf(startAt, timezone),
    localStartTime: localTimeOf(startAt, timezone),
    localEndTime: localTimeOf(endAt, timezone),
  };
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

function doctorSummary(doctor) {
  if (!doctor?._id) return null;
  return {
    id: String(doctor._id),
    fullName: doctor.fullName,
    specialization: doctor.doctorProfile?.specialization ?? null,
    clinicName: doctor.doctorProfile?.clinicName ?? null,
  };
}

function patientSummary(patient) {
  if (!patient?._id) return null;
  return { id: String(patient._id), fullName: patient.fullName, phone: patient.phone ?? null };
}

function rescheduleRequestDTO(request) {
  if (!request) return null;
  return {
    id: String(request._id),
    status: request.status,
    startAt: request.startAt,
    endAt: request.endAt,
    localDate: request.localDate,
    localStartTime: request.localStartTime,
    localEndTime: request.localEndTime,
    reason: request.reason ?? null,
    requestedAt: request.requestedAt,
    decidedAt: request.decidedAt ?? null,
    decidedByRole: request.decidedByRole ?? null,
    decisionNote: request.decisionNote ?? null,
  };
}

// `appointment` is a lean document whose counterpart (doctorId for patients,
// patientId for doctors) is populated.
function toAppointmentDTO(appointment, actor, now, { includeHistory = false } = {}) {
  const { cancellation } = appointment;
  const dto = {
    id: String(appointment._id),
    status: appointment.status,
    startAt: appointment.startAt,
    endAt: appointment.endAt,
    timezone: appointment.timezone,
    localDate: appointment.localDate,
    localStartTime: appointment.localStartTime,
    localEndTime: appointment.localEndTime,
    patientNotes: appointment.patientNotes ?? null,
    ...(actor.role === "doctor"
      ? { patient: patientSummary(appointment.patientId) }
      : { doctor: doctorSummary(appointment.doctorId) }),
    cancellation: cancellation
      ? { byRole: cancellation.byRole, reason: cancellation.reason ?? null, at: cancellation.at, isLate: cancellation.isLate }
      : null,
    rescheduleRequest: rescheduleRequestDTO(appointment.rescheduleRequest),
    allowedActions: allowedActions(appointment, actor, now),
    createdAt: appointment.createdAt,
  };
  if (includeHistory) {
    dto.statusHistory = appointment.statusHistory.map(({ status, at, byRole }) => ({ status, at, byRole }));
    dto.rescheduleHistory = (appointment.rescheduleHistory ?? []).map(
      ({ fromStartAt, fromEndAt, toStartAt, toEndAt, at, initiatedBy, reason }) => ({
        fromStartAt,
        fromEndAt,
        toStartAt,
        toEndAt,
        at,
        initiatedBy,
        reason: reason ?? null,
      })
    );
  }
  return dto;
}

// ---------------------------------------------------------------------------
// Owner scoping
// ---------------------------------------------------------------------------

function ownerField(actor) {
  return actor.role === "doctor" ? "doctorId" : "patientId";
}

function withCounterpart(query, actor) {
  return actor.role === "doctor"
    ? query.populate("patientId", PATIENT_SUMMARY_FIELDS)
    : query.populate("doctorId", DOCTOR_SUMMARY_FIELDS);
}

// Missing and not-yours look the same from outside: both are 404.
function findOwned(actor, appointmentId) {
  if (!OBJECT_ID_PATTERN.test(appointmentId)) return null;
  return withCounterpart(Appointment.findOne({ _id: appointmentId, [ownerField(actor)]: actor.userId }), actor).lean();
}

// ---------------------------------------------------------------------------
// POST /api/appointments
// ---------------------------------------------------------------------------

/**
 * @param actor req.auth ({ userId, role: "patient" })
 * @param input { doctorId, startAt: Date (UTC, tick aligned), patientNotes? }
 * @returns { appointment: DTO, replayed: boolean }
 */
export async function bookAppointment(actor, input) {
  const now = new Date();

  const doctor = await loadActiveDoctor(input.doctorId);
  const availability = await loadBookingAvailability(doctor);
  if (!availability) throw appError("DOCTOR_NOT_ACCEPTING", "This doctor is not accepting appointments right now");

  // Re-derive the slot with the same engine the slots endpoint uses.
  const localDate = localDateOf(input.startAt, availability.timezone);
  const { day, appointments } = await generateDayForDoctor(doctor, availability, localDate, now);
  const slot = day.slots.find((s) => s.startAt.getTime() === input.startAt.getTime());

  if (!slot) {
    throw appError("SLOT_NOT_BOOKABLE", "This time isn't an open slot on the doctor's schedule", {
      reason: day.reason ?? "NOT_ON_GRID",
    });
  }
  if (slot.status === "unavailable") {
    throw appError("SLOT_NOT_BOOKABLE", "This slot is in the past or too soon to book", { reason: "TOO_SOON_OR_PAST" });
  }
  if (slot.status === "booked") {
    const own = appointments.find(
      (a) => String(a.patientId) === actor.userId && a.startAt.getTime() === slot.startAt.getTime()
    );
    if (own) return replay(own._id, doctor, actor, now);
    throw slotUnavailable();
  }

  await enforceBookingLimits(actor.userId, doctor._id, now);

  const appointment = new Appointment({
    doctorId: doctor._id,
    patientId: actor.userId,
    ...buildAppointmentFields({
      startAt: slot.startAt,
      slotDurationMinutes: availability.slotDurationMinutes,
      timezone: availability.timezone,
    }),
    status: "booked",
    patientNotes: input.patientNotes,
    statusHistory: [{ status: "booked", at: now, byUserId: actor.userId, byRole: "patient" }],
  });

  try {
    await appointment.save(MAJORITY);
  } catch (err) {
    if (err?.code === 11000) return resolveBookingConflict(err, appointment, doctor, actor, now);
    throw err;
  }

  return {
    appointment: toAppointmentDTO({ ...appointment.toObject(), doctorId: doctor }, actor, now),
    replayed: false,
  };
}

async function replay(appointmentId, doctor, actor, now) {
  const existing = await Appointment.findById(appointmentId).lean();
  return { appointment: toAppointmentDTO({ ...existing, doctorId: doctor }, actor, now), replayed: true };
}

// Soft anti-hoarding limits. Counts can be off by one under a race, which is
// acceptable for a business rule; the tick indexes cover the hard invariant.
async function enforceBookingLimits(patientId, doctorId, now) {
  const upcoming = { patientId, status: "booked", startAt: trusted({ $gt: now }) };
  const [total, withDoctor] = await Promise.all([
    Appointment.countDocuments(upcoming),
    Appointment.countDocuments({ ...upcoming, doctorId }),
  ]);

  if (total >= MAX_UPCOMING_PER_PATIENT) {
    throw appError("BOOKING_LIMIT_REACHED", `You can hold at most ${MAX_UPCOMING_PER_PATIENT} upcoming appointments`, {
      limit: MAX_UPCOMING_PER_PATIENT,
      scope: "total",
    });
  }
  if (withDoctor >= MAX_UPCOMING_PER_PATIENT_AND_DOCTOR) {
    throw appError(
      "BOOKING_LIMIT_REACHED",
      `You can hold at most ${MAX_UPCOMING_PER_PATIENT_AND_DOCTOR} upcoming appointments with the same doctor`,
      { limit: MAX_UPCOMING_PER_PATIENT_AND_DOCTOR, scope: "doctor" }
    );
  }
}

// E11000 translation. Switches on keyPattern (which index fired), never on
// the error message text.
async function resolveBookingConflict(err, appointment, doctor, actor, now) {
  // A retried request (double click, network retry) can trip either tick
  // index first, so look for our own identical booking before branching.
  const own = await Appointment.findOne({
    doctorId: doctor._id,
    patientId: actor.userId,
    startAt: appointment.startAt,
    status: "booked",
  })
    .select("_id")
    .lean();
  if (own) return replay(own._id, doctor, actor, now);

  const index = err.keyPattern ?? {};

  if ("doctorId" in index && "occupiedTicks" in index) throw slotUnavailable();

  if ("patientId" in index && "occupiedTicks" in index) {
    const existing = await Appointment.findOne({
      patientId: actor.userId,
      status: "booked",
      occupiedTicks: trusted({ $in: appointment.occupiedTicks }),
    })
      .select("_id startAt endAt")
      .lean();
    throw appError(
      "PATIENT_TIME_CONFLICT",
      "You already have another appointment at this time",
      existing ? { appointmentId: String(existing._id), startAt: existing.startAt, endAt: existing.endAt } : undefined
    );
  }

  logger.error({ err, keyPattern: err.keyPattern }, "Unexpected unique index violation while booking");
  throw appError("CONFLICT", "This booking conflicts with existing data. Please try again.");
}

// ---------------------------------------------------------------------------
// GET /api/appointments/my-appointments
// ---------------------------------------------------------------------------

async function doctorTimezone(doctorId) {
  const availability = await DoctorAvailability.findOne({ doctorId }).select("timezone").lean();
  if (availability) return availability.timezone;
  const doctor = await User.findById(doctorId).select("timezone").lean();
  return doctor?.timezone ?? "UTC";
}

async function countByStatus(doctorId, window) {
  // Aggregation pipelines skip Mongoose casting and sanitizing, so cast by hand.
  const rows = await Appointment.aggregate([
    {
      $match: {
        doctorId: new mongoose.Types.ObjectId(doctorId),
        startAt: { $gte: window.start, $lt: window.end },
      },
    },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const counts = { booked: 0, completed: 0, cancelled: 0, no_show: 0 };
  for (const row of rows) counts[row._id] = row.count;
  return counts;
}

/**
 * @param actor req.auth
 * @param query { scope, status?: string[], date?: "YYYY-MM-DD" (doctor only), page, limit }
 * @returns { appointments: DTO[], meta }
 */
export async function listMyAppointments(actor, query) {
  const now = new Date();
  const filter = { [ownerField(actor)]: actor.userId };
  if (query.status) filter.status = trusted({ $in: query.status });
  if (query.scope === "upcoming") filter.endAt = trusted({ $gte: now });
  if (query.scope === "past") filter.endAt = trusted({ $lt: now });
  if (query.reschedule) filter["rescheduleRequest.status"] = query.reschedule;

  let window = null;
  if (query.date) {
    window = localDayWindow(query.date, await doctorTimezone(actor.userId));
    filter.startAt = trusted({ $gte: window.start, $lt: window.end });
  }

  const sort = query.scope === "past" ? { startAt: -1 } : { startAt: 1 };
  const [appointments, total, counts] = await Promise.all([
    withCounterpart(Appointment.find(filter), actor)
      .sort(sort)
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    Appointment.countDocuments(filter),
    window ? countByStatus(actor.userId, window) : null,
  ]);

  return {
    appointments: appointments.map((a) => toAppointmentDTO(a, actor, now)),
    meta: { page: query.page, limit: query.limit, total, ...(counts ? { counts } : {}) },
  };
}

// ---------------------------------------------------------------------------
// GET /api/appointments/:id
// ---------------------------------------------------------------------------

export async function getAppointmentById(actor, appointmentId) {
  const appointment = await findOwned(actor, appointmentId);
  if (!appointment) throw notFound();
  return toAppointmentDTO(appointment, actor, new Date(), { includeHistory: true });
}

// ---------------------------------------------------------------------------
// PATCH /api/appointments/:id/status
// ---------------------------------------------------------------------------

async function lateCancelWindowMinutes(doctorId) {
  const availability = await DoctorAvailability.findOne({ doctorId })
    .select("bookingPolicy.lateCancelWindowMinutes")
    .lean();
  return availability?.bookingPolicy?.lateCancelWindowMinutes ?? DEFAULT_LATE_CANCEL_WINDOW_MINUTES;
}

/**
 * @param actor req.auth
 * @param input { status: "cancelled" | "completed" | "no_show", reason? }
 * @returns { appointment: DTO, unchanged: boolean }
 */
export async function updateStatus(actor, appointmentId, { status, reason }) {
  const now = new Date();
  const appointment = await findOwned(actor, appointmentId);
  if (!appointment) throw notFound();

  const decision = checkStatusTransition(appointment, actor, status, now, { reason });
  if (!decision.allowed) throw appError(decision.code, TRANSITION_MESSAGES[decision.code]);
  if (decision.unchanged) {
    return { appointment: toAppointmentDTO(appointment, actor, now, { includeHistory: true }), unchanged: true };
  }

  const update = {
    $set: { status },
    $push: { statusHistory: { status, at: now, byUserId: actor.userId, byRole: actor.role } },
  };
  if (status === "cancelled") {
    // For patients doctorId is populated, so take the id back out of it.
    const doctorId = appointment.doctorId?._id ?? appointment.doctorId;
    const isLate =
      actor.role === "patient" && now >= addMinutes(appointment.startAt, -(await lateCancelWindowMinutes(doctorId)));
    update.$set.cancellation = {
      byUserId: actor.userId,
      byRole: actor.role,
      ...(reason ? { reason } : {}),
      at: now,
      isLate,
    };
  }
  // Once the appointment is closed, an open reschedule request is moot.
  if (appointment.rescheduleRequest?.status === "pending") {
    Object.assign(update.$set, closeRequestFields("superseded", "system", now));
  }

  // The status: "booked" precondition makes concurrent transitions safe: if a
  // patient cancels while the doctor completes, only one update matches.
  const updated = await withCounterpart(
    Appointment.findOneAndUpdate({ _id: appointment._id, [ownerField(actor)]: actor.userId, status: "booked" }, update, {
      new: true,
      ...MAJORITY,
    }),
    actor
  ).lean();

  if (!updated) {
    const current = await Appointment.findById(appointment._id).select("status").lean();
    throw appError("INVALID_STATUS_TRANSITION", "This appointment was just updated by someone else", {
      currentStatus: current?.status ?? null,
    });
  }

  return { appointment: toAppointmentDTO(updated, actor, now, { includeHistory: true }), unchanged: false };
}

// ---------------------------------------------------------------------------
// Rescheduling. See docs/architecture/03-core-algorithms.md §3.3.1
//
// The doctor has the final say. A doctor moves an appointment directly; a
// patient files a request, and the appointment moves only when the doctor
// approves it. A move is one conditional update of startAt/endAt/
// occupiedTicks on the same document, so the tick indexes release the old
// slot and claim the new one atomically.
// ---------------------------------------------------------------------------

// The owner-scoped load populates the counterpart, so ids may be documents.
const idOf = (ref) => ref?._id ?? ref;

function assertRescheduleAllowed(appointment, actor, action, now, request) {
  const decision = checkRescheduleAction(appointment, actor, action, now, request);
  if (!decision.allowed) throw appError(decision.code, RESCHEDULE_MESSAGES[decision.code]);
}

function closeRequestFields(status, byRole, now, note) {
  return {
    "rescheduleRequest.status": status,
    "rescheduleRequest.decidedAt": now,
    "rescheduleRequest.decidedByRole": byRole,
    ...(note ? { "rescheduleRequest.decisionNote": note } : {}),
  };
}

// Optimistic guard: the write lands only if the appointment is still in the
// state that was validated (same time, same request, still booked).
function unchangedSince(appointment, actor) {
  return {
    _id: appointment._id,
    [ownerField(actor)]: actor.userId,
    status: "booked",
    startAt: appointment.startAt,
    "rescheduleRequest._id": appointment.rescheduleRequest?._id ?? null,
    "rescheduleRequest.status": appointment.rescheduleRequest?.status ?? null,
  };
}

async function concurrentChange(appointmentId) {
  const current = await Appointment.findById(appointmentId).select("status").lean();
  if (current && current.status !== "booked") {
    return appError("INVALID_STATUS_TRANSITION", "This appointment was just updated by someone else", {
      currentStatus: current.status,
    });
  }
  return appError("CONFLICT", "This appointment was just changed. Reload it and try again.");
}

// Checks `startAt` against the doctor's current slot grid with the same engine
// booking uses, and returns the derived fields for the new time. Patients need
// the doctor to be accepting bookings; the doctor can move their own
// appointments while paused.
async function resolveTargetSlot(appointment, startAt, { requireAccepting }, now) {
  const doctorId = idOf(appointment.doctorId);
  let availability;
  if (requireAccepting) {
    availability = await loadBookingAvailability(await loadActiveDoctor(doctorId));
    if (!availability) throw appError("DOCTOR_NOT_ACCEPTING", "This doctor is not accepting appointments right now");
  } else {
    availability = await DoctorAvailability.findOne({ doctorId }).lean();
    if (!availability) throw appError("DOCTOR_NOT_ACCEPTING", "There is no working schedule to reschedule into");
  }

  if (startAt.getTime() === appointment.startAt.getTime()) {
    throw appError("SLOT_NOT_BOOKABLE", "The appointment is already at this time", { reason: "UNCHANGED" });
  }

  const localDate = localDateOf(startAt, availability.timezone);
  const { day } = await generateDayForDoctor({ _id: doctorId }, availability, localDate, now, {
    excludeAppointmentId: appointment._id,
  });
  const slot = day.slots.find((s) => s.startAt.getTime() === startAt.getTime());

  if (!slot) {
    throw appError("SLOT_NOT_BOOKABLE", "This time isn't an open slot on the doctor's schedule", {
      reason: day.reason ?? "NOT_ON_GRID",
    });
  }
  if (slot.status === "unavailable") {
    throw appError("SLOT_NOT_BOOKABLE", "This slot is in the past or too soon to book", { reason: "TOO_SOON_OR_PAST" });
  }
  if (slot.status === "booked") throw slotUnavailable();

  return buildAppointmentFields({
    startAt: slot.startAt,
    slotDurationMinutes: availability.slotDurationMinutes,
    timezone: availability.timezone,
  });
}

async function findPatientClash(patientId, appointmentId, occupiedTicks) {
  return Appointment.findOne({
    patientId,
    status: "booked",
    _id: trusted({ $ne: appointmentId }),
    occupiedTicks: trusted({ $in: occupiedTicks }),
  })
    .select("_id startAt endAt")
    .lean();
}

function patientTimeConflict(clash) {
  return appError(
    "PATIENT_TIME_CONFLICT",
    "The patient already has another appointment at this time",
    clash ? { appointmentId: String(clash._id), startAt: clash.startAt, endAt: clash.endAt } : undefined
  );
}

// Moves the appointment. The doctor is always the actor here: either moving it
// directly or approving the patient's request.
async function moveAppointment(actor, appointment, fields, { initiatedBy, reason, filter = {}, set = {} }, now) {
  const historyEntry = {
    fromStartAt: appointment.startAt,
    fromEndAt: appointment.endAt,
    toStartAt: fields.startAt,
    toEndAt: fields.endAt,
    at: now,
    byUserId: actor.userId,
    initiatedBy,
    ...(reason ? { reason } : {}),
  };

  let updated;
  try {
    updated = await withCounterpart(
      Appointment.findOneAndUpdate(
        { ...unchangedSince(appointment, actor), ...filter },
        { $set: { ...fields, ...set }, $push: { rescheduleHistory: historyEntry } },
        { new: true, ...MAJORITY }
      ),
      actor
    ).lean();
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const index = err.keyPattern ?? {};
    if ("doctorId" in index && "occupiedTicks" in index) throw slotUnavailable();
    if ("patientId" in index && "occupiedTicks" in index) {
      throw patientTimeConflict(await findPatientClash(idOf(appointment.patientId), appointment._id, fields.occupiedTicks));
    }
    logger.error({ err, keyPattern: err.keyPattern }, "Unexpected unique index violation while rescheduling");
    throw appError("CONFLICT", "This change conflicts with existing data. Please try again.");
  }

  if (!updated) throw await concurrentChange(appointment._id);
  return updated;
}

/**
 * PATCH /api/appointments/:id/reschedule (doctor). Moves the appointment now;
 * a pending patient request is superseded.
 * @param input { startAt: Date, reason }
 */
export async function rescheduleAppointment(actor, appointmentId, { startAt, reason }) {
  const now = new Date();
  const appointment = await findOwned(actor, appointmentId);
  if (!appointment) throw notFound();
  assertRescheduleAllowed(appointment, actor, "reschedule", now, { reason });

  const fields = await resolveTargetSlot(appointment, startAt, { requireAccepting: false }, now);
  const set = appointment.rescheduleRequest?.status === "pending" ? closeRequestFields("superseded", "doctor", now) : {};
  const updated = await moveAppointment(actor, appointment, fields, { initiatedBy: "doctor", reason, set }, now);
  return toAppointmentDTO(updated, actor, now, { includeHistory: true });
}

/**
 * PUT /api/appointments/:id/reschedule-request (patient). Creates the pending
 * request, or replaces an earlier pending one. The slot isn't held.
 * @param input { startAt: Date, reason? }
 * @returns { appointment: DTO, unchanged: boolean }
 */
export async function requestReschedule(actor, appointmentId, { startAt, reason }) {
  const now = new Date();
  const appointment = await findOwned(actor, appointmentId);
  if (!appointment) throw notFound();
  assertRescheduleAllowed(appointment, actor, "request_reschedule", now);

  const current = appointment.rescheduleRequest;
  if (current?.status === "pending" && current.startAt.getTime() === startAt.getTime()) {
    return { appointment: toAppointmentDTO(appointment, actor, now, { includeHistory: true }), unchanged: true };
  }

  const fields = await resolveTargetSlot(appointment, startAt, { requireAccepting: true }, now);
  const clash = await findPatientClash(actor.userId, appointment._id, fields.occupiedTicks);
  if (clash) throw patientTimeConflict(clash);

  const request = {
    _id: new mongoose.Types.ObjectId(),
    status: "pending",
    startAt: fields.startAt,
    endAt: fields.endAt,
    localDate: fields.localDate,
    localStartTime: fields.localStartTime,
    localEndTime: fields.localEndTime,
    ...(reason ? { reason } : {}),
    requestedAt: now,
  };
  const updated = await withCounterpart(
    Appointment.findOneAndUpdate(unchangedSince(appointment, actor), { $set: { rescheduleRequest: request } }, {
      new: true,
      ...MAJORITY,
    }),
    actor
  ).lean();
  if (!updated) throw await concurrentChange(appointment._id);

  return { appointment: toAppointmentDTO(updated, actor, now, { includeHistory: true }), unchanged: false };
}

/** DELETE /api/appointments/:id/reschedule-request (patient). */
export async function withdrawRescheduleRequest(actor, appointmentId) {
  const now = new Date();
  const appointment = await findOwned(actor, appointmentId);
  if (!appointment) throw notFound();
  assertRescheduleAllowed(appointment, actor, "withdraw_reschedule", now);

  const updated = await withCounterpart(
    Appointment.findOneAndUpdate(
      unchangedSince(appointment, actor),
      { $set: closeRequestFields("withdrawn", "patient", now) },
      { new: true, ...MAJORITY }
    ),
    actor
  ).lean();
  if (!updated) throw await concurrentChange(appointment._id);
  return toAppointmentDTO(updated, actor, now, { includeHistory: true });
}

/**
 * POST /api/appointments/:id/reschedule-request/decision (doctor).
 * Approving re-checks the requested slot now; if it's no longer open the
 * request stays pending so the doctor can reject it or pick another time.
 * @param input { requestId, decision: "approve" | "reject", note? }
 */
export async function decideRescheduleRequest(actor, appointmentId, { requestId, decision, note }) {
  const now = new Date();
  const appointment = await findOwned(actor, appointmentId);
  if (!appointment) throw notFound();

  const request = appointment.rescheduleRequest;
  if (request?.status === "pending" && String(request._id) !== requestId) {
    throw appError("RESCHEDULE_NOT_PENDING", "The patient changed or withdrew this request. Reload to see the latest.");
  }
  const approve = decision === "approve";
  assertRescheduleAllowed(appointment, actor, approve ? "approve_reschedule" : "reject_reschedule", now);

  let updated;
  if (approve) {
    const fields = await resolveTargetSlot(appointment, request.startAt, { requireAccepting: false }, now);
    updated = await moveAppointment(
      actor,
      appointment,
      fields,
      { initiatedBy: "patient", reason: request.reason, set: closeRequestFields("approved", "doctor", now, note) },
      now
    );
  } else {
    updated = await withCounterpart(
      Appointment.findOneAndUpdate(
        unchangedSince(appointment, actor),
        { $set: closeRequestFields("rejected", "doctor", now, note) },
        { new: true, ...MAJORITY }
      ),
      actor
    ).lean();
    if (!updated) throw await concurrentChange(appointment._id);
  }
  return toAppointmentDTO(updated, actor, now, { includeHistory: true });
}
