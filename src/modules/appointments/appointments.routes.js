import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/authenticate.js";
import { bookingLimiter, userWritesLimiter } from "../../middleware/rateLimits.js";
import {
  book,
  listMine,
  getOne,
  changeStatus,
  reschedule,
  putRescheduleRequest,
  deleteRescheduleRequest,
  decideReschedule,
} from "./appointments.controller.js";

export const appointmentsRouter = Router();

appointmentsRouter.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

appointmentsRouter.post("/", authenticate, requireRole("patient"), bookingLimiter, book);
appointmentsRouter.get("/my-appointments", authenticate, requireRole("patient", "doctor"), listMine);
appointmentsRouter.get("/:id", authenticate, getOne);
appointmentsRouter.patch("/:id/status", authenticate, requireRole("patient", "doctor"), userWritesLimiter, changeStatus);

// Rescheduling: the doctor moves directly or decides; the patient can only request.
appointmentsRouter.patch("/:id/reschedule", authenticate, requireRole("doctor"), userWritesLimiter, reschedule);
appointmentsRouter.put("/:id/reschedule-request", authenticate, requireRole("patient"), bookingLimiter, putRescheduleRequest);
appointmentsRouter.delete("/:id/reschedule-request", authenticate, requireRole("patient"), userWritesLimiter, deleteRescheduleRequest);
appointmentsRouter.post("/:id/reschedule-request/decision", authenticate, requireRole("doctor"), userWritesLimiter, decideReschedule);
