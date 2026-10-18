import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceStreamSocketHandlers } from "@zeros/cloud-client";
import { CloudSdkCapabilitiesSchema } from "../../shared/cloud-sdk-contract";
import type { CloudSdkRuntimeIdentity, CloudSdkRuntimeTarget } from "../../shared/cloud-sdk-contract";
import { CloudSdkDeviceStream } from "../cloud-sdk-device-stream";
import { CloudWorkspaceAccessClientError } from "../cloud-workspace-access-client";

const id = (n: number) => `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
const target = { organizationId: id(1), workspaceId: id(2) }, otherOrg = id(3), sessionId = id(4);
const identity = { ...target, runtimeId: id(5), connectionSequence: 1, generation: 7, authorityEpoch: 3, engineInstanceId: id(6) };
const runtime = { ...identity, deviceSessionId: sessionId, clientSessionId: id(7) } as CloudSdkRuntimeTarget;
const grant = { deviceSessionId: sessionId, url: "wss://realtime.example.test/v1/device-stream", ticket: `zds_${"t".repeat(43)}` };
const capabilities = { engine: { token: "native-validated-engine", expiresAt: "2027-01-15T08:05:00.000Z" },
  realtime: { token: "native-validated-relay", expiresAt: "2027-01-15T08:05:00.000Z" } };
const cleanups: Array<() => void> = [];
const tick = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { for (const off of cleanups.splice(0)) off(); vi.useRealTimers(); });

function fixture() {
  let current = true, targets = [runtime];
  const changes = new Set<() => void>();
  const broker = { assertActive: vi.fn(() => { if (!current) throw new Error("retired account"); }),
    openStreamSession: vi.fn(async (_held: string | null) => grant), runtimeTargets: () => targets,
    subscribeRuntimeTargets: (listener: () => void) => { changes.add(listener); return () => { changes.delete(listener); }; },
    assertRuntime: vi.fn(), acceptPushedCapabilities: vi.fn((_runtime: CloudSdkRuntimeIdentity, _client: string, value: unknown) => CloudSdkCapabilitiesSchema.parse(value)),
    close: vi.fn((runtimeId: string) => { targets = targets.filter(row => row.runtimeId !== runtimeId); for (const changed of changes) changed(); return true; }),
  };
  const sockets: Array<{ handlers: DeviceStreamSocketHandlers; sent: Array<Record<string, unknown>>; close: ReturnType<typeof vi.fn> }> = [];
  const emit = vi.fn(); let nextId = 20;
  const stream = new CloudSdkDeviceStream({ broker, emit, random: () => 0.5, newId: () => id(nextId++),
    createSocket: (_url, handlers) => { const sent: Array<Record<string, unknown>> = [], close = vi.fn(); sockets.push({ handlers, sent, close });
      return { send: text => sent.push(JSON.parse(text)), close }; } });
  cleanups.push(() => stream.dispose());
  const ready = async (features: unknown = [{ organizationId: target.organizationId, deviceStream: true, presence: true },
    { organizationId: otherOrg, deviceStream: false, presence: false }]) => {
    await tick(); const socket = sockets.at(-1)!; socket.handlers.open();
    socket.handlers.message(JSON.stringify({ t: "ready", d: { deviceSessionId: sessionId, cursor: "c0", resumed: false,
      contract: 1, heartbeatIntervalMs: 20_000, ...(features === null ? {} : { organizationFeatures: features }) } }));
    return stream.snapshot();
  };
  return { stream, sockets, broker, emit, ready, retire: () => { current = false; } };
}
const acknowledge = (f: ReturnType<typeof fixture>) => {
  const view = f.stream.snapshot();
  return f.stream.control({ action: "snapshot-current", streamId: view.streamId, leaseId: view.leaseId!, revision: view.revision,
    catalogVersion: 12, workspaces: [{ ...target, version: 5 }] });
};

describe("native device stream ownership", () => {
  it("CM review: ignores a retired socket's late ready after a replacement session opens", async () => {
    const f = fixture(), first = f.stream.control({ action: "start", target });
    await tick();
    const retired = f.sockets[0]!;
    retired.handlers.open(); // The first hello is still awaiting its ready.
    f.stream.control({ action: "stop", streamId: first.streamId, leaseId: first.leaseId! });
    const replacementSessionId = id(99);
    f.broker.openStreamSession.mockResolvedValueOnce({ ...grant, deviceSessionId: replacementSessionId });
    f.stream.control({ action: "start", target });
    await tick();
    expect(f.sockets).toHaveLength(2);
    const current = f.sockets[1]!;
    current.handlers.open();
    const readyFrame = (deviceSessionId: string) => JSON.stringify({ t: "ready", d: {
      deviceSessionId, cursor: "c0", resumed: false, contract: 1,
      heartbeatIntervalMs: 20_000, organizationFeatures: [],
    } });
    current.handlers.message(readyFrame(replacementSessionId));
    expect(f.stream.snapshot().state).toBe("open");
    f.emit.mockClear();
    retired.handlers.message(readyFrame(sessionId));
    expect(f.stream.snapshot().state).toBe("open");
    expect(current.close).not.toHaveBeenCalled();
    expect(f.emit).not.toHaveBeenCalled();
  });

  it.each(["local close", "remote close"])("ignores invalid frames after %s without stopping a replacement", async close => {
    const f = fixture(), first = f.stream.control({ action: "start", target });
    await f.ready(); const retired = f.sockets[0]!;
    if (close === "local close") f.stream.control({ action: "stop", streamId: first.streamId, leaseId: first.leaseId! });
    else retired.handlers.close(1006, "closed");
    if (close === "local close") f.stream.control({ action: "start", target });
    else await vi.advanceTimersByTimeAsync(1_000);
    await f.ready(); const current = f.sockets[1]!;
    f.emit.mockClear();
    for (const frame of ["{", "x".repeat(512 * 1024 + 1), JSON.stringify({ t: "ready", d: {} })]) {
      retired.handlers.message(frame);
      expect(f.stream.snapshot().state).toBe("open");
    }
    expect(current.close).not.toHaveBeenCalled(); expect(f.emit).not.toHaveBeenCalled();
  });

  it("uses one shared session/socket and a replacement renderer lease cannot be stopped by the old lease", async () => {
    const f = fixture(), first = f.stream.control({ action: "start", target });
    const second = f.stream.control({ action: "start", target }); await f.ready();
    expect(f.broker.openStreamSession).toHaveBeenCalledOnce(); expect(f.sockets).toHaveLength(1);
    expect(first).not.toEqual(second);
    expect(f.stream.control({ action: "stop", streamId: first.streamId, leaseId: first.leaseId! })).toBe(false);
    expect(f.stream.snapshot().state).toBe("open");
    expect(f.sockets[0]!.sent[0]).toEqual({ t: "hello", d: { contract: { min: 1, max: 1 }, ticket: grant.ticket } });
    expect(JSON.stringify(f.emit.mock.calls)).not.toContain(grant.ticket);
  });

  it("requires the current complete snapshot before exposing only explicitly covered organizations", async () => {
    const f = fixture(); f.stream.control({ action: "start", target }); const ready = await f.ready();
    expect(ready.catalogRequired).toBe(true); expect(ready.organizations.every(row => !row.deviceStream)).toBe(true);
    expect(acknowledge(f)).toBe(true);
    expect(f.stream.snapshot().organizations).toEqual([{ organizationId: target.organizationId, deviceStream: true, presence: true },
      { organizationId: otherOrg, deviceStream: false, presence: false }]);
    f.sockets[0]!.handlers.message(JSON.stringify({ t: "drain", d: { reconnectAfterMs: 1_000 } }));
    expect(f.stream.snapshot().organizations.every(row => !row.deviceStream)).toBe(true);
    expect(f.stream.control({ action: "snapshot-current", streamId: ready.streamId, leaseId: ready.leaseId!, revision: ready.revision,
      catalogVersion: 12, workspaces: [] })).toBe(false);
  });

  it("keeps polling unproven for old ready metadata and a missing snapshot watermark", async () => {
    const f = fixture(); f.stream.control({ action: "start", target }); await f.ready(null);
    expect(acknowledge(f)).toBe(false); expect(f.stream.snapshot().organizations).toEqual([]);
    const g = fixture(); g.stream.control({ action: "start", target }); const view = await g.ready();
    expect(g.stream.control({ action: "snapshot-current", streamId: view.streamId, leaseId: view.leaseId!, revision: view.revision,
      catalogVersion: null, workspaces: [] })).toBe(false);
    expect(g.stream.snapshot().organizations.every(row => !row.deviceStream)).toBe(true);
  });

  it("retires the destroyed renderer owner but ignores a prior window's late destruction", async () => {
    const f = fixture(); const offFirst = vi.fn(), offSecond = vi.fn(); let firstGone!: () => void, secondGone!: () => void;
    f.stream.control({ action: "start", target }, gone => { firstGone = gone; return offFirst; });
    f.stream.control({ action: "start", target }, gone => { secondGone = gone; return offSecond; }); await f.ready();
    expect(offFirst).toHaveBeenCalledOnce(); firstGone(); expect(f.stream.snapshot().state).toBe("open");
    secondGone(); expect(f.stream.snapshot().state).toBe("stopped"); expect(f.stream.snapshot().leaseId).toBeNull();
    expect(offSecond).toHaveBeenCalledOnce(); expect(f.sockets[0]!.close).toHaveBeenCalledOnce();
  });

  it.each([
    { t: "capability.revoked", c: "c1", d: { reason: "revoked", scope: "workspace" } },
    { t: "notification", c: "c1", d: { id: id(30), workspaceId: target.workspaceId, kind: "turn.completed", title: "x".repeat(201), createdAt: new Date().toISOString() } },
    { t: "notification", c: "c1", d: { id: id(30), workspaceId: target.workspaceId, kind: "turn.completed", title: "Done", chatId: "bad id", createdAt: new Date().toISOString() } },
    { t: "lifecycle.changed", c: "c1", d: { workspaceId: target.workspaceId, version: 1, generation: 7, status: "ready", observedState: "" } },
  ])("rejects malformed consumed S3 fields without forwarding them: $t", async frame => {
    const f = fixture(); f.stream.control({ action: "start", target }); await f.ready(); acknowledge(f); f.emit.mockClear();
    f.sockets[0]!.handlers.message(JSON.stringify(frame));
    expect(f.stream.snapshot().state).toBe("stopped"); expect(f.emit.mock.calls.some(([value]) => value.event.type === "frame")).toBe(false);
  });

  it("clears coverage and stops on a fatal server error", async () => {
    const f = fixture(); f.stream.control({ action: "start", target }); await f.ready(); acknowledge(f);
    f.sockets[0]!.handlers.message(JSON.stringify({ t: "error", d: { code: "unauthorized", message: "Access ended", fatal: true } }));
    expect(f.stream.snapshot().state).toBe("stopped");
    expect(f.stream.snapshot().organizations.every(row => !row.deviceStream)).toBe(true);
  });

  it("stops on native ticket validation failures instead of repeatedly reissuing invalid tickets", async () => {
    const f = fixture(); f.broker.openStreamSession.mockRejectedValue(new CloudWorkspaceAccessClientError(201, "bad_response", "Invalid ticket"));
    f.stream.control({ action: "start", target }); await tick(); await vi.advanceTimersByTimeAsync(60_000);
    expect(f.stream.snapshot().state).toBe("stopped"); expect(f.broker.openStreamSession).toHaveBeenCalledOnce();
    expect(f.sockets).toHaveLength(0);
  });

  it("rejects a ready from another device session and refuses late account events", async () => {
    const f = fixture(); f.stream.control({ action: "start", target }); await tick();
    f.sockets[0]!.handlers.message(JSON.stringify({ t: "ready", d: { deviceSessionId: id(90), cursor: "c0", resumed: false,
      contract: 1, heartbeatIntervalMs: 20_000 } }));
    expect(f.stream.snapshot().state).toBe("stopped");
    const g = fixture(); g.stream.control({ action: "start", target }); await g.ready(); g.retire(); g.emit.mockClear();
    g.sockets[0]!.handlers.message(JSON.stringify({ t: "presence.changed", d: { workspaceId: target.workspaceId, members: [] } }));
    expect(g.emit).not.toHaveBeenCalled(); expect(g.sockets[0]!.close).toHaveBeenCalled();
  });

  it("attaches native runtimes and registers pushed capabilities before publishing an exact runtime renewal", async () => {
    const f = fixture(); f.stream.control({ action: "start", target }); await f.ready();
    expect(f.sockets[0]!.sent).toContainEqual({ t: "attach", d: { workspaceId: target.workspaceId, clientSessionId: runtime.clientSessionId } });
    f.sockets[0]!.handlers.message(JSON.stringify({ t: "capability.renewed", d: { workspaceId: target.workspaceId,
      clientSessionId: runtime.clientSessionId, capabilities } }));
    expect(f.broker.acceptPushedCapabilities).toHaveBeenCalledWith(identity, runtime.clientSessionId, capabilities);
    expect(f.emit).toHaveBeenLastCalledWith(expect.objectContaining({ event: { type: "renewal", runtime: identity, capabilities } }));
    f.broker.close(runtime.runtimeId);
    expect(f.sockets[0]!.sent).toContainEqual({ t: "detach", d: { workspaceId: target.workspaceId, clientSessionId: runtime.clientSessionId } });
    f.emit.mockClear();
    f.sockets[0]!.handlers.message(JSON.stringify({ t: "capability.renewed", d: { workspaceId: target.workspaceId,
      clientSessionId: runtime.clientSessionId, capabilities } }));
    expect(f.emit).not.toHaveBeenCalled();
  });

  it("retires native authority on revocation and stops an invalid capability push without forwarding it", async () => {
    const f = fixture(); f.stream.control({ action: "start", target }); await f.ready();
    f.sockets[0]!.handlers.message(JSON.stringify({ t: "capability.revoked", c: "c1", d: {
      workspaceId: target.workspaceId, reason: "access_revoked", scope: "workspace" } }));
    expect(f.broker.close).toHaveBeenCalledWith(runtime.runtimeId);
    const g = fixture(); g.stream.control({ action: "start", target }); await g.ready();
    g.broker.acceptPushedCapabilities.mockImplementation(() => { throw new Error("invalid capability scope"); }); g.emit.mockClear();
    g.sockets[0]!.handlers.message(JSON.stringify({ t: "capability.renewed", d: { workspaceId: target.workspaceId,
      clientSessionId: runtime.clientSessionId, capabilities } }));
    expect(g.stream.snapshot().state).toBe("stopped");
    expect(g.emit.mock.calls.some(([value]) => value.event.type === "renewal")).toBe(false);
  });
});
