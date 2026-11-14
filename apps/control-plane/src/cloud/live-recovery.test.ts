import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { CloudLiveRecovery, LIVE_CONNECTION_UNAVAILABLE, type LiveRecoveryDeps } from "./live-recovery.js";
import { WorkerConnectionFailure, type WorkerRoute } from "./worker-connection.js";

const workspaceId = "00000000-0000-4000-8000-000000000001", boot = "00000000-0000-4000-8000-000000000002";
function fixture() {
  let now = 1_800_000_000_000, hosted = false;
  let route: WorkerRoute = { workspace: { id: workspaceId, boatSandboxId: "bx_fixture1234", state: "running", archivedAt: null, errorCode: null } as WorkerRoute["workspace"],
    bootId: boot, accessEpoch: "1", workerTokenHash: "a".repeat(64), url: "https://fixture-41783.on.boat.dev", token: "synthetic-port-token", portToken: { value: "synthetic-sealed-token" } };
  const original = route, effects: Array<{ phase: string; at: number }> = [];
  const socket = { close: vi.fn() } as unknown as WebSocket;
  const deps: LiveRecoveryDeps = {
    route: vi.fn(async () => route), now: () => now,
    wait: vi.fn(async (ms, signal) => { signal.throwIfAborted(); now += ms; }),
    witness: vi.fn(async () => ({ seen: () => true, dispose: vi.fn() })),
    compute: {
      exec: vi.fn(async () => { effects.push({ phase: "hide", at: now }); return { exitCode: 0, timedOut: false, stdout: "hidden" }; }),
      hostPort: vi.fn(async () => { effects.push({ phase: "host", at: now }); hosted = true; return { url: route.url!, token: route.token! }; }),
    },
    publish: vi.fn(async (_before, next) => { route = { ...route, ...next }; return true; }),
    condition: vi.fn(async (_before, unavailable) => { effects.push({ phase: unavailable ? "unavailable" : "available", at: now });
      route = { ...route, workspace: { ...route.workspace, errorCode: unavailable ? LIVE_CONNECTION_UNAVAILABLE : null } }; return true; }),
    ready: vi.fn(), mint: vi.fn(() => "synthetic-grant"), logger: { warn: vi.fn() },
    dial: vi.fn(async () => { if (hosted) return socket; now += 10_000; throw new WorkerConnectionFailure("gateway", "5xx"); }),
  };
  const recovery = new CloudLiveRecovery(deps);
  return { recovery, deps, original, effects, socket, now: () => now, route: () => route, change: (next: WorkerRoute) => { route = next; } };
}
const gateway = () => new WorkerConnectionFailure("gateway", "5xx");

describe("live route recovery", () => {
  it("escalates only a freshly witnessed failed rehost and suppresses the named condition while B owns it", async () => {
    const f = fixture();
    f.deps.rebuild = vi.fn(async () => true);
    vi.mocked(f.deps.dial!).mockRejectedValue(gateway());
    f.recovery.failed(f.original, gateway());
    await vi.waitFor(() => expect(f.deps.rebuild).toHaveBeenCalledOnce());
    expect(f.deps.witness).toHaveBeenCalledTimes(3); expect(f.deps.compute.hostPort).toHaveBeenCalledOnce();
    expect(f.deps.condition).not.toHaveBeenCalledWith(expect.anything(), true);
    await f.recovery.close();
  });
  it("keeps the named failure for an N-1 worker when B declines", async () => {
    const f = fixture(); f.deps.rebuild = vi.fn(async () => false);
    vi.mocked(f.deps.dial!).mockRejectedValue(gateway());
    f.recovery.failed(f.original, gateway());
    await vi.waitFor(() => expect(f.deps.condition).toHaveBeenCalledWith(expect.anything(), true));
    expect(f.deps.rebuild).toHaveBeenCalledOnce(); await f.recovery.close();
  });
  it("requires two non-overlapping minute windows and repairs only the route", async () => {
    const f = fixture(), started = f.now(); f.recovery.failed(f.original, gateway());
    await vi.waitFor(() => expect(f.deps.ready).toHaveBeenCalledExactlyOnceWith(workspaceId));
    expect(f.effects).toEqual([{ phase: "hide", at: started + 120_000 }, { phase: "host", at: started + 120_000 }, { phase: "available", at: started + 120_000 }]);
    expect(f.deps.witness).toHaveBeenCalledTimes(3);
    expect(f.deps.compute.hostPort).toHaveBeenCalledExactlyOnceWith("bx_fixture1234", expect.objectContaining({ port: 41783, localhost: true,
      key: `bx_fixture1234:host:41783:recovery:${boot}` }));
    expect(f.route().workspace).toEqual(f.original.workspace); expect(f.socket.close).toHaveBeenCalledWith(1000);
    await f.recovery.close();
  });
  it.each(["timeout", "server_unavailable", "refused", "transport"] as const)("does not repair from %s evidence", async reason => {
    const f = fixture(); vi.mocked(f.deps.dial!).mockRejectedValue(new WorkerConnectionFailure(reason));
    f.recovery.failed(f.original, gateway());
    await vi.waitFor(() => expect(f.deps.condition).toHaveBeenCalledWith(f.original, true));
    expect(f.deps.compute.exec).not.toHaveBeenCalled(); await f.recovery.close();
  });
  it("requires a new outbound proof in the second window too", async () => {
    const f = fixture(); vi.mocked(f.deps.witness).mockResolvedValueOnce({ seen: () => true, dispose: vi.fn() })
      .mockResolvedValueOnce({ seen: () => false, dispose: vi.fn() });
    f.recovery.failed(f.original, gateway());
    await vi.waitFor(() => expect(f.deps.condition).toHaveBeenCalledWith(f.original, true));
    expect(f.deps.compute.exec).not.toHaveBeenCalled(); await f.recovery.close();
  });
  it("joins duplicate failures, replays a lost command reply, and uses one host key", async () => {
    const f = fixture(); vi.mocked(f.deps.compute.exec).mockRejectedValueOnce(new Error("synthetic-secret-provider-canary"));
    f.recovery.failed(f.original, gateway()); f.recovery.failed(f.original, gateway());
    await vi.waitFor(() => expect(f.deps.ready).toHaveBeenCalledOnce());
    const calls = vi.mocked(f.deps.compute.exec).mock.calls;
    expect(calls).toHaveLength(2); expect(calls[0]![1]).toBe(calls[1]![1]);
    expect(f.deps.compute.hostPort).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(f.deps.logger!.warn).mock.calls)).not.toContain("synthetic-secret");
    await f.recovery.close();
  });
  it.each(["stop", "boot", "epoch", "route"] as const)("does not host after a concurrent %s while hide is pending", async change => {
    const f = fixture();
    vi.mocked(f.deps.compute.exec).mockImplementation(async () => {
      const next = { ...f.route() };
      if (change === "stop") next.workspace = { ...next.workspace, state: "stopping" };
      if (change === "boot") next.bootId = "00000000-0000-4000-8000-000000000003";
      if (change === "epoch") next.accessEpoch = "2";
      if (change === "route") next.token = "synthetic-new-port-token";
      f.change(next); return { exitCode: 0, timedOut: false, stdout: "hidden" };
    });
    f.recovery.failed(f.original, gateway());
    await vi.waitFor(() => expect(f.deps.compute.exec).toHaveBeenCalledOnce()); await f.recovery.close();
    expect(f.deps.compute.hostPort).not.toHaveBeenCalled(); expect(f.deps.publish).not.toHaveBeenCalled();
  });
  it("does not publish after a late host reply changed the boot", async () => {
    const f = fixture(); vi.mocked(f.deps.compute.hostPort).mockImplementation(async () => {
      f.change({ ...f.route(), bootId: "00000000-0000-4000-8000-000000000003" });
      return { url: f.original.url!, token: f.original.token! };
    });
    f.recovery.failed(f.original, gateway());
    await vi.waitFor(() => expect(f.deps.compute.hostPort).toHaveBeenCalledOnce()); await f.recovery.close();
    expect(f.deps.publish).not.toHaveBeenCalled();
  });
  it("names an exhausted repair without stopping the worker or repeating hide", async () => {
    const f = fixture(); vi.mocked(f.deps.dial!).mockRejectedValue(gateway()); f.recovery.failed(f.original, gateway());
    await vi.waitFor(() => expect(f.deps.condition).toHaveBeenCalledWith(expect.anything(), true));
    f.recovery.failed(f.route(), gateway());
    expect(f.route().workspace).toMatchObject({ state: "running", errorCode: LIVE_CONNECTION_UNAVAILABLE });
    expect(f.deps.compute.exec).toHaveBeenCalledOnce(); expect(f.deps.compute.hostPort).toHaveBeenCalledOnce();
    await f.recovery.close();
  });
  it("cancels verification immediately when a real client connects", async () => {
    const f = fixture(); let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    vi.mocked(f.deps.dial!).mockImplementation((_route, _grant, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(new WorkerConnectionFailure("cancelled")), { once: true }); enter();
    }));
    f.recovery.failed(f.original, gateway()); await entered; await f.recovery.connected(f.original);
    expect(f.deps.compute.exec).not.toHaveBeenCalled(); expect(f.deps.condition).toHaveBeenCalledExactlyOnceWith(f.original, false);
    await f.recovery.close();
  });
});
