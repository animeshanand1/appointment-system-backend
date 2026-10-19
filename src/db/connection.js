import mongoose from "mongoose";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

mongoose.set("sanitizeFilter", true);
mongoose.set("strictQuery", true);

export async function connectDB() {
  mongoose.set("autoIndex", env.NODE_ENV !== "production");
  await mongoose.connect(env.MONGODB_URI);
  logger.info("Connected to MongoDB");
}
