import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  cloudDesktopDeviceLabel,
  cloudDesktopPlatform,
  cloudDeviceEnrollmentIdempotencyKey,
  cloudDevicePublicKeyFingerprint,
} from "../cloud-device-enrollment";
import { createCloudReplicaDeviceCredential } from "../cloud-replica-device";

describe("cloud desktop device enrollment identity", () => {
  it("derives one deterministic registration key and fingerprint", () => {
    const accountUserId = randomUUID();
    const credential = createCloudReplicaDeviceCredential(accountUserId);
    const first = cloudDeviceEnrollmentIdempotencyKey(
      accountUserId,
      credential.publicKey,
    );
    expect(first).toMatch(/^device-register-[a-f0-9]{64}$/);
    expect(
      cloudDeviceEnrollmentIdempotencyKey(accountUserId, credential.publicKey),
    ).toBe(first);
    expect(cloudDevicePublicKeyFingerprint(credential.publicKey)).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("normalizes host labels and desktop platforms", () => {
    expect(cloudDesktopDeviceLabel("  my\u0000-mac  ")).toBe("my-mac desktop");
    expect(cloudDesktopDeviceLabel(" \u0000 ")).toBe("Zeros desktop");
    expect(cloudDesktopPlatform("darwin")).toBe("macos");
    expect(cloudDesktopPlatform("win32")).toBe("windows");
    expect(cloudDesktopPlatform("freebsd")).toBe("linux");
  });

  it("rejects malformed account and public-key identities", () => {
    expect(() =>
      cloudDeviceEnrollmentIdempotencyKey("not-an-account", "A".repeat(43)),
    ).toThrow("Cloud account is invalid");
    expect(() => cloudDevicePublicKeyFingerprint("*".repeat(43))).toThrow(
      "Cloud device public key is invalid",
    );
  });
});
