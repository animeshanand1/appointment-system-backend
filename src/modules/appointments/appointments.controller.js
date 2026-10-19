import {
  bookAppointmentSchema,
  listAppointmentsQuerySchema,
  rescheduleDecisionSchema,
  rescheduleRequestSchema,
  rescheduleSchema,
  updateStatusSchema,
} from "./appointments.validators.js";
import {
  bookAppointment,
  decideRescheduleRequest,
  getAppointmentById,
  listMyAppointments,
  requestReschedule,
  rescheduleAppointment,
  updateStatus,
  withdrawRescheduleRequest,
} from "./appointments.service.js";
import { AppError } from "../../lib/errors.js";

export async function book(req, res, next) {
  try {
    const input = bookAppointmentSchema.parse(req.body);
    const { appointment, replayed } = await bookAppointment(req.auth, input);

    if (replayed) return res.status(200).json({ data: appointment, meta: { replayed: true } });
    res.location(`/api/appointments/${appointment.id}`).status(201).json({ data: appointment });
  } catch (err) {
    next(err);
  }
}

export async function listMine(req, res, next) {
  try {
    const query = listAppointmentsQuerySchema.parse(req.query);
    if (query.date && req.auth.role !== "doctor") {
      throw new AppError("VALIDATION_FAILED", "Request validation failed", {
        status: 400,
        details: [{ path: "date", message: "The date filter is only available to doctors" }],
      });
    }

    const { appointments, meta } = await listMyAppointments(req.auth, query);
    res.status(200).json({ data: appointments, meta });
  } catch (err) {
    next(err);
  }
}

export async function getOne(req, res, next) {
  try {
    const appointment = await getAppointmentById(req.auth, req.params.id);
    res.status(200).json({ data: appointment });
  } catch (err) {
    next(err);
  }
}

export async function changeStatus(req, res, next) {
  try {
    const input = updateStatusSchema.parse(req.body);
    const { appointment, unchanged } = await updateStatus(req.auth, req.params.id, input);
    res.status(200).json({ data: appointment, ...(unchanged ? { meta: { unchanged: true } } : {}) });
  } catch (err) {
    next(err);
  }
}

export async function reschedule(req, res, next) {
  try {
    const input = rescheduleSchema.parse(req.body);
    const appointment = await rescheduleAppointment(req.auth, req.params.id, input);
    res.status(200).json({ data: appointment });
  } catch (err) {
    next(err);
  }
}

export async function putRescheduleRequest(req, res, next) {
  try {
    const input = rescheduleRequestSchema.parse(req.body);
    const { appointment, unchanged } = await requestReschedule(req.auth, req.params.id, input);
    res.status(200).json({ data: appointment, ...(unchanged ? { meta: { unchanged: true } } : {}) });
  } catch (err) {
    next(err);
  }
}

export async function deleteRescheduleRequest(req, res, next) {
  try {
    const appointment = await withdrawRescheduleRequest(req.auth, req.params.id);
    res.status(200).json({ data: appointment });
  } catch (err) {
    next(err);
  }
}

export async function decideReschedule(req, res, next) {
  try {
    const input = rescheduleDecisionSchema.parse(req.body);
    const appointment = await decideRescheduleRequest(req.auth, req.params.id, input);
    res.status(200).json({ data: appointment });
  } catch (err) {
    next(err);
  }
}
