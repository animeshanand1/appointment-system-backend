import mongoose from "mongoose";

const { Schema, model } = mongoose;

const breakSchema = new Schema(
  {
    start: { type: String, required: true }, // HH:mm
    end: { type: String, required: true },
  },
  { _id: false }
);

const dayScheduleSchema = new Schema(
  {
    isoWeekday: { type: Number, required: true, min: 1, max: 7 }, // 1 = Monday ... 7 = Sunday
    isWorking: { type: Boolean, required: true },
    shiftStart: { type: String },
    shiftEnd: { type: String },
    breaks: { type: [breakSchema], default: [] },
  },
  { _id: false }
);

const doctorAvailabilitySchema = new Schema(
  {
    doctorId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    timezone: { type: String, required: true }, // Ist Kolkata
    slotDurationMinutes: { type: Number, required: true, enum: [10, 15, 20, 30, 45, 60] },
    weeklySchedule: {
      type: [dayScheduleSchema],
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length === 7,
        message: "weeklySchedule must contain exactly 7 entries",
      },
    },
    bookingPolicy: {
      horizonDays: { type: Number, default: 30, min: 1, max: 90 },
      minNoticeMinutes: { type: Number, default: 60, min: 0, max: 1440 },
      lateCancelWindowMinutes: { type: Number, default: 240, min: 0, max: 10080 },
    },
    revision: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, strict: "throw" }
);

export const DoctorAvailability = model("DoctorAvailability", doctorAvailabilitySchema, "doctor_availability");
