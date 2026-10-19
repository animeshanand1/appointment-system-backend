// Seeds demo doctors (with weekly availability) and the demo patient used by
// the login page's "Quick Demo Fill". Idempotent: existing users keep their
// passwords; profiles and schedules are brought back to the values below.
//
//   npm run seed                       uses MONGODB_URI from .env
//   SEED_TIMEZONE=Asia/Kolkata npm run seed
import { pathToFileURL } from "node:url";
import argon2 from "argon2";
import mongoose from "mongoose";
import { connectDB } from "../src/db/connection.js";
import { Admin, Doctor, DoctorAvailability, Patient, User } from "../src/db/models/index.js";

const TIMEZONE = process.env.SEED_TIMEZONE || "America/New_York";
// Demo passwords are public (they're in the frontend's dev build). Override
// them with SEED_DOCTOR_PASSWORD / SEED_PATIENT_PASSWORD for shared environments.
const DOCTOR_PASSWORD = process.env.SEED_DOCTOR_PASSWORD || "doctor@2026";
const PATIENT_PASSWORD = process.env.SEED_PATIENT_PASSWORD || "patient@2026";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || "admin@2026";

export const DEMO_ADMIN = { email: "admin@carepulse.org", fullName: "Demo Admin" };

export const DEMO_PATIENT = { email: "sarah.jenkins@carepulse.org", fullName: "Sarah Jenkins", password: PATIENT_PASSWORD };

export const DEMO_DOCTORS = [
  { email: "dr.jenkins@carepulse.org", fullName: "Dr. Sarah Jenkins", specialization: "cardiology", experienceYears: 18 },
  { email: "dr.chen@carepulse.org", fullName: "Dr. Daniel Chen", specialization: "cardiology", experienceYears: 14 },
  { email: "dr.ortiz@carepulse.org", fullName: "Dr. Michael Ortiz", specialization: "cardiology", experienceYears: 11 },
  { email: "dr.vance@carepulse.org", fullName: "Dr. Marcus Vance", specialization: "neurology", experienceYears: 16 },
  { email: "dr.rostova@carepulse.org", fullName: "Dr. Elena Rostova", specialization: "neurology", experienceYears: 9 },
  { email: "dr.bennett@carepulse.org", fullName: "Dr. Chloe Bennett", specialization: "pediatrics", experienceYears: 12 },
  { email: "dr.patel@carepulse.org", fullName: "Dr. Amy Patel", specialization: "pediatrics", experienceYears: 7 },
  { email: "dr.king@carepulse.org", fullName: "Dr. Robert King", specialization: "orthopedics", experienceYears: 20 },
  { email: "dr.wilson@carepulse.org", fullName: "Dr. James Wilson", specialization: "orthopedics", experienceYears: 10 },
  { email: "dr.reyes@carepulse.org", fullName: "Dr. Sophia Reyes", specialization: "ophthalmology", experienceYears: 13 },
  { email: "dr.dent@carepulse.org", fullName: "Dr. Arthur Dent", specialization: "ophthalmology", experienceYears: 8 },
  { email: "dr.verma@carepulse.org", fullName: "Dr. Asha Verma", specialization: "internal-medicine", experienceYears: 15 },
  { email: "dr.chang@carepulse.org", fullName: "Dr. Michael Chang", specialization: "internal-medicine", experienceYears: 6 },
];

// Mon-Sat 09:00-18:00 with a 13:00-14:00 lunch break, Sunday off.
const WEEKLY_SCHEDULE = [1, 2, 3, 4, 5, 6, 7].map((isoWeekday) =>
  isoWeekday === 7
    ? { isoWeekday, isWorking: false, breaks: [] }
    : { isoWeekday, isWorking: true, shiftStart: "09:00", shiftEnd: "18:00", breaks: [{ start: "13:00", end: "14:00" }] }
);

async function upsertDoctor({ email, fullName, specialization, experienceYears }, passwordHash) {
  const doctorProfile = {
    specialization,
    experienceYears,
    clinicName: "Dr Sahayak",
    isAcceptingAppointments: true,
  };

  let doctor = await User.findOne({ email }).lean();
  if (!doctor) {
    doctor = await Doctor.create({ email, fullName, passwordHash, timezone: TIMEZONE, doctorProfile });
  } else {
    await Doctor.updateOne({ _id: doctor._id }, { $set: { fullName, isActive: true, doctorProfile } });
  }

  await DoctorAvailability.findOneAndUpdate(
    { doctorId: doctor._id },
    {
      $set: {
        timezone: TIMEZONE,
        slotDurationMinutes: 30,
        weeklySchedule: WEEKLY_SCHEDULE,
        bookingPolicy: { horizonDays: 30, minNoticeMinutes: 60, lateCancelWindowMinutes: 240 },
      },
      $setOnInsert: { revision: 0 },
    },
    { upsert: true, runValidators: true }
  );
}

export async function seedDemoData() {
  const doctorHash = await argon2.hash(DOCTOR_PASSWORD, { type: argon2.argon2id });
  for (const doctor of DEMO_DOCTORS) await upsertDoctor(doctor, doctorHash);

  if (!(await User.exists({ email: DEMO_PATIENT.email }))) {
    await Patient.create({
      email: DEMO_PATIENT.email,
      fullName: DEMO_PATIENT.fullName,
      passwordHash: await argon2.hash(PATIENT_PASSWORD, { type: argon2.argon2id }),
      timezone: TIMEZONE,
    });
  }

  if (!(await User.exists({ email: DEMO_ADMIN.email }))) {
    await Admin.create({ ...DEMO_ADMIN, passwordHash: await argon2.hash(ADMIN_PASSWORD, { type: argon2.argon2id }) });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Demo accounts with known passwords would be a backdoor on a real deployment.
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEMO_SEED !== "true") {
    console.error("Refusing to seed demo accounts with NODE_ENV=production (set ALLOW_DEMO_SEED=true to override).");
    process.exit(1);
  }
  await connectDB();
  await seedDemoData();
  console.log(`Seeded ${DEMO_DOCTORS.length} doctors (${TIMEZONE}), demo patient ${DEMO_PATIENT.email} and admin ${DEMO_ADMIN.email}`);
  await mongoose.disconnect();
}
