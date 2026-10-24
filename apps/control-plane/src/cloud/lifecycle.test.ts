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
    leaseRenewedAt: null, baseCommit: null, checkpoint: null, restorePending: false,
    createdAt: new Date(NOW - 60_000).toISOString(), updatedAt: new Date(NOW).toISOString(), attempts: 1, ...extra,
  };
}

const WS = "6f2b7c1e-3b0a-4f7e-9d43-8a0b2b9c6d11";
const SAVED = { object: `cloud-v2/checkpoints/${WS}/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.zck`, key: { sealed: "previous" },
  sha256: "d".repeat(64), bytes: 4096, savedAt: new Date(NOW - 86_400_000).toISOString() };
const SAVED_LINE = `zeros-checkpoint-saved bytes=1234 sha256=${"e".repeat(64)}`;

function checkpointsFake() {
  return {
    storage: {
      uploadUrl: vi.fn(async () => "https://r2.example.test/put?X-Amz-Signature=up"),
      downloadUrl: vi.fn(async () => "https://r2.example.test/get?X-Amz-Signature=down"),
      size: vi.fn(async (): Promise<number | null> => 1234), delete: vi.fn(async () => {}), prune: vi.fn(async () => {}),
    },
    seal: vi.fn(() => ({ sealed: "new" })),
    open: vi.fn(() => Buffer.alloc(32, 7)),
  };
}

/** Answers each kind of VM command the way a healthy VM would. */
function vmCommands(f: { compute: CloudV2Compute }, overrides: { checkpoint?: string; restore?: string } = {}) {
  vi.mocked(f.compute.exec).mockImplementation(async (_id, command) => ({ exitCode: 0, timedOut: false,
    stdout: command.includes("zeros-checkpoint-saved") ? overrides.checkpoint ?? SAVED_LINE
      : command.includes("zeros-checkpoint-restored") ? overrides.restore ?? "zeros-checkpoint-restored" : "" }));
}
const vmCommand = (f: { compute: CloudV2Compute }, marker: string) => vi.mocked(f.compute.exec).mock.calls.find(([, command]) => command.includes(marker));

function setup(claimed: (CloudV2LifecycleWorkspace & { attempts: number })[], options: { snapshot?: string | null; idle?: CloudV2Workspace[]; stopIdle?: CloudV2LifecycleDeps["stopIdle"]; timing?: CloudV2LifecycleDeps["timing"]; now?: () => number;
  checkpoints?: ReturnType<typeof checkpointsFake>; remoteHead?: CloudV2LifecycleDeps["remoteHead"]; githubToken?: CloudV2LifecycleDeps["githubToken"] } = {}) {
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
    // Like the store: only the requested states, never an excluded id, at most `limit`.
    claimPending: vi.fn(async (limit: number, _lease: number, exclude: readonly string[] = [], states: readonly string[] = ["creating", "starting", "stopping", "deleting"]) =>
      claimed.filter(row => states.includes(row.state) && !exclude.includes(row.id)).slice(0, limit)),
    defer: vi.fn(async () => {}),
    transition: vi.fn(async () => null),
    rotateWorkerToken: vi.fn(async () => token),
    computerSnapshot: vi.fn(async () => options.snapshot === undefined ? "cv2-alpha-org-1" : options.snapshot),
    revoke: vi.fn(async () => {}),
    idleSince: vi.fn(async () => options.idle ?? []),
    setWorkerRoute: vi.fn(async () => true),
    leasesDue: vi.fn(async () => []),
    markLeaseRenewed: vi.fn(async () => true),
    setBaseCommit: vi.fn(async () => {}),
    saveCheckpoint: vi.fn(async (): Promise<{ replaced: string | null } | false> => ({ replaced: SAVED.object })),
    checkpointFailed: vi.fn(async () => {}),
    beginRestore: vi.fn(async (): Promise<{ snapshot: string } | "no_computer" | null> => ({ snapshot: "cv2-alpha-org-2" })),
    replaceSandbox: vi.fn(async (): Promise<CloudV2Workspace["state"] | null> => "starting"),
    finishRestore: vi.fn(async () => true),
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
    ...(options.checkpoints ? { checkpoints: options.checkpoints } : {}),
    ...(options.remoteHead ? { remoteHead: options.remoteHead } : {}),
    ...(options.githubToken ? { githubToken: options.githubToken } : {}),
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

  it("saves a checkpoint after the worker stops and before Boat stops the VM, then retires older ones", async () => {
    const checkpoints = checkpointsFake(), records: string[] = [];
    const stopping = workspace("stopping", { boatSandboxId: "bx_abc1", checkpoint: SAVED });
    const f = setup([stopping], { checkpoints, timing: record => records.push(record.phase) });
    vmCommands(f);
    await f.lifecycle.tick();
    const [, command, timeout] = vmCommand(f, "zeros-checkpoint-saved")!;
    expect(command).toContain("systemctl stop zeros-worker.service");
    expect(command).toContain("/home/user/o/r");
    expect(command).not.toContain(Buffer.alloc(32, 7).toString("base64"));
    expect(timeout).toBe(540);
    const saved = vi.mocked(f.store.saveCheckpoint).mock.calls[0]!;
    expect(saved[0]).toBe(stopping.id); expect(saved[1]).toBe("bx_abc1");
    expect(saved[2]).toEqual({ object: expect.stringMatching(new RegExp(`^cloud-v2/checkpoints/${WS}/[0-9a-f-]{36}\\.zck$`)), key: { sealed: "new" }, sha256: "e".repeat(64), bytes: 1234 });
    expect(saved[2].object).not.toBe(SAVED.object);
    expect(checkpoints.seal).toHaveBeenCalledWith(expect.any(Buffer), stopping.id, saved[2].object);
    expect(checkpoints.storage.uploadUrl).toHaveBeenCalledWith(stopping.id, saved[2].object);
    expect(checkpoints.storage.prune).toHaveBeenCalledWith(stopping.id, saved[2].object);
    // The claim is held for the whole command; the worker stopped first; Boat stops last.
    expect(f.store.defer).toHaveBeenCalledWith(stopping.id, "stopping", 660_000, { failure: true });
    expect(f.stopWorker).toHaveBeenCalledBefore(vi.mocked(f.compute.exec));
    expect(f.store.saveCheckpoint).toHaveBeenCalledBefore(vi.mocked(f.compute.stop));
    expect(f.compute.stop).toHaveBeenCalledWith("bx_abc1");
    expect(f.store.transition).toHaveBeenCalledWith(stopping.id, ["stopping"], "stopped");
    expect(records).toContain("checkpoint");
  });

  it.each([
    ["the VM reports a failure", { checkpoint: "zeros-checkpoint-error checkpoint_too_large pack" }, 1234, "checkpoint_too_large"],
    ["the upload is missing", {}, null, "checkpoint_upload_failed"],
    ["the upload has another size", {}, 99, "checkpoint_upload_failed"],
    ["the command prints nothing", { checkpoint: "" }, 1234, "checkpoint_failed"],
  ] as const)("still stops, keeps the previous checkpoint and records why when %s", async (_case, vm, size, code) => {
    const checkpoints = checkpointsFake(), logs: string[] = [];
    checkpoints.storage.size.mockResolvedValue(size);
    const stopping = workspace("stopping", { boatSandboxId: "bx_abc1", checkpoint: SAVED });
    const f = setup([stopping], { checkpoints });
    (f.lifecycle as unknown as { deps: { logger: Pick<Console, "warn"> } }).deps.logger = { warn: line => logs.push(String(line)) };
    vmCommands(f, vm);
    await f.lifecycle.tick();
    expect(f.store.saveCheckpoint).not.toHaveBeenCalled();
    expect(f.store.checkpointFailed).toHaveBeenCalledWith(stopping.id, "bx_abc1", code);
    expect(checkpoints.storage.delete).toHaveBeenCalledWith(stopping.id, expect.stringMatching(/^cloud-v2\/checkpoints\//));
    expect(checkpoints.storage.prune).not.toHaveBeenCalled();
    expect(f.compute.stop).toHaveBeenCalledWith("bx_abc1");
    expect(f.store.transition).toHaveBeenCalledWith(stopping.id, ["stopping"], "stopped");
    expect(logs).toEqual([`[cloud-v2] checkpoint failed (${code})`]);
  });

  it("removes only its own upload when another stop or deletion fenced it out, and saves once per stop", async () => {
    const checkpoints = checkpointsFake();
    const f = setup([workspace("stopping", { boatSandboxId: "bx_abc1" })], { checkpoints });
    vmCommands(f); vi.mocked(f.store.saveCheckpoint).mockResolvedValueOnce(false);
    await f.lifecycle.tick();
    const object = vi.mocked(f.store.saveCheckpoint).mock.calls[0]![2].object;
    expect(checkpoints.storage.delete).toHaveBeenCalledExactlyOnceWith(WS, object);
    expect(checkpoints.storage.prune).not.toHaveBeenCalled();
    // A stop retried after its checkpoint was saved does not save it again.
    const retried = setup([workspace("stopping", { boatSandboxId: "bx_abc1", updatedAt: new Date(NOW - 60_000).toISOString(),
      checkpoint: { ...SAVED, savedAt: new Date(NOW - 30_000).toISOString() } })], { checkpoints: checkpointsFake() });
    vmCommands(retried);
    await retried.lifecycle.tick();
    expect(vmCommand(retried, "zeros-checkpoint-saved")).toBeUndefined();
    expect(retried.compute.stop).toHaveBeenCalledWith("bx_abc1");
  });

  it.each(["expired", "missing"])("restores on a new VM from the active Cloud Computer when Boat %s the stopped one", async kind => {
    const { BoatSnapshotExpiredError } = await import("./boat-client.js");
    const { CloudProviderError } = await import("./provider-error.js");
    const checkpoints = checkpointsFake(), githubToken = vi.fn(async () => ({ token: `ghs_${"g".repeat(36)}` }));
    const waking = workspace("starting", { boatSandboxId: "bx_expired", checkpoint: SAVED });
    const f = setup([waking], { checkpoints, githubToken });
    vmCommands(f);
    vi.mocked(f.compute.resume).mockRejectedValueOnce(kind === "expired" ? new BoatSnapshotExpiredError() : new CloudProviderError("provider_not_found", "gone", false, { httpStatus: 404 }));
    await f.lifecycle.tick();
    expect(f.store.beginRestore).toHaveBeenCalledWith(waking.id, "bx_expired");
    expect(f.compute.create).toHaveBeenCalledWith(expect.objectContaining({ key: `restore:${waking.id}:${SAVED.object}`, from: "cv2-alpha-org-2" }));
    expect(f.store.beginRestore).toHaveBeenCalledBefore(vi.mocked(f.compute.create));
    expect(f.compute.delete).toHaveBeenCalledWith("bx_expired");
    expect(f.store.replaceSandbox).toHaveBeenCalledWith(waking.id, "bx_new1", new Date(NOW));
    const [, restore] = vmCommand(f, "zeros-checkpoint-restored")!;
    expect(restore).toContain("/home/user/o/r");
    expect(restore).toContain("https://github.com/o/r.git");
    expect(restore).not.toContain(`ghs_${"g".repeat(36)}`);
    expect(checkpoints.open).toHaveBeenCalledWith(SAVED.key, waking.id, SAVED.object);
    expect(checkpoints.storage.downloadUrl).toHaveBeenCalledWith(waking.id, SAVED.object);
    // Runtime first, then the checkpoint, then the worker's route and credential.
    const order = vi.mocked(f.compute.exec).mock.calls.map(([, command]) =>
      command.includes("zeros-checkpoint-restored") ? "restore" : command.includes("/opt/zeros/runtime") ? "runtime" : "token");
    expect(order).toEqual(["runtime", "restore", "token"]);
    expect(f.store.finishRestore).toHaveBeenCalledWith(waking.id, "bx_new1");
    expect(f.store.finishRestore).toHaveBeenCalledBefore(vi.mocked(f.compute.hostPort));
    expect(f.compute.hostPort).toHaveBeenCalledWith("bx_new1", expect.anything());
    expect(f.store.transition).not.toHaveBeenCalled();
    expect(f.store.defer).toHaveBeenLastCalledWith(waking.id, "starting", 30_000);
  });

  it("continues a pending restore under the same key, and retries a failed apply without losing the checkpoint", async () => {
    const lostReply = setup([workspace("starting", { restorePending: true, computerBuildId: "build-2", checkpoint: SAVED })], { checkpoints: checkpointsFake() });
    vmCommands(lostReply);
    await lostReply.lifecycle.tick();
    expect(lostReply.store.beginRestore).not.toHaveBeenCalled();
    expect(lostReply.store.computerSnapshot).toHaveBeenCalledWith("org", "build-2");
    expect(lostReply.compute.create).toHaveBeenCalledWith(expect.objectContaining({ key: `restore:${WS}:${SAVED.object}` }));
    expect(lostReply.store.finishRestore).toHaveBeenCalledWith(WS, "bx_new1");

    const failed = setup([workspace("starting", { boatSandboxId: "bx_new1", restorePending: true, checkpoint: SAVED })], { checkpoints: checkpointsFake() });
    vmCommands(failed, { restore: "zeros-checkpoint-error checkpoint_corrupt download" });
    await failed.lifecycle.tick();
    expect(failed.compute.resume).toHaveBeenCalledWith("bx_new1");
    expect(failed.compute.create).not.toHaveBeenCalled();
    expect(failed.store.finishRestore).not.toHaveBeenCalled();
    expect(failed.compute.hostPort).not.toHaveBeenCalled();
    expect(failed.store.defer).toHaveBeenLastCalledWith(WS, "starting", 10_000, { failure: true });

    const fresh = setup([workspace("starting", { checkpoint: SAVED })], { checkpoints: checkpointsFake() });
    vmCommands(fresh);
    await fresh.lifecycle.tick();
    expect(fresh.store.beginRestore).toHaveBeenCalledWith(WS, null);
    expect(fresh.store.finishRestore).toHaveBeenCalledWith(WS, "bx_new1");

    const noComputer = setup([workspace("starting", { boatSandboxId: "bx_expired", checkpoint: SAVED })], { checkpoints: checkpointsFake() });
    vi.mocked(noComputer.compute.resume).mockRejectedValueOnce(new (await import("./boat-client.js")).BoatSnapshotExpiredError());
    vi.mocked(noComputer.store.beginRestore).mockResolvedValueOnce("no_computer");
    await noComputer.lifecycle.tick();
    expect(noComputer.compute.create).not.toHaveBeenCalled();
    expect(noComputer.store.transition).toHaveBeenCalledWith(WS, ["starting"], "failed", { errorCode: "cloud_computer_build_required" });
  });

  it("never checkpoints a replacement that has not received the checkpoint, and finds one whose create reply was lost", async () => {
    for (const state of ["stopping", "deleting"] as const) {
      const checkpoints = checkpointsFake();
      const f = setup([workspace(state, { restorePending: true, computerBuildId: "build-2", checkpoint: SAVED })], { checkpoints });
      vi.mocked(f.store.replaceSandbox).mockResolvedValueOnce(state);
      vmCommands(f);
      await f.lifecycle.tick();
      expect(f.compute.create).toHaveBeenCalledWith(expect.objectContaining({ key: `restore:${WS}:${SAVED.object}` }));
      expect(vmCommand(f, "zeros-checkpoint-saved")).toBeUndefined();
      if (state === "stopping") expect(f.compute.stop).toHaveBeenCalledWith("bx_new1");
      else {
        expect(f.compute.delete).toHaveBeenCalledWith("bx_new1");
        expect(checkpoints.storage.prune).toHaveBeenCalledWith(WS);
      }
      expect(f.store.transition).toHaveBeenCalledWith(WS, [state], state === "stopping" ? "stopped" : "deleted");
    }
  });

  it("deletes every checkpoint object with the workspace and retries when storage fails", async () => {
    const checkpoints = checkpointsFake();
    const f = setup([workspace("deleting", { boatSandboxId: "bx_abc1", checkpoint: SAVED })], { checkpoints });
    await f.lifecycle.tick();
    expect(f.compute.delete).toHaveBeenCalledWith("bx_abc1");
    expect(checkpoints.storage.prune).toHaveBeenCalledExactlyOnceWith(WS);
    expect(checkpoints.storage.prune).toHaveBeenCalledBefore(vi.mocked(f.store.transition));
    const failing = checkpointsFake(); failing.storage.prune.mockRejectedValueOnce(new Error("storage unavailable"));
    const retry = setup([workspace("deleting", { boatSandboxId: "bx_abc1", checkpoint: SAVED })], { checkpoints: failing });
    await retry.lifecycle.tick();
    expect(retry.store.transition).not.toHaveBeenCalled();
    expect(retry.store.revoke).not.toHaveBeenCalled();
    expect(retry.store.defer).toHaveBeenCalledWith(WS, "deleting", 10_000, { failure: true });
  });

  it("records the base branch's GitHub head before delivering the token, and never waits on GitHub for long", async () => {
    const head = "c".repeat(40);
    const found = setup([workspace("creating")], { remoteHead: async () => head });
    await found.lifecycle.tick();
    expect(found.store.setBaseCommit).toHaveBeenCalledWith(WS, head);
    expect(found.store.setBaseCommit).toHaveBeenCalledBefore(vi.mocked(found.store.rotateWorkerToken));
    for (const remoteHead of [async () => { throw new Error("GitHub unavailable"); }, async () => "not-a-sha"]) {
      const f = setup([workspace("creating")], { remoteHead });
      await f.lifecycle.tick();
      expect(f.store.setBaseCommit).not.toHaveBeenCalled();
      expect(f.store.rotateWorkerToken).toHaveBeenCalled();
    }
    const known = vi.fn(async () => head);
    await setup([workspace("creating", { boatSandboxId: "bx_new1", baseCommit: head })], { remoteHead: known }).lifecycle.tick();
    expect(known).not.toHaveBeenCalled();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const hanging = setup([workspace("creating")], { remoteHead: () => new Promise<string | null>(() => {}) });
      const tick = hanging.lifecycle.tick();
      await vi.advanceTimersByTimeAsync(3_000);
      await tick;
      expect(hanging.store.setBaseCommit).not.toHaveBeenCalled();
      expect(hanging.store.defer).toHaveBeenLastCalledWith(WS, "creating", 30_000);
    } finally { vi.useRealTimers(); }
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
    const claimed = [stopping], f = setup(claimed);
    let release!: (value: boolean) => void;
    vi.mocked(f.stopWorker).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = f.lifecycle.tick();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    claimed.push(creating);
    const second = f.lifecycle.tick();
    try {
      await vi.waitFor(() => expect(f.compute.create).toHaveBeenCalledTimes(1));
      expect(f.store.claimPending).toHaveBeenCalledWith(3, 120_000, [stopping.id], ["creating", "starting", "deleting"]);
      expect(f.store.claimPending).toHaveBeenLastCalledWith(1, 120_000, [stopping.id, creating.id], ["stopping"]);
      expect(f.stopWorker).toHaveBeenCalledTimes(1);
    } finally { release(true); await Promise.all([first, second]); }
  });

  it("keeps creates and wakes moving while two stops save their checkpoints", async () => {
    const stops = Array.from({ length: 3 }, (_, i) => workspace("stopping", { id: `stopping-${i}`, boatSandboxId: `bx_stop${i}` }));
    const claimed: (CloudV2LifecycleWorkspace & { attempts: number })[] = [...stops, workspace("creating", { id: "creating-0" })];
    const f = setup(claimed);
    let release!: (value: boolean) => void;
    const blocked = new Promise<boolean>(resolve => { release = resolve; });
    vi.mocked(f.stopWorker).mockImplementation(() => blocked);
    const first = f.lifecycle.tick();
    let later: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(f.stopWorker).toHaveBeenCalledTimes(2));
      expect(f.compute.create).toHaveBeenCalledTimes(1);
      claimed.push(workspace("starting", { id: "starting-0", boatSandboxId: "bx_wake1" }));
      later = f.lifecycle.tick();
      await vi.waitFor(() => expect(f.compute.resume).toHaveBeenCalledWith("bx_wake1"));
      // The third stop waits for a stopping slot, however many slots are free.
      expect(f.stopWorker).toHaveBeenCalledTimes(2);
    } finally { release(true); await Promise.all([first, later]); }
    // Once the first two stops have finished, the third gets a slot.
    claimed.splice(0, 2);
    await f.lifecycle.tick();
    expect(f.stopWorker).toHaveBeenCalledTimes(3);
    expect(f.stopWorker).toHaveBeenLastCalledWith(expect.objectContaining({ id: "stopping-2" }));
  });

  it("bounds concurrent steps at four and serializes overlapping claims", async () => {
    const claimed = Array.from({ length: 5 }, (_, i) => workspace("deleting", { id: `workspace-${i}`, boatSandboxId: `bx_del${i}` }));
    const f = setup(claimed);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.compute.delete).mockImplementation(() => blocked);
    const first = f.lifecycle.tick(), overlapping = f.lifecycle.tick();
    let later: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(f.compute.delete).toHaveBeenCalledTimes(4));
      later = f.lifecycle.tick();
      // The scan still runs, but no slots are available for another claim.
      await vi.waitFor(() => expect(f.store.idleSince).toHaveBeenCalledTimes(2));
      expect(f.store.claimPending).toHaveBeenCalledTimes(1);
      expect(f.store.claimPending).toHaveBeenCalledWith(4, 120_000, [], ["creating", "starting", "deleting"]);
    } finally { release(); await Promise.all([first, overlapping, later]); }
  });

  it("continues interval admission while a step waits and drains it on shutdown", async () => {
    vi.useFakeTimers();
    const claimed = [workspace("stopping", { boatSandboxId: "bx_stop1" })];
    const f = setup(claimed);
    let release!: (value: boolean) => void;
    vi.mocked(f.stopWorker).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const stop = f.lifecycle.start();
    let stopped: Promise<void> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(4_000);
      // Two polls, each claiming creates first and then a stop slot.
      expect(f.store.claimPending).toHaveBeenCalledTimes(4);
      expect(f.stopWorker).toHaveBeenCalledTimes(1);
      let drained = false;
      stopped = stop().then(() => { drained = true; });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(drained).toBe(false);
      expect(f.store.claimPending).toHaveBeenCalledTimes(4);
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
