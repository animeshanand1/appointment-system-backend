// Pure status state machine: (appointment, actor, targetStatus, now) -> allowed | rejection code.
// No I/O, no clock reads. See docs/architecture/03-core-algorithms.md §3.3.
import { addMinutes } from "../../lib/time.js";

const NO_SHOW_GRACE_MINUTES = 10;
const DOCTOR_REASON_MIN_LENGTH = 5;

const ACTIONS = { cancel: "cancelled", complete: "completed", no_show: "no_show" };

const allow = { allowed: true };
const reject = (code) => ({ allowed: false, code });

/**
 * @param appointment { status, startAt, endAt }
 * @param actor { role: "patient" | "doctor" } (ownership is enforced by the owner-scoped load)
 * @param targetStatus "cancelled" | "completed" | "no_show"
 * @param now Date
 * @param request { reason } from the PATCH body
 * @returns { allowed: true, unchanged?: true } | { allowed: false, code }
 */
export function checkStatusTransition(appointment, actor, targetStatus, now, { reason } = {}) {
  if (appointment.status !== "booked") {
    return appointment.status === targetStatus ? { allowed: true, unchanged: true } : reject("INVALID_STATUS_TRANSITION");
  }

  if (targetStatus === "cancelled") {
    if (actor.role === "patient") return now < appointment.startAt ? allow : reject("CANCELLATION_CLOSED");
    if (now >= appointment.endAt) return reject("CANCELLATION_CLOSED");
    return (reason?.trim().length ?? 0) >= DOCTOR_REASON_MIN_LENGTH ? allow : reject("REASON_REQUIRED");
  }

  if (targetStatus === "completed") {
    if (actor.role !== "doctor") return reject("FORBIDDEN_TRANSITION");
    return now >= appointment.startAt ? allow : reject("TRANSITION_TOO_EARLY");
  }

  if (targetStatus === "no_show") {
    if (actor.role !== "doctor") return reject("FORBIDDEN_TRANSITION");
    return now >= addMinutes(appointment.startAt, NO_SHOW_GRACE_MINUTES) ? allow : reject("TRANSITION_TOO_EARLY");
  }

  return reject("INVALID_STATUS_TRANSITION");
}

const RESCHEDULE_ACTIONS = [
  "reschedule", // doctor moves the appointment directly
  "request_reschedule", // patient proposes a new slot (creates or replaces the pending request)
  "withdraw_reschedule", // patient withdraws their pending request
  "approve_reschedule", // doctor accepts the pending request, which moves the appointment
  "reject_reschedule", // doctor declines the pending request
];

const PATIENT_RESCHEDULE_ACTIONS = new Set(["request_reschedule", "withdraw_reschedule"]);

/**
 * Rescheduling rules. The doctor has the final say: a patient can only ask,
 * and the move happens when the doctor approves (or moves it themselves).
 * Whether the target slot is open is checked separately against the slot grid.
 *
 * @param appointment { status, startAt, endAt, rescheduleRequest? }
 * @param actor { role }
 * @param action one of RESCHEDULE_ACTIONS
 * @returns { allowed: true } | { allowed: false, code }
 */
export function checkRescheduleAction(appointment, actor, action, now, { reason } = {}) {
  if (appointment.status !== "booked") return reject("INVALID_STATUS_TRANSITION");

  const isPatientAction = PATIENT_RESCHEDULE_ACTIONS.has(action);
  if ((actor.role === "patient") !== isPatientAction) return reject("FORBIDDEN_TRANSITION");

  const hasPending = appointment.rescheduleRequest?.status === "pending";

  switch (action) {
    case "request_reschedule":
      return now < appointment.startAt ? allow : reject("RESCHEDULE_CLOSED");
    case "withdraw_reschedule":
    case "reject_reschedule":
      return hasPending ? allow : reject("RESCHEDULE_NOT_PENDING");
    case "approve_reschedule":
      if (!hasPending) return reject("RESCHEDULE_NOT_PENDING");
      return now < appointment.endAt ? allow : reject("RESCHEDULE_CLOSED");
    case "reschedule":
      if (now >= appointment.endAt) return reject("RESCHEDULE_CLOSED");
      return (reason?.trim().length ?? 0) >= DOCTOR_REASON_MIN_LENGTH ? allow : reject("REASON_REQUIRED");
    default:
      return reject("INVALID_STATUS_TRANSITION");
  }
}

// The actions the UI may offer right now. A doctor's missing reason is an
// input problem, not a reason to hide the action.
export function allowedActions(appointment, actor, now) {
  const offer = (result) => (result.allowed && !result.unchanged) || result.code === "REASON_REQUIRED";

  const statusActions = Object.entries(ACTIONS)
    .filter(([, targetStatus]) => offer(checkStatusTransition(appointment, actor, targetStatus, now)))
    .map(([action]) => action);
  const rescheduleActions = RESCHEDULE_ACTIONS.filter((action) =>
    offer(checkRescheduleAction(appointment, actor, action, now))
  );
  return [...statusActions, ...rescheduleActions];
}
