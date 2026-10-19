import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { InviteCode, api, createAdmin, createDoctor, createPatient, nextWorkingDate, startApp, stopApp } from "./harness.js";

before(startApp);
after(stopApp);

const registerDoctor = (body) =>
  api("/auth/register", {
    method: "POST",
    body: {
      role: "doctor",
      fullName: "Dr. Neha Rao",
      password: "a-long-passphrase-2026",
      doctorProfile: { specialization: "neurology" },
      ...body,
    },
  });

describe("admin access", () => {
  it("is admin-only", async () => {
    const patient = await createPatient();
    const doctor = await createDoctor();
    for (const path of ["/admin/stats", "/admin/users", "/admin/invites", "/admin/appointments"]) {
      assert.equal((await api(path)).status, 401, path);
      assert.equal((await api(path, { cookie: patient.cookie })).status, 403, path);
      assert.equal((await api(path, { cookie: doctor.cookie })).status, 403, path);
    }
  });

  it("can't be self-registered", async () => {
    const res = await api("/auth/register", {
      method: "POST",
      body: { role: "admin", fullName: "Sneaky Person", email: "sneaky@example.com", password: "a-long-passphrase-2026" },
    });
    assert.equal(res.status, 400);
  });
});

describe("invite codes", () => {
  it("issues a single-use code that only works once, and shows it only at creation", async () => {
    const admin = await createAdmin();
    const created = await api("/admin/invites", { method: "POST", cookie: admin.cookie, body: { label: "Neurology locum" } });
    assert.equal(created.status, 201);
    const code = created.body.meta.code;
    assert.match(code, /^DOC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(created.body.data.status, "active");

    const stored = await InviteCode.findById(created.body.data.id).lean();
    assert.notEqual(stored.codeHash, code);

    const first = await registerDoctor({ email: "neha.rao@example.com", inviteCode: code.toLowerCase() });
    assert.equal(first.status, 201);
    assert.equal(first.body.data.user.role, "doctor");

    const second = await registerDoctor({ email: "someone.else@example.com", inviteCode: code });
    assert.equal(second.status, 403);
    assert.equal(second.body.error.code, "INVALID_INVITE_CODE");

    const list = await api("/admin/invites", { cookie: admin.cookie });
    const listed = list.body.data.find((i) => i.id === created.body.data.id);
    assert.equal(listed.status, "used");
    assert.equal(listed.usedBy.email, "neha.rao@example.com");
    assert.equal(JSON.stringify(list.body).includes(code), false);
  });

  it("honours email locks, expiry and revocation", async () => {
    const admin = await createAdmin();
    const make = async (body) => (await api("/admin/invites", { method: "POST", cookie: admin.cookie, body })).body;

    const locked = await make({ label: "For Dr. Iyer", email: "iyer@example.com" });
    assert.equal((await registerDoctor({ email: "not-iyer@example.com", inviteCode: locked.meta.code })).status, 403);
    assert.equal((await registerDoctor({ email: "iyer@example.com", inviteCode: locked.meta.code })).status, 201);

    const expiring = await make({ label: "Expired code" });
    await InviteCode.updateOne({ _id: expiring.data.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await registerDoctor({ email: "late@example.com", inviteCode: expiring.meta.code })).status, 403);

    const revoked = await make({ label: "Revoked code" });
    const revoke = await api(`/admin/invites/${revoked.data.id}`, { method: "DELETE", cookie: admin.cookie });
    assert.equal(revoke.body.data.status, "revoked");
    assert.equal((await registerDoctor({ email: "revoked@example.com", inviteCode: revoked.meta.code })).status, 403);
    assert.equal((await api(`/admin/invites/${revoked.data.id}`, { method: "DELETE", cookie: admin.cookie })).status, 409);
  });

  it("gives the code back when registration fails after claiming it", async () => {
    const admin = await createAdmin();
    const existing = await createPatient();
    const { meta } = (await api("/admin/invites", { method: "POST", cookie: admin.cookie, body: { label: "Retry" } })).body;

    const clash = await registerDoctor({ email: existing.email, inviteCode: meta.code });
    assert.equal(clash.status, 409);
    const retry = await registerDoctor({ email: "fresh.doctor@example.com", inviteCode: meta.code });
    assert.equal(retry.status, 201);
  });
});

describe("user management", () => {
  it("searches users and deactivates an account, which ends its sessions", async () => {
    const admin = await createAdmin();
    const patient = await createPatient({ fullName: "Meera Joshi" });

    const search = await api("/admin/users?q=meera&role=patient", { cookie: admin.cookie });
    assert.equal(search.status, 200);
    assert.ok(search.body.data.some((u) => u.id === patient.id));

    const off = await api(`/admin/users/${patient.id}`, { method: "PATCH", cookie: admin.cookie, body: { isActive: false } });
    assert.equal(off.body.data.isActive, false);
    assert.equal((await api("/auth/me", { cookie: patient.cookie })).status, 401);

    const on = await api(`/admin/users/${patient.id}`, { method: "PATCH", cookie: admin.cookie, body: { isActive: true } });
    assert.equal(on.body.data.isActive, true);
  });

  it("protects admins and the acting admin", async () => {
    const admin = await createAdmin();
    const other = await createAdmin();
    assert.equal((await api(`/admin/users/${admin.id}`, { method: "PATCH", cookie: admin.cookie, body: { isActive: false } })).status, 403);
    assert.equal((await api(`/admin/users/${other.id}`, { method: "PATCH", cookie: admin.cookie, body: { isActive: false } })).status, 403);
  });

  it("treats regex characters in search as text", async () => {
    const admin = await createAdmin();
    const res = await api(`/admin/users?q=${encodeURIComponent("(.*")}`, { cookie: admin.cookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.meta.total, 0);
  });
});

describe("overview", () => {
  it("reports stats and lists appointments with both parties", async () => {
    const admin = await createAdmin();
    const doctor = await createDoctor({ fullName: "Dr. Overview" });
    const patient = await createPatient({ fullName: "Kiran Patil" });
    const date = nextWorkingDate();
    const grid = await api(`/doctors/${doctor.id}/slots?date=${date}`);
    const booked = await api("/appointments", {
      method: "POST",
      cookie: patient.cookie,
      body: { doctorId: doctor.id, startAt: grid.body.data.slots[0].startAt },
    });
    assert.equal(booked.status, 201);

    const stats = await api("/admin/stats", { cookie: admin.cookie });
    assert.equal(stats.status, 200);
    assert.ok(stats.body.data.appointments.upcoming >= 1);
    assert.ok(stats.body.data.users.doctors >= 1);

    const list = await api(`/admin/appointments?doctorId=${doctor.id}&from=${date}&to=${date}`, { cookie: admin.cookie });
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].patient.fullName, "Kiran Patil");
    assert.equal(list.body.data[0].doctor.fullName, "Dr. Overview");

    const bad = await api(`/admin/appointments?from=${date}&to=2000-01-01`, { cookie: admin.cookie });
    assert.equal(bad.status, 400);
  });
});
