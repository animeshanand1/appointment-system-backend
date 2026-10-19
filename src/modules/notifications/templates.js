// Email bodies. Every value inserted into HTML is escaped; the text version is
// what most clients show in previews.
import { env } from "../../config/env.js";

const BRAND = "Dr Sahayak";

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function formatWhen({ localDate, localStartTime, timezone }) {
  const [y, m, d] = localDate.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return `${day} at ${localStartTime} (${timezone.replace(/_/g, " ")})`;
}

function layout({ heading, paragraphs, action }) {
  const text = [heading, "", ...paragraphs, ...(action ? ["", `${action.label}: ${action.url}`] : []), "", `— ${BRAND}`].join("\n");
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#13211e;line-height:1.5">
<h2 style="font-weight:normal">${escapeHtml(heading)}</h2>
${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n")}
${action ? `<p><a href="${escapeHtml(action.url)}" style="background:#0b6e62;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${escapeHtml(action.label)}</a></p>` : ""}
<p style="color:#69736f;font-size:13px">${BRAND}. You're receiving this because of activity on your account.</p>
</body></html>`;
  return { text, html };
}

const appointmentsUrl = () => `${env.APP_ORIGIN}/dashboard/appointments`;

export function appointmentBooked({ appointment, patient, doctor }) {
  return {
    patient: {
      subject: `Appointment confirmed with ${doctor.fullName}`,
      ...layout({
        heading: `Your appointment is booked, ${patient.fullName}`,
        paragraphs: [`${doctor.fullName}, ${formatWhen(appointment)}.`, "You can move or cancel it from your account."],
        action: { label: "View my appointments", url: appointmentsUrl() },
      }),
    },
    doctor: {
      subject: `New booking: ${patient.fullName}, ${appointment.localDate} ${appointment.localStartTime}`,
      ...layout({
        heading: "New appointment booked",
        paragraphs: [`${patient.fullName} booked ${formatWhen(appointment)}.`],
        action: { label: "Open my agenda", url: `${env.APP_ORIGIN}/dashboard` },
      }),
    },
  };
}

export function appointmentCancelled({ appointment, patient, doctor, recipient }) {
  const reason = appointment.cancellation?.reason;
  const toPatient = recipient === "patient";
  return {
    subject: `Appointment cancelled: ${appointment.localDate} ${appointment.localStartTime}`,
    ...layout({
      heading: "An appointment was cancelled",
      paragraphs: [
        toPatient
          ? `Your appointment with ${doctor.fullName} on ${formatWhen(appointment)} was cancelled by the doctor.`
          : `${patient.fullName} cancelled their appointment on ${formatWhen(appointment)}.`,
        ...(reason ? [`Reason: ${reason}`] : []),
        ...(toPatient ? ["You can book another time from your account."] : []),
      ],
      action: { label: toPatient ? "Book again" : "Open my agenda", url: toPatient ? `${env.APP_ORIGIN}/book` : `${env.APP_ORIGIN}/dashboard` },
    }),
  };
}

export function appointmentMoved({ appointment, doctor, reason }) {
  return {
    subject: `Appointment moved to ${appointment.localDate} ${appointment.localStartTime}`,
    ...layout({
      heading: "Your appointment has a new time",
      paragraphs: [`${doctor.fullName} is now seeing you on ${formatWhen(appointment)}.`, ...(reason ? [`Note: ${reason}`] : [])],
      action: { label: "View my appointments", url: appointmentsUrl() },
    }),
  };
}

export function rescheduleRequested({ appointment, patient }) {
  const request = appointment.rescheduleRequest;
  return {
    subject: `Reschedule request from ${patient.fullName}`,
    ...layout({
      heading: "A patient asked to move an appointment",
      paragraphs: [
        `${patient.fullName} would like to move ${formatWhen(appointment)} to ${formatWhen({ ...request, timezone: appointment.timezone })}.`,
        ...(request.reason ? [`Reason: ${request.reason}`] : []),
      ],
      action: { label: "Review the request", url: `${env.APP_ORIGIN}/dashboard` },
    }),
  };
}

export function rescheduleDecided({ appointment, doctor, approved }) {
  const note = appointment.rescheduleRequest?.decisionNote;
  return {
    subject: approved ? "Your reschedule request was approved" : "Your reschedule request was declined",
    ...layout({
      heading: approved ? "Request approved" : "Request declined",
      paragraphs: [
        approved
          ? `${doctor.fullName} approved your request. Your appointment is now on ${formatWhen(appointment)}.`
          : `${doctor.fullName} couldn't move your appointment. It stays on ${formatWhen(appointment)}.`,
        ...(note ? [`Note from the doctor: ${note}`] : []),
      ],
      action: { label: "View my appointments", url: appointmentsUrl() },
    }),
  };
}

export function appointmentReminder({ appointment, patient, doctor }) {
  return {
    subject: `Reminder: ${doctor.fullName} tomorrow at ${appointment.localStartTime}`,
    ...layout({
      heading: `See you soon, ${patient.fullName}`,
      paragraphs: [
        `This is a reminder of your appointment with ${doctor.fullName} on ${formatWhen(appointment)}.`,
        "If you can't make it, please cancel or move it so someone else can take the slot.",
      ],
      action: { label: "Manage appointment", url: appointmentsUrl() },
    }),
  };
}

export function passwordReset({ user, url, minutes }) {
  return {
    subject: "Reset your Dr Sahayak password",
    ...layout({
      heading: `Password reset for ${user.fullName}`,
      paragraphs: [
        `Someone asked to reset the password for this account. The link works once and expires in ${minutes} minutes.`,
        "If it wasn't you, ignore this email; your password stays the same.",
      ],
      action: { label: "Choose a new password", url },
    }),
  };
}

export function passwordChanged({ user }) {
  return {
    subject: "Your Dr Sahayak password was changed",
    ...layout({
      heading: `Password changed, ${user.fullName}`,
      paragraphs: [
        "The password for your account was just changed, and other devices were signed out.",
        "If you didn't do this, reset your password straight away and contact the hospital.",
      ],
      action: { label: "Reset password", url: `${env.APP_ORIGIN}/forgot-password` },
    }),
  };
}
