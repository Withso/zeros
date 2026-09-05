// Test-only safeStorage substitute: real files/processes, not native Keychain.
// Verify native safeStorage separately with real Dev app launches.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
const key = createHash("sha256").update("dev-session-fixture-only").digest();
export const app = { getPath: () => process.env.ZEROS_TEST_INSTANCE_DIR! };
export const safeStorage = {
  isEncryptionAvailable: () => true,
  /** Encrypt fixture data with a random IV and test-only shared key; this does
   * not exercise macOS Keychain or Electron's native safeStorage implementation. */
  encryptString(value: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
  },
  /** Authenticate and decode the fixture envelope produced by encryptString. */
  decryptString(value: Buffer): string {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      value.subarray(0, 12),
    );
    decipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([
      decipher.update(value.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  },
};
