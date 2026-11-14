import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { CloudLiveRecovery, LIVE_CONNECTION_UNAVAILABLE, type LiveRecoveryDeps } from "./live-recovery.js";
import { WorkerConnectionFailure, type WorkerRoute } from "./worker-connection.js";

const workspaceId = "00000000-0000-4000-8000-000000000001", boot = "00000000-0000-4000-8000-000000000002";
function fixture() {
  let now = 1_800_000_000_000;
  let route: WorkerRoute = { workspace: { id: workspaceId, boatSandboxId: "bx_fixture1234", state: "running", archivedAt: null, errorCode: null } as WorkerRoute["workspace"],
    bootId: boot, accessEpoch: "1", workerTokenHash: "a".repeat(64), url: "https://fixture-41783.on.boat.dev", token: "synthetic-port-token", portToken: { value: "synthetic-sealed-token" } };
  const original = route, effects: Array<{ phase: string; at: number }> = [];
  const socket = { close: vi.fn() } as unknown as WebSocket;
  const deps: LiveRecoveryDeps = {
    route: vi.fn(async () => route), now: () => now,
    wait: vi.fn(async (ms, signal) => { signal.throwIfAborted(); now += ms; }),
    witness: vi.fn(async () => ({ seen: () => true, dispose: vi.fn() })),
    rebuild: vi.fn(async () => { effects.push({ phase: "rebuild", at: now }); return true; }),
    condition: vi.fn(async (_before, unavailable) => { effects.push({ phase: unavailable ? "unavailable" : "available", at: now });
      route = { ...route, workspace: { ...route.workspace, errorCode: unavailable ? LIVE_CONNECTION_UNAVAILABLE : null } }; return true; }),
    ready: vi.fn(), mint: vi.fn(() => "synthetic-grant"), logger: { warn: vi.fn() },
    dial: vi.fn(async () => { now += 10_000; throw new WorkerConnectionFailure("gateway", "5xx"); }),
  };
  const recovery = new CloudLiveRecovery(deps);
  return { recovery, deps, original, effects, socket, now: () => now, route: () => route, change: (next: WorkerRoute) => { route = next; } };
}
const gateway = () => new WorkerConnectionFailure("gateway", "5xx");

describe("live route recovery", () => {
  it("requires two non-overlapping witnessed minute windows before admitting a rebuild", async () => {
    const f = fixture(), started = f.now(); f.recovery.failed(f.original, gateway());
    await vi.waitFor(() => expect(f.deps.rebuild).toHaveBeenCalledExactlyOnceWith(f.original));
    expect(f.effects).toEqual([{ phase: "rebuild", at: started + 120_000 }]);
    expect(f.deps.witness).toHaveBeenCalledTimes(2);
    expect(f.deps.condition).not.toHaveBeenCalled();
    expect(f.route()).toEqual(f.original);
    await f.recovery.close();
  });
  it("keeps the named failure for an N-1 worker when B declines", async () => {
    const f = fixture(); vi.mocked(f.deps.rebuild!).mockResolvedValue(false);
    f.recovery.failed(f.original, gateway());
    await vi.waitFor(() => expect(f.deps.condition).toHaveBeenCalledWith(f.original, true));
    expect(f.deps.rebuild).toHaveBeenCalledOnce(); await f.recovery.close();
  });
  it("ends verification immediately when a probe connects", async () => {
    const f = fixture(); vi.mocked(f.deps.dial!).mockResolvedValueOnce(f.socket);
    f.recovery.failed(f.original, gateway());
    await vi.waitFor(() => expect(f.deps.ready).toHaveBeenCalledExactlyOnceWith(workspaceId));
    expect(f.deps.rebuild).not.toHaveBeenCalled(); expect(f.socket.close).toHaveBeenCalledWith(1000);
    await f.recovery.close();
  });
  it.each(["timeout", "server_unavailable", "refused", "transport"] as const)("does not rebuild from %s evidence", async reason => {
    const f = fixture(); vi.mocked(f.deps.dial!).mockRejectedValue(new WorkerConnectionFailure(reason));
    f.recovery.failed(f.original, gateway());
    await vi.waitFor(() => expect(f.deps.condition).toHaveBeenCalledWith(f.original, true));
    expect(f.deps.rebuild).not.toHaveBeenCalled(); await f.recovery.close();
  });
  it("requires a new outbound proof in the second window too", async () => {
    const f = fixture(); vi.mocked(f.deps.witness).mockResolvedValueOnce({ seen: () => true, dispose: vi.fn() })
      .mockResolvedValueOnce({ seen: () => false, dispose: vi.fn() });
    f.recovery.failed(f.original, gateway());
    await vi.waitFor(() => expect(f.deps.condition).toHaveBeenCalledWith(f.original, true));
    expect(f.deps.rebuild).not.toHaveBeenCalled(); await f.recovery.close();
  });
  it("joins duplicate failures and contains an uncertain rebuild reply", async () => {
    const f = fixture(); vi.mocked(f.deps.rebuild!).mockRejectedValue(new Error("synthetic-secret-provider-canary"));
    f.recovery.failed(f.original, gateway()); f.recovery.failed(f.original, gateway());
    await vi.waitFor(() => expect(f.deps.condition).toHaveBeenCalledWith(f.original, true));
    f.recovery.failed(f.route(), gateway());
    expect(f.deps.rebuild).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(f.deps.logger!.warn).mock.calls)).not.toContain("synthetic-secret");
    await f.recovery.close();
  });
  it.each(["stop", "boot", "epoch", "route", "sandbox", "archive", "token"] as const)("does not rebuild after a concurrent %s at the final witness", async change => {
    const f = fixture();
    vi.mocked(f.deps.witness).mockResolvedValueOnce({ seen: () => true, dispose: vi.fn() })
      .mockResolvedValueOnce({ seen: () => {
        const next = { ...f.route() };
        if (change === "stop") next.workspace = { ...next.workspace, state: "stopping" };
        if (change === "boot") next.bootId = "00000000-0000-4000-8000-000000000003";
        if (change === "epoch") next.accessEpoch = "2";
        if (change === "route") next.token = "synthetic-new-port-token";
        if (change === "sandbox") next.workspace = { ...next.workspace, boatSandboxId: "bx_successor1234" };
        if (change === "archive") next.workspace = { ...next.workspace, archivedAt: new Date(f.now()).toISOString() };
        if (change === "token") next.workerTokenHash = "b".repeat(64);
        f.change(next); return true;
      }, dispose: vi.fn() });
    f.recovery.failed(f.original, gateway());
    await vi.waitFor(() => expect(f.route()).not.toEqual(f.original)); await f.recovery.close();
    expect(f.deps.rebuild).not.toHaveBeenCalled(); expect(f.deps.condition).not.toHaveBeenCalled();
  });
  it("does not publish a stale failure after a late rebuild refusal", async () => {
    const f = fixture(); vi.mocked(f.deps.rebuild!).mockImplementation(async () => {
      f.change({ ...f.route(), bootId: "00000000-0000-4000-8000-000000000003" }); return false;
    });
    f.recovery.failed(f.original, gateway());
    await vi.waitFor(() => expect(f.deps.rebuild).toHaveBeenCalledOnce()); await f.recovery.close();
    expect(f.deps.condition).not.toHaveBeenCalled();
  });
  it("cancels verification immediately when a real client connects", async () => {
    const f = fixture(); let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    vi.mocked(f.deps.dial!).mockImplementation((_route, _grant, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(new WorkerConnectionFailure("cancelled")), { once: true }); enter();
    }));
    f.recovery.failed(f.original, gateway()); await entered; await f.recovery.connected(f.original);
    expect(f.deps.rebuild).not.toHaveBeenCalled(); expect(f.deps.condition).toHaveBeenCalledExactlyOnceWith(f.original, false);
    await f.recovery.close();
  });
});
