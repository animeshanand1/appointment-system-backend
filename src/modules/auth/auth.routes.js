import { Router } from "express";
import {
  forgotPassword,
  login,
  logout,
  me,
  patchMe,
  postChangePassword,
  postResetPassword,
  register,
} from "./auth.controller.js";
import { authenticate } from "../../middleware/authenticate.js";
import {
  changePasswordLimiter,
  forgotPasswordAccountLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
  userWritesLimiter,
} from "../../middleware/rateLimits.js";

export const authRouter = Router();

authRouter.post("/register", register);
authRouter.post("/login", login);
authRouter.post("/logout", authenticate, logout);
authRouter.get("/me", authenticate, me);
authRouter.patch("/me", authenticate, userWritesLimiter, patchMe);
authRouter.post("/forgot-password", forgotPasswordLimiter, forgotPasswordAccountLimiter, forgotPassword);
authRouter.post("/reset-password", resetPasswordLimiter, postResetPassword);
authRouter.post("/change-password", authenticate, changePasswordLimiter, postChangePassword);
