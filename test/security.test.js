// Security behaviour that can be checked without a database: HTTP-layer
// defences, input validation, the login timing/inactive-account rules and
// session token claims. Runs standalone (no harness).
import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.APP_ORIGIN ??= "http://localhost:5173";
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:1/unused";
process.env.JWT_SECRET ??= "test-secret-that-is-at-least-32-characters-long";
process.env.DOCTOR_INVITE_CODE ??= "test-invite-code";

const { app } = await import("../src/app.js");
const { User } = await import("../src/db/models/index.js");
const { authenticateUser, registerUser } = await import("../src/modules/auth/auth.service.js");
const { loginSchema, registerSchema } = await import("../src/modules/auth/auth.validators.js");
const { bookAppointmentSchema } = await import("../src/modules/appointments/appointments.validators.js");
const { cleanText } = await import("../src/lib/sanitize.js");
const { signSession, verifySession } = await import("../src/lib/jwt.js");
const { SignJWT } = await import("jose");
const argon2 = (await import("argon2")).default;

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const post = (path, { body, headers = {} } = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
  });

describe("HTTP hardening", () => {
  it("sends strict security headers and no-store on API responses", async () => {
    const res = await fetch(`${base}/health/live`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
    assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("strict-transport-security"), /max-age=31536000/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-powered-by"), null);
  });

  it("rejects state-changing requests from another origin or site", async () => {
    const foreign = await post("/appointments", { headers: { Origin: "https://evil.example" } });
    assert.equal(foreign.status, 403);

    const crossSite = await post("/appointments", { headers: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(crossSite.status, 403);
    assert.equal((await crossSite.json()).error.code, "FORBIDDEN");
  });

  it("only accepts JSON bodies (no forms, no file uploads)", async () => {
    const form = await post("/appointments", {
      body: "doctorId=1",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    assert.equal(form.status, 415);

    const upload = await fetch(`${base}/appointments`, { method: "POST", body: new FormData() });
    assert.equal(upload.status, 415);
    assert.equal((await upload.json()).error.code, "UNSUPPORTED_MEDIA_TYPE");
  });

  it("answers malformed and oversized JSON with 4xx, not 500", async () => {
    const malformed = await post("/appointments", { body: "{not json" });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "MALFORMED_JSON");

    const huge = await post("/appointments", { body: JSON.stringify({ patientNotes: "x".repeat(20_000) }) });
    assert.equal(huge.status, 413);
    assert.equal((await huge.json()).error.code, "PAYLOAD_TOO_LARGE");
  });

  it("rate-limits login attempts and says when to retry", async () => {
    const statuses = [];
    let last;
    for (let i = 0; i < 6; i += 1) {
      last = await post("/auth/login", { body: { email: "victim@example.com" } });
      statuses.push(last.status);
    }
    assert.deepEqual(statuses.slice(0, 5), [400, 400, 400, 400, 400]);
    assert.equal(last.status, 429);
    assert.equal((await last.json()).error.code, "RATE_LIMITED");
    assert.ok(Number(last.headers.get("retry-after")) > 0);
  });
});

describe("input validation", () => {
  const valid = { fullName: "Asha Verma", email: "asha@example.com", password: "a-long-passphrase-2026" };

  it("accepts a normal registration and strips invisible characters", () => {
    const zeroWidth = String.fromCharCode(0x200b);
    const parsed = registerSchema.parse({ ...valid, fullName: ` Asha${zeroWidth} Verma ` });
    assert.equal(parsed.fullName, "Asha Verma");
    assert.equal(parsed.role, "patient");
  });

  it("rejects markup in names, weak passwords, bad time zones and unknown fields", () => {
    for (const input of [
      { ...valid, fullName: "<script>alert(1)</script>" },
      { ...valid, password: "onlyletters" },
      { ...valid, password: "x1".repeat(65) },
      { ...valid, timezone: "Mars/Olympus" },
      { ...valid, isActive: true },
      { ...valid, role: "admin" },
    ]) {
      assert.equal(registerSchema.safeParse(input).success, false, JSON.stringify(input).slice(0, 80));
    }
  });

  it("bounds login input so argon2 can't be fed huge passwords", () => {
    assert.equal(loginSchema.safeParse({ email: "a@b.co", password: "x".repeat(129) }).success, false);
    assert.equal(loginSchema.safeParse({ email: { $gt: "" }, password: "x" }).success, false);
  });

  it("cleans patient notes but keeps line breaks", () => {
    const parsed = bookAppointmentSchema.parse({
      doctorId: "a".repeat(24),
      startAt: "2030-01-07T09:00:00Z",
      patientNotes: `Chest pain${String.fromCharCode(0)}\nsince Monday`,
    });
    assert.equal(parsed.patientNotes, "Chest pain\nsince Monday");
    assert.equal(cleanText("a\nb"), "a b");
  });
});

describe("login rules", () => {
  it("spends argon2 time even when the email doesn't exist", async (t) => {
    t.mock.method(User, "findOne", () => ({ select: async () => null }));
    const verify = t.mock.method(argon2, "verify");
    await assert.rejects(authenticateUser("nobody@example.com", "whatever1"), { code: "INVALID_CREDENTIALS" });
    assert.equal(verify.mock.callCount(), 1);
  });

  it("refuses deactivated accounts with the same error as a wrong password", async (t) => {
    const passwordHash = await argon2.hash("right-password-1", { type: argon2.argon2id });
    const save = mock.fn();
    t.mock.method(User, "findOne", () => ({
      select: async () => ({ _id: "a".repeat(24), passwordHash, isActive: false, tokenVersion: 0, save }),
    }));
    await assert.rejects(authenticateUser("former@example.com", "right-password-1"), { code: "INVALID_CREDENTIALS" });
    assert.equal(save.mock.callCount(), 0);
  });

  it("rejects a wrong doctor invite code before touching the database", async () => {
    await assert.rejects(
      registerUser({ role: "doctor", inviteCode: "guess", password: "a-long-passphrase-2026" }),
      { code: "INVALID_INVITE_CODE" }
    );
  });
});

describe("session tokens", () => {
  it("round-trips our own tokens", async () => {
    const token = await signSession({ userId: "a".repeat(24), role: "patient", tokenVersion: 0 });
    const payload = await verifySession(token);
    assert.equal(payload.sub, "a".repeat(24));
  });

  it("rejects tokens signed with the right secret but for another audience", async () => {
    const foreign = await new SignJWT({ role: "doctor", tv: 0 })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("a".repeat(24))
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    await assert.rejects(verifySession(foreign));
  });
});
