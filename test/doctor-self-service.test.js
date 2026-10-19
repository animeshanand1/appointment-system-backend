import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import {
  Appointment,
  Doctor,
  MON_SAT_9_TO_6,
  TZ,
  api,
  createDoctor,
  createPatient,
  nextWorkingDate,
  startApp,
  stopApp,
} from "./harness.js";

before(startApp);
after(stopApp);

const POLICY = { horizonDays: 30, minNoticeMinutes: 60, lateCancelWindowMinutes: 240 };

const schedulePayload = (overrides = {}) => ({
  revision: null,
  timezone: TZ,
  slotDurationMinutes: 30,
  bookingPolicy: POLICY,
  weeklySchedule: MON_SAT_9_TO_6,
  ...overrides,
});

const workingDay = (isoWeekday, shiftStart, shiftEnd, breaks = []) => ({
  isoWeekday,
  isWorking: true,
  shiftStart,
  shiftEnd,
  breaks,
});

const weekWith = (fn) => MON_SAT_9_TO_6.map((day) => fn(day) ?? day);

const putAvailability = (cookie, body) => api("/doctors/me/availability", { method: "PUT", cookie, body });
const dayAfter = (date) => DateTime.fromISO(date).plus({ days: 1 }).toISODate();

async function bookFirstSlot(doctor, patient, date, index = 2) {
  const grid = await api(`/doctors/${doctor.id}/slots?date=${date}`);
  const slot = grid.body.data.slots.filter((s) => s.status === "available")[index];
  const res = await api("/appointments", {
    method: "POST",
    cookie: patient.cookie,
    body: { doctorId: doctor.id, startAt: slot.startAt },
  });
  assert.equal(res.status, 201);
  return res.body.data;
}

describe("access control", () => {
  it("requires a session and the doctor role on every self-service route", async () => {
    const patient = await createPatient();
    const routes = [
      ["GET", "/doctors/me/availability"],
      ["PUT", "/doctors/me/availability", schedulePayload()],
      ["PATCH", "/doctors/me/profile", { bio: "x" }],
      ["GET", "/doctors/me/time-off"],
      ["POST", "/doctors/me/time-off", { startLocal: "2030-01-01T09:00", endLocal: "2030-01-01T10:00" }],
      ["DELETE", "/doctors/me/time-off/0123456789abcdef01234567"],
    ];
    for (const [method, path, body] of routes) {
      const anonymous = await api(path, { method, body });
      assert.equal(anonymous.status, 401, `${method} ${path}`);
      const asPatient = await api(path, { method, body, cookie: patient.cookie });
      assert.equal(asPatient.status, 403, `${method} ${path}`);
      assert.equal(asPatient.body.error.code, "FORBIDDEN_ROLE");
    }
  });
});

describe("GET /api/doctors/me/availability", () => {
  it("returns null before the first save", async () => {
    const doctor = await createDoctor({ withAvailability: false });
    const res = await api("/doctors/me/availability", { cookie: doctor.cookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.data, null);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("returns the stored schedule with all seven days in order", async () => {
    const doctor = await createDoctor();
    const res = await api("/doctors/me/availability", { cookie: doctor.cookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.revision, 0);
    assert.equal(res.body.data.timezone, TZ);
    assert.equal(res.body.data.slotDurationMinutes, 30);
    assert.deepEqual(res.body.data.bookingPolicy, POLICY);
    assert.deepEqual(res.body.data.weeklySchedule.map((d) => d.isoWeekday), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(res.body.data.weeklySchedule[0], workingDay(1, "09:00", "18:00", [{ start: "13:00", end: "14:00" }]));
    assert.deepEqual(res.body.data.weeklySchedule[6], { isoWeekday: 7, isWorking: false, breaks: [] });
  });
});

describe("PUT /api/doctors/me/availability", () => {
  it("creates the first schedule, opens bookings and makes slots appear", async () => {
    const doctor = await createDoctor({ withAvailability: false, accepting: false });

    const res = await putAvailability(doctor.cookie, schedulePayload());
    assert.equal(res.status, 200);
    assert.equal(res.body.data.revision, 1);
    assert.deepEqual(res.body.meta.outOfHoursBookings, []);

    const stored = await Doctor.findById(doctor.id).lean();
    assert.equal(stored.doctorProfile.isAcceptingAppointments, true);

    const grid = await api(`/doctors/${doctor.id}/slots?date=${nextWorkingDate()}`);
    assert.equal(grid.body.data.slots.length, 16);
  });

  it("replaces an existing schedule, bumps the revision and changes the grid", async () => {
    const doctor = await createDoctor();
    const shorter = weekWith((day) => (day.isWorking ? workingDay(day.isoWeekday, "10:00", "12:00") : null));

    const res = await putAvailability(
      doctor.cookie,
      schedulePayload({ revision: 0, slotDurationMinutes: 60, weeklySchedule: shorter })
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.data.revision, 1);
    assert.equal(res.body.data.slotDurationMinutes, 60);

    const grid = await api(`/doctors/${doctor.id}/slots?date=${nextWorkingDate()}`);
    assert.deepEqual(grid.body.data.slots.map((s) => s.slotStartTime), ["10:00", "11:00"]);
  });

  it("does not turn bookings back on for a doctor who paused them", async () => {
    const doctor = await createDoctor({ accepting: false });
    const res = await putAvailability(doctor.cookie, schedulePayload({ revision: 0 }));
    assert.equal(res.status, 200);
    const stored = await Doctor.findById(doctor.id).lean();
    assert.equal(stored.doctorProfile.isAcceptingAppointments, false);
  });

  it("rejects a stale revision and reports the current one", async () => {
    const doctor = await createDoctor();
    const first = await putAvailability(doctor.cookie, schedulePayload({ revision: 0 }));
    assert.equal(first.status, 200);

    const stale = await putAvailability(doctor.cookie, schedulePayload({ revision: 0 }));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "STALE_REVISION");
    assert.equal(stale.body.error.details.currentRevision, 1);
  });

  it("rejects a first-save form (revision null) when a schedule already exists", async () => {
    const doctor = await createDoctor();
    const res = await putAvailability(doctor.cookie, schedulePayload({ revision: null }));
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "STALE_REVISION");
    assert.equal(res.body.error.details.currentRevision, 0);
  });

  it("lets only one of two concurrent saves from the same revision win", async () => {
    const doctor = await createDoctor();
    const results = await Promise.all([
      putAvailability(doctor.cookie, schedulePayload({ revision: 0, slotDurationMinutes: 15 })),
      putAvailability(doctor.cookie, schedulePayload({ revision: 0, slotDurationMinutes: 20 })),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  });

  it("drops stale shift times from days marked as not working", async () => {
    const doctor = await createDoctor();
    const days = weekWith((day) => (day.isoWeekday === 3 ? { isoWeekday: 3, isWorking: false, shiftStart: "09:00", shiftEnd: "17:00", breaks: [] } : null));
    const res = await putAvailability(doctor.cookie, schedulePayload({ revision: 0, weeklySchedule: days }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.weeklySchedule[2], { isoWeekday: 3, isWorking: false, breaks: [] });
  });

  it("reports future bookings that no longer fit, without cancelling them", async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    const date = nextWorkingDate();
    const booking = await bookFirstSlot(doctor, patient, date);
    assert.equal(booking.localStartTime, "10:00");

    const afternoonsOnly = weekWith((day) => (day.isWorking ? workingDay(day.isoWeekday, "14:00", "18:00") : null));
    const res = await putAvailability(doctor.cookie, schedulePayload({ revision: 0, weeklySchedule: afternoonsOnly }));

    assert.equal(res.status, 200);
    assert.equal(res.body.meta.outOfHoursBookings.length, 1);
    assert.deepEqual(res.body.meta.outOfHoursBookings[0], {
      id: booking.id,
      startAt: booking.startAt,
      endAt: booking.endAt,
      localDate: date,
      localStartTime: "10:00",
      localEndTime: "10:30",
      patientName: "Test Patient",
    });

    const stored = await Appointment.findById(booking.id).lean();
    assert.equal(stored.status, "booked");
  });

  it("does not report bookings that still fit", async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    await bookFirstSlot(doctor, patient, nextWorkingDate());

    const res = await putAvailability(doctor.cookie, schedulePayload({ revision: 0, slotDurationMinutes: 15 }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.meta.outOfHoursBookings, []);
  });

  it("validates the schedule and points at the offending field", async () => {
    const doctor = await createDoctor();
    const base = MON_SAT_9_TO_6;
    const withDay = (index, day) => base.map((d, i) => (i === index ? day : d));

    const cases = [
      ["timezone", schedulePayload({ revision: 0, timezone: "Mars/Olympus" }), "timezone"],
      ["slot length", schedulePayload({ revision: 0, slotDurationMinutes: 25 }), "slotDurationMinutes"],
      ["6 days", schedulePayload({ revision: 0, weeklySchedule: base.slice(0, 6) }), "weeklySchedule"],
      ["duplicate weekday", schedulePayload({ revision: 0, weeklySchedule: withDay(1, workingDay(1, "09:00", "12:00")) }), "weeklySchedule.1.isoWeekday"],
      ["no working day", schedulePayload({ revision: 0, weeklySchedule: base.map((d) => ({ isoWeekday: d.isoWeekday, isWorking: false, breaks: [] })) }), "weeklySchedule"],
      ["off-grid time", schedulePayload({ revision: 0, weeklySchedule: withDay(0, workingDay(1, "09:03", "12:00")) }), "weeklySchedule.0.shiftStart"],
      ["end before start", schedulePayload({ revision: 0, weeklySchedule: withDay(0, workingDay(1, "12:00", "09:00")) }), "weeklySchedule.0.shiftEnd"],
      ["missing shift", schedulePayload({ revision: 0, weeklySchedule: withDay(0, { isoWeekday: 1, isWorking: true, breaks: [] }) }), "weeklySchedule.0.shiftStart"],
      ["break outside shift", schedulePayload({ revision: 0, weeklySchedule: withDay(0, workingDay(1, "09:00", "12:00", [{ start: "11:30", end: "12:30" }])) }), "weeklySchedule.0.breaks.0"],
      ["overlapping breaks", schedulePayload({ revision: 0, weeklySchedule: withDay(0, workingDay(1, "09:00", "18:00", [{ start: "12:00", end: "13:00" }, { start: "12:30", end: "13:30" }])) }), "weeklySchedule.0.breaks.1"],
      ["too many breaks", schedulePayload({ revision: 0, weeklySchedule: withDay(0, workingDay(1, "09:00", "18:00", [1, 2, 3, 4].map((h) => ({ start: `${9 + h * 2}:00`, end: `${9 + h * 2}:30` })))) }), "weeklySchedule.0.breaks"],
      ["no room for a slot", schedulePayload({ revision: 0, slotDurationMinutes: 60, weeklySchedule: withDay(0, workingDay(1, "09:00", "09:45")) }), "weeklySchedule.0.shiftEnd"],
      ["horizon", schedulePayload({ revision: 0, bookingPolicy: { ...POLICY, horizonDays: 91 } }), "bookingPolicy.horizonDays"],
      ["notice step", schedulePayload({ revision: 0, bookingPolicy: { ...POLICY, minNoticeMinutes: 62 } }), "bookingPolicy.minNoticeMinutes"],
      ["unknown field", { ...schedulePayload({ revision: 0 }), doctorId: "x" }, ""],
    ];

    for (const [label, body, path] of cases) {
      const res = await putAvailability(doctor.cookie, body);
      assert.equal(res.status, 400, label);
      assert.equal(res.body.error.code, "VALIDATION_FAILED", label);
      if (path) assert.ok(res.body.error.details.some((d) => d.path === path), `${label}: ${JSON.stringify(res.body.error.details)}`);
    }

    // None of the rejected saves touched the stored schedule.
    const stored = await api("/doctors/me/availability", { cookie: doctor.cookie });
    assert.equal(stored.body.data.revision, 0);
  });
});

describe("PATCH /api/doctors/me/profile", () => {
  it("updates profile fields and returns the public doctor shape", async () => {
    const doctor = await createDoctor();
    const res = await api("/doctors/me/profile", {
      method: "PATCH",
      cookie: doctor.cookie,
      body: { bio: "  Preventive cardiology.  ", qualifications: ["MBBS", "MD"], experienceYears: 12, clinicAddress: "12 MG Road" },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.id, doctor.id);
    assert.equal(res.body.data.bio, "Preventive cardiology.");
    assert.deepEqual(res.body.data.qualifications, ["MBBS", "MD"]);
    assert.equal(res.body.data.experienceYears, 12);
    assert.equal(res.body.data.clinicAddress, "12 MG Road");
    assert.equal(res.body.data.clinicName, "Test Clinic");
    assert.equal(res.body.data.timezone, TZ);
  });

  it("clears an optional field with null or an empty string", async () => {
    const doctor = await createDoctor();
    const res = await api("/doctors/me/profile", {
      method: "PATCH",
      cookie: doctor.cookie,
      body: { clinicName: null, bio: "" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.clinicName, null);
    assert.equal(res.body.data.bio, null);
  });

  it("pauses and resumes bookings, hiding the doctor from the directory while paused", async () => {
    const doctor = await createDoctor({ fullName: "Dr. Pause Resume" });
    const patch = (body) => api("/doctors/me/profile", { method: "PATCH", cookie: doctor.cookie, body });
    const listed = async () => (await api("/doctors?q=pause")).body.data.map((d) => d.id);

    assert.deepEqual(await listed(), [doctor.id]);

    const paused = await patch({ isAcceptingAppointments: false });
    assert.equal(paused.body.data.isAcceptingAppointments, false);
    assert.deepEqual(await listed(), []);

    const grid = await api(`/doctors/${doctor.id}/slots?date=${nextWorkingDate()}`);
    assert.equal(grid.body.data.reason, "NOT_ACCEPTING");

    const resumed = await patch({ isAcceptingAppointments: true });
    assert.equal(resumed.body.data.isAcceptingAppointments, true);
    assert.deepEqual(await listed(), [doctor.id]);
  });

  it("refuses to accept appointments before a schedule exists", async () => {
    const doctor = await createDoctor({ withAvailability: false, accepting: false });
    const res = await api("/doctors/me/profile", { method: "PATCH", cookie: doctor.cookie, body: { isAcceptingAppointments: true } });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, "DOCTOR_NOT_ACCEPTING");
  });

  it("rejects empty bodies, unknown fields and out-of-range values", async () => {
    const doctor = await createDoctor();
    for (const body of [{}, { specialization: "neurology" }, { role: "patient" }, { experienceYears: 90 }, { bio: "x".repeat(1001) }, { qualifications: new Array(11).fill("MD") }]) {
      const res = await api("/doctors/me/profile", { method: "PATCH", cookie: doctor.cookie, body });
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
      assert.equal(res.body.error.code, "VALIDATION_FAILED");
    }
  });
});

describe("GET /api/doctors/:id", () => {
  it("returns the public profile with weekly hours and the booking window", async () => {
    const doctor = await createDoctor({ fullName: "Dr. Public Profile" });
    const res = await api(`/doctors/${doctor.id}`);

    assert.equal(res.status, 200);
    const data = res.body.data;
    assert.equal(data.id, doctor.id);
    assert.equal(data.fullName, "Dr. Public Profile");
    assert.equal(data.specialization, "cardiology");
    assert.equal(data.timezone, TZ);
    assert.equal(data.slotDurationMinutes, 30);
    assert.equal(data.isAcceptingAppointments, true);
    assert.equal(data.weeklyHours.length, 7);
    assert.deepEqual(data.weeklyHours[0].windows, [{ start: "09:00", end: "13:00" }, { start: "14:00", end: "18:00" }]);
    assert.deepEqual(data.weeklyHours[6], { isoWeekday: 7, windows: [] });

    const today = DateTime.now().setZone(TZ).toISODate();
    assert.deepEqual(data.bookingWindow, { today, lastBookableDate: DateTime.fromISO(today).plus({ days: 30 }).toISODate() });
    assert.equal(data.passwordHash, undefined);
    assert.equal(data.email, undefined);
  });

  it("handles a doctor without a schedule", async () => {
    const doctor = await createDoctor({ withAvailability: false });
    const res = await api(`/doctors/${doctor.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.weeklyHours, []);
    assert.equal(res.body.data.bookingWindow, null);
  });

  it("returns 400 for a malformed id and 404 for an unknown or inactive doctor", async () => {
    const bad = await api("/doctors/not-an-id");
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "VALIDATION_FAILED");

    const inactive = await createDoctor({ isActive: false });
    for (const id of ["0123456789abcdef01234567", inactive.id]) {
      const res = await api(`/doctors/${id}`);
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "DOCTOR_NOT_FOUND");
    }
  });
});

describe("time-off", () => {
  const post = (cookie, body) => api("/doctors/me/time-off", { method: "POST", cookie, body });

  it("creates, lists and deletes a block, and the slot grid reflects it", async () => {
    const doctor = await createDoctor();
    const date = nextWorkingDate(3);

    const created = await post(doctor.cookie, { startLocal: `${date}T00:00`, endLocal: `${dayAfter(date)}T00:00`, reason: "  Conference  " });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.meta.conflicts, []);
    const block = created.body.data;
    assert.equal(block.startLocal, `${date}T00:00`);
    assert.equal(block.endLocal, `${dayAfter(date)}T00:00`);
    assert.equal(block.startAt, DateTime.fromISO(`${date}T00:00`, { zone: TZ }).toUTC().toISO());
    assert.equal(block.reason, "Conference");

    const grid = await api(`/doctors/${doctor.id}/slots?date=${date}`);
    assert.equal(grid.body.data.reason, "ON_TIME_OFF");

    const list = await api("/doctors/me/time-off", { cookie: doctor.cookie });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.map((b) => b.id), [block.id]);

    const removed = await api(`/doctors/me/time-off/${block.id}`, { method: "DELETE", cookie: doctor.cookie });
    assert.equal(removed.status, 204);
    const after = await api("/doctors/me/time-off", { cookie: doctor.cookie });
    assert.deepEqual(after.body.data, []);
    const reopened = await api(`/doctors/${doctor.id}/slots?date=${date}`);
    assert.equal(reopened.body.data.reason, null);
  });

  it("lists soonest first and hides blocks that ended before `from`", async () => {
    const doctor = await createDoctor();
    const later = nextWorkingDate(9);
    const sooner = nextWorkingDate(4);
    await post(doctor.cookie, { startLocal: `${later}T09:00`, endLocal: `${later}T12:00` });
    await post(doctor.cookie, { startLocal: `${sooner}T09:00`, endLocal: `${sooner}T12:00` });

    const all = await api("/doctors/me/time-off", { cookie: doctor.cookie });
    assert.deepEqual(all.body.data.map((b) => b.startLocal.slice(0, 10)), [sooner, later]);

    const fromLater = await api(`/doctors/me/time-off?from=${later}`, { cookie: doctor.cookie });
    assert.deepEqual(fromLater.body.data.map((b) => b.startLocal.slice(0, 10)), [later]);

    const bad = await api("/doctors/me/time-off?from=2026-02-30", { cookie: doctor.cookie });
    assert.equal(bad.status, 400);
  });

  it("dry run reports conflicts and writes nothing", async () => {
    const doctor = await createDoctor();
    const patient = await createPatient({ fullName: "Asha Verma" });
    const date = nextWorkingDate();
    const booking = await bookFirstSlot(doctor, patient, date);

    const res = await post(doctor.cookie, { startLocal: `${date}T09:00`, endLocal: `${date}T12:00`, dryRun: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.data, null);
    assert.equal(res.body.meta.conflicts.length, 1);
    assert.equal(res.body.meta.conflicts[0].id, booking.id);
    assert.equal(res.body.meta.conflicts[0].patientName, "Asha Verma");
    assert.equal(res.body.meta.conflicts[0].localStartTime, "10:00");

    const list = await api("/doctors/me/time-off", { cookie: doctor.cookie });
    assert.deepEqual(list.body.data, []);
  });

  it("keeps conflicting bookings by default", async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    const date = nextWorkingDate();
    const booking = await bookFirstSlot(doctor, patient, date);

    const res = await post(doctor.cookie, { startLocal: `${date}T09:00`, endLocal: `${date}T12:00` });
    assert.equal(res.status, 201);
    assert.equal(res.body.meta.conflicts.length, 1);
    assert.equal(res.body.meta.cancelledAppointmentIds, undefined);
    assert.equal((await Appointment.findById(booking.id).lean()).status, "booked");
  });

  it("cancels conflicting bookings on request, on the doctor's behalf", async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    const date = nextWorkingDate();
    const inside = await bookFirstSlot(doctor, patient, date, 2);
    const outside = await bookFirstSlot(doctor, patient, date, 10);

    const res = await post(doctor.cookie, {
      startLocal: `${date}T09:00`,
      endLocal: `${date}T12:00`,
      reason: "Surgery",
      cancelConflictingAppointments: true,
    });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.meta.cancelledAppointmentIds, [inside.id]);

    const cancelled = await Appointment.findById(inside.id).lean();
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.cancellation.byRole, "doctor");
    assert.equal(cancelled.cancellation.reason, "Doctor unavailable: Surgery");
    assert.equal(cancelled.cancellation.isLate, false);
    assert.equal(cancelled.statusHistory.at(-1).status, "cancelled");
    assert.equal((await Appointment.findById(outside.id).lean()).status, "booked");

    const mine = await api("/appointments/my-appointments?scope=all&status=cancelled", { cookie: patient.cookie });
    assert.deepEqual(mine.body.data.map((a) => a.id), [inside.id]);
    assert.equal(mine.body.data[0].cancellation.byRole, "doctor");
  });

  it("does not treat back-to-back bookings as conflicts (end is exclusive)", async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    const date = nextWorkingDate();
    const booking = await bookFirstSlot(doctor, patient, date, 2); // 10:00-10:30

    const res = await post(doctor.cookie, { startLocal: `${date}T10:30`, endLocal: `${date}T12:00`, dryRun: true });
    assert.deepEqual(res.body.meta.conflicts, []);
    const touching = await post(doctor.cookie, { startLocal: `${date}T09:00`, endLocal: `${date}T10:00`, dryRun: true });
    assert.deepEqual(touching.body.meta.conflicts, []);
    assert.equal((await Appointment.findById(booking.id).lean()).status, "booked");
  });

  it("validates the range", async () => {
    const doctor = await createDoctor();
    const date = nextWorkingDate();
    const yesterday = DateTime.now().setZone(TZ).minus({ days: 2 }).toISODate();
    const farOff = DateTime.fromISO(date).plus({ days: 91 }).toISODate();

    const cases = [
      ["off the 5-minute grid", { startLocal: `${date}T09:03`, endLocal: `${date}T12:00` }, "startLocal"],
      ["end before start", { startLocal: `${date}T12:00`, endLocal: `${date}T09:00` }, "endLocal"],
      ["empty range", { startLocal: `${date}T09:00`, endLocal: `${date}T09:00` }, "endLocal"],
      ["over 90 days", { startLocal: `${date}T00:00`, endLocal: `${farOff}T00:00` }, "endLocal"],
      ["entirely in the past", { startLocal: `${yesterday}T09:00`, endLocal: `${yesterday}T12:00` }, "endLocal"],
      ["bad shape", { startLocal: `${date} 09:00`, endLocal: `${date}T12:00` }, "startLocal"],
      ["impossible date", { startLocal: "2030-02-30T09:00", endLocal: "2030-03-01T09:00" }, "startLocal"],
      ["offset supplied", { startLocal: `${date}T09:00+05:30`, endLocal: `${date}T12:00` }, "startLocal"],
      ["unknown field", { startLocal: `${date}T09:00`, endLocal: `${date}T12:00`, doctorId: "x" }, ""],
      ["dry run + cancel", { startLocal: `${date}T09:00`, endLocal: `${date}T12:00`, dryRun: true, cancelConflictingAppointments: true }, "cancelConflictingAppointments"],
    ];
    for (const [label, body, path] of cases) {
      const res = await post(doctor.cookie, body);
      assert.equal(res.status, 400, label);
      assert.equal(res.body.error.code, "VALIDATION_FAILED", label);
      if (path) assert.ok(res.body.error.details.some((d) => d.path === path), `${label}: ${JSON.stringify(res.body.error.details)}`);
    }
  });

  it("accepts a block that started in the past but is still running", async () => {
    const doctor = await createDoctor();
    const past = DateTime.now().setZone(TZ).minus({ days: 1 }).toISODate();
    const future = DateTime.now().setZone(TZ).plus({ days: 2 }).toISODate();
    const res = await post(doctor.cookie, { startLocal: `${past}T09:00`, endLocal: `${future}T09:00` });
    assert.equal(res.status, 201);
  });

  it("falls back to the account time zone before a schedule exists", async () => {
    const doctor = await createDoctor({ withAvailability: false });
    const date = nextWorkingDate();
    const res = await post(doctor.cookie, { startLocal: `${date}T09:00`, endLocal: `${date}T12:00` });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.timezone, TZ);
  });

  it("only lets a doctor delete their own blocks", async () => {
    const owner = await createDoctor();
    const other = await createDoctor();
    const date = nextWorkingDate();
    const created = await post(owner.cookie, { startLocal: `${date}T09:00`, endLocal: `${date}T12:00` });
    const id = created.body.data.id;

    for (const target of [id, "0123456789abcdef01234567", "not-an-id"]) {
      const res = await api(`/doctors/me/time-off/${target}`, { method: "DELETE", cookie: other.cookie });
      assert.equal(res.status, 404, target);
      assert.equal(res.body.error.code, "TIME_OFF_NOT_FOUND");
    }
    const list = await api("/doctors/me/time-off", { cookie: owner.cookie });
    assert.equal(list.body.data.length, 1);
  });
});

describe("GET /api/auth/me for doctors", () => {
  it("reports hasAvailability so first-time doctors can be sent to setup", async () => {
    const withSchedule = await createDoctor();
    const without = await createDoctor({ withAvailability: false });

    const yes = await api("/auth/me", { cookie: withSchedule.cookie });
    const no = await api("/auth/me", { cookie: without.cookie });
    assert.equal(yes.body.data.user.hasAvailability, true);
    assert.equal(no.body.data.user.hasAvailability, false);

    await putAvailability(without.cookie, schedulePayload());
    const after = await api("/auth/me", { cookie: without.cookie });
    assert.equal(after.body.data.user.hasAvailability, true);
  });

  it("does not add the flag for patients", async () => {
    const patient = await createPatient();
    const res = await api("/auth/me", { cookie: patient.cookie });
    assert.equal("hasAvailability" in res.body.data.user, false);
  });
});
