import { describe, expect, it } from "vitest";

import {
  engineStartupWaitDecision,
  isExpectedEngineHealth,
  parseOwnedEngineManifest,
  zeroContactRespawnBackoffMs,
} from "../../../electron/engine-health";

describe("owned engine manifest", () => {
  const manifest = {
    pid: 4312,
    port: 24203,
    instance: "engine-boot-a",
    protocolVersion: 7,
  };

  it("accepts the exact child and carries its per-boot identity", () => {
    expect(parseOwnedEngineManifest(manifest, 4312)).toEqual({
      port: 24203,
      instance: "engine-boot-a",
    });
  });

  it("rejects a sibling manifest even when its port looks valid", () => {
    expect(parseOwnedEngineManifest(manifest, 9999)).toBeNull();
  });

  it("rejects legacy or malformed manifests without an exact identity", () => {
    expect(
      parseOwnedEngineManifest({ pid: 4312, port: 24203 }, 4312),
    ).toBeNull();
    expect(
      parseOwnedEngineManifest(
        { pid: 4312, port: 70_000, instance: "engine-boot-a" },
        4312,
      ),
    ).toBeNull();
  });
});

describe("engine health ownership", () => {
  it("accepts only the expected engine generation", () => {
    expect(
      isExpectedEngineHealth(
        { status: "ok", instance: "engine-boot-a" },
        "engine-boot-a",
      ),
    ).toBe(true);
    expect(
      isExpectedEngineHealth(
        { status: "ok", instance: "engine-boot-b" },
        "engine-boot-a",
      ),
    ).toBe(false);
  });

  it("rejects generic, malformed, or empty-identity health responses", () => {
    expect(isExpectedEngineHealth({ status: "ok" }, "engine-boot-a")).toBe(
      false,
    );
    expect(isExpectedEngineHealth("ok", "engine-boot-a")).toBe(false);
    expect(isExpectedEngineHealth({ status: "ok", instance: "" }, "")).toBe(
      false,
    );
  });
});

describe("zeroContactRespawnBackoffMs", () => {
  it("keeps the first respawn immediate so ordinary crash recovery is fast", () => {
    expect(zeroContactRespawnBackoffMs(0)).toBe(0);
    expect(zeroContactRespawnBackoffMs(1)).toBe(0);
  });

  it("doubles per zero-contact cycle from the probe window", () => {
    // Probe window ~15s (5 probes x 3s): 2nd → 30s, 3rd → 60s, 4th → 120s.
    expect(zeroContactRespawnBackoffMs(2)).toBe(30_000);
    expect(zeroContactRespawnBackoffMs(3)).toBe(60_000);
    expect(zeroContactRespawnBackoffMs(4)).toBe(120_000);
  });

  it("caps at five minutes so a broken environment retries forever, slowly", () => {
    expect(zeroContactRespawnBackoffMs(5)).toBe(240_000);
    expect(zeroContactRespawnBackoffMs(6)).toBe(300_000);
    expect(zeroContactRespawnBackoffMs(50)).toBe(300_000);
  });

  it("honors caller-supplied probe window and cap", () => {
    expect(
      zeroContactRespawnBackoffMs(3, { probeWindowMs: 1_000, capMs: 3_000 }),
    ).toBe(3_000);
  });
});

describe("engineStartupWaitDecision", () => {
  it("keeps waiting through a legitimate recovery that exceeds ten seconds", () => {
    expect(
      engineStartupWaitDecision({
        elapsedMs: 10_208,
        childExited: false,
      }),
    ).toBe("wait");
  });

  it("fails promptly when the exact spawned child exits", () => {
    expect(
      engineStartupWaitDecision({ elapsedMs: 250, childExited: true }),
    ).toBe("child-exited");
  });

  it("keeps recovery bounded", () => {
    expect(
      engineStartupWaitDecision({
        elapsedMs: 10 * 60_000,
        childExited: false,
      }),
    ).toBe("timed-out");
  });
});
