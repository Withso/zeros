import { describe, expect, it } from "vitest";
import {
  cloudHostRuntimeProfile,
  readCloudHostRuntimeProfile,
  cloudRuntimeProcessSecurityQualified,
} from "../cloud-workspace-validation/sandbox/cloud-runtime-profile.mjs";

describe("cloud host runtime identities", () => {
  it.each([1, 2, 3])("refuses worker-v%i host identities and process qualification", version => {
    expect(() => cloudHostRuntimeProfile({ version, profile: `zeros-cloud-worker-v${version}`,
      backend: "cloud-worker", uid: 10001, gid: 10001 })).toThrow();
    expect(cloudRuntimeProcessSecurityQualified(version, "2", { secure: true, noNewPrivs: 1, seccompMode: 2 })).toBe(false);
  });

  it("qualifies seccomp at the isolated engine instead of requiring a containerized VM broker", () => {
    expect(
      cloudRuntimeProcessSecurityQualified(4, "0", {
        secure: true,
        noNewPrivs: 1,
        seccompMode: 2,
      }),
    ).toBe(true);
    for (const identity of [
      null,
      { secure: true },
      { secure: true, noNewPrivs: 0, seccompMode: 2 },
      { secure: true, noNewPrivs: 1, seccompMode: 0 },
    ])
      expect(cloudRuntimeProcessSecurityQualified(4, "2", identity)).toBe(
        false,
      );
    expect(cloudRuntimeProcessSecurityQualified(1, "2", null)).toBe(false);
    expect(
      cloudRuntimeProcessSecurityQualified(1, "0", {
        secure: true,
        noNewPrivs: 1,
        seccompMode: 2,
      }),
    ).toBe(false);
    expect(
      cloudRuntimeProcessSecurityQualified(5, "2", {
        secure: true,
        noNewPrivs: 1,
        seccompMode: 2,
      }),
    ).toBe(false);
  });
  const marker = {
    version: 4,
    profile: "zeros-cloud-worker-v4",
    backend: "cloud-worker",
    uid: 10001,
    gid: 10001,
  };
  it("separates the general engine from the broker's runtime and setup authority", () => {
    expect(cloudHostRuntimeProfile(marker)).toEqual({
      version: 4,
      profile: "zeros-cloud-worker-v4",
      engineUid: 10003,
      engineGid: 10003,
      runtimeDirectory: "/run/zeros/engine",
      setupDirectory: "/srv/zeros/setup",
      managedSettingsDirectory: "/srv/zeros/managed-settings",
    });
    expect(cloudRuntimeProcessSecurityQualified(4,"0",{secure:true,noNewPrivs:1,seccompMode:2})).toBe(true);
  });
  it("rejects mismatched profiles and caller-selected worker identities", () => {
    for (const change of [
      { version: 1 },
      { version: 3 },
      { uid: 0 },
      { gid: 10003 },
      { backend: "local" },
    ])
      expect(() => cloudHostRuntimeProfile({ ...marker, ...change })).toThrow(
        /runtime/,
      );
    if (process.getuid?.() !== 0)
      expect(() =>
        readCloudHostRuntimeProfile("/tmp/cloud-worker.json"),
      ).toThrow(/root admission/);
  });
});
