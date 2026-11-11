import { createMessage } from "@zeros/protocol/messages";
import { SYNC_BRIDGE_PATH, SYNC_BRIDGE_PROTOCOL, SYNC_HINT_KIND, SyncBootstrapReplySchema, SyncReadReplySchema, SyncSnapshotReplySchema,
  type SyncGrantReply, type SyncReadRequest, type SyncSnapshotRequest } from "@zeros/protocol/workspace-sync";
import { SyncChangedError, type SyncSource } from "./engine";

/** Why a sync socket could not be opened. Paused waits for the VM. */
export class SyncConnectError extends Error {
  constructor(readonly kind: "paused" | "update_required" | "not_connected" | "unavailable" | "signed_out") { super(`Sync connection: ${kind}`); }
}

export interface SyncSocket {
  readonly readyState: number; send(data: string): void; close(code?: number): void; terminate(): void;
  on(event: "open" | "close" | "error", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown, binary: boolean) => void): unknown;
}
export interface DirectDeps {
  /** A fresh single-use grant from the control plane (D+H); throws SyncConnectError. */
  grant(): Promise<SyncGrantReply>;
  dial(url: string, protocol: string, headers: Record<string, string>): SyncSocket;
  renewMs?: number;
}

const REQUEST_TIMEOUT_MS = 120_000, MAX_FRAME_CHARS = 16 * 1024 * 1024, RENEW_MS = 8 * 60_000;

/** The Mac's direct socket to the worker through Boat's protected route. The
 * control plane only authorizes it; no file byte passes through it. The
 * socket is renewed with a fresh grant about every 8 minutes (the worker
 * closes one unrenewed for 10). One request is in flight at a time. */
export class DirectSyncConnection implements SyncSource {
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  private renew?: ReturnType<typeof setInterval>;
  private queue = Promise.resolve();
  private constructor(private readonly ws: SyncSocket, private readonly hint: () => void, private readonly ended: () => void) {}

  static async connect(deps: DirectDeps, handlers: { hint(): void; closed(): void }): Promise<DirectSyncConnection> {
    const first = await deps.grant();
    const url = new URL(first.url); url.protocol = "wss:"; url.pathname = SYNC_BRIDGE_PATH;
    const ws = deps.dial(url.toString(), SYNC_BRIDGE_PROTOCOL, { Cookie: `_port_auth=${first.portAuth}`, "X-Zeros-Worker-Auth": first.grant });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.terminate(); reject(new SyncConnectError("unavailable")); }, 20_000);
      ws.on("open", () => { clearTimeout(timer); resolve(); });
      ws.on("error", () => { clearTimeout(timer); reject(new SyncConnectError("unavailable")); });
    });
    const connection = new DirectSyncConnection(ws, handlers.hint, handlers.closed);
    ws.on("message", (data, binary) => { if (!binary) connection.receive(String(data)); });
    ws.on("close", () => connection.end());
    connection.renew = setInterval(() => {
      void deps.grant().then(next => { if (!connection.closed) ws.send(JSON.stringify({ t: "renew", grant: next.grant })); },
        () => { /* A refused renewal (revoked, disconnected): the worker closes the socket at its deadline. */ });
    }, deps.renewMs ?? RENEW_MS);
    connection.renew.unref?.();
    return connection;
  }

  snapshot(request: SyncSnapshotRequest) { return this.request("sync.snapshot", request).then(result => SyncSnapshotReplySchema.parse(result)); }
  read(request: SyncReadRequest) { return this.request("sync.read", request).then(result => SyncReadReplySchema.parse(result)); }
  bootstrap(have?: string) { return this.request("sync.bootstrap", have ? { have } : {}).then(result => SyncBootstrapReplySchema.parse(result)); }
  bundleRead(id: string, offset: number, length: number) { return this.request("sync.bundleRead", { id, offset, length }).then(result => SyncReadReplySchema.parse(result)); }
  close(): void { if (!this.closed) { this.ws.close(1000); this.end(); } }

  /** One request at a time: the decision is one read in flight per Mac. */
  private request(op: string, params: object): Promise<unknown> {
    const run = this.queue.then(() => this.send(op, params));
    this.queue = run.then(() => {}, () => {});
    return run;
  }
  private send(op: string, params: object): Promise<unknown> {
    if (this.closed || this.ws.readyState !== 1) return Promise.reject(new SyncConnectError("unavailable"));
    const frame = createMessage({ type: "WORKSPACE_REQUEST", source: "browser", op, params: params as Record<string, unknown> });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(frame.id); reject(new SyncConnectError("unavailable")); }, REQUEST_TIMEOUT_MS);
      this.pending.set(frame.id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(frame));
    });
  }

  private receive(raw: string): void {
    if (raw.length > MAX_FRAME_CHARS) return;
    let message: { type?: unknown; source?: unknown; requestId?: unknown; result?: unknown; code?: unknown; kinds?: unknown };
    try { message = JSON.parse(raw); } catch { return; }
    if (message.source !== "engine") return;
    if (message.type === "DB_CHANGED" && Array.isArray(message.kinds) && message.kinds.includes(SYNC_HINT_KIND)) { this.hint(); return; }
    if ((message.type !== "WORKSPACE_RESPONSE" && message.type !== "WORKSPACE_ERROR") || typeof message.requestId !== "string") return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId); clearTimeout(pending.timer);
    if (message.type === "WORKSPACE_RESPONSE") pending.resolve(message.result);
    else pending.reject(message.code === "SYNC_CHANGED" ? new SyncChangedError() : new SyncConnectError("unavailable"));
  }

  private end(): void {
    if (this.closed) return;
    this.closed = true; clearInterval(this.renew);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new SyncConnectError("unavailable")); }
    this.pending.clear();
    this.ended();
  }
}
