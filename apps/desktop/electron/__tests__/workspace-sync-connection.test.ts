import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { SyncChangedError } from "../workspace-sync/engine";
import { DirectSyncConnection, SyncConnectError, type SyncSocket } from "../workspace-sync/connection";

const EPOCH = "6b0c0a2e-1f3a-4b5c-8d6e-7f8091a2b3c4";
const grant = (n: number) => ({ url: "https://route.example.test/", portAuth: "synthetic-port-auth-value", grant: `v1.payload${n}.signature`, expiresAt: "2026-11-11T00:00:00Z" });
function socket() {
  const events = new EventEmitter(), sent: Array<Record<string, unknown>> = [];
  const ws = {
    readyState: 1, send: (data: string) => { sent.push(JSON.parse(data)); }, close: () => { events.emit("close"); }, terminate: () => { events.emit("close"); },
    on: (event: string, listener: (...args: unknown[]) => void) => { events.on(event, listener); if (event === "open") queueMicrotask(() => events.emit("open")); return events; },
    emitMessage: (value: object) => { events.emit("message", Buffer.from(JSON.stringify({ source: "engine", ...value })), false); }, closeNow: () => { events.emit("close"); },
  } as unknown as SyncSocket & { emitMessage(value: object): void; closeNow(): void };
  return { ws, sent };
}

describe("the direct sync socket", () => {
  it("dials the worker's sync path with the port-auth cookie and grant, renews with fresh grants, and keeps one request in flight", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let grants = 0;
      const s = socket(), dial = vi.fn(() => s.ws);
      const connection = await DirectSyncConnection.connect({ grant: async () => grant(++grants), dial, renewMs: 1000 }, { hint: () => {}, closed: () => {} });
      expect(dial).toHaveBeenCalledWith("wss://route.example.test/v2/worker/sync", "zeros.worker.sync.v1",
        { Cookie: "_port_auth=synthetic-port-auth-value", "X-Zeros-Worker-Auth": "v1.payload1.signature" });
      const first = connection.snapshot({}), second = connection.read({ path: "a.txt", sha256: "a".repeat(64), offset: 0, length: 1 });
      await vi.waitFor(() => expect(s.sent).toHaveLength(1));   // the read waits for the snapshot
      s.ws.emitMessage({ type: "WORKSPACE_RESPONSE", requestId: s.sent[0]!.id, result: { epoch: EPOCH, seq: 0, full: [] } });
      expect(await first).toEqual({ epoch: EPOCH, seq: 0, full: [] });
      await vi.waitFor(() => expect(s.sent).toHaveLength(2));
      s.ws.emitMessage({ type: "WORKSPACE_ERROR", requestId: s.sent[1]!.id, code: "SYNC_CHANGED" });
      await expect(second).rejects.toBeInstanceOf(SyncChangedError);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(s.sent.at(-1)).toEqual({ t: "renew", grant: "v1.payload2.signature" }));
      connection.close();
      await vi.advanceTimersByTimeAsync(3000);
      expect(s.sent.filter(frame => frame.t === "renew")).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("passes hints on, fails pending requests when the worker closes the socket, and surfaces a refused grant", async () => {
    const s = socket();
    let hints = 0, closed = 0;
    const connection = await DirectSyncConnection.connect({ grant: async () => grant(1), dial: () => s.ws }, { hint: () => { hints++; }, closed: () => { closed++; } });
    s.ws.emitMessage({ type: "DB_CHANGED", kinds: ["workspaceSync"] });
    s.ws.emitMessage({ type: "DB_CHANGED", kinds: ["chats"] });
    expect(hints).toBe(1);
    const pending = connection.bootstrap();
    await vi.waitFor(() => expect(s.sent).toHaveLength(1));
    expect(s.sent[0]).toMatchObject({ type: "WORKSPACE_REQUEST", op: "sync.bootstrap", params: {} });
    s.ws.closeNow();
    await expect(pending).rejects.toBeInstanceOf(SyncConnectError);
    expect(closed).toBe(1);
    await expect(DirectSyncConnection.connect({ grant: async () => { throw new SyncConnectError("paused"); }, dial: () => s.ws }, { hint: () => {}, closed: () => {} }))
      .rejects.toMatchObject({ kind: "paused" });
  });
});
