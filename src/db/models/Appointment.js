import mongoose from "mongoose";

const { Schema, model } = mongoose;

// See docs/architecture/02-data-model.md §2.4
const cancellationSchema = new Schema(
  {
    byUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    byRole: { type: String, enum: ["patient", "doctor", "system"], required: true },
    reason: { type: String, maxlength: 300 },
    at: { type: Date, required: true },
    isLate: { type: Boolean, required: true },
  },
  { _id: false }
);

const statusHistoryEntrySchema = new Schema(
  {
    status: { type: String, enum: ["booked", "cancelled", "completed", "no_show"], required: true },
    at: { type: Date, required: true },
    byUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    byRole: { type: String, enum: ["patient", "doctor", "system"], required: true },
  },
  { _id: false }
);

// A patient's proposal to move the appointment. Only the latest request is
// kept; the doctor approves or rejects it. See docs/architecture/03-core-algorithms.md §3.3.1
const rescheduleRequestSchema = new Schema({
  status: { type: String, enum: ["pending", "approved", "rejected", "withdrawn", "superseded"], required: true },
  startAt: { type: Date, required: true }, // requested slot
  endAt: { type: Date, required: true },
  localDate: { type: String, required: true },
  localStartTime: { type: String, required: true },
  localEndTime: { type: String, required: true },
  reason: { type: String, maxlength: 300 },
  requestedAt: { type: Date, required: true },
  decidedAt: { type: Date },
  decidedByRole: { type: String, enum: ["patient", "doctor", "system"] },
  decisionNote: { type: String, maxlength: 300 },
});

// One entry per actual move, whoever initiated it.
const rescheduleHistoryEntrySchema = new Schema(
  {
    fromStartAt: { type: Date, required: true },
    fromEndAt: { type: Date, required: true },
    toStartAt: { type: Date, required: true },
    toEndAt: { type: Date, required: true },
    at: { type: Date, required: true },
    byUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    initiatedBy: { type: String, enum: ["patient", "doctor"], required: true },
    reason: { type: String, maxlength: 300 },
  },
  { _id: false }
);

const appointmentSchema = new Schema(
  {
    doctorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    patientId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    occupiedTicks: { type: [Date], required: true, select: false }, // every 5-min instant in [startAt, endAt)
    timezone: { type: String, required: true }, // snapshot of the doctor's zone at booking time
    localDate: { type: String, required: true }, // YYYY-MM-DD, display/export snapshot
    localStartTime: { type: String, required: true }, // HH:mm
    localEndTime: { type: String, required: true }, // HH:mm
    status: { type: String, enum: ["booked", "cancelled", "completed", "no_show"], default: "booked" },
    patientNotes: { type: String, trim: true, maxlength: 500 },
    cancellation: { type: cancellationSchema, default: undefined },
    statusHistory: { type: [statusHistoryEntrySchema], default: [] },
    rescheduleRequest: { type: rescheduleRequestSchema, default: undefined },
    rescheduleHistory: { type: [rescheduleHistoryEntrySchema], default: [] },
    // The startAt a reminder email was sent for, so a moved appointment gets a new one.
    reminderSentFor: { type: Date },
  },
  { timestamps: true, strict: "throw" }
);

// The anti-overlap guarantee: one unique index entry per occupied tick,
// so two active appointments for the same doctor can never share a tick.
// See docs/architecture/02-data-model.md §2.5.
appointmentSchema.index(
  { doctorId: 1, occupiedTicks: 1 },
  { name: "uniq_doctor_active_ticks", unique: true, partialFilterExpression: { status: "booked" } }
);

appointmentSchema.index(
  { patientId: 1, occupiedTicks: 1 },
  { name: "uniq_patient_active_ticks", unique: true, partialFilterExpression: { status: "booked" } }
);

appointmentSchema.index({ doctorId: 1, startAt: 1 }, { name: "doctor_timeline" });
appointmentSchema.index({ patientId: 1, startAt: -1 }, { name: "patient_timeline" });
appointmentSchema.index(
  { doctorId: 1, startAt: 1 },
  { name: "doctor_pending_reschedules", partialFilterExpression: { "rescheduleRequest.status": "pending" } }
);

appointmentSchema.index({ status: 1, startAt: 1 }, { name: "upcoming_by_start" });

export const Appointment = model("Appointment", appointmentSchema, "appointments");
