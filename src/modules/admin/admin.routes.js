import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/authenticate.js";
import { userWritesLimiter } from "../../middleware/rateLimits.js";
import { addInvite, appointments, invites, removeInvite, stats, updateUser, users } from "./admin.controller.js";

export const adminRouter = Router();

// Every admin route needs an admin session.
adminRouter.use(authenticate, requireRole("admin"));

adminRouter.get("/stats", stats);
adminRouter.get("/users", users);
adminRouter.patch("/users/:id", userWritesLimiter, updateUser);
adminRouter.get("/invites", invites);
adminRouter.post("/invites", userWritesLimiter, addInvite);
adminRouter.delete("/invites/:id", userWritesLimiter, removeInvite);
adminRouter.get("/appointments", appointments);
