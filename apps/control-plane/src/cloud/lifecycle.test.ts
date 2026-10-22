import { describe, expect, it, vi } from "vitest";
import type { CloudV2Compute } from "./boat.js";
import { CLOUD_V2_IDLE_STOP_MS, CLOUD_V2_WORKER_TOKEN_PATH, CloudV2Lifecycle, deliverWorkerTokenCommand, type CloudV2LifecycleDeps } from "./lifecycle.js";
import type { CloudV2Workspace } from "./store.js";
import { generateKeyPairSync } from "node:crypto";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const token = `zw2w_${"a".repeat(43)}`;
const runtime = `/opt/zeros/runtime/${"b".repeat(64)}`;
const publicKeys = [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()];

function workspace(state: CloudV2Workspace["state"], extra: Partial<CloudV2Workspace> = {}): CloudV2Workspace & { attempts: number } {
  return {
    id: "6f2b7c1e-3b0a-4f7e-9d43-8a0b2b9c6d11", organizationId: "org", creatorUserId: "u", name: "w", repository: "o/r",
    branch: "zeros/w", baseBranch: "main", state, boatSandboxId: null, computerBuildId: null, errorCode: null, activeAt: null, archivedAt: null,
    createdAt: new Date(NOW - 60_000).toISOString(), updatedAt: new Date(NOW).toISOString(), attempts: 1, ...extra,
  };
}

function setup(claimed: (CloudV2Workspace & { attempts: number })[], options: { snapshot?: string | null; idle?: CloudV2Workspace[] } = {}) {
  const compute: CloudV2Compute = {
    create: vi.fn(async () => ({ sandboxId: "bx_new1" })),
    resume: vi.fn(async () => {}),
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
  };
  const stopWorker = vi.fn(async () => true);
  const lifecycle = new CloudV2Lifecycle({
    store, compute, now: () => NOW, sleep: async () => {},
    publicKeys, sealPortToken: () => ({ encrypted: true }), stopWorker,
    runtime: { sha256: "b".repeat(64), url: async () => "https://r2.example.test/runtime.tar.gz?sig=1" },
    bootEnv: ws => ({ CLOUD_V2_API_URL: "https://api.example.test", ZEROS_WORKSPACE_ID: ws.id }),
    sandboxName: ws => `zeros-alpha-${ws.id.slice(0, 8)}`,
  });
  return { lifecycle, compute, store, stopWorker };
}

describe("cloud v2 lifecycle", () => {
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

  it("writes the token through base64 without ever putting it in shell syntax", () => {
    const command = deliverWorkerTokenCommand(token);
    expect(command).not.toContain(token);
    expect(command).toContain(Buffer.from(token).toString("base64"));
    expect(command).toContain(CLOUD_V2_WORKER_TOKEN_PATH);
    expect(() => deliverWorkerTokenCommand("zw2w_'; rm -rf / #")).toThrow();
  });
});
