// Input schemas for the doctor self-service endpoints. The schedule invariants
// are listed in docs/architecture/02-data-model.md §2.2.
import { z } from "zod";
import { isValidLocalDate, parseHHmm } from "../../lib/time.js";
import { multilineText, text, timeZone } from "../../lib/sanitize.js";
import { workingWindows } from "../slots/slot.engine.js";

const SLOT_DURATIONS = [10, 15, 20, 30, 45, 60];
const MAX_BREAKS_PER_DAY = 3;

const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const LOCAL_DATETIME_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;

const hhmm = z
  .string()
  .regex(HHMM_PATTERN, "Expected a time in HH:mm format")
  .refine((value) => parseHHmm(value) % 5 === 0, "Times must fall on a 5-minute boundary");

const breakSchema = z.object({ start: hhmm, end: hhmm }).strict();

const daySchema = z
  .object({
    isoWeekday: z.number().int().min(1).max(7),
    isWorking: z.boolean(),
    shiftStart: hhmm.optional(),
    shiftEnd: hhmm.optional(),
    breaks: z.array(breakSchema).max(MAX_BREAKS_PER_DAY).default([]),
  })
  .strict();

const bookingPolicySchema = z
  .object({
    horizonDays: z.number().int().min(1).max(90).default(30),
    minNoticeMinutes: z
      .number()
      .int()
      .min(0)
      .max(1440)
      .refine((value) => value % 5 === 0, "Must be a multiple of 5")
      .default(60),
    lateCancelWindowMinutes: z.number().int().min(0).max(10080).default(240),
  })
  .strict();

// Reports problems with the path of the offending day or break so the form can
// put each message next to its field.
function checkDay(day, index, slotDurationMinutes, ctx) {
  const at = (...path) => ["weeklySchedule", index, ...path];

  if (!day.isWorking) return;

  if (!day.shiftStart) ctx.addIssue({ code: "custom", path: at("shiftStart"), message: "Start time is required on a working day" });
  if (!day.shiftEnd) ctx.addIssue({ code: "custom", path: at("shiftEnd"), message: "End time is required on a working day" });
  if (!day.shiftStart || !day.shiftEnd) return;

  const shiftStart = parseHHmm(day.shiftStart);
  const shiftEnd = parseHHmm(day.shiftEnd);
  if (shiftEnd <= shiftStart) {
    ctx.addIssue({ code: "custom", path: at("shiftEnd"), message: "End time must be after the start time" });
    return;
  }

  let previousEnd = shiftStart;
  let breaksAreValid = true;
  day.breaks.forEach((brk, breakIndex) => {
    const start = parseHHmm(brk.start);
    const end = parseHHmm(brk.end);
    const problem =
      end <= start
        ? "A break must end after it starts"
        : start < shiftStart || end > shiftEnd
          ? "A break must sit inside the working hours"
          : start < previousEnd
            ? "Breaks must be in order and must not overlap"
            : null;
    if (problem) {
      breaksAreValid = false;
      ctx.addIssue({ code: "custom", path: at("breaks", breakIndex), message: problem });
    } else {
      previousEnd = end;
    }
  });
  if (!breaksAreValid) return;

  const fitsASlot = workingWindows(day).some((window) => window.end - window.start >= slotDurationMinutes);
  if (!fitsASlot) {
    ctx.addIssue({
      code: "custom",
      path: at("shiftEnd"),
      message: `Working hours must leave room for at least one ${slotDurationMinutes}-minute slot`,
    });
  }
}

export const availabilitySchema = z
  .object({
    // null on the first save; afterwards it must equal the stored revision.
    revision: z.number().int().min(0).nullable(),
    timezone: timeZone,
    slotDurationMinutes: z.number().refine((value) => SLOT_DURATIONS.includes(value), {
      message: `Slot length must be one of ${SLOT_DURATIONS.join(", ")} minutes`,
    }),
    bookingPolicy: bookingPolicySchema.default({}),
    weeklySchedule: z.array(daySchema).length(7, "weeklySchedule must contain exactly 7 days"),
  })
  .strict()
  .superRefine((input, ctx) => {
    const seen = new Set();
    input.weeklySchedule.forEach((day, index) => {
      if (seen.has(day.isoWeekday)) {
        ctx.addIssue({ code: "custom", path: ["weeklySchedule", index, "isoWeekday"], message: "Each weekday may appear only once" });
      }
      seen.add(day.isoWeekday);
    });

    input.weeklySchedule.forEach((day, index) => checkDay(day, index, input.slotDurationMinutes, ctx));

    if (!input.weeklySchedule.some((day) => day.isWorking)) {
      ctx.addIssue({ code: "custom", path: ["weeklySchedule"], message: "Choose at least one working day" });
    }
  })
  // Non-working days keep only their weekday, so stale shift times can't linger.
  .transform((input) => ({
    ...input,
    weeklySchedule: input.weeklySchedule
      .map((day) =>
        day.isWorking
          ? day
          : { isoWeekday: day.isoWeekday, isWorking: false, breaks: [] }
      )
      .sort((a, b) => a.isoWeekday - b.isoWeekday),
  }));

// "YYYY-MM-DDTHH:mm" with no offset: the doctor's wall-clock time.
const localDateTime = z
  .string()
  .regex(LOCAL_DATETIME_PATTERN, "Expected a local date and time like 2026-12-24T09:00")
  // Zod still runs this after a failed regex, so the match can be null.
  .refine((value) => {
    const match = LOCAL_DATETIME_PATTERN.exec(value);
    return match !== null && isValidLocalDate(match[1]) && HHMM_PATTERN.test(match[2]);
  }, "Not a real calendar date and time");

export function splitLocalDateTime(value) {
  const [, date, time] = LOCAL_DATETIME_PATTERN.exec(value);
  return { date, minutes: parseHHmm(time) };
}

export const createTimeOffSchema = z
  .object({
    startLocal: localDateTime,
    endLocal: localDateTime,
    reason: text({ max: 200 })
      .transform((value) => value || undefined)
      .optional(),
    dryRun: z.boolean().default(false),
    cancelConflictingAppointments: z.boolean().default(false),
  })
  .strict()
  .refine((input) => !(input.dryRun && input.cancelConflictingAppointments), {
    message: "A dry run can't cancel appointments",
    path: ["cancelConflictingAppointments"],
  });

export const listTimeOffQuerySchema = z
  .object({
    from: z.string().refine(isValidLocalDate, "Expected a real calendar date in YYYY-MM-DD format").optional(),
  })
  .strict();

// Partial update: at least one key, null clears an optional text field.
export const updateProfileSchema = z
  .object({
    qualifications: z.array(text({ min: 1, max: 100 })).max(10),
    experienceYears: z.number().int().min(0).max(70).nullable(),
    bio: multilineText({ max: 1000 }).nullable(),
    clinicName: text({ max: 120 }).nullable(),
    clinicAddress: text({ max: 300 }).nullable(),
    isAcceptingAppointments: z.boolean(),
  })
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, "Provide at least one field to update");

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Expected a 24-character hex id");
