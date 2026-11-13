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
  it("sends multiple held commits only after sync-have-v2, bounded to 64 distinct commit IDs", async () => {
    const s = socket();
    const connection = await DirectSyncConnection.connect({ grant: async () => grant(1), dial: () => s.ws }, { hint: () => {}, closed: () => {} });
    const heads = Array.from({ length: 70 }, (_, i) => i.toString(16).padStart(40, "0"));
    const send = async (have: string[]) => {
      const result = connection.bootstrap(have);
      const frame = s.sent.at(-1)!;
      s.ws.emitMessage({ type: "WORKSPACE_RESPONSE", requestId: frame.id, result: { branch: "main", head: heads[0] } });
      await result;
      return frame.params;
    };
    try {
      expect(await send(heads)).toEqual({ have: heads[0] });
      s.ws.emitMessage({ type: "ENGINE_READY", capabilities: ["workspace-sync-v1", "sync-have-v2"] });
      expect(await send([heads[0]!, ...heads, "not-an-id"])).toEqual({ have: heads.slice(0, 64) });
      expect(await send([])).toEqual({});
      s.ws.emitMessage({ type: "ENGINE_READY", capabilities: ["workspace-sync-v1"] });
      expect(await send(heads)).toEqual({ have: heads[0] });
    } finally { connection.close(); }
  });

  it("dials the worker's sync path with the port-auth cookie and grant, and renews with fresh grants", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let grants = 0;
      const s = socket(), dial = vi.fn(() => s.ws);
      const connection = await DirectSyncConnection.connect({ grant: async () => grant(++grants), dial, renewMs: 1000 }, { hint: () => {}, closed: () => {} });
      expect(dial).toHaveBeenCalledWith("wss://route.example.test/v2/worker/sync", "zeros.worker.sync.v1",
        { Cookie: "_port_auth=synthetic-port-auth-value", "X-Zeros-Worker-Auth": "v1.payload1.signature" });
      const first = connection.snapshot({}), second = connection.read({ path: "a.txt", sha256: "a".repeat(64), offset: 0, length: 1 });
      await vi.waitFor(() => expect(s.sent).toHaveLength(2));
      s.ws.emitMessage({ type: "WORKSPACE_RESPONSE", requestId: s.sent[0]!.id, result: { epoch: EPOCH, seq: 0, full: [] } });
      expect(await first).toEqual({ epoch: EPOCH, seq: 0, full: [] });
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

  it("keeps up to six requests in flight (a seventh waits for a reply), and batches only once the worker says sync-batch-v1", async () => {
    const s = socket();
    const connection = await DirectSyncConnection.connect({ grant: async () => grant(1), dial: () => s.ws }, { hint: () => {}, closed: () => {} });
    expect(connection.batching()).toBe(false);
    s.ws.emitMessage({ type: "ENGINE_READY", capabilities: ["workspace-sync-v1"] });
    expect(connection.batching()).toBe(false);
    s.ws.emitMessage({ type: "ENGINE_READY", capabilities: ["workspace-sync-v1", "sync-batch-v1"] });
    expect(connection.batching()).toBe(true);
    const reads = Array.from({ length: 7 }, (_, index) => connection.read({ path: `f${index}.txt`, sha256: "a".repeat(64), offset: 0, length: 1 }));
    await vi.waitFor(() => expect(s.sent).toHaveLength(6));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(s.sent).toHaveLength(6);
    s.ws.emitMessage({ type: "WORKSPACE_RESPONSE", requestId: s.sent[0]!.id, result: { bytes: 1, base64: "YQ==" } });
    await vi.waitFor(() => expect(s.sent).toHaveLength(7));
    const batch = connection.readBatch({ files: [{ path: "a.txt", sha256: "a".repeat(64) }] });
    for (const frame of s.sent.slice(1)) s.ws.emitMessage({ type: "WORKSPACE_RESPONSE", requestId: frame.id, result: { bytes: 1, base64: "YQ==" } });
    await Promise.all(reads);
    await vi.waitFor(() => expect(s.sent).toHaveLength(8));
    expect(s.sent[7]).toMatchObject({ op: "sync.readBatch", params: { files: [{ path: "a.txt" }] } });
    s.ws.emitMessage({ type: "WORKSPACE_RESPONSE", requestId: s.sent[7]!.id, result: { entries: [{ path: "a.txt", changed: true }] } });
    expect(await batch).toEqual({ entries: [{ path: "a.txt", changed: true }] });
    connection.close();
  });
});

describe("sync grant refusals", () => {
  it("names a person's lost access apart from a Mac that is not connected", async () => {
    const { syncGrantRefusal } = await import("../workspace-sync/connection");
    const { DeviceControlError } = await import("../local-commands/control");
    const refused = (status: number, code: string) => syncGrantRefusal(new DeviceControlError(status, code)).kind;
    expect(refused(403, "member_access_revoked")).toBe("access_revoked");
    expect(refused(404, "not_found")).toBe("access_revoked");
    expect(refused(403, "mac_not_connected")).toBe("not_connected");
    expect(refused(401, "signed_out")).toBe("signed_out");
    expect(refused(409, "worker_update_required")).toBe("update_required");
    expect(refused(409, "cloud_workspace_not_running")).toBe("paused");
    expect(syncGrantRefusal(new Error("network")).kind).toBe("unavailable");
  });
});
