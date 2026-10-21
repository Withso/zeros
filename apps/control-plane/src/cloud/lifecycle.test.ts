import { describe, expect, it, vi } from "vitest";
import type { CloudV2Compute } from "./boat.js";
import { CLOUD_V2_IDLE_STOP_MS, CLOUD_V2_WORKER_TOKEN_PATH, CloudV2Lifecycle, deliverWorkerTokenCommand, type CloudV2LifecycleDeps } from "./lifecycle.js";
import type { CloudV2Workspace } from "./store.js";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const token = `zw2w_${"a".repeat(43)}`;

function workspace(state: CloudV2Workspace["state"], extra: Partial<CloudV2Workspace> = {}): CloudV2Workspace & { attempts: number } {
  return {
    id: "6f2b7c1e-3b0a-4f7e-9d43-8a0b2b9c6d11", organizationId: "org", creatorUserId: "u", name: "w", repository: "o/r",
    branch: "zeros/w", baseBranch: "main", state, boatSandboxId: null, computerBuildId: null, errorCode: null, activeAt: null,
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
    saveSnapshot: vi.fn(async () => {}),
    deleteSnapshot: vi.fn(async () => {}),
  };
  const store: CloudV2LifecycleDeps["store"] = {
    claimPending: vi.fn(async () => claimed),
    defer: vi.fn(async () => {}),
    transition: vi.fn(async () => null),
    rotateWorkerToken: vi.fn(async () => token),
    computerSnapshot: vi.fn(async () => options.snapshot === undefined ? "cv2-alpha-org-1" : options.snapshot),
    revoke: vi.fn(async () => {}),
    idleSince: vi.fn(async () => options.idle ?? []),
  };
  const lifecycle = new CloudV2Lifecycle({
    store, compute, now: () => NOW,
    bootEnv: ws => ({ ZEROS_WORKER_URL: "wss://relay/v2/cloud/worker", ZEROS_WORKSPACE_ID: ws.id }),
    sandboxName: ws => `zeros-alpha-${ws.id.slice(0, 8)}`,
  });
  return { lifecycle, compute, store };
}

describe("cloud v2 lifecycle", () => {
  it("creates the VM from the org snapshot with the workspace id as idempotency key, then delivers the token", async () => {
    const { lifecycle, compute, store } = setup([workspace("creating")]);
    await lifecycle.tick();
    expect(compute.create).toHaveBeenCalledWith({
      key: "6f2b7c1e-3b0a-4f7e-9d43-8a0b2b9c6d11", from: "cv2-alpha-org-1", name: "zeros-alpha-6f2b7c1e",
      env: { ZEROS_WORKER_URL: "wss://relay/v2/cloud/worker", ZEROS_WORKSPACE_ID: "6f2b7c1e-3b0a-4f7e-9d43-8a0b2b9c6d11" },
    });
    expect(JSON.stringify(vi.mocked(compute.create).mock.calls)).not.toContain(token);
    expect(vi.mocked(compute.exec).mock.calls[0]![0]).toBe("bx_new1");
    expect(store.defer).toHaveBeenLastCalledWith(expect.any(String), "creating", 15_000);
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
    expect(failing.store.defer).toHaveBeenCalledWith(expect.any(String), "stopping", 20_000);
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

  it("resumes a starting VM and re-delivers the token on the first attempt only", async () => {
    const first = setup([workspace("starting", { boatSandboxId: "bx_abc1", attempts: 1 })]);
    await first.lifecycle.tick();
    expect(first.compute.resume).toHaveBeenCalledWith("bx_abc1");
    expect(first.compute.exec).toHaveBeenCalledTimes(1);
    const second = setup([workspace("starting", { boatSandboxId: "bx_abc1", attempts: 2 })]);
    await second.lifecycle.tick();
    expect(second.compute.resume).not.toHaveBeenCalled();
    expect(second.compute.exec).not.toHaveBeenCalled();
  });

  it("writes the token through base64 without ever putting it in shell syntax", () => {
    const command = deliverWorkerTokenCommand(token);
    expect(command).not.toContain(token);
    expect(command).toContain(Buffer.from(token).toString("base64"));
    expect(command).toContain(CLOUD_V2_WORKER_TOKEN_PATH);
    expect(() => deliverWorkerTokenCommand("zw2w_'; rm -rf / #")).toThrow();
  });
});
