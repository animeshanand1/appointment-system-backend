// Creates a hospital admin account. Admins can't self-register.
//
//   ADMIN_EMAIL=ops@hospital.org ADMIN_NAME="Priya Shah" ADMIN_PASSWORD='...' npm run create-admin
import argon2 from "argon2";
import mongoose from "mongoose";
import { z } from "zod";
import { connectDB } from "../src/db/connection.js";
import { Admin, User } from "../src/db/models/index.js";
import { email, newPassword, personName } from "../src/lib/sanitize.js";

const input = z
  .object({ ADMIN_EMAIL: email, ADMIN_NAME: personName, ADMIN_PASSWORD: newPassword })
  .safeParse(process.env);

if (!input.success) {
  console.error("Set ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD:", input.error.flatten().fieldErrors);
  process.exit(1);
}

const { ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD } = input.data;

await connectDB();
if (await User.exists({ email: ADMIN_EMAIL })) {
  console.error(`An account with ${ADMIN_EMAIL} already exists.`);
  await mongoose.disconnect();
  process.exit(1);
}
await Admin.create({
  email: ADMIN_EMAIL,
  fullName: ADMIN_NAME,
  passwordHash: await argon2.hash(ADMIN_PASSWORD, { type: argon2.argon2id }),
});
console.log(`Admin ${ADMIN_EMAIL} created.`);
await mongoose.disconnect();
