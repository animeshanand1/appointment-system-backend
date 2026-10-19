import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Appointment, User, api, createDoctor, createPatient, nextWorkingDate, startApp, stopApp } from "./harness.js";
import { clearSentMail, sentMail } from "../src/lib/mailer.js";
import { flushNotifications } from "../src/modules/notifications/notifications.service.js";
import { sendDueReminders } from "../src/jobs/reminders.js";

before(startApp);
after(stopApp);

async function availableSlots(doctorId, date) {
  const res = await api(`/doctors/${doctorId}/slots?date=${date}`);
  return res.body.data.slots.filter((s) => s.status === "available");
}

async function mailTo(email) {
  await flushNotifications();
  return sentMail().filter((m) => m.to === email);
}

describe("appointment emails", () => {
  let doctor;
  let patient;
  let slots;
  let appt;

  beforeEach(async () => {
    doctor = await createDoctor({ fullName: "Dr. Mail Test" });
    patient = await createPatient({ fullName: "Ravi Kumar" });
    slots = await availableSlots(doctor.id, nextWorkingDate());
    clearSentMail();
    const res = await api("/appointments", {
      method: "POST",
      cookie: patient.cookie,
      body: { doctorId: doctor.id, startAt: slots[0].startAt, patientNotes: "<b>knee</b>" },
    });
    assert.equal(res.status, 201);
    appt = res.body.data;
    await flushNotifications();
  });

  it("confirms a booking to the patient and tells the doctor", async () => {
    const [toPatient] = await mailTo(patient.email);
    const [toDoctor] = await mailTo(doctor.email);
    assert.match(toPatient.subject, /Appointment confirmed with Dr\. Mail Test/);
    assert.match(toPatient.text, /09:00/);
    assert.match(toDoctor.subject, /New booking: Ravi Kumar/);
  });

  it("tells the doctor when the patient cancels, and the patient when the doctor cancels", async () => {
    clearSentMail();
    await api(`/appointments/${appt.id}/status`, { method: "PATCH", cookie: patient.cookie, body: { status: "cancelled" } });
    assert.equal((await mailTo(doctor.email)).length, 1);
    assert.equal((await mailTo(patient.email)).length, 0);

    const second = await api("/appointments", {
      method: "POST",
      cookie: patient.cookie,
      body: { doctorId: doctor.id, startAt: slots[2].startAt },
    });
    await flushNotifications();
    clearSentMail();
    await api(`/appointments/${second.body.data.id}/status`, {
      method: "PATCH",
      cookie: doctor.cookie,
      body: { status: "cancelled", reason: "Called away to surgery" },
    });
    const [toPatient] = await mailTo(patient.email);
    assert.match(toPatient.text, /Called away to surgery/);
  });

  it("covers reschedule requests, decisions and direct moves", async () => {
    clearSentMail();
    await api(`/appointments/${appt.id}/reschedule-request`, {
      method: "PUT",
      cookie: patient.cookie,
      body: { startAt: slots[4].startAt, reason: "Exam that morning" },
    });
    const [request] = await mailTo(doctor.email);
    assert.match(request.subject, /Reschedule request from Ravi Kumar/);

    const pending = await Appointment.findById(appt.id).lean();
    clearSentMail();
    await api(`/appointments/${appt.id}/reschedule-request/decision`, {
      method: "POST",
      cookie: doctor.cookie,
      body: { requestId: String(pending.rescheduleRequest._id), decision: "approve" },
    });
    const [decision] = await mailTo(patient.email);
    assert.match(decision.subject, /approved/);

    clearSentMail();
    await api(`/appointments/${appt.id}/reschedule`, {
      method: "PATCH",
      cookie: doctor.cookie,
      body: { startAt: slots[6].startAt, reason: "Clinic running late" },
    });
    const [moved] = await mailTo(patient.email);
    assert.match(moved.subject, /Appointment moved/);
  });

  it("escapes user text in HTML and skips deactivated recipients", async () => {
    const [toDoctor] = await mailTo(doctor.email);
    assert.ok(!toDoctor.html.includes("<b>knee</b>"));

    await User.updateOne({ _id: doctor.id }, { $set: { isActive: false } });
    clearSentMail();
    await api(`/appointments/${appt.id}/status`, { method: "PATCH", cookie: patient.cookie, body: { status: "cancelled" } });
    assert.equal((await mailTo(doctor.email)).length, 0);
  });
});

describe("reminders", () => {
  it("sends one reminder per appointment about a day ahead, and again after a move", async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    const slots = await availableSlots(doctor.id, nextWorkingDate());
    const res = await api("/appointments", { method: "POST", cookie: patient.cookie, body: { doctorId: doctor.id, startAt: slots[0].startAt } });
    const id = res.body.data.id;

    // Pretend it was booked a week ago and now starts in 12 hours.
    const startAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
    await Appointment.collection.updateOne(
      { _id: Appointment.castObject({ _id: id })._id },
      { $set: { startAt, createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }
    );

    clearSentMail();
    assert.ok((await sendDueReminders()) >= 1);
    assert.equal(sentMail().filter((m) => m.to === patient.email && /Reminder/.test(m.subject)).length, 1);

    assert.equal(await sendDueReminders(), 0);

    await Appointment.collection.updateOne(
      { _id: Appointment.castObject({ _id: id })._id },
      { $set: { startAt: new Date(startAt.getTime() + 60 * 60 * 1000) } }
    );
    assert.equal(await sendDueReminders(), 1);
  });
});
