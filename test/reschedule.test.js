import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Appointment, api, createDoctor, createPatient, nextWorkingDate, startApp, stopApp } from "./harness.js";

before(startApp);
after(stopApp);

async function availableSlots(doctorId, date) {
  const res = await api(`/doctors/${doctorId}/slots?date=${date}`);
  assert.equal(res.status, 200);
  return res.body.data.slots.filter((s) => s.status === "available");
}

async function slotStatus(doctorId, date, startAt) {
  const res = await api(`/doctors/${doctorId}/slots?date=${date}`);
  return res.body.data.slots.find((s) => s.startAt === startAt)?.status;
}

const book = (cookie, body) => api("/appointments", { method: "POST", cookie, body });
const reschedule = (cookie, id, body) => api(`/appointments/${id}/reschedule`, { method: "PATCH", cookie, body });
const requestMove = (cookie, id, body) => api(`/appointments/${id}/reschedule-request`, { method: "PUT", cookie, body });
const withdraw = (cookie, id) => api(`/appointments/${id}/reschedule-request`, { method: "DELETE", cookie });
const decide = (cookie, id, body) =>
  api(`/appointments/${id}/reschedule-request/decision`, { method: "POST", cookie, body });

describe("rescheduling", () => {
  let doctor;
  let patient;
  let date;
  let slots;
  let appt;

  beforeEach(async () => {
    doctor = await createDoctor();
    patient = await createPatient();
    date = nextWorkingDate();
    slots = await availableSlots(doctor.id, date);
    const res = await book(patient.cookie, { doctorId: doctor.id, startAt: slots[0].startAt });
    assert.equal(res.status, 201);
    appt = res.body.data;
  });

  describe("doctor moves directly (PATCH /:id/reschedule)", () => {
    it("moves the appointment, frees the old slot and records history", async () => {
      const res = await reschedule(doctor.cookie, appt.id, { startAt: slots[3].startAt, reason: "Clinic running late" });

      assert.equal(res.status, 200);
      const moved = res.body.data;
      assert.equal(moved.id, appt.id);
      assert.equal(moved.status, "booked");
      assert.equal(moved.startAt, slots[3].startAt);
      assert.equal(moved.endAt, slots[3].endAt);
      assert.equal(moved.localStartTime, "10:30");
      assert.deepEqual(moved.rescheduleHistory, [
        {
          fromStartAt: slots[0].startAt,
          fromEndAt: slots[0].endAt,
          toStartAt: slots[3].startAt,
          toEndAt: slots[3].endAt,
          at: moved.rescheduleHistory[0].at,
          initiatedBy: "doctor",
          reason: "Clinic running late",
        },
      ]);

      assert.equal(await slotStatus(doctor.id, date, slots[0].startAt), "available");
      assert.equal(await slotStatus(doctor.id, date, slots[3].startAt), "booked");

      const seenByPatient = await api(`/appointments/${appt.id}`, { cookie: patient.cookie });
      assert.equal(seenByPatient.body.data.startAt, slots[3].startAt);
    });

    it("requires a reason", async () => {
      const res = await reschedule(doctor.cookie, appt.id, { startAt: slots[3].startAt, reason: "no" });
      assert.equal(res.status, 422);
      assert.equal(res.body.error.code, "REASON_REQUIRED");
    });

    it("is doctor-only", async () => {
      const res = await reschedule(patient.cookie, appt.id, { startAt: slots[3].startAt, reason: "Want a later time" });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "FORBIDDEN_ROLE");
    });

    it("returns 404 for another doctor's appointment", async () => {
      const other = await createDoctor();
      const res = await reschedule(other.cookie, appt.id, { startAt: slots[3].startAt, reason: "Not my patient" });
      assert.equal(res.status, 404);
    });

    it("refuses a slot another patient holds", async () => {
      const other = await createPatient();
      await book(other.cookie, { doctorId: doctor.id, startAt: slots[3].startAt });
      const res = await reschedule(doctor.cookie, appt.id, { startAt: slots[3].startAt, reason: "Clinic running late" });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "SLOT_UNAVAILABLE");
    });

    it("refuses off-grid times and the current time", async () => {
      const lunch = `${date}T07:30:00.000Z`; // 13:00 IST
      const offGrid = await reschedule(doctor.cookie, appt.id, { startAt: lunch, reason: "Clinic running late" });
      assert.equal(offGrid.status, 422);
      assert.equal(offGrid.body.error.code, "SLOT_NOT_BOOKABLE");

      const same = await reschedule(doctor.cookie, appt.id, { startAt: slots[0].startAt, reason: "Clinic running late" });
      assert.equal(same.status, 422);
      assert.deepEqual(same.body.error.details, { reason: "UNCHANGED" });
    });

    it("refuses cancelled appointments", async () => {
      await api(`/appointments/${appt.id}/status`, { method: "PATCH", cookie: patient.cookie, body: { status: "cancelled" } });
      const res = await reschedule(doctor.cookie, appt.id, { startAt: slots[3].startAt, reason: "Clinic running late" });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "INVALID_STATUS_TRANSITION");
    });

    it("supersedes a pending patient request", async () => {
      await requestMove(patient.cookie, appt.id, { startAt: slots[4].startAt });
      const res = await reschedule(doctor.cookie, appt.id, { startAt: slots[6].startAt, reason: "Offering this instead" });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.startAt, slots[6].startAt);
      assert.equal(res.body.data.rescheduleRequest.status, "superseded");
    });
  });

  describe("patient requests, doctor decides", () => {
    it("creates a pending request without moving the appointment", async () => {
      const res = await requestMove(patient.cookie, appt.id, { startAt: slots[4].startAt, reason: "Work meeting" });

      assert.equal(res.status, 200);
      const data = res.body.data;
      assert.equal(data.startAt, slots[0].startAt);
      assert.equal(data.rescheduleRequest.status, "pending");
      assert.equal(data.rescheduleRequest.startAt, slots[4].startAt);
      assert.equal(data.rescheduleRequest.reason, "Work meeting");
      assert.deepEqual(data.allowedActions, ["cancel", "request_reschedule", "withdraw_reschedule"]);

      // The requested slot isn't held.
      assert.equal(await slotStatus(doctor.id, date, slots[4].startAt), "available");

      const inbox = await api("/appointments/my-appointments?reschedule=pending", { cookie: doctor.cookie });
      assert.deepEqual(inbox.body.data.map((a) => a.id), [appt.id]);
      assert.deepEqual(inbox.body.data[0].allowedActions, [
        "cancel",
        "reschedule",
        "approve_reschedule",
        "reject_reschedule",
      ]);
    });

    it("treats an identical retry as a no-op", async () => {
      await requestMove(patient.cookie, appt.id, { startAt: slots[4].startAt });
      const retry = await requestMove(patient.cookie, appt.id, { startAt: slots[4].startAt });
      assert.equal(retry.status, 200);
      assert.deepEqual(retry.body.meta, { unchanged: true });
    });

    it("moves the appointment when the doctor approves", async () => {
      const req = await requestMove(patient.cookie, appt.id, { startAt: slots[4].startAt, reason: "Work meeting" });
      const res = await decide(doctor.cookie, appt.id, {
        requestId: req.body.data.rescheduleRequest.id,
        decision: "approve",
        note: "See you then",
      });

      assert.equal(res.status, 200);
      const data = res.body.data;
      assert.equal(data.startAt, slots[4].startAt);
      assert.equal(data.rescheduleRequest.status, "approved");
      assert.equal(data.rescheduleRequest.decidedByRole, "doctor");
      assert.equal(data.rescheduleRequest.decisionNote, "See you then");
      assert.equal(data.rescheduleHistory[0].initiatedBy, "patient");
      assert.equal(data.rescheduleHistory[0].reason, "Work meeting");
      assert.equal(await slotStatus(doctor.id, date, slots[0].startAt), "available");
      assert.equal(await slotStatus(doctor.id, date, slots[4].startAt), "booked");
    });

    it("keeps the original time when the doctor rejects", async () => {
      const req = await requestMove(patient.cookie, appt.id, { startAt: slots[4].startAt });
      const res = await decide(doctor.cookie, appt.id, {
        requestId: req.body.data.rescheduleRequest.id,
        decision: "reject",
        note: "Fully booked that morning",
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.startAt, slots[0].startAt);
      assert.equal(res.body.data.rescheduleRequest.status, "rejected");
      assert.equal(res.body.data.rescheduleRequest.decisionNote, "Fully booked that morning");
      assert.deepEqual(res.body.data.rescheduleHistory, []);
    });

    it("refuses a decision on a request the patient has since replaced", async () => {
      const first = await requestMove(patient.cookie, appt.id, { startAt: slots[4].startAt });
      await requestMove(patient.cookie, appt.id, { startAt: slots[5].startAt });
      const res = await decide(doctor.cookie, appt.id, {
        requestId: first.body.data.rescheduleRequest.id,
        decision: "approve",
      });

      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "RESCHEDULE_NOT_PENDING");
      const current = await api(`/appointments/${appt.id}`, { cookie: doctor.cookie });
      assert.equal(current.body.data.startAt, slots[0].startAt);
    });

    it("keeps the request pending if its slot was taken before approval", async () => {
      const req = await requestMove(patient.cookie, appt.id, { startAt: slots[4].startAt });
      const other = await createPatient();
      await book(other.cookie, { doctorId: doctor.id, startAt: slots[4].startAt });

      const res = await decide(doctor.cookie, appt.id, { requestId: req.body.data.rescheduleRequest.id, decision: "approve" });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "SLOT_UNAVAILABLE");

      const current = await api(`/appointments/${appt.id}`, { cookie: doctor.cookie });
      assert.equal(current.body.data.rescheduleRequest.status, "pending");
      assert.equal(current.body.data.startAt, slots[0].startAt);
    });

    it("lets the patient withdraw", async () => {
      await requestMove(patient.cookie, appt.id, { startAt: slots[4].startAt });
      const res = await withdraw(patient.cookie, appt.id);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.rescheduleRequest.status, "withdrawn");

      const again = await withdraw(patient.cookie, appt.id);
      assert.equal(again.status, 409);
      assert.equal(again.body.error.code, "RESCHEDULE_NOT_PENDING");
    });

    it("rejects a request that clashes with the patient's other appointment", async () => {
      const otherDoctor = await createDoctor();
      await book(patient.cookie, { doctorId: otherDoctor.id, startAt: slots[4].startAt });
      const res = await requestMove(patient.cookie, appt.id, { startAt: slots[4].startAt });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "PATIENT_TIME_CONFLICT");
    });

    it("keeps each side to its own endpoints", async () => {
      const asDoctor = await requestMove(doctor.cookie, appt.id, { startAt: slots[4].startAt });
      assert.equal(asDoctor.status, 403);
      const req = await requestMove(patient.cookie, appt.id, { startAt: slots[4].startAt });
      const asPatient = await decide(patient.cookie, appt.id, {
        requestId: req.body.data.rescheduleRequest.id,
        decision: "approve",
      });
      assert.equal(asPatient.status, 403);
    });

    it("closes a pending request when the appointment is cancelled", async () => {
      await requestMove(patient.cookie, appt.id, { startAt: slots[4].startAt });
      const res = await api(`/appointments/${appt.id}/status`, {
        method: "PATCH",
        cookie: patient.cookie,
        body: { status: "cancelled" },
      });
      assert.equal(res.body.data.rescheduleRequest.status, "superseded");
      assert.equal(res.body.data.rescheduleRequest.decidedByRole, "system");
    });

    it("refuses requests once the appointment has started", async () => {
      const start = new Date(Date.now() - 5 * 60 * 1000);
      start.setUTCSeconds(0, 0);
      start.setUTCMinutes(start.getUTCMinutes() - (start.getUTCMinutes() % 5));
      await Appointment.updateOne(
        { _id: appt.id },
        { $set: { startAt: start, endAt: new Date(start.getTime() + 30 * 60 * 1000) } }
      );

      const res = await requestMove(patient.cookie, appt.id, { startAt: slots[4].startAt });
      assert.equal(res.status, 422);
      assert.equal(res.body.error.code, "RESCHEDULE_CLOSED");
    });
  });
});
