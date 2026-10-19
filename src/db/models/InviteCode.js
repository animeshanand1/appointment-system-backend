import mongoose from "mongoose";

const { Schema, model } = mongoose;

// A single-use code an admin issues to one doctor. Only a SHA-256 hash of the
// code is stored; the plain code is shown once, when it's created.
const inviteCodeSchema = new Schema(
  {
    codeHash: { type: String, required: true, unique: true },
    codeHint: { type: String, required: true }, // last 4 characters, to tell codes apart in lists
    label: { type: String, required: true, trim: true, maxlength: 120 },
    // When set, only this email can register with the code.
    email: { type: String, trim: true, lowercase: true, maxlength: 254 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
    usedBy: { type: Schema.Types.ObjectId, ref: "User" },
    revokedAt: { type: Date },
  },
  { timestamps: true, strict: "throw" }
);

inviteCodeSchema.index({ createdAt: -1 }, { name: "invites_recent" });

export const InviteCode = model("InviteCode", inviteCodeSchema, "invite_codes");
