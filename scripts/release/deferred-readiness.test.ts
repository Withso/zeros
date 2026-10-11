import { afterEach, describe, expect, it, vi } from "vitest";
import { alphaFrontierIdentity } from "./alpha-frontier";
import { HostedReceipt, ReleaseIdentity } from "./contracts";

const digest = "b".repeat(64), sha = "a".repeat(40);
const deferredReadiness = { kind: "retired-boat-deletions" };
const exception = { kind: "retired-boat-deletions", expiresAt: "2026-10-10T00:00:00.000Z" };
const identity = { version: 1, ready: true, sourceSha: sha, channel: "alpha", maintenance: false,
  migrations: { state: "current", head: "0001_initial.sql", expectedHead: "0001_initial.sql", manifestSha256: digest },
  cloud: { enabled: true, ready: true, state: "healthy", operationalState: "degraded" },
  worker: null, workerQualified: false, deferredReadiness };

describe("receipted deferred retired Boat deletion readiness", () => {
  afterEach(() => vi.useRealTimers());
  function clock() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
  }
  it("preserves operational degradation and the deferral in the hosted receipt", () => {
    const receipt = HostedReceipt.parse({ version: 1, status: "success", channel: "alpha", sourceSha: sha,
      branch: "main", repository: "example/zeros", runId: "1", runAttempt: "1", backend: identity,
      migration: { mode: "execute", database: "zeros-control-plane-alpha", branch: { name: "main", production: true },
        backup: { id: "backup", state: "success" }, controlledApprovals: [], pendingMigrations: [], applied: [], ledger: "verified", role: { deleted: true } },
      railwayDeploymentId: "deployment", pages: [], completedAt: new Date().toISOString() });
    expect(receipt.backend.deferredReadiness).toEqual(deferredReadiness);
    expect(receipt.backend.cloud.operationalState).toBe("degraded");
  });
  it.each(["alpha", "beta", "production"])("defers without an expiry on %s", channel => {
    expect(ReleaseIdentity.safeParse({ ...identity, channel }).success).toBe(true);
  });
  it("rejects degraded readiness without a deferral, or a contradictory deferral", () => {
    for (const changed of [
      { deferredReadiness: undefined },
      { deferredReadiness: { kind: "skip-all-health" } },
      { deferredReadiness: { ...deferredReadiness, expiresAt: exception.expiresAt } },
      { cloud: { ...identity.cloud, operationalState: "healthy" } },
      { cloud: { ...identity.cloud, operationalState: undefined } },
      { cloud: { ...identity.cloud, enabled: false } },
      { cloud: { ...identity.cloud, state: "disabled" } },
      { alphaReadinessException: exception },
    ]) expect(ReleaseIdentity.safeParse({ ...identity, ...changed }).success).toBe(false);
  });
  // The admission frontier reads the API deployed before this release, which
  // may still report the expiring Alpha waiver this deferral replaced.
  it("still reads a current legacy Alpha waiver from an earlier API", () => {
    clock();
    const legacy = { ...identity, deferredReadiness: undefined, alphaReadinessException: exception };
    expect(ReleaseIdentity.safeParse(legacy).success).toBe(true);
    for (const changed of [
      { channel: "beta" }, { channel: "production" },
      { alphaReadinessException: { ...exception, expiresAt: new Date().toISOString() } },
      { alphaReadinessException: { ...exception, expiresAt: "2026-10-10T12:00:00.001Z" } },
      { alphaReadinessException: { ...exception, kind: "skip-all-health" } },
      { cloud: { ...identity.cloud, operationalState: "healthy" } },
    ]) expect(ReleaseIdentity.safeParse({ ...legacy, ...changed }).success).toBe(false);
  });
  // Admission reads the outgoing deployment before replacing it, ready or not.
  it.each([
    ["the new deferral", 200, {}],
    ["a current legacy waiver", 200, { deferredReadiness: undefined, alphaReadinessException: exception }],
    ["an unready identity", 503, { ready: false, deferredReadiness: undefined,
      cloud: { enabled: true, ready: false, state: "unready" } }],
  ] as const)("admission reads an outgoing Alpha API that reports %s", async (_name, status, changed) => {
    clock();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ...identity, ...changed }), { status }));
    await expect(alphaFrontierIdentity(fetcher as unknown as typeof fetch)).resolves.toMatchObject({ channel: "alpha", sourceSha: sha });
  });
  it("admission refuses an outgoing identity whose legacy waiver has expired", async () => {
    clock();
    const expired = { ...identity, deferredReadiness: undefined, alphaReadinessException: { ...exception, expiresAt: new Date().toISOString() } };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(expired), { status: 200 }));
    await expect(alphaFrontierIdentity(fetcher as unknown as typeof fetch)).resolves.toBeNull();
  });
});
