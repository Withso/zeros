import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Bearer prefixes make a leaked value recognisable in logs and scanners. */
export type CloudV2TokenKind = "worker" | "connect" | "proxy";
const PREFIX: Record<CloudV2TokenKind, string> = { worker: "zw2w_", connect: "zw2c_", proxy: "zw2p_" };
const BODY = /^[A-Za-z0-9_-]{43}$/;

export function newCloudV2Token(kind: CloudV2TokenKind): { token: string; hash: Buffer } {
  const token = PREFIX[kind] + randomBytes(32).toString("base64url");
  return { token, hash: hashCloudV2Token(token) };
}

export function hashCloudV2Token(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Shape check only; authority always comes from the stored hash. */
export function isCloudV2Token(value: unknown, kind: CloudV2TokenKind): value is string {
  return typeof value === "string" && value.startsWith(PREFIX[kind]) && BODY.test(value.slice(PREFIX[kind].length));
}

export function sameHash(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
