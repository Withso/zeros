import { describe, expect, it, vi } from "vitest";

import {
  KEYSTORE_UNAVAILABLE_ERROR,
  ensureSafeStorageEncryption,
  prepareSafeStorageEncryption,
  shouldUseLinuxPlainTextSafeStorageFallback,
} from "../safe-storage-availability";

function fakeStore(opts: {
  available: boolean | (() => boolean);
  afterPlainText?: boolean;
}) {
  let available =
    typeof opts.available === "function" ? opts.available() : opts.available;
  const setUsePlainTextEncryption = vi.fn((usePlainText: boolean) => {
    if (usePlainText && opts.afterPlainText !== undefined) {
      available = opts.afterPlainText;
    }
  });
  return {
    setUsePlainTextEncryption,
    store: {
      isEncryptionAvailable: () => available,
      setUsePlainTextEncryption,
    },
  };
}

describe("shouldUseLinuxPlainTextSafeStorageFallback", () => {
  it("never activates on macOS, with or without Keychain", () => {
    expect(shouldUseLinuxPlainTextSafeStorageFallback("darwin", true)).toBe(
      false,
    );
    expect(shouldUseLinuxPlainTextSafeStorageFallback("darwin", false)).toBe(
      false,
    );
  });

  it("never activates on Windows", () => {
    expect(shouldUseLinuxPlainTextSafeStorageFallback("win32", false)).toBe(
      false,
    );
  });

  it("activates on Linux only when encryption is unavailable", () => {
    expect(shouldUseLinuxPlainTextSafeStorageFallback("linux", true)).toBe(
      false,
    );
    expect(shouldUseLinuxPlainTextSafeStorageFallback("linux", false)).toBe(
      true,
    );
  });
});

describe("prepareSafeStorageEncryption", () => {
  it("does not touch Electron safeStorage on macOS when Keychain works", () => {
    const { store, setUsePlainTextEncryption } = fakeStore({ available: true });
    expect(prepareSafeStorageEncryption("darwin", store)).toBe(true);
    expect(setUsePlainTextEncryption).not.toHaveBeenCalled();
  });

  it("does not enable plaintext on macOS when Keychain is denied", () => {
    const { store, setUsePlainTextEncryption } = fakeStore({
      available: false,
    });
    expect(prepareSafeStorageEncryption("darwin", store)).toBe(false);
    expect(setUsePlainTextEncryption).not.toHaveBeenCalled();
  });

  it("leaves a working Linux keyring alone so the Mac Keychain path stays the proxy", () => {
    const { store, setUsePlainTextEncryption } = fakeStore({ available: true });
    expect(prepareSafeStorageEncryption("linux", store)).toBe(true);
    expect(setUsePlainTextEncryption).not.toHaveBeenCalled();
  });

  it("enables Electron's Linux plaintext fallback when no keyring exists", () => {
    const { store, setUsePlainTextEncryption } = fakeStore({
      available: false,
      afterPlainText: true,
    });
    expect(prepareSafeStorageEncryption("linux", store)).toBe(true);
    expect(setUsePlainTextEncryption).toHaveBeenCalledTimes(1);
    expect(setUsePlainTextEncryption).toHaveBeenCalledWith(true);
  });
});

describe("ensureSafeStorageEncryption", () => {
  it("throws the existing Keychain error on macOS and never opts into plaintext", () => {
    const { store, setUsePlainTextEncryption } = fakeStore({
      available: false,
    });
    expect(() => ensureSafeStorageEncryption("darwin", store)).toThrow(
      KEYSTORE_UNAVAILABLE_ERROR,
    );
    expect(setUsePlainTextEncryption).not.toHaveBeenCalled();
  });

  it("allows Linux writes after the plaintext fallback makes encryption available", () => {
    const { store } = fakeStore({ available: false, afterPlainText: true });
    expect(() => ensureSafeStorageEncryption("linux", store)).not.toThrow();
  });

  it("still refuses to write if Linux plaintext fallback cannot enable encryption", () => {
    const { store } = fakeStore({ available: false, afterPlainText: false });
    expect(() => ensureSafeStorageEncryption("linux", store)).toThrow(
      KEYSTORE_UNAVAILABLE_ERROR,
    );
  });
});
