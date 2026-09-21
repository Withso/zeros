import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createMessage, type BridgeMessage } from "@zeros/protocol/messages";
import type { CloudEventEngineRequest } from "@zeros/protocol/cloud-events";
import { CloudEventRuntime } from "../cloud-event-runtime";
import { CloudEventRuntimeError } from "../cloud-event-client";
import { MessageRouter } from "../transport/router";

const event = () => createMessage({ type: "DB_CHANGED", source: "engine", kinds: ["chats"] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const streamId = randomUUID(), onFailure = vi.fn();
  const request = vi.fn(async (input: CloudEventEngineRequest): Promise<unknown> => {
    if (input.kind !== "append") throw new Error("unexpected read");
    return { streamId, head: input.events.at(-1)!.sequence, replayed: false };
  });
  const runtime = new CloudEventRuntime(streamId, { request, onFailure });
  return { streamId, runtime, request, onFailure };
}
describe("cloud stream sequencing and backpressure", () => {
  it("assigns one sequence before fan-out, even with zero subscribers", async () => {
    const f = fixture(), router = new MessageRouter();
    router.setCapture(message => f.runtime.capture(message));
    router.broadcast(event());
    const sends = [vi.fn(), vi.fn()];
    sends.forEach((send, i) => router.register({ id: String(i), kind: "cloud", send, close() {} }));
    router.routeToSession("execution", event());
    expect(sends[0].mock.calls[0][0].cloudStream).toEqual({ streamId: f.streamId, sequence: 2 });
    expect(sends[1].mock.calls[0][0]).toBe(sends[0].mock.calls[0][0]);
    expect(f.request).not.toHaveBeenCalled(); f.runtime.start();
    await f.runtime.flush();
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0][0]).toMatchObject({ events: [{ sequence: 1 }, { sequence: 2 }] }); f.runtime.close();
  });
  it("retries an identical batch after a lost acknowledgement and never renumbers subsequent events", async () => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    f.request.mockRejectedValueOnce(new CloudEventRuntimeError("event_service_unavailable"));
    f.runtime.start(); f.runtime.capture(event()); const done = f.runtime.flush();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(1));
    f.runtime.capture(event()); await done; await f.runtime.flush();
    expect(f.request.mock.calls[1][0]).toEqual(f.request.mock.calls[0][0]);
    expect(f.request.mock.calls[2][0]).toMatchObject({ events: [{ sequence: 2 }] });
    expect(original).toBeTypeOf("function"); expect(f.onFailure).not.toHaveBeenCalled(); f.runtime.close();
  });
  it("captures normalized state at the cursor while later events remain replayable", async () => {
    const f = fixture(), append = deferred<unknown>(); f.runtime.start();
    f.request.mockImplementationOnce(() => append.promise);
    const state = { text: "before" }; f.runtime.capture(event());
    const snapshot = f.runtime.snapshot(() => state);
    state.text = "after"; f.runtime.capture(event());
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    append.resolve({ streamId: f.streamId, head: 2, replayed: false });
    expect(await snapshot).toEqual({ cursor: { streamId: f.streamId, sequence: 1 }, snapshot: { text: "before" } });
    f.runtime.close();
  });
  it("keeps terminal output outside the journal and requires a snapshot after an oversized event", async () => {
    const f = fixture();
    const terminal = { ...event(), type: "PTY_DATA", data: "x".repeat(300000) } as unknown as BridgeMessage;
    expect(f.runtime.capture(terminal)).toBe(terminal);
    const large = f.runtime.capture({ ...event(), diagnostic: "x".repeat(300000) } as BridgeMessage);
    expect(large.cloudStream).toMatchObject({ sequence: 1, requiresSnapshot: true });
    f.runtime.start(); await f.runtime.flush();
    const append = f.request.mock.calls[0][0];
    expect(JSON.stringify(append).length).toBeLessThan(1000);
    f.request.mockResolvedValueOnce({ streamId: f.streamId, head: 1, firstRetained: 1, cursor: 1,
      events: append.kind === "append" ? append.events : [] });
    await expect(f.runtime.replay({ streamId: f.streamId, sequence: 0 })).rejects.toMatchObject({ code: "event_snapshot_required" });
    expect(f.onFailure).not.toHaveBeenCalled(); f.runtime.close();
  });
  it("refuses a wrong stream and noncontiguous replay instead of reporting success", async () => {
    const f = fixture(); f.runtime.start(); f.runtime.capture(event()); await f.runtime.flush();
    await expect(f.runtime.replay({ streamId: randomUUID(), sequence: 0 })).rejects.toMatchObject({ code: "event_stream_changed" });
    f.request.mockResolvedValueOnce({ streamId: f.streamId, head: 3, firstRetained: 1, cursor: 3, events: [{ sequence: 3, frame: event() }] });
    await expect(f.runtime.replay({ streamId: f.streamId, sequence: 0 })).rejects.toMatchObject({ code: "event_response_invalid" }); f.runtime.close();
  });
  it("does not acknowledge pending snapshots after authority closes", async () => {
    const f = fixture(); f.runtime.capture(event());
    const snapshot = f.runtime.snapshot(() => ({})); f.runtime.close();
    await expect(snapshot).rejects.toMatchObject({ code: "engine_authority_rejected" });
    expect(f.request).not.toHaveBeenCalled();
  });
});
