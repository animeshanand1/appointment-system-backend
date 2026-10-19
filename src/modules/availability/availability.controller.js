import {
  availabilitySchema,
  createTimeOffSchema,
  listTimeOffQuerySchema,
} from "./availability.validators.js";
import { createTimeOff, deleteTimeOff, getAvailability, listTimeOff, saveAvailability } from "./availability.service.js";

export async function getMine(req, res, next) {
  try {
    res.status(200).json({ data: await getAvailability(req.auth) });
  } catch (err) {
    next(err);
  }
}

export async function saveMine(req, res, next) {
  try {
    const input = availabilitySchema.parse(req.body);
    const { availability, outOfHoursBookings } = await saveAvailability(req.auth, input);
    res.status(200).json({ data: availability, meta: { outOfHoursBookings } });
  } catch (err) {
    next(err);
  }
}

export async function listMyTimeOff(req, res, next) {
  try {
    const query = listTimeOffQuerySchema.parse(req.query);
    res.status(200).json({ data: await listTimeOff(req.auth, query) });
  } catch (err) {
    next(err);
  }
}

export async function addTimeOff(req, res, next) {
  try {
    const input = createTimeOffSchema.parse(req.body);
    const { timeOff, dryRun, ...meta } = await createTimeOff(req.auth, input);
    res.status(dryRun ? 200 : 201).json({ data: timeOff, meta });
  } catch (err) {
    next(err);
  }
}

export async function removeTimeOff(req, res, next) {
  try {
    await deleteTimeOff(req.auth, req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
