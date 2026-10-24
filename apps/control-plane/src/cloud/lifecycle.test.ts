import { describe, expect, it, vi } from "vitest";
import type { CloudV2Compute } from "./boat.js";
import { CLOUD_V2_IDLE_STOP_MS, CLOUD_V2_WORKER_TOKEN_PATH, CloudV2Lifecycle, deliverWorkerTokenCommand, type CloudV2LifecycleDeps } from "./lifecycle.js";
import type { CloudV2Workspace, CloudV2LifecycleWorkspace } from "./store.js";
import { generateKeyPairSync } from "node:crypto";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const token = `zw2w_${"a".repeat(43)}`;
const runtime = `/opt/zeros/runtime/${"b".repeat(64)}`;
const publicKeys = [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()];

function workspace(state: CloudV2Workspace["state"], extra: Partial<CloudV2LifecycleWorkspace & { attempts: number }> = {}): CloudV2LifecycleWorkspace & { attempts: number } {
  return {
    id: "6f2b7c1e-3b0a-4f7e-9d43-8a0b2b9c6d11", organizationId: "org", creatorUserId: "u", name: "w", repository: "o/r",
    branch: "zeros/w", baseBranch: "main", state, boatSandboxId: null, computerBuildId: null, errorCode: null, activeAt: null, archivedAt: null,
    stoppedAt: null, retentionSnapshot: null, retentionSavedAt: null, leaseRenewedAt: null, retentionOperationUntil: null, restorePending: false,
    createdAt: new Date(NOW - 60_000).toISOString(), updatedAt: new Date(NOW).toISOString(), attempts: 1, ...extra,
  };
}

function setup(claimed: (CloudV2LifecycleWorkspace & { attempts: number })[], options: { snapshot?: string | null; idle?: CloudV2Workspace[]; stopIdle?: CloudV2LifecycleDeps["stopIdle"]; timing?: CloudV2LifecycleDeps["timing"]; now?: () => number } = {}) {
  const compute: CloudV2Compute = {
    create: vi.fn(async () => ({ sandboxId: "bx_new1" })),
    resume: vi.fn(async () => {}),
    extendLease: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "", timedOut: false })),
    execLong: vi.fn(async () => ({ exitCode: 0, stdout: "", timedOut: false })),
    saveSnapshot: vi.fn(async () => {}),
    deleteSnapshot: vi.fn(async () => {}),
    hostPort: vi.fn(async () => ({ url: "https://fixture-41783.on.boat.dev", token: "synthetic-port-token" })),
  };
  const store: CloudV2LifecycleDeps["store"] = {
    claimPending: vi.fn(async () => claimed),
    defer: vi.fn(async () => {}),
    transition: vi.fn(async () => null),
    rotateWorkerToken: vi.fn(async () => token),
    computerSnapshot: vi.fn(async () => options.snapshot === undefined ? "cv2-alpha-org-1" : options.snapshot),
    revoke: vi.fn(async () => {}),
    idleSince: vi.fn(async () => options.idle ?? []),
    setWorkerRoute: vi.fn(async () => true),
    leasesDue: vi.fn(async () => []),
    markLeaseRenewed: vi.fn(async () => true),
    retentionDue: vi.fn(async () => []),
    beginRetention: vi.fn(async () => true),
    finishRetention: vi.fn(async () => {}),
    deferRetention: vi.fn(async () => {}),
    retentionCleanupDue: vi.fn(async () => []),
    beginRetentionCleanup: vi.fn(async () => true),
    finishRetentionCleanup: vi.fn(async () => {}),
    beginRestore: vi.fn(async () => true),
    finishRestore: vi.fn(async () => "starting" as const),
  };
  const stopWorker = vi.fn(async () => true);
  const lifecycle = new CloudV2Lifecycle({
    store, compute, now: options.now ?? (() => NOW), sleep: async () => {},
    ...(options.timing ? { timing: options.timing } : {}),
    ...(options.stopIdle ? { stopIdle: options.stopIdle } : {}),
    publicKeys, sealPortToken: () => ({ encrypted: true }), stopWorker,
    runtime: { sha256: "b".repeat(64), url: async () => "https://r2.example.test/runtime.tar.gz?sig=1" },
    bootEnv: ws => ({ CLOUD_V2_API_URL: "https://api.example.test", ZEROS_WORKSPACE_ID: ws.id }),
    sandboxName: ws => `zeros-alpha-${ws.id.slice(0, 8)}`,
    retentionName: ws => `zeros-alpha-ret-${ws.id.slice(0, 8)}`,
  });
  return { lifecycle, compute, store, stopWorker };
}

describe("cloud v2 lifecycle", () => {
  it("allocates from the workspace's pinned computer build", async () => {
    const w = workspace("creating", { computerBuildId: "pinned-build" }), f = setup([w]);
    await f.lifecycle.tick();
    expect(f.store.computerSnapshot).toHaveBeenCalledWith(w.organizationId, "pinned-build");
    expect(f.compute.create).toHaveBeenCalledWith(expect.objectContaining({ from: "cv2-alpha-org-1" }));
  });

  it("persists retention intent before saving and admits unrelated creates while one save is blocked", async () => {
    const stopped = workspace("stopped", { boatSandboxId: "bx_stopped", stoppedAt: new Date(NOW - 12 * 86_400_000).toISOString() });
    const f = setup([]), stop = f.lifecycle.start();
    vi.mocked(f.store.retentionDue).mockResolvedValueOnce([stopped]);
    let release!: () => void;
    vi.mocked(f.compute.saveSnapshot).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    try {
      await f.lifecycle.tick();
      await vi.waitFor(() => expect(f.compute.saveSnapshot).toHaveBeenCalledWith("bx_stopped", "zeros-alpha-ret-6f2b7c1e"));
      expect(f.store.beginRetention).toHaveBeenCalledWith(stopped, "zeros-alpha-ret-6f2b7c1e");
      expect(f.store.beginRetention).toHaveBeenCalledBefore(f.compute.saveSnapshot);
      vi.mocked(f.store.claimPending).mockResolvedValueOnce([workspace("creating")]);
      await f.lifecycle.tick();
      expect(f.compute.create).toHaveBeenCalledTimes(1);
      expect(f.store.retentionDue).toHaveBeenCalledTimes(1);
      expect(f.store.finishRetention).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(f.store.finishRetention).toHaveBeenCalledWith(stopped.id, "bx_stopped", "zeros-alpha-ret-6f2b7c1e"));
    } finally { release?.(); await stop(); }
  });

  it("retries a failed retention save with its original persisted name and no snapshot receipt", async () => {
    let now = NOW;
    const stopped = workspace("stopped", { boatSandboxId: "bx_stopped", stoppedAt: new Date(NOW - 13 * 86_400_000).toISOString(), retentionSnapshot: "zeros-alpha-original-retention" });
    const f = setup([], { now: () => now }), stop = f.lifecycle.start();
    vi.mocked(f.store.retentionDue).mockResolvedValue([stopped]);
    vi.mocked(f.compute.saveSnapshot).mockRejectedValueOnce(Object.assign(new Error("private provider details"), { code: "credit_required" }));
    try {
      await f.lifecycle.tick();
      await vi.waitFor(() => expect(f.store.deferRetention).toHaveBeenCalledWith(stopped.id, stopped.retentionSnapshot));
      expect(f.store.finishRetention).not.toHaveBeenCalled();
      await f.lifecycle.tick(); expect(f.compute.saveSnapshot).toHaveBeenCalledTimes(1);
      now += 60_001; await f.lifecycle.tick();
      await vi.waitFor(() => expect(f.store.finishRetention).toHaveBeenCalledTimes(1));
      expect(f.compute.saveSnapshot).toHaveBeenLastCalledWith("bx_stopped", stopped.retentionSnapshot);
    } finally { await stop(); }
  });

  it.each(["expired", "missing"])("restores a %s disk from retention before installing runtime and delivering a fresh token", async kind => {
    const { BoatSnapshotExpiredError } = await import("./boat-client.js");
    const { CloudProviderError } = await import("./provider-error.js");
    const retained = workspace("starting", { boatSandboxId: "bx_expired", retentionSnapshot: "zeros-alpha-retained", retentionSavedAt: new Date(NOW - 86_400_000).toISOString() });
    const f = setup([retained]);
    vi.mocked(f.compute.resume).mockRejectedValueOnce(kind === "expired" ? new BoatSnapshotExpiredError() : new CloudProviderError("provider_not_found", "gone", false, { httpStatus: 404 }));
    await f.lifecycle.tick();
    expect(f.compute.create).toHaveBeenCalledWith(expect.objectContaining({ key: `restore:${retained.id}:zeros-alpha-retained`, from: "zeros-alpha-retained" }));
    expect(f.store.beginRestore).toHaveBeenCalledBefore(f.compute.create);
    expect(f.compute.delete).toHaveBeenCalledWith("bx_expired");
    expect(f.store.finishRestore).toHaveBeenCalledWith(retained.id, "bx_expired", "zeros-alpha-retained", "bx_new1", new Date(NOW));
    expect(f.compute.hostPort).toHaveBeenCalledWith("bx_new1", expect.anything());
    expect(f.compute.deleteSnapshot).not.toHaveBeenCalled();
    expect(f.store.transition).not.toHaveBeenCalled();
  });

  it("replays a pending restore with the same key after a lost create reply and cleans it up on deletion", async () => {
    const retained = workspace("deleting", { boatSandboxId: "bx_expired", retentionSnapshot: "zeros-alpha-retained", retentionSavedAt: new Date(NOW - 86_400_000).toISOString(), restorePending: true });
    const f = setup([retained]);
    vi.mocked(f.store.finishRestore).mockResolvedValueOnce("deleting");
    await f.lifecycle.tick();
    expect(f.compute.create).toHaveBeenCalledWith(expect.objectContaining({ key: `restore:${retained.id}:zeros-alpha-retained` }));
    expect(f.compute.delete).toHaveBeenCalledWith("bx_new1");
    expect(f.compute.deleteSnapshot).toHaveBeenCalledWith("zeros-alpha-retained");
    expect(f.compute.exec).not.toHaveBeenCalled();
    expect(f.store.transition).toHaveBeenCalledWith(retained.id, ["deleting"], "deleted");
  });

  it("recovers an unacknowledged retention save when the source disk has since expired", async () => {
    const { BoatSnapshotExpiredError } = await import("./boat-client.js");
    const retained = workspace("starting", { boatSandboxId: "bx_expired", stoppedAt: new Date(NOW - 15 * 86_400_000).toISOString(), retentionSnapshot: "zeros-alpha-retained" });
    const f = setup([retained]);
    vi.mocked(f.compute.resume).mockRejectedValueOnce(new BoatSnapshotExpiredError());
    await f.lifecycle.tick();
    expect(f.compute.saveSnapshot).toHaveBeenCalledWith("bx_expired", "zeros-alpha-retained");
    expect(f.store.finishRetention).toHaveBeenCalledBefore(f.compute.create);
    expect(f.compute.hostPort).toHaveBeenCalledWith("bx_new1", expect.anything());
    expect(f.store.transition).not.toHaveBeenCalled();
  });

  it("recovers a pending restore before a concurrent Stop retires the new sandbox", async () => {
    const retained = workspace("stopping", { boatSandboxId: "bx_expired", retentionSnapshot: "zeros-alpha-retained", retentionSavedAt: new Date(NOW - 86_400_000).toISOString(), restorePending: true });
    const f = setup([retained]);
    vi.mocked(f.store.finishRestore).mockResolvedValueOnce("stopping");
    await f.lifecycle.tick();
    expect(f.compute.create).toHaveBeenCalledTimes(1);
    expect(f.compute.stop).toHaveBeenCalledWith("bx_new1");
    expect(f.compute.exec).not.toHaveBeenCalled();
    expect(f.store.transition).toHaveBeenCalledWith(retained.id, ["stopping"], "stopped");
  });

  it("cleans a saved retention snapshot only after the worker is running and waits for snapshot deletion before erasure", async () => {
    const retained = workspace("running", { boatSandboxId: "bx_restored", retentionSnapshot: "zeros-alpha-retained", retentionSavedAt: new Date(NOW - 86_400_000).toISOString() });
    const f = setup([]), stop = f.lifecycle.start();
    vi.mocked(f.store.retentionCleanupDue).mockResolvedValueOnce([retained]);
    await f.lifecycle.tick();
    await vi.waitFor(() => expect(f.store.finishRetentionCleanup).toHaveBeenCalledWith(retained.id, "zeros-alpha-retained"));
    expect(f.compute.deleteSnapshot).toHaveBeenCalledBefore(f.store.finishRetentionCleanup);
    await stop();
    const deleting = setup([{ ...retained, state: "deleting" }]);
    vi.mocked(deleting.compute.deleteSnapshot).mockRejectedValueOnce(new Error("retry delete"));
    await deleting.lifecycle.tick();
    expect(deleting.store.transition).not.toHaveBeenCalled();
    expect(deleting.store.revoke).not.toHaveBeenCalled();
    expect(deleting.store.defer).toHaveBeenCalledWith(retained.id, "deleting", 10_000, { failure: true });
  });

  it("records a full Boat lease on create and on resume", async () => {
    for (const state of ["creating", "starting"] as const) {
      const f = setup([workspace(state, { boatSandboxId: state === "starting" ? "bx_test" : null })]);
      await f.lifecycle.tick();
      expect(f.store.markLeaseRenewed).toHaveBeenCalledWith(expect.any(String), state === "creating" ? "bx_new1" : "bx_test", new Date(NOW));
    }
  });

  it("renews due running leases in the background without blocking new creates and throttles retries", async () => {
    let now = NOW;
    const f = setup([], { now: () => now });
    const running = workspace("running", { boatSandboxId: "bx_busy1" });
    vi.mocked(f.store.leasesDue).mockResolvedValue([running]);
    let release!: () => void;
    vi.mocked(f.compute.extendLease).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const stop = f.lifecycle.start();
    try {
      await f.lifecycle.tick();
      await vi.waitFor(() => expect(f.compute.extendLease).toHaveBeenCalledWith("bx_busy1", 86_400));
      vi.mocked(f.store.claimPending).mockResolvedValueOnce([workspace("creating")]);
      await f.lifecycle.tick();
      expect(f.compute.create).toHaveBeenCalledTimes(1);
      expect(f.compute.extendLease).toHaveBeenCalledTimes(1);
      release();
      await vi.waitFor(() => expect(f.store.markLeaseRenewed).toHaveBeenCalledWith(running.id, "bx_busy1", new Date(NOW)));
      await f.lifecycle.tick();
      expect(f.store.leasesDue).toHaveBeenCalledTimes(1);
      expect(f.store.leasesDue).toHaveBeenCalledWith(new Date(NOW - 12 * 60 * 60_000), 4);
      now += 60_001;
      vi.mocked(f.compute.extendLease).mockRejectedValueOnce(new Error("provider failure with private values"));
      vi.mocked(f.store.markLeaseRenewed).mockClear();
      await f.lifecycle.tick();
      await vi.waitFor(() => expect(f.compute.extendLease).toHaveBeenCalledTimes(2));
      expect(f.store.markLeaseRenewed).not.toHaveBeenCalled();
    } finally { release?.(); await stop(); }
  });

  it.each(["creating", "starting"] as const)("reports value-free %s phase durations and runtime replacement", async state => {
    let now = NOW;
    const timing = vi.fn();
    const f = setup([workspace(state, { boatSandboxId: state === "starting" ? "bx_test" : null })], { timing, now: () => now });
    vi.mocked(f.compute.create).mockImplementationOnce(async () => { now += 10; return { sandboxId: "bx_test" }; });
    vi.mocked(f.compute.resume).mockImplementationOnce(async () => { now += 10; });
    vi.mocked(f.compute.exec).mockImplementationOnce(async () => { now += 20; return { exitCode: 0, stdout: "runtime-changed\n", timedOut: false }; })
      .mockImplementationOnce(async () => { now += 40; return { exitCode: 0, stdout: "credential never logged", timedOut: false }; });
    vi.mocked(f.compute.hostPort).mockImplementationOnce(async () => { now += 30; return { url: "https://private.example.test", token: "never-log" }; });
    await f.lifecycle.tick();
    expect(timing.mock.calls.map(([record]) => record)).toEqual([
      { workspaceId: "6f2b7c1e", state, phase: state === "creating" ? "boat_create" : "boat_resume", durationMs: 10 },
      { workspaceId: "6f2b7c1e", state, phase: "runtime_install", durationMs: 20, runtimeChanged: true },
      { workspaceId: "6f2b7c1e", state, phase: "protected_route", durationMs: 30 },
      { workspaceId: "6f2b7c1e", state, phase: "token_delivery", durationMs: 40 },
      { workspaceId: "6f2b7c1e", state, phase: "total", durationMs: 100 },
    ]);
  });

  it("never lets a timing observer prevent a workspace from starting", async () => {
    const f = setup([workspace("creating")], { timing: () => { throw new Error("diagnostic sink unavailable"); } });
    await f.lifecycle.tick();
    expect(f.store.defer).toHaveBeenLastCalledWith(expect.any(String), "creating", 30_000);
  });

  it("admits a create while an earlier stop is waiting for its worker", async () => {
    const stopping = workspace("stopping", { boatSandboxId: "bx_stop1" });
    const creating = workspace("creating", { id: "7f2b7c1e-3b0a-4f7e-9d43-8a0b2b9c6d11" });
    const f = setup([stopping, creating]);
    let release!: (value: boolean) => void;
    vi.mocked(f.stopWorker).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const tick = f.lifecycle.tick();
    try {
      await vi.waitFor(() => expect(f.compute.create).toHaveBeenCalledTimes(1));
      expect(f.compute.stop).not.toHaveBeenCalled();
    } finally { release(true); await tick; }
  });

  it("fills free slots on later polls without reclaiming a step whose database lease expired", async () => {
    const stopping = workspace("stopping", { boatSandboxId: "bx_stop1" });
    const creating = workspace("creating", { id: "7f2b7c1e-3b0a-4f7e-9d43-8a0b2b9c6d11" });
    const f = setup([stopping]);
    vi.mocked(f.store.claimPending).mockResolvedValueOnce([stopping]).mockResolvedValueOnce([creating]);
    let release!: (value: boolean) => void;
    vi.mocked(f.stopWorker).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = f.lifecycle.tick();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const second = f.lifecycle.tick();
    try {
      await vi.waitFor(() => expect(f.compute.create).toHaveBeenCalledTimes(1));
      expect(f.store.claimPending).toHaveBeenLastCalledWith(3, 120_000, [stopping.id]);
      expect(f.stopWorker).toHaveBeenCalledTimes(1);
    } finally { release(true); await Promise.all([first, second]); }
  });

  it("bounds concurrent steps at four and serializes overlapping claims", async () => {
    const claimed = Array.from({ length: 4 }, (_, i) => workspace("stopping", { id: `workspace-${i}`, boatSandboxId: "bx_stop1" }));
    const f = setup(claimed);
    let release!: (value: boolean) => void;
    const blocked = new Promise<boolean>(resolve => { release = resolve; });
    vi.mocked(f.stopWorker).mockImplementation(() => blocked);
    const first = f.lifecycle.tick(), overlapping = f.lifecycle.tick();
    let later: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(f.stopWorker).toHaveBeenCalledTimes(4));
      later = f.lifecycle.tick();
      // The scan still runs, but no slots are available for another claim.
      await vi.waitFor(() => expect(f.store.idleSince).toHaveBeenCalledTimes(2));
      expect(f.store.claimPending).toHaveBeenCalledTimes(1);
      expect(f.store.claimPending).toHaveBeenCalledWith(4, 120_000, []);
    } finally { release(true); await Promise.all([first, overlapping, later]); }
  });

  it("continues interval admission while a step waits and drains it on shutdown", async () => {
    vi.useFakeTimers();
    const f = setup([workspace("stopping", { boatSandboxId: "bx_stop1" })]);
    vi.mocked(f.store.claimPending).mockResolvedValueOnce([workspace("stopping", { boatSandboxId: "bx_stop1" })]).mockResolvedValue([]);
    let release!: (value: boolean) => void;
    vi.mocked(f.stopWorker).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const stop = f.lifecycle.start();
    let stopped: Promise<void> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(4_000);
      expect(f.store.claimPending).toHaveBeenCalledTimes(2);
      let drained = false;
      stopped = stop().then(() => { drained = true; });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(drained).toBe(false);
      expect(f.store.claimPending).toHaveBeenCalledTimes(2);
      release(true);
      await stopped;
      expect(f.compute.stop).toHaveBeenCalledTimes(1);
    } finally { release?.(true); await (stopped ?? stop()); vi.useRealTimers(); }
  });

  it("lets the pending-work-aware idle transition run without revoking the worker before its final flush", async () => {
    const idle = workspace("running"), stopIdle = vi.fn(async () => {});
    const f = setup([], { idle: [idle], stopIdle });
    await f.lifecycle.tick();
    expect(stopIdle).toHaveBeenCalledWith(idle.id, new Date(NOW - CLOUD_V2_IDLE_STOP_MS));
    expect(f.store.revoke).not.toHaveBeenCalled();
    expect(f.store.transition).not.toHaveBeenCalled();
  });
  it("persists an encrypted protected route before delivering a boot token, on both create and wake", async () => {
    for (const state of ["creating", "starting"] as const) {
      const f = setup([workspace(state, { boatSandboxId: "bx_test" })]);
      await f.lifecycle.tick();
      expect(f.compute.hostPort).toHaveBeenCalledWith("bx_test", { port: 41783, localhost: true, title: "Zeros worker" });
      expect(f.store.setWorkerRoute).toHaveBeenCalledWith(expect.any(String), "bx_test", "https://fixture-41783.on.boat.dev", { encrypted: true });
      expect(vi.mocked(f.store.setWorkerRoute).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.store.rotateWorkerToken).mock.invocationCallOrder[0]!);
      expect(vi.mocked(f.compute.exec).mock.calls[0]![1]).toContain("worker-auth.json");
    }
  });

  it("waits for the worker's final history acknowledgement before stopping Boat", async () => {
    const f = setup([workspace("stopping", { boatSandboxId: "bx_test" })]);
    let release!: (value: boolean) => void;
    vi.mocked(f.stopWorker).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const step = f.lifecycle.tick();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(f.compute.stop).not.toHaveBeenCalled();
    release(true); await step;
    expect(f.compute.stop).toHaveBeenCalledWith("bx_test");
  });
  it("creates the VM from the org snapshot with the workspace id as idempotency key, then delivers the token", async () => {
    const { lifecycle, compute, store } = setup([workspace("creating")]);
    await lifecycle.tick();
    expect(compute.create).toHaveBeenCalledWith({
      key: "6f2b7c1e-3b0a-4f7e-9d43-8a0b2b9c6d11", from: "cv2-alpha-org-1", name: "zeros-alpha-6f2b7c1e", // gitleaks:allow
      env: { CLOUD_V2_API_URL: "https://api.example.test", ZEROS_WORKSPACE_ID: "6f2b7c1e-3b0a-4f7e-9d43-8a0b2b9c6d11" },
    });
    expect(JSON.stringify(vi.mocked(compute.create).mock.calls)).not.toContain(token);
    expect(vi.mocked(compute.exec).mock.calls[0]![0]).toBe("bx_new1");
    // The runtime the control plane names is installed before the worker starts.
    expect(vi.mocked(compute.exec).mock.calls[0]![1]).toContain(runtime);
    expect(vi.mocked(compute.exec).mock.calls[1]![1]).toContain(Buffer.from(token).toString("base64"));
    expect(store.defer).toHaveBeenLastCalledWith(expect.any(String), "creating", 30_000);
  });

  it("fails creation without a Cloud Computer and after the boot deadline", async () => {
    const none = setup([workspace("creating")], { snapshot: null });
    await none.lifecycle.tick();
    expect(none.store.transition).toHaveBeenCalledWith(expect.any(String), ["creating"], "failed", { errorCode: "cloud_computer_build_required" });
    expect(none.compute.create).not.toHaveBeenCalled();
    const late = setup([workspace("creating", { boatSandboxId: "bx_old1", createdAt: new Date(NOW - 11 * 60_000).toISOString() })]);
    await late.lifecycle.tick();
    expect(late.store.transition).toHaveBeenCalledWith(expect.any(String), ["creating"], "failed", { errorCode: "worker_boot_timeout" });
  });

  it("retries a provider failure with backoff and gives up after the last attempt", async () => {
    const failing = setup([workspace("stopping", { boatSandboxId: "bx_abc1", attempts: 2 })]);
    vi.mocked(failing.compute.stop).mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "provider_request_failed" }));
    await failing.lifecycle.tick();
    expect(failing.store.defer).toHaveBeenCalledWith(expect.any(String), "stopping", 20_000, { failure: true });
    const last = setup([workspace("stopping", { boatSandboxId: "bx_abc1", attempts: 8 })]);
    vi.mocked(last.compute.stop).mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "provider_budget_exhausted" }));
    await last.lifecycle.tick();
    expect(last.store.transition).toHaveBeenCalledWith(expect.any(String), ["stopping"], "failed", { errorCode: "provider_budget_exhausted" });
  });

  it("stops idle workspaces, revokes tokens on stop and drops history on delete", async () => {
    const idle = workspace("running");
    const { lifecycle, compute, store } = setup([
      workspace("stopping", { boatSandboxId: "bx_abc1" }),
      workspace("deleting", { id: "7f2b7c1e-3b0a-4f7e-9d43-8a0b2b9c6d11", boatSandboxId: "bx_def1" }),
    ], { idle: [idle] });
    await lifecycle.tick();
    expect(vi.mocked(store.idleSince).mock.calls[0]![0].getTime()).toBe(NOW - CLOUD_V2_IDLE_STOP_MS);
    expect(store.transition).toHaveBeenCalledWith(idle.id, ["running"], "stopping");
    expect(compute.stop).toHaveBeenCalledWith("bx_abc1");
    expect(store.revoke).toHaveBeenCalledWith(idle.id, false);
    expect(compute.delete).toHaveBeenCalledWith("bx_def1");
    expect(store.revoke).toHaveBeenCalledWith("7f2b7c1e-3b0a-4f7e-9d43-8a0b2b9c6d11", true);
  });

  it("resumes a stopped VM and delivers a fresh credential on every retry", async () => {
    const fresh = setup([workspace("starting", { boatSandboxId: "bx_abc1", updatedAt: new Date(NOW - 5_000).toISOString() })]);
    await fresh.lifecycle.tick();
    expect(fresh.compute.resume).toHaveBeenCalledWith("bx_abc1");
    // Every wake installs verification keys and restarts with a rotated token.
    expect(fresh.compute.exec).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fresh.compute.exec).mock.calls[0]![1]).toContain(runtime);
    expect(fresh.store.defer).toHaveBeenLastCalledWith(expect.any(String), "starting", 30_000);
    // A first delivery that failed while the VM restored is retried, never dropped.
    const slow = setup([workspace("starting", { boatSandboxId: "bx_abc1", attempts: 3, updatedAt: new Date(NOW - 45_000).toISOString() })]);
    await slow.lifecycle.tick();
    expect(slow.compute.resume).toHaveBeenCalledWith("bx_abc1");
    expect(slow.compute.exec).toHaveBeenCalledTimes(2);
  });

  it("retries a command while a resumed VM is still restoring", async () => {
    const restoring = setup([workspace("starting", { boatSandboxId: "bx_abc1", updatedAt: new Date(NOW - 5_000).toISOString() })]);
    vi.mocked(restoring.compute.exec).mockRejectedValueOnce(Object.assign(new Error("restoring"), { code: "provider_request_failed" }));
    await restoring.lifecycle.tick();
    expect(restoring.compute.exec).toHaveBeenCalledTimes(3);
    expect(restoring.store.defer).toHaveBeenLastCalledWith(expect.any(String), "starting", 30_000);
  });

  it("fails a wake that never reconnects, and a start without a VM at once", async () => {
    const late = setup([workspace("starting", { boatSandboxId: "bx_abc1", updatedAt: new Date(NOW - 11 * 60_000).toISOString() })]);
    await late.lifecycle.tick();
    expect(late.store.transition).toHaveBeenCalledWith(expect.any(String), ["starting"], "failed", { errorCode: "worker_boot_timeout" });
    expect(late.compute.resume).not.toHaveBeenCalled();
    const lost = setup([workspace("starting")]);
    await lost.lifecycle.tick();
    expect(lost.store.transition).toHaveBeenCalledWith(expect.any(String), ["starting"], "failed", { errorCode: "sandbox_missing" });
    expect(lost.store.defer).not.toHaveBeenCalled();
  });

  // Boat answers 404 for a VM it no longer has, and refuses to resume a disk
  // it deleted after 14 stopped days. Retrying for minutes cannot recover
  // either; the workspace showed "stopping" or "waking" until it gave up.
  it("fails at once when Boat no longer has the VM or its disk, for both wake and stop", async () => {
    const { CloudProviderError } = await import("./provider-error.js");
    const { BoatSnapshotExpiredError } = await import("./boat-client.js");
    const missing = () => new CloudProviderError("provider_not_found", "Boat API request did not succeed", false, { httpStatus: 404 });
    for (const [state, call, error] of [["starting", "resume", missing()], ["stopping", "stop", missing()], ["starting", "resume", new BoatSnapshotExpiredError()]] as const) {
      const f = setup([workspace(state, { boatSandboxId: "bx_gone1", updatedAt: new Date(NOW - 5_000).toISOString() })]);
      vi.mocked(f.compute[call]).mockRejectedValueOnce(error);
      await f.lifecycle.tick();
      expect(f.store.transition).toHaveBeenCalledWith(expect.any(String), [state], "failed", { errorCode: "sandbox_missing" });
      expect(f.store.revoke).toHaveBeenCalledWith(expect.any(String), false);
      expect(f.store.defer).not.toHaveBeenCalled();
    }
    // Any other refusal keeps the bounded retry.
    const busy = setup([workspace("stopping", { boatSandboxId: "bx_abc1" })]);
    vi.mocked(busy.compute.stop).mockRejectedValueOnce(new CloudProviderError("provider_request_failed", "Boat API request did not succeed", false, { httpStatus: 409 }));
    await busy.lifecycle.tick();
    expect(busy.store.transition).not.toHaveBeenCalled();
    expect(busy.store.defer).toHaveBeenCalledWith(expect.any(String), "stopping", 10_000, { failure: true });
  });

  it("writes the token through base64 without ever putting it in shell syntax", () => {
    const command = deliverWorkerTokenCommand(token);
    expect(command).not.toContain(token);
    expect(command).toContain(Buffer.from(token).toString("base64"));
    expect(command).toContain(CLOUD_V2_WORKER_TOKEN_PATH);
    expect(() => deliverWorkerTokenCommand("zw2w_'; rm -rf / #")).toThrow();
  });
});
