import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudDetachedPushHealth, DETACHED_HEALTH_CADENCE_MS, DETACHED_HEALTH_WINDOW_MS } from "../cloud-detached-push-health";
import { DETACHED_HEALTH_CADENCE_MS as SERVER_CADENCE, DETACHED_HEALTH_WINDOW_MS as SERVER_WINDOW } from
  "../../../../control-plane/src/realtime/uplink-detached";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture() {
  let clock = 0;
  const health = new CloudDetachedPushHealth(() => clock);
  const send = vi.fn((_type: string, _data: Record<string, unknown>) => true);
  const connection = { connectionId: randomUUID(), syncId: randomUUID(), authCursor: "cursor-1", revision: 1, send };
  health.connect(connection);
  const advance = (ms: number) => { clock += ms; vi.advanceTimersByTime(ms); };
  const response = (): Record<string, unknown> => ({ ...send.mock.calls.at(-1)![1], healthy: true });
  return { health, send, connection, advance, response };
}

describe("challenged detached push health", () => {
  it("keeps the wire bounds equal and makes no request without accepted work", () => {
    expect(DETACHED_HEALTH_CADENCE_MS).toBe(SERVER_CADENCE); expect(DETACHED_HEALTH_WINDOW_MS).toBe(SERVER_WINDOW);
    const f = fixture(); f.advance(3_600_000); expect(f.send).not.toHaveBeenCalled();
    const release = f.health.retain(); expect(f.send).toHaveBeenCalledOnce();
    release(); f.advance(3_600_000); expect(f.send).toHaveBeenCalledOnce();
  });

  it("stale_health_reply_does_not_extend_deadline", () => {
    const f = fixture(), release = f.health.retain(), response = f.response();
    f.advance(9_999); f.health.receive("auth.health", response);
    expect(f.health.deadline()).toBe(10_000); // observation start, never receipt time
    f.advance(1); expect(f.health.deadline()).toBeNull();
    f.health.receive("auth.health", response); expect(f.health.deadline()).toBeNull(); release();
  });

  it.each(["connection", "sync", "challenge", "cursor", "revision"])("binds %s before accepting fresh health", kind => {
    const f = fixture(), release = f.health.retain(), response = f.response();
    if (kind === "connection") response.connectionId = randomUUID();
    if (kind === "sync") response.syncId = randomUUID();
    if (kind === "challenge") response.challengeId = randomUUID();
    if (kind === "cursor") response.authCursor = "foreign";
    if (kind === "revision") f.health.connect({ ...f.connection, revision: 2 });
    f.health.receive("auth.health", response); expect(f.health.deadline()).toBeNull(); release();
  });

  it("lost push invalidates immediately and an old reply cannot heal a replacement", () => {
    const f = fixture(), release = f.health.retain(), response = f.response(), changed = vi.fn();
    f.health.onChange(changed); f.health.receive("auth.health", response); expect(f.health.deadline()).toBe(10_000);
    f.health.connect(null); expect(f.health.deadline()).toBeNull(); expect(changed).toHaveBeenCalled();
    f.health.connect({ ...f.connection, connectionId: randomUUID() }); f.health.receive("auth.health", response);
    expect(f.health.deadline()).toBeNull(); release();
  });

  it("a known source failure invalidates health even without an outstanding challenge", () => {
    const f = fixture(), release = f.health.retain(); f.health.receive("auth.health", f.response());
    f.health.receive("auth.health_lost", { connectionId: f.connection.connectionId, syncId: f.connection.syncId });
    expect(f.health.deadline()).toBeNull(); release();
  });

  it("bounds challenges across work fan-in, lost replies and connection churn", () => {
    const f = fixture(), releases = Array.from({ length: 256 }, () => f.health.retain());
    expect(f.send).toHaveBeenCalledOnce(); expect(() => f.health.retain()).toThrow("accepted_work_limit");
    f.advance(5_000); expect(f.send).toHaveBeenCalledOnce(); // one still outstanding
    f.health.connect(null); f.health.connect({ ...f.connection, connectionId: randomUUID() });
    expect(f.send).toHaveBeenCalledTimes(2);
    f.advance(9_999); expect(f.send).toHaveBeenCalledTimes(2);
    f.advance(1); expect(f.send).toHaveBeenCalledTimes(3);
    for (const release of releases) release();
  });

  it("continues challenges every five seconds when replies arrive, without extending from their delivery", () => {
    const f = fixture(), release = f.health.retain(); f.advance(1_000); f.health.receive("auth.health", f.response());
    expect(f.health.deadline()).toBe(10_000); f.advance(4_000); expect(f.send).toHaveBeenCalledTimes(2);
    f.advance(2_000); f.health.receive("auth.health", f.response()); expect(f.health.deadline()).toBe(15_000); release();
  });
});
