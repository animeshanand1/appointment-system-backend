// Per-doctor invite codes: generation, hashing and the atomic claim used at
// registration.
import { createHash, randomInt } from "node:crypto";
import mongoose from "mongoose";
import { InviteCode } from "../../db/models/index.js";

// No 0/O/1/I/L, so codes survive being read out over the phone.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function generateInviteCode() {
  const group = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `DOC-${group()}-${group()}-${group()}-${group()}`;
}

export function hashInviteCode(code) {
  return createHash("sha256").update(String(code).trim().toUpperCase()).digest("hex");
}

/**
 * Marks a valid code as used. Atomic: two registrations racing for the same
 * code can't both succeed.
 * @returns the claimed invite, or null when the code is unknown, used,
 *   revoked, expired or reserved for a different email.
 */
export async function claimInviteCode(code, email, now = new Date()) {
  return InviteCode.findOneAndUpdate(
    {
      codeHash: hashInviteCode(code),
      usedAt: null,
      revokedAt: null,
      expiresAt: mongoose.trusted({ $gt: now }),
      $or: mongoose.trusted([{ email: null }, { email }]),
    },
    { $set: { usedAt: now } },
    { new: true }
  ).lean();
}

export async function completeInviteClaim(inviteId, userId) {
  await InviteCode.updateOne({ _id: inviteId }, { $set: { usedBy: userId } });
}

// Gives the code back when registration fails after the claim (e.g. the email
// was already taken).
export async function releaseInviteClaim(inviteId) {
  await InviteCode.updateOne({ _id: inviteId, usedBy: null }, { $unset: { usedAt: "" } });
}
