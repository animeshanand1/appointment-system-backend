// Emails patients a reminder about a day before each appointment. Runs inside
// the API process on a timer; each appointment is claimed with an atomic update
// first, so several instances never send the same reminder twice.
import mongoose from "mongoose";
import { Appointment } from "../db/models/index.js";
import { logger } from "../lib/logger.js";
import { sendReminder } from "../modules/notifications/notifications.service.js";

const { trusted } = mongoose;
const HOUR_MS = 60 * 60 * 1000;
const INTERVAL_MS = 5 * 60 * 1000;
const BATCH = 200;
// Appointments booked this close to their start already got a confirmation.
const MIN_LEAD_MS = 20 * HOUR_MS;

export async function sendDueReminders(now = new Date()) {
  const due = await Appointment.find({
    status: "booked",
    startAt: trusted({ $gt: new Date(now.getTime() + HOUR_MS), $lte: new Date(now.getTime() + 24 * HOUR_MS) }),
    $expr: trusted({
      $and: [
        { $ne: ["$reminderSentFor", "$startAt"] },
        { $lte: ["$createdAt", { $subtract: ["$startAt", MIN_LEAD_MS] }] },
      ],
    }),
  })
    .select("_id startAt reminderSentFor")
    .limit(BATCH)
    .lean();

  let sent = 0;
  for (const candidate of due) {
    const claimed = await Appointment.findOneAndUpdate(
      { _id: candidate._id, status: "booked", startAt: candidate.startAt, reminderSentFor: candidate.reminderSentFor ?? null },
      { $set: { reminderSentFor: candidate.startAt } },
      { new: true }
    )
      .populate("patientId", "fullName email isActive")
      .populate("doctorId", "fullName email isActive")
      .lean();
    if (!claimed) continue;
    try {
      await sendReminder(claimed);
      sent += 1;
    } catch (err) {
      // Release the claim so the next run retries.
      await Appointment.updateOne({ _id: claimed._id }, { $unset: { reminderSentFor: "" } });
      logger.error({ err, appointmentId: String(claimed._id) }, "Reminder failed");
    }
  }
  return sent;
}

export function startReminderJob() {
  const run = () => sendDueReminders().catch((err) => logger.error({ err }, "Reminder run failed"));
  const timer = setInterval(run, INTERVAL_MS);
  timer.unref();
  run();
  return () => clearInterval(timer);
}
