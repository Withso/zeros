import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(), list: vi.fn(), accept: vi.fn(),
  account: 1, owner: 1, stop: 0, status: "ready", autoConnect: true,
  listeners: new Set<() => void>(),
  clients: [] as Array<{ dispose: () => void; refresh: () => Promise<unknown> }>,
}));
vi.mock("../../cloud-v2", () => ({ connectCloudV2Workspace: mocks.connect }));
vi.mock("../../../features/team/control-plane", () => ({
  ControlPlaneError: class extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
}));
vi.mock("../../../state/cloud-workspace-catalog", () => ({
  acceptCloudEngineWorkspace: mocks.accept,
  cloudCatalogGeneration: () => mocks.account,
  cloudWorkspaceOwnerGeneration: () => mocks.owner,
  cloudWorkspaceStopVersion: () => mocks.stop,
  cloudWorkspaceDocument: () => ({ status: mocks.status, capabilities: { canWrite: true }, deletedAt: null }),
  canReadCloudWorkspace: () => true,
  cloudWorkspaceLifecycleTask: () => undefined,
  isCloudWorkspaceLifecyclePending: () => false,
  refreshCloudWorkspace: async () => ({}),
  subscribeCloudWorkspaces: (listener: () => void) => {
    mocks.listeners.add(listener); return () => mocks.listeners.delete(listener);
  },
}));
vi.mock("../workspace-bridge", () => ({ bridgeWorkspaceList: mocks.list }));
vi.mock("../ws-client", () => ({
  RuntimeClient: class {
    status = "connecting";
    lastRejection = null;
    listeners = new Set<(status: string) => void>();
    refresh: () => Promise<unknown>;
    dispose = vi.fn();
    constructor(_target: unknown, options: { refreshCloudConnectionTarget: () => Promise<unknown> }) {
      this.refresh = options.refreshCloudConnectionTarget; mocks.clients.push(this);
    }
    async connect() {
      if (!mocks.autoConnect) return;
      this.status = "connected"; for (const listener of this.listeners) listener(this.status);
    }
    onStatusChange(listener: (status: string) => void) {
      this.listeners.add(listener); return () => this.listeners.delete(listener);
    }
  },
}));

import { ControlPlaneError } from "../../../features/team/control-plane";
import { openCloudV2Runtime } from "../open-cloud-v2-runtime";
import { relayPresenceActive } from "../relay-presence";
import { cloudConnectBackoffKey, cloudConnectWaitMs, recordCloudConnectFailure, resetCloudConnectBackoffForTests } from "../cloud-connect-backoff";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const workspace = { id: target.workspaceId, path: "/home/user/example/repo" };
const ticket = { url: "wss://api.example.test/v2/cloud/workspaces/w/bridge", protocols: ["zeros.cloud.v2", "ticket.fixture"], expiresAt: "2030-01-01T00:00:00Z" };
const controllers: AbortController[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function opening(wake = true) {
  const controller = new AbortController(); controllers.push(controller);
  let settled = false;
  const result = openCloudV2Runtime(target, { wake, signal: controller.signal }).then(
    value => { settled = true; return value; }, error => { settled = true; return error as Error; });
  return { controller, result, settled: () => settled };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
const notify = () => { for (const listener of mocks.listeners) listener(); };
const unavailable = () => new ControlPlaneError(503, "cloud_workspace_unavailable", "Temporarily unavailable");

beforeEach(() => {
  vi.useFakeTimers();
  mocks.account = 1; mocks.owner = 1; mocks.stop = 0; mocks.status = "ready"; mocks.autoConnect = true;
  mocks.connect.mockReset().mockResolvedValue(ticket);
  mocks.list.mockReset().mockResolvedValue([workspace]); mocks.accept.mockReset();
  mocks.clients.length = 0; mocks.listeners.clear();
  // The lower jitter bound: each wait is half its ceiling (500 ms, 1 s, 2 s, 4 s, ...).
  resetCloudConnectBackoffForTests(); vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await flush(); vi.useRealTimers(); vi.restoreAllMocks();
});

describe("bounded cloud connect ticket retries", () => {
  it.each([
    unavailable(), new ControlPlaneError(502, "upstream_unavailable", "Unavailable"),
    new TypeError("Failed to fetch"), new DOMException("Network unavailable", "NetworkError"),
    new DOMException("Request timed out", "TimeoutError"),
  ])("waits before retrying a transient ticket failure: %s", async error => {
    mocks.connect.mockRejectedValueOnce(error);
    const attempt = opening(); await flush();
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(attempt.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(499); expect(mocks.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await attempt.result).toMatchObject({ scope: { ...target, root: workspace.path } });
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(mocks.accept).toHaveBeenCalledExactlyOnceWith(target, workspace, 1);
    expect(vi.getTimerCount()).toBe(0); expect(mocks.listeners.size).toBe(0);
  });

  it.each([
    ...[401, 403, 404, 409, 429].map(status => new ControlPlaneError(status, "cloud_workspace_not_running", "Refused")),
    new Error("network unavailable"), new DOMException("Cancelled", "AbortError"),
  ])("never retries a refusal, abort or untyped error: %s", async error => {
    mocks.connect.mockRejectedValue(error);
    const attempt = opening(); await flush();
    expect(await attempt.result).toBe(error); expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.clients).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("stops after five ticket attempts with nonzero increasing backoff", async () => {
    const error = unavailable(); mocks.connect.mockRejectedValue(error);
    const attempt = opening(); await flush();
    for (const [index, delay] of [500, 1_000, 2_000, 4_000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(mocks.connect).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.connect).toHaveBeenCalledTimes(index + 2);
    }
    expect(await attempt.result).toBe(error); expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds slow attempts together to thirty seconds, even if fetch ignores cancellation", async () => {
    const first = deferred<typeof ticket>(), second = deferred<typeof ticket>();
    mocks.connect.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const attempt = opening(); await flush();
    await vi.advanceTimersByTimeAsync(20_000); first.reject(new DOMException("Timeout", "TimeoutError"));
    await flush(); await vi.advanceTimersByTimeAsync(500);
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    const signal = mocks.connect.mock.calls[1]![1].signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(9_499); expect(attempt.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(attempt.settled()).toBe(true);
    expect(await attempt.result).toBeInstanceOf(Error); expect(signal.aborted).toBe(true);
    second.resolve(ticket); await flush(); expect(mocks.clients).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0); expect(mocks.listeners.size).toBe(0);
  });

  it.each(["request", "backoff"] as const)("cancels an in-flight %s on abort, account/owner replacement and Stop", async phase => {
    for (const cancel of [
      (controller: AbortController) => controller.abort(),
      () => { mocks.account += 2; notify(); },
      () => { mocks.owner += 2; notify(); },
      () => { mocks.stop++; mocks.status = "stopped"; notify(); },
    ]) {
      mocks.status = "ready"; mocks.connect.mockReset(); mocks.clients.length = 0;
      const held = deferred<typeof ticket>();
      if (phase === "request") mocks.connect.mockReturnValueOnce(held.promise);
      else mocks.connect.mockRejectedValueOnce(unavailable()).mockResolvedValue(ticket);
      const attempt = opening(); await flush();
      expect(attempt.settled()).toBe(false);
      cancel(attempt.controller); await flush(); expect(attempt.settled()).toBe(true);
      expect(await attempt.result).toBeInstanceOf(Error);
      held.resolve(ticket); await vi.advanceTimersByTimeAsync(30_000);
      expect(mocks.connect).toHaveBeenCalledTimes(1); expect(mocks.clients).toHaveLength(0);
      expect(mocks.accept).not.toHaveBeenCalled(); expect(mocks.listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("fences late checkout confirmation and disposes the client when Stop wins", async () => {
    const held = deferred<typeof workspace[]>(); mocks.list.mockReturnValueOnce(held.promise);
    const attempt = opening(); await flush(); expect(mocks.list).toHaveBeenCalledTimes(1);
    mocks.stop++; notify(); await flush();
    expect(attempt.settled()).toBe(true); expect(await attempt.result).toBeInstanceOf(Error);
    expect(mocks.clients[0]!.dispose).toHaveBeenCalledTimes(1);
    held.resolve([workspace]); await flush(); expect(mocks.accept).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); expect(mocks.listeners.size).toBe(0);
  });

  it("counts ticket acquisition against the original three-minute open deadline", async () => {
    const held = deferred<typeof ticket>(); mocks.connect.mockReturnValueOnce(held.promise); mocks.autoConnect = false;
    const attempt = opening(); await flush(); await vi.advanceTimersByTimeAsync(10_000);
    held.resolve(ticket); await flush(); expect(mocks.clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(169_999); expect(attempt.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(attempt.settled()).toBe(true);
    expect(await attempt.result).toBeInstanceOf(Error); expect(mocks.clients[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])("keeps every reconnect retry passive after wake=%s", async wake => {
    const attempt = opening(wake); await flush(); await attempt.result;
    expect(mocks.connect.mock.calls[0]![1].wake).toBe(wake);
    mocks.connect.mockClear().mockRejectedValueOnce(unavailable()).mockResolvedValue(ticket);
    const refreshing = mocks.clients[0]!.refresh().catch(error => error); await flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(await refreshing).toMatchObject({ kind: "cloud", workspaceId: target.workspaceId });
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    for (const [, options] of mocks.connect.mock.calls) expect(options.wake).toBe(false);
    expect(vi.getTimerCount()).toBe(0); expect(mocks.listeners.size).toBe(0);
  });

  it("ends a reconnect ticket retry when the original open deadline expires", async () => {
    mocks.autoConnect = false;
    const attempt = opening(); await flush();
    await vi.advanceTimersByTimeAsync(179_000);
    mocks.connect.mockRejectedValue(unavailable());
    let settled = false;
    const reconnect = mocks.clients[0]!.refresh().catch(error => { settled = true; return error; });
    await flush(); await vi.advanceTimersByTimeAsync(1_000);
    expect(attempt.settled()).toBe(true); expect(settled).toBe(true);
    expect(await reconnect).toBeInstanceOf(Error); expect(vi.getTimerCount()).toBe(0);
  });

  it("does not consume the next connection sequence when ticket retries are exhausted", async () => {
    const attempt = opening(); await flush(); await attempt.result;
    mocks.connect.mockRejectedValue(unavailable());
    const failed = mocks.clients[0]!.refresh().catch(error => error);
    await vi.advanceTimersByTimeAsync(7_500);
    expect(await failed).toBeInstanceOf(Error);
    mocks.connect.mockResolvedValue(ticket);
    // The next ticket waits for the shared backoff (the fifth failure set 8 s).
    const next = mocks.clients[0]!.refresh(); await vi.advanceTimersByTimeAsync(8_000);
    expect(await next).toMatchObject({ connectionSequence: 2 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a held reconnect ticket when its peer is released", async () => {
    const attempt = opening(); await flush();
    const peer = await attempt.result;
    if (peer instanceof Error) throw peer;
    const held = deferred<typeof ticket>(); mocks.connect.mockReturnValueOnce(held.promise);
    let settled = false;
    const reconnect = mocks.clients[0]!.refresh().catch(error => { settled = true; return error; });
    await flush(); peer.release(); await flush();
    expect(settled).toBe(true); expect(await reconnect).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("shares one backoff across opens: a second open waits before posting connect again", async () => {
    mocks.connect.mockRejectedValue(unavailable());
    const first = opening(); await flush(); await vi.advanceTimersByTimeAsync(7_500);
    expect(await first.result).toBeInstanceOf(Error); expect(mocks.connect).toHaveBeenCalledTimes(5);
    const second = opening(); await flush();
    await vi.advanceTimersByTimeAsync(7_999); expect(mocks.connect).toHaveBeenCalledTimes(5);
    mocks.connect.mockResolvedValue(ticket);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.connect).toHaveBeenCalledTimes(6);
    expect(await second.result).toMatchObject({ scope: { ...target, root: workspace.path } });
  });

  it("waits at least 30 s between connect posts once failures have grown, outside the 30 s ticket window", async () => {
    const key = cloudConnectBackoffKey(target);
    for (let index = 0; index < 7; index++) recordCloudConnectFailure(key);
    expect(cloudConnectWaitMs(key)).toBe(30_000);
    mocks.connect.mockRejectedValueOnce(unavailable()).mockResolvedValue(ticket);
    const attempt = opening(); await flush();
    await vi.advanceTimersByTimeAsync(29_999); expect(mocks.connect).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1); expect(mocks.connect).toHaveBeenCalledTimes(1);
    // The next wait (30 s) cannot fit the ticket window: the open fails without another post.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await attempt.result).toBeInstanceOf(Error); expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(cloudConnectWaitMs(key)).toBeGreaterThanOrEqual(0);
  });

  it("cancels a shared-backoff wait on abort without posting", async () => {
    recordCloudConnectFailure(cloudConnectBackoffKey(target));
    const attempt = opening(); await flush();
    attempt.controller.abort(); await flush();
    expect(await attempt.result).toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(5_000); expect(mocks.connect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("R1 relay-presence-v1: a connection admitted with the feature counts as presence while open; without it, never", async () => {
    mocks.connect.mockResolvedValueOnce({ ...ticket, features: ["relay-presence-v1"] } as never);
    const attempt = opening(); await flush();
    const peer = await attempt.result;
    if (peer instanceof Error) throw peer;
    expect(relayPresenceActive(target)).toBe(true);
    peer.release();
    expect(relayPresenceActive(target)).toBe(false);
    const plain = opening(); await flush();
    const other = await plain.result;
    if (other instanceof Error) throw other;
    expect(relayPresenceActive(target)).toBe(false);
    other.release();
  });
});
