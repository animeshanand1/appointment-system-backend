import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { authenticate, requireRole } from "../../middleware/authenticate.js";
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

// Runs after authenticate, so the limit is per user rather than per IP.
const bookingLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  keyGenerator: (req) => req.auth.userId,
  standardHeaders: true,
  legacyHeaders: false,
});

appointmentsRouter.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

appointmentsRouter.post("/", authenticate, requireRole("patient"), bookingLimiter, book);
appointmentsRouter.get("/my-appointments", authenticate, requireRole("patient", "doctor"), listMine);
appointmentsRouter.get("/:id", authenticate, getOne);
appointmentsRouter.patch("/:id/status", authenticate, requireRole("patient", "doctor"), changeStatus);

// Rescheduling: the doctor moves directly or decides; the patient can only request.
appointmentsRouter.patch("/:id/reschedule", authenticate, requireRole("doctor"), reschedule);
appointmentsRouter.put("/:id/reschedule-request", authenticate, requireRole("patient"), bookingLimiter, putRescheduleRequest);
appointmentsRouter.delete("/:id/reschedule-request", authenticate, requireRole("patient"), deleteRescheduleRequest);
appointmentsRouter.post("/:id/reschedule-request/decision", authenticate, requireRole("doctor"), decideReschedule);
