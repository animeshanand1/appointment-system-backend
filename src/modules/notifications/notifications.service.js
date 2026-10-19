// Sends the emails that follow appointment and account events. Delivery never
// blocks or fails the request that triggered it: messages are queued after the
// response and failures are only logged.
import { Appointment } from "../../db/models/index.js";
import { logger } from "../../lib/logger.js";
import { sendMail } from "../../lib/mailer.js";
import * as templates from "./templates.js";

const pending = new Set();

function deliver(task) {
  const job = new Promise((resolve) => setImmediate(resolve))
    .then(task)
    .catch((err) => logger.error({ err }, "Notification failed"))
    .finally(() => pending.delete(job));
  pending.add(job);
}

// For tests and graceful shutdown: wait until queued emails are handed over.
export async function flushNotifications() {
  while (pending.size) await Promise.all([...pending]);
}

const PARTY_FIELDS = "fullName email isActive";

async function loadAppointment(appointmentId) {
  return Appointment.findById(appointmentId)
    .populate("patientId", PARTY_FIELDS)
    .populate("doctorId", PARTY_FIELDS)
    .lean();
}

async function send(user, message) {
  // Deactivated accounts get no mail.
  if (!user?.email || user.isActive === false) return;
  await sendMail({ to: user.email, subject: message.subject, text: message.text, html: message.html });
}

/**
 * @param event "booked" | "cancelled" | "moved" | "reschedule_requested" | "reschedule_decided"
 * @param appointmentId
 * @param extra { reason?, approved? }
 */
export function notifyAppointment(event, appointmentId, extra = {}) {
  deliver(async () => {
    const appointment = await loadAppointment(appointmentId);
    if (!appointment) return;
    const patient = appointment.patientId;
    const doctor = appointment.doctorId;
    const ctx = { appointment, patient, doctor, ...extra };

    switch (event) {
      case "booked": {
        const message = templates.appointmentBooked(ctx);
        await send(patient, message.patient);
        await send(doctor, message.doctor);
        break;
      }
      case "cancelled": {
        // Tell the other side; "system" cancellations go to the patient.
        const recipient = appointment.cancellation?.byRole === "patient" ? "doctor" : "patient";
        await send(recipient === "patient" ? patient : doctor, templates.appointmentCancelled({ ...ctx, recipient }));
        break;
      }
      case "moved":
        await send(patient, templates.appointmentMoved(ctx));
        break;
      case "reschedule_requested":
        await send(doctor, templates.rescheduleRequested(ctx));
        break;
      case "reschedule_decided":
        await send(patient, templates.rescheduleDecided(ctx));
        break;
      default:
        logger.warn({ event }, "Unknown notification event");
    }
  });
}

export function notifyPasswordReset(user, url, minutes) {
  deliver(() => send(user, templates.passwordReset({ user, url, minutes })));
}

export function notifyPasswordChanged(user) {
  deliver(() => send(user, templates.passwordChanged({ user })));
}

export async function sendReminder(appointment) {
  await send(appointment.patientId, templates.appointmentReminder({
    appointment,
    patient: appointment.patientId,
    doctor: appointment.doctorId,
  }));
}
