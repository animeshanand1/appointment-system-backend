// I/O shell around the pure slot engine: validates input, loads availability,
// time-off and booked appointments, then calls generateSlots. See
// docs/architecture/03-core-algorithms.md §3.1.
//
// The booking service re-derives slots through generateDayForDoctor, so the
// slot grid a patient sees and the one a booking is checked against are the same.
import mongoose from "mongoose";
import { z } from "zod";
import { generateSlots } from "./slot.engine.js";
import { Appointment, Doctor, DoctorAvailability, TimeOff } from "../../db/models/index.js";
import { AppError } from "../../lib/errors.js";
import { isValidLocalDate, localDayWindow } from "../../lib/time.js";

const slotsQuerySchema = z.object({
  doctorId: z.string().regex(/^[a-f\d]{24}$/i, "Invalid doctor id"),
  date: z.string().refine(isValidLocalDate, "Expected a real calendar date in YYYY-MM-DD format"),
});

export async function loadActiveDoctor(doctorId) {
  const doctor = await Doctor.findOne({ _id: doctorId, isActive: true }).lean();
  if (!doctor) throw new AppError("DOCTOR_NOT_FOUND", "Doctor not found", { status: 404 });
  return doctor;
}

// Returns the availability only when the doctor is currently taking bookings.
export async function loadBookingAvailability(doctor) {
  if (!doctor.doctorProfile?.isAcceptingAppointments) return null;
  return DoctorAvailability.findOne({ doctorId: doctor._id }).lean();
}

// Runs the engine for one doctor-local date. Also returns the active
// appointments it considered so callers can inspect who holds a slot.
// `excludeAppointmentId` leaves out the appointment being rescheduled, so it
// doesn't block a move into a slot that overlaps its current time.
export async function generateDayForDoctor(doctor, availability, date, now, { excludeAppointmentId } = {}) {
  const window = localDayWindow(date, availability.timezone);
  // sanitizeFilter is on globally, so query operators must be marked trusted.
  const overlapsWindow = {
    startAt: mongoose.trusted({ $lt: window.end }),
    endAt: mongoose.trusted({ $gt: window.start }),
  };
  const excluded = excludeAppointmentId ? { _id: mongoose.trusted({ $ne: excludeAppointmentId }) } : {};

  const [appointments, timeOff] = await Promise.all([
    Appointment.find({ doctorId: doctor._id, status: "booked", ...overlapsWindow, ...excluded })
      .select("patientId startAt endAt")
      .lean(),
    TimeOff.find({ doctorId: doctor._id, ...overlapsWindow })
      .select("startAt endAt")
      .lean(),
  ]);

  return { day: generateSlots(availability, date, { appointments, timeOff }, now), appointments };
}

export async function getSlotsForDate(doctorId, date) {
  slotsQuerySchema.parse({ doctorId, date });
  const doctor = await loadActiveDoctor(doctorId);
  const availability = await loadBookingAvailability(doctor);
  const now = new Date();

  const day = availability
    ? (await generateDayForDoctor(doctor, availability, date, now)).day
    : {
        date,
        timezone: null,
        slotDurationMinutes: null,
        isWorkingDay: false,
        reason: "NOT_ACCEPTING",
        slots: [],
      };

  return { doctorId: String(doctor._id), ...day, generatedAt: now };
}
