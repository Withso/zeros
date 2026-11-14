import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { recoveryWorkerReady } from "./recovery-ready.js";
import type { WorkerRoute } from "./worker-connection.js";

const route = { bootId: "00000000-0000-4000-8000-000000000001" } as WorkerRoute;
function socket() {
  const value = Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn(), close: vi.fn(), terminate: vi.fn() });
  return value;
}
describe("replacement configured readiness", () => {
  it("does not mistake an open carrier or a broadcast for this client's ENGINE_READY", async () => {
    const ws = socket(), ready = recoveryWorkerReady(route, "synthetic", { dial: async () => ws as never, timeoutMs: 15 });
    await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
    ws.emit("message", Buffer.from(JSON.stringify({ t: "frame", clientId: "*", frame: { type: "ENGINE_READY" } })), false);
    expect(await ready).toBe(false); expect(ws.terminate).toHaveBeenCalled();
  });
  it("uses a passive client and waits for the worker's configuration barrier", async () => {
    const ws = socket(), ready = recoveryWorkerReady(route, "synthetic", { dial: async () => ws as never, timeoutMs: 1000 });
    await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
    const opened = JSON.parse(ws.send.mock.calls[0]![0]); expect(opened).toMatchObject({ t: "open", passive: true });
    ws.emit("message", Buffer.from(JSON.stringify({ t: "frame", clientId: opened.clientId, frame: { type: "ENGINE_READY" } })), false);
    expect(await ready).toBe(true); expect(ws.close).toHaveBeenCalledWith(1000);
    expect(JSON.parse(ws.send.mock.calls[1]![0])).toEqual({ t: "close", clientId: opened.clientId });
  });
});
