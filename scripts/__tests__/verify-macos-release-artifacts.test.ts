import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertExpectedMetadata,
  cleanupVerificationScratch,
  findNonOwnerWritable,
  parseArguments,
  parseCodeSignMetadata,
} from "../verify-macos-release-artifacts.mjs";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("macOS release artifact verification", () => {
  it("parses an explicit artifact and signing policy", () => {
    expect(
      parseArguments([
        "--dmg",
        "release/Zeros-1.2.3-arm64.dmg",
        "--zip",
        "release/Zeros-1.2.3-arm64-mac.zip",
        "--app-name",
        "Zeros.app",
        "--bundle-id",
        "com.zeros",
        "--team-id",
        "H8MS56JU2Z",
      ]),
    ).toEqual({
      dmg: resolve("release/Zeros-1.2.3-arm64.dmg"),
      zip: resolve("release/Zeros-1.2.3-arm64-mac.zip"),
      appName: "Zeros.app",
      bundleId: "com.zeros",
      teamId: "H8MS56JU2Z",
    });
  });

  it("rejects an app name that could escape the artifact root", () => {
    expect(() =>
      parseArguments([
        "--dmg",
        "release/app.dmg",
        "--zip",
        "release/app.zip",
        "--app-name",
        "../Zeros.app",
        "--bundle-id",
        "com.zeros",
        "--team-id",
        "H8MS56JU2Z",
      ]),
    ).toThrow("one top-level .app bundle name");
  });

  it("requires the expected Developer ID, bundle, runtime, and timestamp", () => {
    const metadata = parseCodeSignMetadata(`
Identifier=com.zeros.alpha
CodeDirectory v=20500 size=443 flags=0x10000(runtime) hashes=3+7 location=embedded
CDHash=0123456789abcdef
Signature size=9032
Authority=Developer ID Application: WITHSO TECHNOLOGIES (OPC) PRIVATE LIMITED (H8MS56JU2Z)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=29 Aug 2026 at 12:01:02 AM
TeamIdentifier=H8MS56JU2Z
`);

    expect(() =>
      assertExpectedMetadata(
        metadata,
        { bundleId: "com.zeros.alpha", teamId: "H8MS56JU2Z" },
        "updater ZIP app",
      ),
    ).not.toThrow();
    expect(() =>
      assertExpectedMetadata(
        metadata,
        { bundleId: "com.zeros.alpha", teamId: "AAAAAAAAAA" },
        "updater ZIP app",
      ),
    ).toThrow("expected Apple team AAAAAAAAAA");
  });

  it("rejects signed metadata without a secure timestamp", () => {
    const metadata = parseCodeSignMetadata(`
Identifier=com.zeros.beta
CodeDirectory v=20500 size=443 flags=0x10000(runtime) hashes=3+7 location=embedded
CDHash=0123456789abcdef
Authority=Developer ID Application: WITHSO TECHNOLOGIES (OPC) PRIVATE LIMITED (H8MS56JU2Z)
TeamIdentifier=H8MS56JU2Z
`);

    expect(() =>
      assertExpectedMetadata(
        metadata,
        { bundleId: "com.zeros.beta", teamId: "H8MS56JU2Z" },
        "DMG app",
      ),
    ).toThrow("secure signing timestamp is missing");
  });

  it("finds owner-read-only entries that would strand an in-place update", () => {
    const root = mkdtempSync(join(tmpdir(), "zeros-release-mode-test-"));
    temporaryRoots.push(root);
    const writable = join(root, "writable");
    const readOnly = join(root, "read-only");
    mkdirSync(writable);
    writeFileSync(readOnly, "fixture");
    chmodSync(readOnly, 0o444);

    expect(findNonOwnerWritable(root)).toEqual([readOnly]);
  });

  it("preserves a still-mounted scratch directory without masking the verification failure", () => {
    const remove = vi.fn();
    const report = vi.fn();
    const verificationFailure = new Error("signature rejected");

    expect(() =>
      cleanupVerificationScratch(
        {
          attached: true,
          mount: "/private/tmp/verify/dmg",
          scratch: "/private/tmp/verify",
          priorFailure: verificationFailure,
        },
        {
          detach: () => ({ status: 16, output: "resource busy" }),
          remove,
          report,
        },
      ),
    ).not.toThrow();
    expect(remove).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(
      expect.stringContaining("resource busy"),
    );
  });
});
