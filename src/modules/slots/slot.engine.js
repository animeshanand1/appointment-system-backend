// Pure slot-grid generator: (availability, date, blocks, now) -> day result.
// No I/O, no clock reads. See docs/architecture/03-core-algorithms.md §3.1.
//
// Pipeline: horizon gate -> day-schedule lookup -> working windows -> candidate
// generation -> instant conversion -> time-off removal -> status assignment.
import {
  addDaysToLocalDate,
  addMinutes,
  formatHHmm,
  intervalsOverlap,
  isoWeekdayOf,
  localDateOf,
  parseHHmm,
  wallClockToInstant,
  MINUTE_MS,
} from "../../lib/time.js";

function emptyDay(availability, date, reason, isWorkingDay = false) {
  return {
    date,
    timezone: availability.timezone,
    slotDurationMinutes: availability.slotDurationMinutes,
    isWorkingDay,
    reason,
    slots: [],
  };
}

// [shiftStart, shiftEnd) minus every break, in minutes since local midnight.
export function workingWindows(daySchedule) {
  let windows = [{ start: parseHHmm(daySchedule.shiftStart), end: parseHHmm(daySchedule.shiftEnd) }];
  for (const brk of daySchedule.breaks ?? []) {
    const breakStart = parseHHmm(brk.start);
    const breakEnd = parseHHmm(brk.end);
    windows = windows.flatMap((w) => {
      if (breakEnd <= w.start || breakStart >= w.end) return [w];
      return [
        { start: w.start, end: breakStart },
        { start: breakEnd, end: w.end },
      ].filter((part) => part.end > part.start);
    });
  }
  return windows;
}

/**
 * @param availability DoctorAvailability-shaped object (timezone, slotDurationMinutes, weeklySchedule, bookingPolicy)
 * @param date doctor-local calendar date, "YYYY-MM-DD"
 * @param blocks { appointments: [{ startAt, endAt }], timeOff: [{ startAt, endAt }] } overlapping the local day
 * @param now the request's single clock read (Date)
 */
export function generateSlots(availability, date, blocks, now) {
  const tz = availability.timezone;
  const duration = availability.slotDurationMinutes;
  const { horizonDays, minNoticeMinutes } = availability.bookingPolicy;

  const todayLocal = localDateOf(now, tz);
  if (date < todayLocal) return emptyDay(availability, date, "PAST_DATE");
  if (date > addDaysToLocalDate(todayLocal, horizonDays)) return emptyDay(availability, date, "BEYOND_HORIZON");

  const daySchedule = availability.weeklySchedule.find((d) => d.isoWeekday === isoWeekdayOf(date));
  if (!daySchedule?.isWorking) return emptyDay(availability, date, "DAY_OFF");

  const candidates = [];
  for (const window of workingWindows(daySchedule)) {
    for (let cursor = window.start; cursor + duration <= window.end; cursor += duration) {
      const startAt = wallClockToInstant(date, cursor, tz);
      const endAt = wallClockToInstant(date, cursor + duration, tz);
      // Drop slots that touch a DST gap or straddle a transition.
      if (!startAt || !endAt || endAt.getTime() - startAt.getTime() !== duration * MINUTE_MS) continue;
      candidates.push({ startAt, endAt, slotStartTime: formatHHmm(cursor), slotEndTime: formatHHmm(cursor + duration) });
    }
  }

  const timeOff = blocks.timeOff ?? [];
  const onShift = candidates.filter(
    (slot) => !timeOff.some((block) => intervalsOverlap(slot.startAt, slot.endAt, block.startAt, block.endAt))
  );
  if (candidates.length > 0 && onShift.length === 0) return emptyDay(availability, date, "ON_TIME_OFF", true);

  const noticeCutoff = addMinutes(now, minNoticeMinutes);
  const appointments = blocks.appointments ?? [];
  const slots = onShift
    .map((slot) => {
      let status = "available";
      if (slot.startAt < noticeCutoff) status = "unavailable";
      else if (appointments.some((a) => intervalsOverlap(slot.startAt, slot.endAt, a.startAt, a.endAt))) status = "booked";
      return { ...slot, status };
    })
    .sort((a, b) => a.startAt - b.startAt);

  return { ...emptyDay(availability, date, null, true), slots };
}
