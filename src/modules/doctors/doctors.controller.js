import { z } from "zod";
import { getDoctorById, listDoctors, listDoctorsQuerySchema, updateMyProfile } from "./doctors.service.js";
import { getSlotsForDate } from "../slots/slot.service.js";
import { objectIdSchema, updateProfileSchema } from "../availability/availability.validators.js";

const slotsQuerySchema = z.object({ date: z.string() }).strict();

export async function list(req, res, next) {
  try {
    const query = listDoctorsQuerySchema.parse(req.query);
    const { doctors, meta } = await listDoctors(query);
    res.status(200).json({ data: doctors, meta });
  } catch (err) {
    next(err);
  }
}

export async function getOne(req, res, next) {
  try {
    const doctorId = objectIdSchema.parse(req.params.id);
    res.status(200).json({ data: await getDoctorById(doctorId) });
  } catch (err) {
    next(err);
  }
}

export async function slots(req, res, next) {
  try {
    const { date } = slotsQuerySchema.parse(req.query);
    const day = await getSlotsForDate(req.params.id, date);
    res.set("Cache-Control", "no-store").status(200).json({ data: day });
  } catch (err) {
    next(err);
  }
}

export async function patchMyProfile(req, res, next) {
  try {
    const input = updateProfileSchema.parse(req.body);
    res.status(200).json({ data: await updateMyProfile(req.auth, input) });
  } catch (err) {
    next(err);
  }
}
