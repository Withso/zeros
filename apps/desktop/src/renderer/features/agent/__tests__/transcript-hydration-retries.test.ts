import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const availability = vi.hoisted(() => ({ running: true }));
vi.mock("../../../state/cloud-workspace-catalog", async original => ({
  ...(await original<typeof import("../../../state/cloud-workspace-catalog")>()),
  canBackgroundSyncCloudWorkspace: () => availability.running,
}));
import { setActiveBridge } from "../../../platform/bridge/active-bridge";
import { cloudScopedId } from "../../../platform/bridge/cloud-workspace-key";
import { WorkspaceRuntimeClient } from "../../../platform/bridge/workspace-runtime-client";
import type { ConnectionStatus } from "../../../platform/bridge/ws-client";
import { TranscriptHydrationRetries } from "../transcript-hydration-retries";

const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const cloudChat = cloudScopedId(target, "conversation");
const folder = `cloud://${target.organizationId}/${target.workspaceId}`;
const cleanups: (() => void)[] = [];
const settle = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
beforeEach(() => { availability.running = true; });

function transport(initial: ConnectionStatus = "disconnected") {
  const listeners = new Map<string, Set<() => void>>();
  const statuses = new Map<string, ConnectionStatus>([[folder, initial]]);
  const bridge = new WorkspaceRuntimeClient({ open: vi.fn(), workspaces: () => [] });
  vi.spyOn(bridge, "status", "get").mockReturnValue("connected");
  vi.spyOn(bridge, "statusForWorkspace").mockImplementation(key => statuses.get(key!) ?? "disconnected");
  vi.spyOn(bridge, "onWorkspaceStatusChange").mockImplementation((key, fn) => {
    const list = listeners.get(key) ?? new Set();
    list.add(fn); listeners.set(key, list);
    return () => { list.delete(fn); };
  });
  setActiveBridge(bridge);
  cleanups.push(() => bridge.dispose());
  return {
    connect(key = folder) {
      statuses.set(key, "connected");
      for (const fn of listeners.get(key) ?? []) fn();
    },
    disconnect() {
      statuses.set(folder, "disconnected");
      for (const fn of listeners.get(folder) ?? []) fn();
    },
    listeners,
  };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  setActiveBridge(null);
  vi.restoreAllMocks();
});

describe("transcript hydration after a workspace connection failure", () => {
  it("continues local hydration when cloud background reads are unavailable", async () => {
    transport();
    availability.running = false;
    const retry = vi.fn(async (_id: string, _current: () => boolean) => {});
    const pending = new TranscriptHydrationRetries(retry);
    cleanups.push(() => pending.clear());

    pending.add("local-chat");
    await settle();

    expect(retry).toHaveBeenCalledExactlyOnceWith("local-chat", expect.any(Function));
    expect(retry.mock.calls[0][1]()).toBe(true);
  });
  it("keeps background retries inert while its cloud workspace is stopped or archived", async () => {
    const connection = transport("connected");
    availability.running = false;
    const retry = vi.fn(async () => {}), pending = new TranscriptHydrationRetries(retry);
    cleanups.push(() => pending.clear());
    pending.add(cloudChat);
    for (let index = 0; index < 20; index++) { pending.nudge(cloudChat); connection.connect(); }
    await settle(); expect(retry).not.toHaveBeenCalled();
    availability.running = true;
    connection.disconnect(); connection.connect(); await settle();
    expect(retry).toHaveBeenCalledOnce();
  });
  it("retries readable cloud history on a database nudge without reconnecting its VM", async () => {
    transport();
    const retry = vi.fn(async () => { pending.add(cloudChat); });
    const pending = new TranscriptHydrationRetries(retry);
    cleanups.push(() => pending.clear());
    pending.add(cloudChat);
    pending.nudge("other-chat");
    await settle();
    expect(retry).not.toHaveBeenCalled();
    pending.nudge(cloudChat);
    pending.nudge(cloudChat);
    await settle();
    expect(retry).toHaveBeenCalledOnce();
    pending.nudge(cloudChat);
    await settle();
    expect(retry).toHaveBeenCalledTimes(2);
    pending.delete(cloudChat);
    pending.nudge(cloudChat);
    await settle();
    expect(retry).toHaveBeenCalledTimes(2);
  });
  it("retries only the reconnecting cloud workspace while Local remains connected", async () => {
    const connection = transport();
    const retry = vi.fn(async () => {});
    const pending = new TranscriptHydrationRetries(retry);
    cleanups.push(() => pending.clear());
    pending.add(cloudChat);
    await settle();
    expect(retry).not.toHaveBeenCalled();
    connection.connect(`${folder}/other`);
    await settle();
    expect(retry).not.toHaveBeenCalled();
    connection.connect();
    await settle();
    expect(retry).toHaveBeenCalledExactlyOnceWith(cloudChat, expect.any(Function));
  });

  it("recovers when reconnection finished before the failed read rejected, without spinning", async () => {
    transport("connected");
    const retry = vi.fn(async () => { pending.add(cloudChat); });
    const pending = new TranscriptHydrationRetries(retry);
    cleanups.push(() => pending.clear());
    pending.add(cloudChat);
    await settle();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("keeps a connection edge that arrives while the previous retry is still settling", async () => {
    const connection = transport("connected");
    let finish!: () => void;
    const retry = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = new TranscriptHydrationRetries(retry);
    cleanups.push(() => pending.clear());
    pending.add(cloudChat);
    await settle();
    connection.disconnect(); connection.connect();
    pending.add(cloudChat);
    expect(retry).toHaveBeenCalledOnce();
    finish();
    await settle();
    expect(retry).toHaveBeenCalledTimes(2);
    finish();
  });

  it("cancels retry listeners and already scheduled work when the chat closes", async () => {
    const connection = transport("connected");
    const retry = vi.fn(async () => {});
    const pending = new TranscriptHydrationRetries(retry);
    pending.add(cloudChat);
    pending.delete(cloudChat);
    await settle();
    expect(retry).not.toHaveBeenCalled();
    expect(connection.listeners.get(folder)?.size).toBe(0);
    connection.disconnect(); connection.connect();
    await settle();
    expect(retry).not.toHaveBeenCalled();
  });

  it("invalidates an old retry even when the same chat is immediately reopened", async () => {
    transport("connected");
    const retry = vi.fn(async (_id: string, _isCurrent: () => boolean) => {});
    const pending = new TranscriptHydrationRetries(retry);
    cleanups.push(() => pending.clear());
    pending.add(cloudChat);
    await settle();
    const first = retry.mock.calls[0][1];
    expect(first()).toBe(true);
    pending.delete(cloudChat);
    pending.add(cloudChat);
    await settle();
    expect(first()).toBe(false);
    expect(retry.mock.calls[1][1]()).toBe(true);
  });
});
