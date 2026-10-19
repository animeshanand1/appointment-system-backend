import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  api,
  createDoctor,
  localDateOffset,
  nextSunday,
  nextWorkingDate,
  startApp,
  stopApp,
} from "./harness.js";

before(startApp);
after(stopApp);

describe("GET /api/doctors", () => {
  let chen;
  let ortiz;

  before(async () => {
    ortiz = await createDoctor({ fullName: "Dr. Michael Ortiz", specialization: "cardiology" });
    chen = await createDoctor({ fullName: "Dr. Daniel Chen", specialization: "cardiology" });
    await createDoctor({ fullName: "Dr. Marcus Vance", specialization: "neurology" });
    await createDoctor({ fullName: "Dr. Paused Person", specialization: "cardiology", accepting: false });
    await createDoctor({ fullName: "Dr. Inactive Person", specialization: "cardiology", isActive: false });
  });

  it("lists only active, accepting doctors sorted by name, with schedule fields", async () => {
    const res = await api("/doctors?specialization=cardiology");

    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.data.map((d) => d.fullName),
      ["Dr. Daniel Chen", "Dr. Michael Ortiz"]
    );
    assert.deepEqual(res.body.meta, { page: 1, limit: 20, total: 2 });
    assert.deepEqual(res.body.data[0], {
      id: chen.id,
      fullName: "Dr. Daniel Chen",
      specialization: "cardiology",
      experienceYears: 10,
      clinicName: "Test Clinic",
      timezone: "Asia/Kolkata",
      slotDurationMinutes: 30,
    });
    assert.equal(res.body.data[1].id, ortiz.id);
  });

  it("normalizes the specialization filter's case", async () => {
    const res = await api("/doctors?specialization=Cardiology");
    assert.equal(res.status, 200);
    assert.equal(res.body.meta.total, 2);
  });

  it("matches the q prefix with or without the Dr. title", async () => {
    const byName = await api("/doctors?q=dan");
    assert.deepEqual(byName.body.data.map((d) => d.fullName), ["Dr. Daniel Chen"]);

    const withTitle = await api("/doctors?q=Dr.%20Mar");
    assert.deepEqual(withTitle.body.data.map((d) => d.fullName), ["Dr. Marcus Vance"]);
  });

  it("treats regex characters in q as plain text", async () => {
    const res = await api(`/doctors?q=${encodeURIComponent("(.*")}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.meta.total, 0);
  });

  it("paginates", async () => {
    const res = await api("/doctors?limit=1&page=2&specialization=cardiology");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.map((d) => d.fullName), ["Dr. Michael Ortiz"]);
    assert.equal(res.body.meta.total, 2);
  });

  it("rejects invalid queries with VALIDATION_FAILED", async () => {
    for (const query of ["limit=51", "page=0", "q=a", "unknown=1"]) {
      const res = await api(`/doctors?${query}`);
      assert.equal(res.status, 400, query);
      assert.equal(res.body.error.code, "VALIDATION_FAILED", query);
    }
  });
});

describe("GET /api/doctors/:id/slots", () => {
  let doctor;

  before(async () => {
    doctor = await createDoctor({ fullName: "Dr. Slot Grid" });
  });

  it("returns the working-day grid with the lunch break removed", async () => {
    const date = nextWorkingDate();
    const res = await api(`/doctors/${doctor.id}/slots?date=${date}`);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const day = res.body.data;
    assert.equal(day.doctorId, doctor.id);
    assert.equal(day.date, date);
    assert.equal(day.timezone, "Asia/Kolkata");
    assert.equal(day.slotDurationMinutes, 30);
    assert.equal(day.isWorkingDay, true);
    assert.equal(day.reason, null);
    assert.equal(day.slots.length, 16);
    assert.equal(day.slots[0].slotStartTime, "09:00");
    assert.equal(day.slots.at(-1).slotEndTime, "18:00");
    assert.ok(!day.slots.some((s) => s.slotStartTime === "13:00" || s.slotStartTime === "13:30"));
    assert.ok(day.slots.every((s) => s.status === "available"));
    assert.equal(day.slots[0].startAt, `${date}T03:30:00.000Z`);
  });

  it("explains empty days with a reason", async () => {
    const cases = [
      [nextSunday(), "DAY_OFF"],
      [localDateOffset(-1), "PAST_DATE"],
      [localDateOffset(31), "BEYOND_HORIZON"],
    ];
    for (const [date, reason] of cases) {
      const res = await api(`/doctors/${doctor.id}/slots?date=${date}`);
      assert.equal(res.status, 200, reason);
      assert.equal(res.body.data.reason, reason);
      assert.deepEqual(res.body.data.slots, []);
    }
  });

  it("reports NOT_ACCEPTING for a paused doctor", async () => {
    const paused = await createDoctor({ accepting: false });
    const res = await api(`/doctors/${paused.id}/slots?date=${nextWorkingDate()}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.reason, "NOT_ACCEPTING");
    assert.deepEqual(res.body.data.slots, []);
  });

  it("rejects bad dates and ids", async () => {
    for (const path of [
      `/doctors/${doctor.id}/slots?date=2026-02-30`,
      `/doctors/${doctor.id}/slots?date=2026-9-7`,
      `/doctors/${doctor.id}/slots`,
      `/doctors/not-an-id/slots?date=${nextWorkingDate()}`,
    ]) {
      const res = await api(path);
      assert.equal(res.status, 400, path);
      assert.equal(res.body.error.code, "VALIDATION_FAILED", path);
    }
  });

  it("returns 404 for an unknown or inactive doctor", async () => {
    const inactive = await createDoctor({ isActive: false });
    for (const id of ["0123456789abcdef01234567", inactive.id]) {
      const res = await api(`/doctors/${id}/slots?date=${nextWorkingDate()}`);
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "DOCTOR_NOT_FOUND");
    }
  });
});
