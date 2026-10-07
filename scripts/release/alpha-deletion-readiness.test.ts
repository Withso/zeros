import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedReceipt, ReleaseIdentity } from "./contracts";

const digest = "b".repeat(64), sha = "a".repeat(40);
const exception = { kind: "retired-boat-deletions", expiresAt: "2026-10-10T00:00:00.000Z" };
const identity = { version: 1, ready: true, sourceSha: sha, channel: "alpha", maintenance: false,
  migrations: { state: "current", head: "0001_initial.sql", expectedHead: "0001_initial.sql", manifestSha256: digest },
  cloud: { enabled: true, ready: true, state: "healthy", operationalState: "degraded" },
  worker: null, workerQualified: false, alphaReadinessException: exception };

describe("receipted temporary Alpha deletion readiness", () => {
  afterEach(() => vi.useRealTimers());
  function clock() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
  }
  it("preserves operational degradation and exception expiry in the hosted receipt", () => {
    clock();
    const receipt = HostedReceipt.parse({ version: 1, status: "success", channel: "alpha", sourceSha: sha,
      branch: "main", repository: "example/zeros", runId: "1", runAttempt: "1", backend: identity,
      migration: { mode: "execute", database: "zeros-control-plane-alpha", branch: { name: "main", production: true },
        backup: { id: "backup", state: "success" }, controlledApprovals: [], pendingMigrations: [], applied: [], ledger: "verified", role: { deleted: true } },
      railwayDeploymentId: "deployment", pages: [], completedAt: new Date().toISOString() });
    expect(receipt.backend.alphaReadinessException).toEqual(exception);
    expect(receipt.backend.cloud.operationalState).toBe("degraded");
  });
  it.each(["beta", "production"])("rejects a deferred deletion on %s", channel => {
    clock();
    expect(ReleaseIdentity.safeParse({ ...identity, channel }).success).toBe(false);
  });
  it("rejects a missing, expired or contradictory exception", () => {
    clock();
    for (const changed of [
      { alphaReadinessException: undefined },
      { alphaReadinessException: { ...exception, expiresAt: new Date().toISOString() } },
      { alphaReadinessException: { ...exception, kind: "skip-all-health" } },
      { cloud: { ...identity.cloud, operationalState: "healthy" } },
    ]) expect(ReleaseIdentity.safeParse({ ...identity, ...changed }).success).toBe(false);
  });
});
