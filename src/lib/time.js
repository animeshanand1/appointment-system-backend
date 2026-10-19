// The only module allowed to convert between wall-clock time (HH:mm + IANA
// zone) and UTC instants. See docs/architecture/03-core-algorithms.md §3.4.
// Everything here is built on Luxon so DST and zone handling stays correct.
//
// Conventions: instants are JS Dates (UTC), calendar dates are "YYYY-MM-DD"
// strings, wall-clock times are minutes since local midnight or "HH:mm".
import { DateTime, IANAZone } from "luxon";

export const TICK_MINUTES = 5;
export const MINUTE_MS = 60 * 1000;
export const TICK_MS = TICK_MINUTES * MINUTE_MS;

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * MINUTE_MS;

export function nowUTC() {
  return DateTime.utc();
}

export function isValidTimeZone(tz) {
  return typeof tz === "string" && IANAZone.isValidZone(tz);
}

// Rejects both bad shapes ("2026-9-7") and impossible dates ("2026-02-30").
export function isValidLocalDate(date) {
  if (typeof date !== "string" || !LOCAL_DATE_PATTERN.test(date)) return false;
  const parsed = DateTime.fromISO(date, { zone: "utc" });
  return parsed.isValid && parsed.toISODate() === date;
}

export function localDateOf(instant, tz) {
  return DateTime.fromJSDate(instant, { zone: tz }).toISODate();
}

export function localTimeOf(instant, tz) {
  return DateTime.fromJSDate(instant, { zone: tz }).toFormat("HH:mm");
}

export function addDaysToLocalDate(date, days) {
  return DateTime.fromISO(date, { zone: "utc" }).plus({ days }).toISODate();
}

// 1 = Monday ... 7 = Sunday. A calendar date's weekday doesn't depend on the zone.
export function isoWeekdayOf(date) {
  return DateTime.fromISO(date, { zone: "utc" }).weekday;
}

export function parseHHmm(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export function formatHHmm(minutes) {
  const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
  return `${hours}:${String(minutes % 60).padStart(2, "0")}`;
}

// Wall-clock time on a local date -> UTC instant, with the DST policy:
// a time inside a spring-forward gap returns null, and an ambiguous time
// (fall-back repeat) resolves to the earlier instant. Luxon's own resolution
// depends on the current offset, so it's done explicitly here to stay deterministic.
export function wallClockToInstant(date, minutesSinceMidnight, tz) {
  const zone = IANAZone.create(tz);
  const [year, month, day] = date.split("-").map(Number);
  const wallAsUTC = Date.UTC(year, month - 1, day) + minutesSinceMidnight * MINUTE_MS;

  // Zones never change offset twice within a day, so the offsets a day on
  // either side cover every valid reading of this wall-clock time.
  const candidateOffsets = new Set([zone.offset(wallAsUTC - DAY_MS), zone.offset(wallAsUTC + DAY_MS)]);
  let earliest = null;
  for (const offset of candidateOffsets) {
    const instant = wallAsUTC - offset * MINUTE_MS;
    if (zone.offset(instant) === offset && (earliest === null || instant < earliest)) earliest = instant;
  }
  return earliest === null ? null : new Date(earliest);
}

// Local midnight as an instant. Never "start + 24h": DST days are 23 or 25 hours.
export function startOfLocalDay(date, tz) {
  return DateTime.fromISO(date, { zone: tz }).startOf("day").toJSDate();
}

export function localDayWindow(date, tz) {
  return { start: startOfLocalDay(date, tz), end: startOfLocalDay(addDaysToLocalDate(date, 1), tz) };
}

export function isTickAligned(instant) {
  return instant.getTime() % TICK_MS === 0;
}

// Every 5-min instant in [startAt, endAt).
export function ticksBetween(startAt, endAt) {
  const ticks = [];
  for (let t = startAt.getTime(); t < endAt.getTime(); t += TICK_MS) ticks.push(new Date(t));
  return ticks;
}

export function addMinutes(instant, minutes) {
  return new Date(instant.getTime() + minutes * MINUTE_MS);
}

export function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart.getTime() < bEnd.getTime() && aEnd.getTime() > bStart.getTime();
}
