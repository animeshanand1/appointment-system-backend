import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PASSWORD, User, api, createDoctor, createPatient, startApp, stopApp } from "./harness.js";
import { clearSentMail, sentMail } from "../src/lib/mailer.js";
import { flushNotifications } from "../src/modules/notifications/notifications.service.js";

before(startApp);
after(stopApp);
beforeEach(clearSentMail);

const sessionCookie = (res) => res.headers.get("set-cookie")?.split(";")[0];
const resetTokenFrom = (mail) => /token=([a-f\d]{64})/.exec(mail.text)?.[1];

async function requestReset(email) {
  const res = await api("/auth/forgot-password", { method: "POST", body: { email } });
  await flushNotifications();
  return res;
}

describe("forgot / reset password", () => {
  it("emails a single-use link and answers identically for unknown emails", async () => {
    const patient = await createPatient();

    const known = await requestReset(patient.email);
    const unknown = await requestReset("nobody@example.com");
    assert.equal(known.status, 202);
    assert.equal(unknown.status, 202);
    assert.deepEqual(known.body, unknown.body);

    const mails = sentMail();
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, patient.email);
    const token = resetTokenFrom(mails[0]);
    assert.ok(token);

    // Only a hash is stored.
    const stored = await User.findById(patient.id).select("+passwordReset").lean();
    assert.notEqual(stored.passwordReset.tokenHash, token);

    const reset = await api("/auth/reset-password", { method: "POST", body: { token, password: "brand-new-pass-77" } });
    assert.equal(reset.status, 200);

    const reused = await api("/auth/reset-password", { method: "POST", body: { token, password: "another-pass-88" } });
    assert.equal(reused.status, 400);
    assert.equal(reused.body.error.code, "INVALID_RESET_TOKEN");

    // Old sessions are revoked, the new password works, the old one doesn't.
    assert.equal((await api("/auth/me", { cookie: patient.cookie })).status, 401);
    const oldLogin = await api("/auth/login", { method: "POST", body: { email: patient.email, password: PASSWORD } });
    assert.equal(oldLogin.status, 401);
    const newLogin = await api("/auth/login", { method: "POST", body: { email: patient.email, password: "brand-new-pass-77" } });
    assert.equal(newLogin.status, 200);

    await flushNotifications();
    assert.ok(sentMail().some((m) => m.subject.includes("password was changed")));
  });

  it("rejects expired tokens and weak passwords", async () => {
    const patient = await createPatient();
    await requestReset(patient.email);
    const token = resetTokenFrom(sentMail()[0]);

    const weak = await api("/auth/reset-password", { method: "POST", body: { token, password: "short" } });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.error.code, "VALIDATION_FAILED");

    await User.updateOne({ _id: patient.id }, { $set: { "passwordReset.expiresAt": new Date(Date.now() - 1000) } });
    const expired = await api("/auth/reset-password", { method: "POST", body: { token, password: "brand-new-pass-77" } });
    assert.equal(expired.status, 400);
  });

  it("sends nothing for deactivated accounts", async () => {
    const patient = await createPatient();
    await User.updateOne({ _id: patient.id }, { $set: { isActive: false } });
    const res = await requestReset(patient.email);
    assert.equal(res.status, 202);
    assert.equal(sentMail().length, 0);
  });

  it("limits reset emails per account", async () => {
    const patient = await createPatient();
    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await requestReset(patient.email)).status);
    assert.deepEqual(statuses, [202, 202, 202, 429]);
  });
});

describe("change password", () => {
  it("requires the current password, revokes other sessions and re-issues this one", async () => {
    const patient = await createPatient();

    const wrong = await api("/auth/change-password", {
      method: "POST",
      cookie: patient.cookie,
      body: { currentPassword: "not-my-password-1", newPassword: "fresh-pass-2026" },
    });
    assert.equal(wrong.status, 401);

    const ok = await api("/auth/change-password", {
      method: "POST",
      cookie: patient.cookie,
      body: { currentPassword: PASSWORD, newPassword: "fresh-pass-2026" },
    });
    assert.equal(ok.status, 200);
    const fresh = sessionCookie(ok);
    assert.ok(fresh);

    assert.equal((await api("/auth/me", { cookie: patient.cookie })).status, 401);
    assert.equal((await api("/auth/me", { cookie: fresh })).status, 200);
  });
});

describe("PATCH /auth/me", () => {
  it("updates a patient's own profile and clears fields with null", async () => {
    const patient = await createPatient();
    const res = await api("/auth/me", {
      method: "PATCH",
      cookie: patient.cookie,
      body: { fullName: "Asha  Verma", phone: "9123456780", patientProfile: { dateOfBirth: "1990-04-12", gender: "female" } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.user.phone, "9123456780");
    assert.deepEqual(res.body.data.user.patientProfile, { dateOfBirth: "1990-04-12", gender: "female" });

    const cleared = await api("/auth/me", { method: "PATCH", cookie: patient.cookie, body: { phone: null } });
    assert.equal(cleared.body.data.user.phone, undefined);
  });

  it("refuses email/role changes, bad dates and patient fields on doctors", async () => {
    const patient = await createPatient();
    const doctor = await createDoctor();
    for (const [cookie, body] of [
      [patient.cookie, { email: "new@example.com" }],
      [patient.cookie, { role: "doctor" }],
      [patient.cookie, { patientProfile: { dateOfBirth: "2999-01-01" } }],
      [patient.cookie, { timezone: "Mars/Olympus" }],
      [doctor.cookie, { patientProfile: { gender: "male" } }],
      [patient.cookie, {}],
    ]) {
      const res = await api("/auth/me", { method: "PATCH", cookie, body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });
});
