import { SignJWT, jwtVerify } from "jose";
import { env } from "../config/env.js";

const secret = new TextEncoder().encode(env.JWT_SECRET);
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60; // 12h, see docs/architecture/01-system-architecture.md §1.5

export async function signSession({ userId, role, tokenVersion }) {
  return new SignJWT({ role, tv: tokenVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(secret);
}

export async function verifySession(token) {
  const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
  return payload;
}

export const SESSION_COOKIE_NAME = "session";
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/api",
  maxAge: SESSION_MAX_AGE_SECONDS * 1000,
};
