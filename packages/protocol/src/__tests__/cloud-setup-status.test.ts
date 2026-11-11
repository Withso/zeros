import { describe, expect, it } from "vitest";

describe("setup-status-v1", () => {
  it("bounds the setup report (setup-status-v1): closed states and reasons, epoch milliseconds, nothing else", async () => {
    const { CloudV2SetupStatusSchema } = await import("../cloud-v2-relay");
    expect(CloudV2SetupStatusSchema.parse({ state: "failed", startedAt: 1, finishedAt: 2, exitCode: 3 })).toEqual({ state: "failed", startedAt: 1, finishedAt: 2, exitCode: 3 });
    expect(CloudV2SetupStatusSchema.safeParse({ state: "failed", startedAt: 1, reason: "timed_out" }).success).toBe(true);
    for (const bad of [{ state: "paused", startedAt: 1 }, { state: "running", startedAt: "2026-11-10T00:00:00Z" }, { state: "running", startedAt: 1, path: "/home/user/x" },
      { state: "failed", startedAt: 1, reason: "other" }, { state: "failed", startedAt: 1, exitCode: 1.5 }])
      expect(CloudV2SetupStatusSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});
