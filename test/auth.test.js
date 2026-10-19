import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { api, startApp, stopApp } from "./harness.js";

before(startApp);
after(stopApp);

const sessionCookie = (res) => res.headers.get("set-cookie")?.split(";")[0];

describe("auth session flow", () => {
  const credentials = { email: "Asha.Verma@Example.com", password: "a-long-passphrase-2026" };

  it("registers a patient, then logs in, reads /me and logs out", async () => {
    const registered = await api("/auth/register", {
      method: "POST",
      body: { fullName: "Asha Verma", ...credentials },
    });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.data.user.role, "patient");
    assert.equal(registered.body.data.user.email, "asha.verma@example.com");
    assert.ok(sessionCookie(registered)?.startsWith("session="));

    const login = await api("/auth/login", { method: "POST", body: credentials });
    assert.equal(login.status, 200);
    const cookie = sessionCookie(login);

    const me = await api("/auth/me", { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.body.data.user.fullName, "Asha Verma");

    const logout = await api("/auth/logout", { method: "POST", cookie, body: {} });
    assert.equal(logout.status, 204);
  });

  it("rejects a wrong password and duplicate registration", async () => {
    const wrong = await api("/auth/login", { method: "POST", body: { ...credentials, password: "wrong-password" } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, "INVALID_CREDENTIALS");

    const duplicate = await api("/auth/register", { method: "POST", body: { fullName: "Asha Again", ...credentials } });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, "EMAIL_ALREADY_REGISTERED");
  });

  it("returns 401 from /me without a session", async () => {
    const res = await api("/auth/me");
    assert.equal(res.status, 401);
  });
});
