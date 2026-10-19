import "dotenv/config";
import { z } from "zod";


// This file loads and validates all environment variables before the server starts.
// If any required configuration is missing or invalid, the application stops immediately.

// Placeholder values from .env.example must never reach production.
const EXAMPLE_VALUES = new Set(["change-this-to-a-long-random-string", "change-this-invite-code"]);

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(5000),
    APP_ORIGIN: z.string().url(),
    MONGODB_URI: z.string().min(1),
    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
    DOCTOR_INVITE_CODE: z.string().min(1).max(128),
    // Number of reverse proxies in front of the API (load balancer, CDN), so
    // req.ip and the rate limiters see the client's address rather than the
    // proxy's. 0 when the API is exposed directly.
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    if (EXAMPLE_VALUES.has(env.JWT_SECRET)) {
      ctx.addIssue({ code: "custom", path: ["JWT_SECRET"], message: "Replace the example JWT_SECRET" });
    }
    if (EXAMPLE_VALUES.has(env.DOCTOR_INVITE_CODE) || env.DOCTOR_INVITE_CODE.length < 16) {
      ctx.addIssue({
        code: "custom",
        path: ["DOCTOR_INVITE_CODE"],
        message: "Use a random invite code of at least 16 characters in production",
      });
    }
    if (!env.APP_ORIGIN.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["APP_ORIGIN"], message: "APP_ORIGIN must be https in production" });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
