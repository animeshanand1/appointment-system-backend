import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  logoutSchema,
  registerSchema,
  resetPasswordSchema,
  updateMeSchema,
} from "./auth.validators.js";
import {
  authenticateUser,
  changePassword,
  registerUser,
  requestPasswordReset,
  resetPassword,
  updateMe,
  withAvailabilityFlag,
} from "./auth.service.js";
import { signSession, SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS } from "../../lib/jwt.js";
import { User } from "../../db/models/index.js";

export async function register(req, res, next) {
  try {
    const input = registerSchema.parse(req.body);
    const user = await registerUser(input);

    const token = await signSession({ userId: user.id, role: user.role, tokenVersion: 0 });
    res.cookie(SESSION_COOKIE_NAME, token, SESSION_COOKIE_OPTIONS);
    res.status(201).json({ data: { user } });
  } catch (err) {
    next(err);
  }
}

export async function login(req, res, next) {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const { dto, tokenVersion } = await authenticateUser(email, password);

    const token = await signSession({ userId: dto.id, role: dto.role, tokenVersion });
    res.cookie(SESSION_COOKIE_NAME, token, SESSION_COOKIE_OPTIONS);
    res.status(200).json({ data: { user: dto } });
  } catch (err) {
    next(err);
  }
}

export async function logout(req, res, next) {
  try {
    const { allDevices } = logoutSchema.parse(req.body ?? {});
    if (allDevices && req.auth) {
      await User.updateOne({ _id: req.auth.userId }, { $inc: { tokenVersion: 1 } });
    }
    res.clearCookie(SESSION_COOKIE_NAME, { ...SESSION_COOKIE_OPTIONS, maxAge: 0 });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function me(req, res, next) {
  try {
    const user = await User.findById(req.auth.userId);
    res.status(200).json({ data: { user: await withAvailabilityFlag(user) } });
  } catch (err) {
    next(err);
  }
}

export async function patchMe(req, res, next) {
  try {
    const input = updateMeSchema.parse(req.body);
    res.status(200).json({ data: { user: await updateMe(req.auth, input) } });
  } catch (err) {
    next(err);
  }
}

// Always 202 with the same body, whether or not the account exists.
export async function forgotPassword(req, res, next) {
  try {
    const { email } = forgotPasswordSchema.parse(req.body);
    await requestPasswordReset(email);
    res.status(202).json({ data: { message: "If that email has an account, a reset link is on its way." } });
  } catch (err) {
    next(err);
  }
}

export async function postResetPassword(req, res, next) {
  try {
    const { token, password } = resetPasswordSchema.parse(req.body);
    await resetPassword(token, password);
    // Any session in this browser predates the reset and is now invalid.
    res.clearCookie(SESSION_COOKIE_NAME, { ...SESSION_COOKIE_OPTIONS, maxAge: 0 });
    res.status(200).json({ data: { message: "Password updated. Please sign in." } });
  } catch (err) {
    next(err);
  }
}

// Signs out other devices and re-issues this one's session.
export async function postChangePassword(req, res, next) {
  try {
    const input = changePasswordSchema.parse(req.body);
    const { dto, tokenVersion } = await changePassword(req.auth, input);
    const token = await signSession({ userId: dto.id, role: dto.role, tokenVersion });
    res.cookie(SESSION_COOKIE_NAME, token, SESSION_COOKIE_OPTIONS);
    res.status(200).json({ data: { user: dto } });
  } catch (err) {
    next(err);
  }
}
