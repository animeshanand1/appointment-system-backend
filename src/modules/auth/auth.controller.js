import { registerSchema, loginSchema, logoutSchema } from "./auth.validators.js";
import { registerUser, authenticateUser, withAvailabilityFlag } from "./auth.service.js";
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
