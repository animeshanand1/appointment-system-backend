import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Appointment,
  api,
  createDoctor,
  createPatient,
  nextSunday,
  nextWorkingDate,
  startApp,
  stopApp,
} from "./harness.js";

before(startApp);
after(stopApp);

async function availableSlots(doctorId, date) {
  const res = await api(`/doctors/${doctorId}/slots?date=${date}`);
  assert.equal(res.status, 200);
  return res.body.data.slots.filter((s) => s.status === "available");
}

const book = (cookie, body) => api("/appointments", { method: "POST", cookie, body });

describe("POST /api/appointments", () => {
  let doctor;
  let date;
  let slots;

  beforeEach(async () => {
    doctor = await createDoctor({ fullName: "Dr. Daniel Chen" });
    date = nextWorkingDate();
    slots = await availableSlots(doctor.id, date);
  });

  it("requires a session", async () => {
    const res = await book(undefined, { doctorId: doctor.id, startAt: slots[0].startAt });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHENTICATED");
  });

  it("rejects a forged session cookie", async () => {
    const res = await book("session=not-a-jwt", { doctorId: doctor.id, startAt: slots[0].startAt });
    assert.equal(res.status, 401);
  });

  it("does not let doctors book", async () => {
    const res = await book(doctor.cookie, { doctorId: doctor.id, startAt: slots[0].startAt });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "FORBIDDEN_ROLE");
  });

  it("books an open slot and marks it booked in the grid", async () => {
    const patient = await createPatient();
    const res = await book(patient.cookie, {
      doctorId: doctor.id,
      startAt: slots[2].startAt,
      patientNotes: "  Chest tightness after exercise.  ",
    });

    assert.equal(res.status, 201);
    const appt = res.body.data;
    assert.equal(res.headers.get("location"), `/api/appointments/${appt.id}`);
    assert.equal(appt.status, "booked");
    assert.equal(appt.startAt, slots[2].startAt);
    assert.equal(appt.endAt, slots[2].endAt);
    assert.equal(appt.localDate, date);
    assert.equal(appt.localStartTime, "10:00");
    assert.equal(appt.localEndTime, "10:30");
    assert.equal(appt.timezone, "Asia/Kolkata");
    assert.equal(appt.patientNotes, "Chest tightness after exercise.");
    assert.deepEqual(appt.doctor, {
      id: doctor.id,
      fullName: "Dr. Daniel Chen",
      specialization: "cardiology",
      clinicName: "Test Clinic",
    });
    assert.deepEqual(appt.allowedActions, ["cancel", "request_reschedule"]);

    const grid = await api(`/doctors/${doctor.id}/slots?date=${date}`);
    const slot = grid.body.data.slots.find((s) => s.startAt === slots[2].startAt);
    assert.equal(slot.status, "booked");

    const mine = await api("/appointments/my-appointments", { cookie: patient.cookie });
    assert.deepEqual(mine.body.data.map((a) => a.id), [appt.id]);
  });

  it("stores empty notes as absent", async () => {
    const patient = await createPatient();
    const res = await book(patient.cookie, { doctorId: doctor.id, startAt: slots[0].startAt, patientNotes: "   " });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.patientNotes, null);
  });

  it("replays an identical retry instead of double booking", async () => {
    const patient = await createPatient();
    const body = { doctorId: doctor.id, startAt: slots[0].startAt };
    const first = await book(patient.cookie, body);
    const retry = await book(patient.cookie, body);

    assert.equal(first.status, 201);
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.body.meta, { replayed: true });
    assert.equal(retry.body.data.id, first.body.data.id);
    assert.equal(await Appointment.countDocuments({ doctorId: doctor.id }), 1);
  });

  it("returns SLOT_UNAVAILABLE when another patient holds the slot", async () => {
    const [alice, bob] = await Promise.all([createPatient(), createPatient()]);
    await book(alice.cookie, { doctorId: doctor.id, startAt: slots[0].startAt });
    const res = await book(bob.cookie, { doctorId: doctor.id, startAt: slots[0].startAt });

    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "SLOT_UNAVAILABLE");
  });

  it("lets exactly one of several concurrent requests win the same slot", async () => {
    const patients = await Promise.all(Array.from({ length: 6 }, () => createPatient()));
    const results = await Promise.all(
      patients.map((p) => book(p.cookie, { doctorId: doctor.id, startAt: slots[5].startAt }))
    );

    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409]);
    assert.ok(results.filter((r) => r.status === 409).every((r) => r.body.error.code === "SLOT_UNAVAILABLE"));
    assert.equal(await Appointment.countDocuments({ doctorId: doctor.id, status: "booked" }), 1);
  });

  it("returns PATIENT_TIME_CONFLICT for an overlapping booking with another doctor", async () => {
    const patient = await createPatient();
    const other = await createDoctor({ fullName: "Dr. Other Doctor" });
    const first = await book(patient.cookie, { doctorId: doctor.id, startAt: slots[1].startAt });
    const res = await book(patient.cookie, { doctorId: other.id, startAt: slots[1].startAt });

    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "PATIENT_TIME_CONFLICT");
    assert.equal(res.body.error.details.appointmentId, first.body.data.id);
  });

  it("limits a patient to two upcoming appointments with the same doctor", async () => {
    const patient = await createPatient();
    assert.equal((await book(patient.cookie, { doctorId: doctor.id, startAt: slots[0].startAt })).status, 201);
    assert.equal((await book(patient.cookie, { doctorId: doctor.id, startAt: slots[1].startAt })).status, 201);
    const res = await book(patient.cookie, { doctorId: doctor.id, startAt: slots[2].startAt });

    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, "BOOKING_LIMIT_REACHED");
    assert.deepEqual(res.body.error.details, { limit: 2, scope: "doctor" });
  });

  it("rejects times that are not open slots with SLOT_NOT_BOOKABLE", async () => {
    const patient = await createPatient();
    const offGrid = new Date(new Date(slots[0].startAt).getTime() + 10 * 60 * 1000).toISOString();
    const lunch = `${date}T07:30:00.000Z`; // 13:00 IST
    const sunday = `${nextSunday()}T04:00:00.000Z`;

    for (const startAt of [offGrid, lunch, sunday]) {
      const res = await book(patient.cookie, { doctorId: doctor.id, startAt });
      assert.equal(res.status, 422, startAt);
      assert.equal(res.body.error.code, "SLOT_NOT_BOOKABLE", startAt);
    }
  });

  it("rejects bookings with a paused doctor", async () => {
    const patient = await createPatient();
    const paused = await createDoctor({ accepting: false });
    const res = await book(patient.cookie, { doctorId: paused.id, startAt: slots[0].startAt });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, "DOCTOR_NOT_ACCEPTING");
  });

  it("returns 404 for an unknown doctor", async () => {
    const patient = await createPatient();
    const res = await book(patient.cookie, { doctorId: "0123456789abcdef01234567", startAt: slots[0].startAt });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "DOCTOR_NOT_FOUND");
  });

  it("validates the request body strictly", async () => {
    const patient = await createPatient();
    const valid = { doctorId: doctor.id, startAt: slots[0].startAt };
    const cases = [
      [{ ...valid, fullName: "Sarah" }, ""],
      [{ ...valid, patientNotes: "x".repeat(501) }, "patientNotes"],
      [{ ...valid, startAt: "2026-09-21T05:02:00.000Z" }, "startAt"],
      [{ ...valid, startAt: "tomorrow" }, "startAt"],
      [{ ...valid, doctorId: "abc" }, "doctorId"],
      [{ startAt: valid.startAt }, "doctorId"],
    ];
    for (const [body, path] of cases) {
      const res = await book(patient.cookie, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error.code, "VALIDATION_FAILED");
      assert.ok(res.body.error.details.some((d) => d.path === path), JSON.stringify(res.body.error.details));
    }
    assert.equal(await Appointment.countDocuments({ patientId: patient.id }), 0);
  });

  it("refuses cross-origin writes", async () => {
    const patient = await createPatient();
    const res = await api("/appointments", {
      method: "POST",
      cookie: patient.cookie,
      headers: { Origin: "https://evil.example" },
      body: { doctorId: doctor.id, startAt: slots[0].startAt },
    });
    assert.equal(res.status, 403);
  });
});
