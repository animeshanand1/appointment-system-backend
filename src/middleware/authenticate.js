import { AppError } from "../lib/errors.js";
import { verifySession, SESSION_COOKIE_NAME } from "../lib/jwt.js";
import { User } from "../db/models/User.js";

export async function authenticate(req, res, next) {
  try {
    const token = req.cookies?.[SESSION_COOKIE_NAME];
    if (!token) throw new AppError("UNAUTHENTICATED", "Not authenticated", { status: 401 });

    const payload = await verifySession(token);
    // tokenVersion is select: false, so it has to be requested explicitly.
    const user = await User.findById(payload.sub).select("+tokenVersion").lean();

    if (!user || !user.isActive || user.tokenVersion !== payload.tv) {
      throw new AppError("UNAUTHENTICATED", "Session is no longer valid", { status: 401 });
    }

    req.auth = { userId: String(user._id), role: user.role };
    next();
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError("UNAUTHENTICATED", "Not authenticated", { status: 401 }));
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return next(new AppError("FORBIDDEN_ROLE", "This action is not permitted for your role", { status: 403 }));
    }
    next();
  };
}
