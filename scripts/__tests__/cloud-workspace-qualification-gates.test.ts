import { describe, expect, it } from "vitest";
import {
  assertFullCloudBoundary,
  assertLiveAgentChallengeResponse,
  assertCommandExitCode,
  evaluateSoakGate,
  parseRequiredCloudAgents,
  parseValidationAutoDeleteMinutes,
  parseSoakOptions,
  requireHttpRoundTrip,
  resolveRemoteSourceCommit,
  shouldDeleteStaleEphemeralSnapshot,
  validateEphemeralSnapshotName,
} from "../cloud-workspace-validation/lib/qualification-gates";

describe("cloud workspace qualification gates", () => {
  it("fails closed when an in-worker probe does not return exit code zero", () => {
    expect(() => assertCommandExitCode("egress", 0)).not.toThrow();
    for (const code of [1, 127, null, undefined, Number.NaN]) {
      expect(() => assertCommandExitCode("egress", code)).toThrow(/egress/);
    }
  });

  it("requires the SSH tunnel to complete an HTTP 200 round trip", () => {
    expect(() => requireHttpRoundTrip("SSH forward", 200)).not.toThrow();
    for (const status of [0, 199, 201, 500, Number.NaN]) {
      expect(() => requireHttpRoundTrip("SSH forward", status)).toThrow(
        /SSH forward/,
      );
    }
  });

  it("validates soak duration, cadence, and the explicit drop budget", () => {
    expect(
      parseSoakOptions({
        ZEROS_SOAK_HOURS: "4",
        ZEROS_SOAK_PING_MS: "25000",
        ZEROS_SOAK_MAX_DROPS: "0",
      }),
    ).toEqual({ hours: 4, pingMs: 25_000, maxDrops: 0 });

    for (const env of [
      { ZEROS_SOAK_HOURS: "0" },
      { ZEROS_SOAK_HOURS: "NaN" },
      { ZEROS_SOAK_PING_MS: "999" },
      { ZEROS_SOAK_MAX_DROPS: "-1" },
      { ZEROS_SOAK_MAX_DROPS: "1.5" },
    ]) {
      expect(() => parseSoakOptions(env)).toThrow(/soak/i);
    }
  });

  it("fails a soak on excess drops, a dead final connection, or early stop", () => {
    expect(
      evaluateSoakGate({
        drops: 0,
        maxDrops: 0,
        connected: true,
        completed: true,
      }),
    ).toEqual({ ok: true, reason: "stable" });
    expect(
      evaluateSoakGate({
        drops: 1,
        maxDrops: 0,
        connected: true,
        completed: true,
      }).ok,
    ).toBe(false);
    expect(
      evaluateSoakGate({
        drops: 0,
        maxDrops: 0,
        connected: false,
        completed: true,
      }).ok,
    ).toBe(false);
    expect(
      evaluateSoakGate({
        drops: 0,
        maxDrops: 0,
        connected: true,
        completed: false,
      }).ok,
    ).toBe(false);
    expect(
      evaluateSoakGate({
        drops: Number.NaN,
        maxDrops: 0,
        connected: true,
        completed: true,
      }).ok,
    ).toBe(false);
  });

  it("requires an explicit, unique provider set for paid live agent checks", () => {
    expect(parseRequiredCloudAgents("claude,codex,cursor")).toEqual([
      "claude",
      "codex",
      "cursor",
    ]);
    expect(() => parseRequiredCloudAgents(undefined)).toThrow(
      /required agents/i,
    );
    expect(() => parseRequiredCloudAgents("claude,claude")).toThrow(
      /duplicate/i,
    );
    expect(() => parseRequiredCloudAgents("claude,../escape")).toThrow(
      /agent id/i,
    );
  });

  it("graduates only a full, enforced cloud-worker boundary", () => {
    const full = {
      version: 1,
      actor: "agent-code",
      state: "ready",
      backend: "cloud-worker",
      designProtection: {
        required: true,
        enforced: true,
        protectedDirectoryCount: 1,
      },
      parity: { level: "full", restrictions: [] },
      checkedAt: Date.now(),
    };
    expect(() => assertFullCloudBoundary("claude", full)).not.toThrow();
    for (const boundary of [
      undefined,
      { ...full, state: "unavailable" },
      { ...full, backend: "zeros-srt" },
      {
        ...full,
        designProtection: { ...full.designProtection, enforced: false },
      },
      {
        ...full,
        parity: {
          level: "restricted",
          restrictions: ["container-workflows-unavailable"],
        },
      },
    ]) {
      expect(() => assertFullCloudBoundary("claude", boundary)).toThrow(
        /claude/,
      );
    }
  });

  it("requires the live provider to return its per-turn unique challenge", () => {
    const marker = "ZEROS_PING_0123456789ABCDEF";
    expect(() =>
      assertLiveAgentChallengeResponse(
        "claude",
        `Here is the requested marker: ${marker}`,
        marker,
      ),
    ).not.toThrow();
    for (const [response, candidate] of [
      ["", marker],
      ["PINGOK", marker],
      ["ZEROS_PING_OTHER_MARKER", marker],
      [marker, "unsafe-marker"],
    ]) {
      expect(() =>
        assertLiveAgentChallengeResponse("claude", response, candidate),
      ).toThrow(/claude/i);
    }
  });

  it("allows automated deletion only for a run-scoped CI snapshot", () => {
    expect(() =>
      validateEphemeralSnapshotName("zeros-zsr-ci-12345-2"),
    ).not.toThrow();
    for (const name of [
      "zeros-engine-v1",
      "zeros-zsr-ci-12345",
      "zeros-zsr-ci-main-2",
      "zeros-zsr-ci-0-1",
      "zeros-zsr-ci-12345-2-extra",
    ]) {
      expect(() => validateEphemeralSnapshotName(name)).toThrow(/snapshot/i);
    }
  });

  it("keeps operator sandboxes durable by default but bounds CI orphan cleanup", () => {
    expect(parseValidationAutoDeleteMinutes(undefined)).toBe(-1);
    expect(parseValidationAutoDeleteMinutes("720")).toBe(720);
    for (const value of ["0", "59", "10081", "1.5", "NaN"]) {
      expect(() => parseValidationAutoDeleteMinutes(value)).toThrow(
        /auto-delete/i,
      );
    }
  });

  it("selects only old, exactly namespaced CI snapshots for janitor cleanup", () => {
    const now = Date.parse("2026-08-16T12:00:00.000Z");
    expect(
      shouldDeleteStaleEphemeralSnapshot(
        {
          name: "zeros-zsr-ci-123-1",
          createdAt: "2026-08-15T11:59:59.000Z",
        },
        now,
        24 * 60 * 60_000,
      ),
    ).toBe(true);
    for (const candidate of [
      { name: "zeros-engine-v1", createdAt: "2020-01-01T00:00:00Z" },
      { name: "zeros-zsr-ci-123-1", createdAt: "2026-08-16T11:00:00Z" },
      { name: "zeros-zsr-ci-123-1", createdAt: "not-a-date" },
    ]) {
      expect(
        shouldDeleteStaleEphemeralSnapshot(candidate, now, 24 * 60 * 60_000),
      ).toBe(false);
    }
  });

  it("pins a moving repository ref to the workflow's exact commit", () => {
    const commit = "a".repeat(40);
    expect(
      resolveRemoteSourceCommit(`${commit}\trefs/heads/main\n`, commit),
    ).toBe(commit);
    expect(() =>
      resolveRemoteSourceCommit(`${"b".repeat(40)}\trefs/heads/main\n`, commit),
    ).toThrow(/exact commit/i);
    expect(() =>
      resolveRemoteSourceCommit(
        `${commit}\trefs/heads/main\n${"b".repeat(40)}\trefs/tags/main\n`,
      ),
    ).toThrow(/one immutable commit/i);
  });
});
