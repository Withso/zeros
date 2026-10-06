import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudRuntimeStagingWorker, type RuntimeStagingStore, type RuntimeStagingTransitions } from "./runtime-staging-worker.js";
import type { RuntimeStagePlan } from "./runtime-staging-store.js";
import type { RuntimeUpdateResult } from "./runtime-update-runner.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  const workspaceId = randomUUID(), organizationId = randomUUID(), transitionId = randomUUID();
  const sourceEngineInstanceId = randomUUID();
  const scope = { workspaceId, organizationId, transitionId };
  const claim = { ...scope, workerId: "zeros-v2-test-stage", workerFence: randomUUID(), executionFence: randomUUID() };
  const plan: RuntimeStagePlan = {
    resourceId: "bx_zeros-v2-test-stage", phase: "offered", objectKey: "runtime/test", deadline: Date.now() + 900_000,
    input: { schema: "zeros.runtime-update/v1", operation: "stage", transitionId, fence: claim.executionFence,
      scope: { workspaceId, organizationId, sourceGeneration: 1, candidateGeneration: 2, sourceEngineInstanceId },
      mode: "engine", expiresAt: new Date(Date.now() + 900_000).toISOString(),
      source: { schema: "zeros.active-runtime/v1", runtimeId: `r1-${"1".repeat(64)}`, manifestSha256: "1".repeat(64),
        baseCompatibilityId: `bc1-${"b".repeat(64)}`, installerReceiptSha256: "9".repeat(64), bootId: randomUUID(),
        root: `/opt/zeros-infra/r1-${"1".repeat(64)}`, cgroupRoot: "/sys/fs/cgroup/system.slice/zeros-host.service", supervisorSessionId: randomUUID() } },
    target: { runtimeId: `r1-${"2".repeat(64)}`, manifestSha256: "2".repeat(64), archiveSha256: "3".repeat(64),
      archiveBytes: 100, expandedBytes: 200, sourceCommit: "4".repeat(40), nodeModulesAbi: 127,
      bootstrapProtocolVersion: 1, engineProtocolVersion: 1 },
  };
  const result: RuntimeUpdateResult = { schema: plan.input.schema, operation: "stage", transitionId,
    fence: claim.executionFence, scope: plan.input.scope, outcome: "staged" };
  const store = {
    discover: vi.fn(async () => ({ items: [{ workspaceId, organizationId, generation: 1, sourceEngineInstanceId,
      operationId: randomUUID(), mode: "engine" as const }], cursor: null })),
    pending: vi.fn<RuntimeStagingStore["pending"]>(async () => ({ items: [], cursor: null })),
    read: vi.fn(async () => plan as RuntimeStagePlan | null),
  } satisfies RuntimeStagingStore;
  const transitions = {
    offer: vi.fn(async () => ({ transitionId, sourceGeneration: 1, candidateGeneration: 2,
      phase: "offered", executionMode: "retain_allocation" as const })),
    claim: vi.fn(async () => claim), renew: vi.fn(async () => true),
    reconcile: vi.fn<RuntimeStagingTransitions["reconcile"]>(async () => "stage"), staged: vi.fn(async () => true),
    release: vi.fn(async () => true), cancelStaging: vi.fn(async () => true),
  } satisfies RuntimeStagingTransitions;
  const artifacts = { presignGet: vi.fn(async () => ({ url: "https://objects.example.test/private-capability",
    expiresAt: new Date(Date.now() + 900_000).toISOString() })) };
  const run = vi.fn(async (_resource: string, _input: unknown, _signal: AbortSignal) => result);
  const warn = vi.fn();
  const worker = new CloudRuntimeStagingWorker({ store, transitions, artifacts, run, workerId: claim.workerId,
    logger: { warn }, intervalMs: 5_000, concurrency: 2 });
  return { worker, store, transitions, artifacts, run, warn, claim, plan, result, scope };
}
async function drain() { await vi.advanceTimersByTimeAsync(0); }

describe("qualification-driven runtime staging", () => {
  it("stages a busy source through the existing installer without activation, then releases the claim", async () => {
    const f = fixture(); const stop = f.worker.start(); await drain();
    expect(f.run).toHaveBeenCalledOnce();
    const [resource, input] = f.run.mock.calls[0]!;
    expect(resource).toBe(f.plan.resourceId);
    expect(input).toMatchObject({ operation: "stage", mode: "engine", scope: f.plan.input.scope });
    const install = JSON.parse(Buffer.from((input as { install: string }).install, "base64url").toString());
    expect(install).toMatchObject({ purpose: "qualification", runtime: f.plan.target });
    expect(f.transitions.staged).toHaveBeenCalledExactlyOnceWith(f.claim);
    expect(f.transitions.release).toHaveBeenCalledExactlyOnceWith(f.claim);
    await stop();
  });

  it("coalesces duplicate hints during an install without duplicating it", async () => {
    const f = fixture();
    let finish!: () => void;
    f.run.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(f.result); }));
    const stop = f.worker.start(); await drain();
    for (let i = 0; i < 50; i++) f.worker.notify();
    await drain(); expect(f.run).toHaveBeenCalledOnce();
    finish(); await drain();
    expect(f.transitions.staged).toHaveBeenCalledOnce();
    await stop();
  });

  it("recovers durable offered work after restart with no notification or rediscovery", async () => {
    const f = fixture();
    f.store.discover.mockResolvedValue({ items: [], cursor: null });
    f.store.pending.mockResolvedValue({ items: [f.scope], cursor: null });
    const stop = f.worker.start(); await drain();
    expect(f.transitions.offer).not.toHaveBeenCalled();
    expect(f.run).toHaveBeenCalledOnce();
    await stop();
  });

  it("leaves valid staged work for the activation worker", async () => {
    const f = fixture(); f.plan.phase = "staged";
    f.transitions.reconcile.mockResolvedValue("activate");
    const stop = f.worker.start(); await drain();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.transitions.release).toHaveBeenCalledExactlyOnceWith(f.claim);
    await stop();
  });

  it("cancels a revoked/superseded/source-mismatched offer after artifact signing, before provider I/O", async () => {
    const f = fixture();
    f.artifacts.presignGet.mockImplementation(async () => {
      f.store.read.mockResolvedValue(null);
      return { url: "https://objects.example.test/private-capability", expiresAt: f.plan.input.expiresAt };
    });
    const stop = f.worker.start(); await drain();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.transitions.cancelStaging).toHaveBeenCalledExactlyOnceWith(f.claim);
    expect(f.transitions.staged).not.toHaveBeenCalled();
    await stop();
  });

  it("discards a completed install if its eligibility changed while downloading", async () => {
    const f = fixture();
    f.run.mockImplementation(async () => { f.store.read.mockResolvedValue(null); return f.result; });
    const stop = f.worker.start(); await drain();
    expect(f.transitions.staged).not.toHaveBeenCalled();
    expect(f.transitions.cancelStaging).toHaveBeenCalledExactlyOnceWith(f.claim);
    await stop();
  });

  it("aborts on lease loss and never records a stale receipt", async () => {
    const f = fixture();
    f.run.mockImplementation((_resource, _input, signal) => new Promise(resolve => {
      signal.addEventListener("abort", () => resolve(f.result), { once: true });
    }));
    const stop = f.worker.start(); await drain();
    f.transitions.renew.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(f.transitions.renew).toHaveBeenCalled();
    expect(f.transitions.staged).not.toHaveBeenCalled();
    expect(f.transitions.cancelStaging).not.toHaveBeenCalled();
    await stop();
  });

  it("bounds retries and never prints provider errors or signed URLs", async () => {
    const f = fixture();
    f.run.mockRejectedValue(new Error("private-capability and provider response"));
    const stop = f.worker.start(); await drain();
    for (let i = 0; i < 100; i++) f.worker.notify();
    await drain(); expect(f.run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(240_000);
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(f.transitions.cancelStaging).toHaveBeenCalledExactlyOnceWith(f.claim);
    expect(JSON.stringify(f.warn.mock.calls)).not.toContain("private");
    await stop();
  });

  it("aborts outstanding staging on shutdown without recording success", async () => {
    const f = fixture();
    f.run.mockImplementation((_resource, _input, signal) => new Promise(resolve => {
      signal.addEventListener("abort", () => resolve(f.result), { once: true });
    }));
    const stop = f.worker.start(); await drain(); await stop();
    expect(f.transitions.staged).not.toHaveBeenCalled();
    expect(f.transitions.release).toHaveBeenCalledExactlyOnceWith(f.claim);
    f.worker.notify(); await vi.advanceTimersByTimeAsync(100_000);
    expect(f.run).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("limits simultaneous downloads even when a discovery page offers more work", async () => {
    const f = fixture();
    const scopes = Array.from({ length: 3 }, () => ({ ...f.scope, workspaceId: randomUUID(), transitionId: randomUUID() }));
    f.store.pending.mockResolvedValue({ items: scopes, cursor: null });
    f.store.discover.mockResolvedValue({ items: [], cursor: null });
    f.transitions.claim.mockImplementation(async scope => ({ ...f.claim, ...scope }));
    f.store.read.mockImplementation(async claim => ({ ...f.plan, input: { ...f.plan.input, transitionId: claim.transitionId,
      scope: { ...f.plan.input.scope, workspaceId: claim.workspaceId } } }));
    f.run.mockImplementation((_resource, _input, signal) => new Promise(resolve => {
      signal.addEventListener("abort", () => resolve(f.result), { once: true });
    }));
    const stop = f.worker.start(); await drain();
    expect(f.run).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 30; i++) f.worker.notify();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.run).toHaveBeenCalledTimes(2);
    await stop();
  });
});
