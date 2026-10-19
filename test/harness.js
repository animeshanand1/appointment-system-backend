// Shared test setup: an in-memory MongoDB, the Express app on a random port,
// and factories for signed-in patients and doctors.
//
// mongodb-memory-server downloads a mongod binary on first use. Where that
// download is blocked, point MONGOMS_SYSTEM_BINARY at a local mongod.
import argon2 from "argon2";
import { DateTime } from "luxon";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.APP_ORIGIN ??= "http://localhost:5173";
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:1/replaced-at-startup";
process.env.JWT_SECRET ??= "test-secret-that-is-at-least-32-characters-long";
process.env.DOCTOR_INVITE_CODE ??= "test-invite-code";
// Lets every simulated client have its own address (see api()), so the
// per-IP rate limiters don't treat the whole suite as one abusive client.
process.env.TRUST_PROXY = "1";

const { MongoMemoryReplSet } = await import("mongodb-memory-server");
const { default: mongoose } = await import("mongoose");
const { app } = await import("../src/app.js");
const models = await import("../src/db/models/index.js");
const { signSession, SESSION_COOKIE_NAME } = await import("../src/lib/jwt.js");

export const { Appointment, Doctor, DoctorAvailability, Patient, User } = models;

export const TZ = "Asia/Kolkata";
export const PASSWORD = "a-long-passphrase-2026";

const workday = (isoWeekday) => ({
  isoWeekday,
  isWorking: true,
  shiftStart: "09:00",
  shiftEnd: "18:00",
  breaks: [{ start: "13:00", end: "14:00" }],
});

export const MON_SAT_9_TO_6 = [1, 2, 3, 4, 5, 6, 7].map((isoWeekday) =>
  isoWeekday === 7 ? { isoWeekday, isWorking: false, breaks: [] } : workday(isoWeekday)
);

let mongo;
let server;
let baseUrl;
let passwordHash;

export async function startApp() {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(mongo.getUri("appointment-sys-test"));
  // The unique booking indexes are what make double-booking impossible, so
  // they must exist before any test books.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));

  passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
}

export async function stopApp() {
  await new Promise((resolve) => server?.close(resolve));
  await mongoose.disconnect();
  await mongo?.stop();
}

const randomIp = () => `10.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}.${(Math.random() * 254 + 1) | 0}`;

/**
 * @returns { status, body, headers }
 */
export async function api(path, { method = "GET", body, cookie, headers = {}, ip = randomIp() } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      "X-Forwarded-For": ip,
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

async function cookieFor(user) {
  const token = await signSession({ userId: String(user._id), role: user.role, tokenVersion: 0 });
  return `${SESSION_COOKIE_NAME}=${token}`;
}

const uniqueEmail = (prefix) => `${prefix}.${randomUUID().slice(0, 8)}@example.com`;

export async function createPatient({ fullName = "Test Patient", email = uniqueEmail("patient"), phone = "9876543210" } = {}) {
  const patient = await Patient.create({ email, passwordHash, fullName, phone, timezone: TZ });
  return { id: String(patient._id), email, cookie: await cookieFor(patient), user: patient };
}

export async function createDoctor({
  fullName = "Dr. Test Doctor",
  specialization = "cardiology",
  accepting = true,
  isActive = true,
  withAvailability = true,
  email = uniqueEmail("doctor"),
} = {}) {
  const doctor = await Doctor.create({
    email,
    passwordHash,
    fullName,
    timezone: TZ,
    isActive,
    doctorProfile: {
      specialization,
      experienceYears: 10,
      clinicName: "Test Clinic",
      isAcceptingAppointments: accepting,
    },
  });
  if (withAvailability) {
    await DoctorAvailability.create({
      doctorId: doctor._id,
      revision: 0,
      timezone: TZ,
      slotDurationMinutes: 30,
      bookingPolicy: { horizonDays: 30, minNoticeMinutes: 60, lateCancelWindowMinutes: 240 },
      weeklySchedule: MON_SAT_9_TO_6,
    });
  }
  return { id: String(doctor._id), email, cookie: await cookieFor(doctor), user: doctor };
}

const today = () => DateTime.now().setZone(TZ).startOf("day");

// Clinic-local "YYYY-MM-DD", `days` from today.
export function localDateOffset(days) {
  return today().plus({ days }).toISODate();
}

// The n-th Mon-Sat date after today (never today, so min-notice never bites).
export function nextWorkingDate(n = 1) {
  let date = today();
  let found = 0;
  while (found < n) {
    date = date.plus({ days: 1 });
    if (date.weekday !== 7) found += 1;
  }
  return date.toISODate();
}

export function nextSunday() {
  let date = today().plus({ days: 1 });
  while (date.weekday !== 7) date = date.plus({ days: 1 });
  return date.toISODate();
}
