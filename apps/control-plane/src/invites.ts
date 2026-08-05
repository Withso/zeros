// ──────────────────────────────────────────────────────────
// Invitation-token contract:
//   raw token  = 32 bytes CSPRNG, base64url — goes in the email/deep link
//   stored     = SHA-256(raw) only — a DB leak must not leak join links
// Redemption re-validates email binding, expiry, single-use, revocation.
// ──────────────────────────────────────────────────────────

import { createHash, randomBytes } from "node:crypto";

export function generateInviteToken(): { raw: string; hash: Buffer } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashInviteToken(raw) };
}

// Redemption looks the token up by its SHA-256 via an indexed equality on a
// UNIQUE column — a hash of 32 bytes of CSPRNG, so a timing side-channel on
// the lookup reveals nothing guessable. (A constant-time compare would add no
// real defense here and isn't on the DB lookup path.)
export function hashInviteToken(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}
