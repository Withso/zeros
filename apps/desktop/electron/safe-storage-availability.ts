// ──────────────────────────────────────────────────────────
// safeStorage availability — Linux cloud-agent fallback
// ──────────────────────────────────────────────────────────
//
// The Mac app encrypts session tokens and the PKCE handoff verifier with
// Electron safeStorage (Keychain). Cloud-agent computer-use runs that SAME
// unpackaged app on Linux, where libsecret/D-Bus is often missing, so
// `isEncryptionAvailable()` is false and Sign in dies before AuthGate.
//
// This is NOT a Linux product port. The renderer, engine, and auth flow stay
// the Mac app. The only Linux branch is OS plumbing: Electron's
// `setUsePlainTextEncryption` is documented as a no-op on macOS/Windows, and
// we still never call it on darwin so a Keychain denial keeps throwing.
//
// Prefer a real OS keyring when `isEncryptionAvailable()` is already true
// (closest proxy to Keychain). Fall back only when Linux has no key.
// ──────────────────────────────────────────────────────────

export const KEYSTORE_UNAVAILABLE_ERROR =
  "OS keystore unavailable — cannot encrypt secrets. " +
  "On macOS this usually means Keychain access was denied.";

export interface SafeStorageAvailability {
  isEncryptionAvailable: () => boolean;
  setUsePlainTextEncryption: (usePlainText: boolean) => void;
}

/** True only on Linux when Chromium has no usable secret key yet. */
export function shouldUseLinuxPlainTextSafeStorageFallback(
  platform: NodeJS.Platform,
  encryptionAvailable: boolean,
): boolean {
  return platform === "linux" && !encryptionAvailable;
}

/**
 * Make encrypt/decrypt possible without changing the Mac Keychain path.
 * Returns whether encryption is available afterwards. Never throws.
 */
export function prepareSafeStorageEncryption(
  platform: NodeJS.Platform,
  store: SafeStorageAvailability,
): boolean {
  if (store.isEncryptionAvailable()) return true;
  if (!shouldUseLinuxPlainTextSafeStorageFallback(platform, false)) {
    return false;
  }
  store.setUsePlainTextEncryption(true);
  const available = store.isEncryptionAvailable();
  if (available) {
    console.warn(
      "[secret-store] Linux OS keyring unavailable; using in-process safeStorage key. macOS Keychain path is unchanged.",
    );
  }
  return available;
}

/** Writes must refuse to store plaintext when no encryptor exists. */
export function ensureSafeStorageEncryption(
  platform: NodeJS.Platform,
  store: SafeStorageAvailability,
): void {
  if (prepareSafeStorageEncryption(platform, store)) return;
  throw new Error(KEYSTORE_UNAVAILABLE_ERROR);
}
