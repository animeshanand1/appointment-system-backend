import { Appointment } from "./models/Appointment.js";
import { logger } from "../lib/logger.js";

// The tick indexes are what actually prevent double booking (doctor side) and
// a patient holding two overlapping appointments (patient side). Booking is
// unsafe without them, so refuse to start.
const CRITICAL_APPOINTMENT_INDEXES = ["uniq_doctor_active_ticks", "uniq_patient_active_ticks"];

export async function assertCriticalIndexes() {
  // Ensures indexes are built (autoIndex) and the collection exists before listing them.
  await Appointment.init();
  const indexNames = new Set((await Appointment.collection.indexes()).map((index) => index.name));
  const missing = CRITICAL_APPOINTMENT_INDEXES.filter((name) => !indexNames.has(name));

  if (missing.length > 0) {
    logger.error({ missing }, "Missing required indexes on appointments collection");
    process.exit(1);
  }
}
