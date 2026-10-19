import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/authenticate.js";
import { doctorWritesLimiter as writesLimiter, slotsLimiter } from "../../middleware/rateLimits.js";
import { getOne, list, patchMyProfile, slots } from "./doctors.controller.js";
import {
  addTimeOff,
  getMine,
  listMyTimeOff,
  removeTimeOff,
  saveMine,
} from "../availability/availability.controller.js";

export const doctorsRouter = Router();

// Doctor self-service routes are registered before /:id so "me" is never
// treated as an ObjectId. See docs/architecture/04-api-specification.md §4.2.
doctorsRouter.use("/me", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const asDoctor = [authenticate, requireRole("doctor")];

doctorsRouter.get("/me/availability", ...asDoctor, getMine);
doctorsRouter.put("/me/availability", ...asDoctor, writesLimiter, saveMine);
doctorsRouter.patch("/me/profile", ...asDoctor, writesLimiter, patchMyProfile);
doctorsRouter.get("/me/time-off", ...asDoctor, listMyTimeOff);
doctorsRouter.post("/me/time-off", ...asDoctor, writesLimiter, addTimeOff);
doctorsRouter.delete("/me/time-off/:id", ...asDoctor, writesLimiter, removeTimeOff);

doctorsRouter.get("/", list);
doctorsRouter.get("/:id", getOne);
doctorsRouter.get("/:id/slots", slotsLimiter, slots);
