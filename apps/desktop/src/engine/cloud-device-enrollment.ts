import { createHash } from "node:crypto";
import os from "node:os";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;

function decodedPublicKey(value: string): Buffer {
  if (!BASE64URL_32.test(value)) {
    throw new Error("Cloud device public key is invalid");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) {
    bytes.fill(0);
    throw new Error("Cloud device public key is invalid");
  }
  return bytes;
}

/** Stable across the Electron-main and engine enrollment paths. A retry from
 * either process therefore resolves to the same server device instead of
 * racing two identities for one safeStorage key. */
export function cloudDeviceEnrollmentIdempotencyKey(
  accountUserId: string,
  publicKey: string,
): string {
  if (!UUID_PATTERN.test(accountUserId)) {
    throw new Error("Cloud account is invalid");
  }
  const bytes = decodedPublicKey(publicKey);
  try {
    return `device-register-${createHash("sha256")
      .update(accountUserId, "utf8")
      .update("\0")
      .update(bytes)
      .digest("hex")}`;
  } finally {
    bytes.fill(0);
  }
}

export function cloudDevicePublicKeyFingerprint(publicKey: string): string {
  const bytes = decodedPublicKey(publicKey);
  try {
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    bytes.fill(0);
  }
}

export function cloudDesktopDeviceLabel(hostname = os.hostname()): string {
  const normalized = hostname
    // eslint-disable-next-line no-control-regex -- device labels reject C0 and DEL
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .trim()
    .slice(0, 96);
  return normalized ? `${normalized} desktop`.slice(0, 120) : "Zeros desktop";
}

export function cloudDesktopPlatform(
  platform = process.platform,
): "macos" | "windows" | "linux" {
  return platform === "darwin"
    ? "macos"
    : platform === "win32"
      ? "windows"
      : "linux";
}
