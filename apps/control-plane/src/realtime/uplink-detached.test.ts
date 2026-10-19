import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UplinkSession } from "./uplink-server.js";
import { UplinkDetachedHealth } from "./uplink-detached.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const observe = vi.fn(async () => true), current = vi.fn(() => true);
  const health = new UplinkDetachedHealth({ observe, current, now: () => Date.now() });
  const peer = () => {
    let state: ReturnType<NonNullable<UplinkSession["authState"]>> = { syncId: randomUUID(), authCursor: "cursor-1", revision: 1 };
    const send = vi.fn(() => true);
    const session: UplinkSession = { connectionId: randomUUID(), identity: { workspaceId: randomUUID(), organizationId: randomUUID(),
      generation: 1, engineInstanceId: randomUUID(), bootId: randomUUID() }, features: new Set(["detached.v1"]), sendReliable: () => true,
      sendControl: send, authState: () => state };
    health.onOpen(session);
    const request = () => { const frame = { connectionId: session.connectionId, syncId: state!.syncId, authCursor: state!.authCursor,
      challengeId: randomUUID() }; health.onFrame(session, "auth.health_request", frame); return frame; };
    return { session, send, request, state: () => state, setState: (value: typeof state) => { state = value; } };
  };
  return { health, observe, current, peer };
}

describe("shared detached authority observation", () => {
  it("bounds process-wide observations to one per five seconds under staggered fan-in", async () => {
    const f = fixture();
    for (let i = 0; i < 12; i++) { f.peer().request(); await vi.advanceTimersByTimeAsync(1_000); }
    expect(f.observe.mock.calls.length).toBeLessThanOrEqual(3);
    f.health.stop();
  });
  it("no_dormant_queries and fan_in_uses_one_fresh_observation", async () => {
    const f = fixture(), peers = Array.from({ length: 256 }, f.peer);
    await vi.advanceTimersByTimeAsync(60_000); expect(f.observe).not.toHaveBeenCalled();
    for (const peer of peers) peer.request();
    expect(f.observe).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1_000);
    expect(f.observe).toHaveBeenCalledOnce();
    for (const peer of peers) expect(peer.send.mock.calls.at(-1)?.[1].healthy).toBe(true);
    f.health.stop();
  });

  it("a request arriving during a read waits for a newer observation", async () => {
    const f = fixture(), first = f.peer(), second = f.peer(), pending = deferred<boolean>();
    f.observe.mockReturnValueOnce(pending.promise); first.request(); await vi.advanceTimersByTimeAsync(1_000);
    second.request(); pending.resolve(true); await vi.advanceTimersByTimeAsync(0);
    expect(first.send.mock.calls.at(-1)?.[1].healthy).toBe(true); expect(second.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_000); expect(f.observe).toHaveBeenCalledTimes(2);
    expect(second.send.mock.calls.at(-1)?.[1].healthy).toBe(true); f.health.stop();
  });
  it("queues small network jitter at the next shared slot instead of revoking healthy work", async () => {
    const f = fixture(), peer = f.peer(); peer.request(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_999); peer.send.mockClear(); peer.request();
    expect(peer.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.observe).toHaveBeenCalledTimes(2); expect(peer.send.mock.calls.at(-1)?.[1].healthy).toBe(true); f.health.stop();
  });

  it.each(["read", "pending_snapshot", "auth_ack", "keys", "listener"])("%s cannot produce positive health", async kind => {
    const f = fixture(), peer = f.peer(), pending = deferred<boolean>(); f.observe.mockReturnValueOnce(pending.promise);
    peer.request(); await vi.advanceTimersByTimeAsync(1_000);
    if (kind === "read") pending.resolve(false);
    else {
      if (kind === "pending_snapshot") f.current.mockReturnValue(false);
      if (kind === "auth_ack") peer.setState(null);
      if (kind === "keys") peer.setState({ ...peer.state()!, revision: 2 });
      if (kind === "listener") f.health.invalidate();
      pending.resolve(true);
    }
    await vi.advanceTimersByTimeAsync(0); expect(peer.send.mock.calls.at(-1)?.[1].healthy).toBe(false); f.health.stop();
  });

  it("a never-settling source remains one flight and invalidates existing health", async () => {
    const f = fixture(), peer = f.peer(), pending = deferred<boolean>(); f.observe.mockReturnValueOnce(pending.promise);
    peer.request(); await vi.advanceTimersByTimeAsync(6_000);
    expect(peer.send.mock.calls.some(call => call[0] === "auth.health_lost")).toBe(true);
    for (let i = 0; i < 100; i++) { const other = f.peer(); other.request(); f.health.onClose(other.session); }
    await vi.advanceTimersByTimeAsync(60_000); expect(f.observe).toHaveBeenCalledOnce();
    pending.resolve(true); await vi.advanceTimersByTimeAsync(0);
    expect(peer.send.mock.calls.at(-1)?.[1].healthy).toBe(false); f.health.stop();
  });

  it("never ACKs retired sockets and rate limits repeated requests without source work", async () => {
    const f = fixture(), peer = f.peer(), pending = deferred<boolean>(); f.observe.mockReturnValueOnce(pending.promise);
    peer.request(); peer.request(); expect(peer.send.mock.calls.at(-1)?.[1].healthy).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000); f.health.onClose(peer.session); peer.send.mockClear();
    pending.resolve(true); await vi.advanceTimersByTimeAsync(0); expect(peer.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000); expect(f.observe).toHaveBeenCalledOnce(); f.health.stop();
  });
});
