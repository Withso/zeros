import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessage } from "@zeros/protocol/messages";
import { CloudEventRuntime } from "../cloud-event-runtime";
import { CloudEventRuntimeError } from "../cloud-event-client";
import { MessageRouter } from "../transport/router";
import { ZerosEngine } from "../zeros-engine";

const methods = ZerosEngine.prototype as unknown as {
  handleCloudRuntimeAuthorityLoss(this: unknown, site?: string, error?: unknown): void;
};
const event = () => createMessage({ type: "DB_CHANGED", source: "engine", kinds: ["chats"] });

function fixture(cloud: boolean) {
  const router = new MessageRouter(), send = vi.fn(), request = vi.fn();
  const events = cloud ? new CloudEventRuntime(randomUUID(), { request, onFailure: vi.fn() }) : null;
  if (events) router.setCapture(message => events.capture(message));
  router.register({ id: "synthetic-client", kind: cloud ? "cloud" : "local", send, close() {} });
  const engine = Object.assign(Object.create(ZerosEngine.prototype), {
    router, running: false, cloudWorker: cloud ? { version: 4 } : null,
    cloudRuntimeAuthorityStopping: false, cloudEvents: events,
    cloudIdleStop: { close: vi.fn() }, cloudCommands: { close: vi.fn() }, cloudActions: null,
    cloudCheckpointScheduler: null, cloudLocalWriterLifecycle: null,
  });
  return { router, send, request, events, engine };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("engine event capture retirement", () => {
  it("logs the first closed cause before shutdown and retains it across later failures", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => {}), f = fixture(true);
    f.engine.stop = vi.fn(() => {
      expect(log).toHaveBeenCalledExactlyOnceWith("[Zeros cloud] durable engine authority was retired",
        { site: "event-journal", code: "event_conflict" });
      return new Promise<void>(() => {});
    });
    methods.handleCloudRuntimeAuthorityLoss.call(f.engine, "event-journal", new CloudEventRuntimeError("event_conflict"));
    methods.handleCloudRuntimeAuthorityLoss.call(f.engine, "agent-boot", new Error("private teardown detail"));
    expect(log).toHaveBeenCalledTimes(1);
    expect(f.engine.stop).toHaveBeenCalledOnce();
  });

  it.each([
    Object.assign(new Error("private provider payload"), { code: "unregistered-private-value" }),
    Object.defineProperty(new Error("private provider payload"), "code", { get() { throw new Error("private getter detail"); } }),
  ])("never logs arbitrary failure fields or throws while diagnosing them", error => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => {}), f = fixture(true);
    f.engine.stop = vi.fn(() => new Promise<void>(() => {}));
    expect(() => methods.handleCloudRuntimeAuthorityLoss.call(f.engine, "native-pump", error)).not.toThrow();
    expect(log).toHaveBeenCalledExactlyOnceWith("[Zeros cloud] durable engine authority was retired",
      { site: "native-pump", code: "unclassified_failure" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  });

  it("records a closed shutdown failure and still rejects failed retirement", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {}), f = fixture(true);
    f.engine.cloudLocalNativePump = { dispose: async () => { throw new CloudEventRuntimeError("event_conflict"); } };
    await expect(ZerosEngine.prototype.stop.call(f.engine)).rejects.toThrow("Zeros engine teardown failed");
    expect(log).toHaveBeenCalledExactlyOnceWith("[Zeros cloud] engine shutdown failed",
      { site: "engine-shutdown", code: "event_conflict" });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("keeps the first cause when shutdown itself rejects before its teardown collector", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => {}), f = fixture(true);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    f.engine.stop = vi.fn(async () => { throw new CloudEventRuntimeError("event_storage_unavailable"); });
    methods.handleCloudRuntimeAuthorityLoss.call(f.engine, "event-journal", "event_conflict");
    await vi.advanceTimersByTimeAsync(0);
    expect(log.mock.calls).toEqual([
      ["[Zeros cloud] durable engine authority was retired", { site: "event-journal", code: "event_conflict" }],
      ["[Zeros cloud] engine shutdown failed", { site: "engine-shutdown", code: "event_storage_unavailable" }],
    ]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains the synchronous capture failure that starts authority retirement without fan-out", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture(true), failure = new CloudEventRuntimeError("event_conflict");
    f.engine.stop = vi.fn(() => new Promise<void>(() => {}));
    f.router.setCapture(() => {
      methods.handleCloudRuntimeAuthorityLoss.call(f.engine, "event-journal", failure);
      throw failure;
    });
    expect(() => f.router.broadcast(event())).not.toThrow();
    expect(f.engine.stop).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
    f.events!.close();
  });

  it("contains a late asynchronous broadcast after the cloud journal closes", async () => {
    const f = fixture(true);
    await ZerosEngine.prototype.stop.call(f.engine);
    await expect(Promise.resolve().then(() => f.router.broadcast(event()))).resolves.toBeUndefined();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    expect(() => f.events!.capture(event())).toThrow("engine_authority_rejected");
  });

  it("preserves capture errors while the journal has not been retired", () => {
    const f = fixture(true), failure = new CloudEventRuntimeError("event_storage_unavailable");
    f.router.setCapture(() => { throw failure; });
    expect(() => f.router.broadcast(event())).toThrow(failure);
    expect(() => f.router.broadcastExcept("other-client", event())).toThrow(failure);
    expect(f.send).not.toHaveBeenCalled();
    f.events!.close();
  });

  it("cannot revive retired cloud broadcasts by installing another capture hook", async () => {
    const f = fixture(true), capture = vi.fn(message => message);
    await ZerosEngine.prototype.stop.call(f.engine);
    f.router.setCapture(capture);
    f.router.broadcast(event());
    f.router.broadcastExcept("other-client", event());
    expect(capture).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("contains a late timer broadcastExcept while authority-loss shutdown is pending", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture(true);
    f.engine.stop = vi.fn(() => { f.events!.close(); return new Promise<void>(() => {}); });
    methods.handleCloudRuntimeAuthorityLoss.call(f.engine, "event-journal", "engine_authority_rejected");
    let failure: unknown = null;
    setTimeout(() => { try { f.router.broadcastExcept("other-client", event()); } catch (error) { failure = error; } }, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(failure).toBeNull();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.engine.stop).toHaveBeenCalledOnce();
  });

  it.each(["Personal", "organization-local"])("keeps %s routing independent of cloud capture retirement", async owner => {
    const f = fixture(false);
    f.engine.owner = owner;
    await ZerosEngine.prototype.stop.call(f.engine);
    const message = event();
    f.router.broadcast(message);
    expect(f.send).toHaveBeenCalledExactlyOnceWith(message);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("does not retire another cloud owner's journal when the first engine stops", async () => {
    const a = fixture(true), b = fixture(true);
    await ZerosEngine.prototype.stop.call(a.engine);
    b.router.broadcast(event());
    expect(b.send).toHaveBeenCalledOnce();
    expect(b.events!.cursor.sequence).toBe(1);
    expect(a.send).not.toHaveBeenCalled();
    b.events!.close();
  });
});
