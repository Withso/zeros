import { describe, expect, it } from "vitest";
import {
  cloudHostRuntimeProfile,
  readCloudHostRuntimeProfile,
  cloudRuntimeProcessSecurityQualified,
} from "../cloud-workspace-validation/sandbox/cloud-runtime-profile.mjs";

describe("cloud host runtime identities", () => {
  it("qualifies seccomp at the isolated engine instead of requiring a containerized VM broker", () => {
    expect(
      cloudRuntimeProcessSecurityQualified(2, "0", {
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
      expect(cloudRuntimeProcessSecurityQualified(2, "2", identity)).toBe(
        false,
      );
    expect(cloudRuntimeProcessSecurityQualified(1, "2", null)).toBe(true);
    expect(
      cloudRuntimeProcessSecurityQualified(1, "0", {
        secure: true,
        noNewPrivs: 1,
        seccompMode: 2,
      }),
    ).toBe(false);
    expect(
      cloudRuntimeProcessSecurityQualified(4, "2", {
        secure: true,
        noNewPrivs: 1,
        seccompMode: 2,
      }),
    ).toBe(false);
  });
  const marker = {
    version: 2,
    profile: "zeros-cloud-worker-v2",
    backend: "cloud-worker",
    uid: 10001,
    gid: 10001,
  };
  it("separates the general engine from the broker's runtime and setup authority", () => {
    expect(cloudHostRuntimeProfile(marker)).toEqual({
      version: 2,
      profile: "zeros-cloud-worker-v2",
      engineUid: 10003,
      engineGid: 10003,
      runtimeDirectory: "/run/zeros/engine",
      setupDirectory: "/srv/zeros/setup",
      managedSettingsDirectory: "/srv/zeros/managed-settings",
    });
    expect(cloudHostRuntimeProfile({...marker,version:3,profile:"zeros-cloud-worker-v3"})).toMatchObject({
      version:3,profile:"zeros-cloud-worker-v3",engineUid:10003,engineGid:10003,
    });
    expect(cloudRuntimeProcessSecurityQualified(3,"0",{secure:true,noNewPrivs:1,seccompMode:2})).toBe(true);
  });
  it("retains version-one paths for already accepted legacy images", () => {
    expect(
      cloudHostRuntimeProfile({
        ...marker,
        version: 1,
        profile: "zeros-cloud-worker-v1",
      }),
    ).toMatchObject({
      engineUid: 0,
      runtimeDirectory: "/run/zeros",
      setupDirectory: "/srv/zeros/state/setup",
      managedSettingsDirectory: "/srv/zeros/state/user-settings",
    });
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
        /Unsupported/,
      );
    if (process.getuid?.() !== 0)
      expect(() =>
        readCloudHostRuntimeProfile("/tmp/cloud-worker.json"),
      ).toThrow(/root admission/);
  });
});
