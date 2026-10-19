import mongoose from "mongoose";

const { Schema, model } = mongoose;

// See docs/architecture/02-data-model.md §2.3
const timeOffSchema = new Schema(
  {
    doctorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    startAt: { type: Date, required: true }, // UTC, inclusive
    endAt: { type: Date, required: true }, // UTC, exclusive
    reason: { type: String, maxlength: 200 },
  },
  { timestamps: true, strict: "throw" }
);

timeOffSchema.index({ doctorId: 1, startAt: 1, endAt: 1 }, { name: "doctor_timeoff_range" });

export const TimeOff = model("TimeOff", timeOffSchema, "time_off");
