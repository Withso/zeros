import path from "node:path";
import { describe, expect, it } from "vitest";
import { releaseBunVersion, sidecarBunMismatch } from "../bun-release-pin.mjs";

const repoRoot = path.resolve(__dirname, "../..");

describe("the sidecar's Bun", () => {
  it("reads the release workflow's exact pin", () => {
    expect(releaseBunVersion(repoRoot)).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("builds only with the release pin unless explicitly overridden", () => {
    expect(sidecarBunMismatch("1.4.4", "1.4.4", {})).toBeNull();
    expect(sidecarBunMismatch("1.3.13", "1.4.4", {})).toMatch(/1\.3\.13 differs from the release pin 1\.4\.4/);
    expect(sidecarBunMismatch("1.3.13", "1.4.4", { ZEROS_SIDECAR_ANY_BUN: "1" })).toBeNull();
    expect(sidecarBunMismatch("1.3.13", "1.4.4", { ZEROS_SIDECAR_ANY_BUN: "yes" })).not.toBeNull();
  });
});
