import { createMessage } from "@zeros/protocol/messages";
import { SYNC_BATCH_CAPABILITY, SYNC_BRIDGE_PATH, SYNC_BRIDGE_PROTOCOL, SYNC_HINT_KIND, SYNC_LIMITS, SyncBootstrapReplySchema, SyncReadBatchReplySchema,
  SyncReadReplySchema, SyncSnapshotReplySchema, type SyncGrantReply, type SyncReadBatchRequest, type SyncReadRequest, type SyncSnapshotRequest } from "@zeros/protocol/workspace-sync";
import { SyncChangedError, type SyncSource } from "./engine";
import type { GitHave } from "./git";

/** Why a sync socket could not be opened. Paused waits for the VM. */
export class SyncConnectError extends Error {
  /** `detail`: a closed code for the log (dial_<status>, dial_timeout, close_<code>, reply_<CODE>, timeout). */
  constructor(readonly kind: "paused" | "update_required" | "not_connected" | "unavailable" | "signed_out" | "access_revoked", readonly detail?: string) { super(`Sync connection: ${kind}`); }
}

/** What a refused sync grant (D+H) means for the run. Team sharing 3A: this person lost access (removed, Hold, no
 * repository access): the workspace answers member_access_revoked, or is hidden (404). Sync then stops for good. */
export function syncGrantRefusal(error: unknown): SyncConnectError {
  const refusal = error as { status?: unknown; code?: unknown } | null;
  if (!refusal || typeof refusal.status !== "number" || typeof refusal.code !== "string") return new SyncConnectError("unavailable");
  if (refusal.status === 401) return new SyncConnectError("signed_out");
  if (refusal.code === "member_access_revoked" || refusal.status === 404) return new SyncConnectError("access_revoked");
  if (refusal.code === "worker_update_required") return new SyncConnectError("update_required");
  if (refusal.code === "cloud_workspace_not_running") return new SyncConnectError("paused");
  if (refusal.code === "mac_not_connected" || refusal.status === 403) return new SyncConnectError("not_connected");
  return new SyncConnectError("unavailable");
}

export interface SyncSocket {
  readonly readyState: number; send(data: string): void; close(code?: number): void; terminate(): void;
  on(event: "open" | "close" | "error", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown, binary: boolean) => void): unknown;
  on(event: "close", listener: (code?: number) => void): unknown;
  on(event: "unexpected-response", listener: (request: unknown, response: { statusCode?: number }) => void): unknown;
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
 * closes one unrenewed for 10). Up to SYNC_LIMITS.inFlight requests are in
 * flight (the worker serves a passive client's frames concurrently); batches
 * are used only after the worker's ENGINE_READY says sync-batch-v1. */
export class DirectSyncConnection implements SyncSource {
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  private renew?: ReturnType<typeof setInterval>;
  private inFlight = 0;
  private readonly waiting: Array<() => void> = [];
  private batch = false;
  private multiHave = false;
  private constructor(private readonly ws: SyncSocket, private readonly hint: () => void, private readonly ended: () => void) {}

  static async connect(deps: DirectDeps, handlers: { hint(): void; closed(): void }): Promise<DirectSyncConnection> {
    const first = await deps.grant();
    const url = new URL(first.url); url.protocol = "wss:"; url.pathname = SYNC_BRIDGE_PATH;
    const ws = deps.dial(url.toString(), SYNC_BRIDGE_PROTOCOL, { Cookie: `_port_auth=${first.portAuth}`, "X-Zeros-Worker-Auth": first.grant });
    await new Promise<void>((resolve, reject) => {
      let status: number | undefined;
      const timer = setTimeout(() => { ws.terminate(); reject(new SyncConnectError("unavailable", "dial_timeout")); }, 20_000);
      ws.on("open", () => { clearTimeout(timer); resolve(); });
      ws.on("unexpected-response", (_request, response) => { status = response.statusCode; });
      ws.on("error", () => { clearTimeout(timer); reject(new SyncConnectError("unavailable", status ? `dial_${status}` : "dial_error")); });
    });
    const connection = new DirectSyncConnection(ws, handlers.hint, handlers.closed);
    ws.on("message", (data, binary) => { if (!binary) connection.receive(String(data)); });
    ws.on("close", (code?: number) => connection.end(`close_${code ?? 0}`));
    connection.renew = setInterval(() => {
      void deps.grant().then(next => { if (!connection.closed) ws.send(JSON.stringify({ t: "renew", grant: next.grant })); },
        () => { /* A refused renewal (revoked, disconnected): the worker closes the socket at its deadline. */ });
    }, deps.renewMs ?? RENEW_MS);
    connection.renew.unref?.();
    return connection;
  }

  snapshot(request: SyncSnapshotRequest) { return this.request("sync.snapshot", request).then(result => SyncSnapshotReplySchema.parse(result)); }
  read(request: SyncReadRequest) { return this.request("sync.read", request).then(result => SyncReadReplySchema.parse(result)); }
  bootstrap(have?: GitHave) {
    const heads = [...new Set(typeof have === "string" ? [have] : have ?? [])].filter(id => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(id)).slice(0, 64);
    return this.request("sync.bootstrap", heads.length ? { have: this.multiHave ? heads : heads[0] } : {}).then(result => SyncBootstrapReplySchema.parse(result));
  }
  bundleRead(id: string, offset: number, length: number) { return this.request("sync.bundleRead", { id, offset, length }).then(result => SyncReadReplySchema.parse(result)); }
  readBatch(request: SyncReadBatchRequest) { return this.request("sync.readBatch", request).then(result => SyncReadBatchReplySchema.parse(result)); }
  /** The worker serves sync.readBatch (an older one never says so). */
  batching(): boolean { return this.batch; }
  close(): void { if (!this.closed) { this.ws.close(1000); this.end("closed_here"); } }

  /** At most SYNC_LIMITS.inFlight at once; the rest wait their turn in order. */
  private async request(op: string, params: object): Promise<unknown> {
    if (this.inFlight >= SYNC_LIMITS.inFlight) await new Promise<void>(resolve => this.waiting.push(resolve));
    this.inFlight++;
    try { return await this.send(op, params); }
    finally { this.inFlight--; this.waiting.shift()?.(); }
  }
  private send(op: string, params: object): Promise<unknown> {
    if (this.closed || this.ws.readyState !== 1) return Promise.reject(new SyncConnectError("unavailable", this.endedWith ?? "closed"));
    const frame = createMessage({ type: "WORKSPACE_REQUEST", source: "browser", op, params: params as Record<string, unknown> });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(frame.id); reject(new SyncConnectError("unavailable", "timeout")); }, REQUEST_TIMEOUT_MS);
      this.pending.set(frame.id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(frame));
    });
  }

  private receive(raw: string): void {
    if (raw.length > MAX_FRAME_CHARS) return;
    let message: { type?: unknown; source?: unknown; requestId?: unknown; result?: unknown; code?: unknown; kinds?: unknown; capabilities?: unknown };
    try { message = JSON.parse(raw); } catch { return; }
    if (message.source !== "engine") return;
    if (message.type === "DB_CHANGED" && Array.isArray(message.kinds) && message.kinds.includes(SYNC_HINT_KIND)) { this.hint(); return; }
    if (message.type === "ENGINE_READY") {
      this.batch = Array.isArray(message.capabilities) && message.capabilities.includes(SYNC_BATCH_CAPABILITY);
      this.multiHave = Array.isArray(message.capabilities) && message.capabilities.includes("sync-have-v2");
      return;
    }
    if ((message.type !== "WORKSPACE_RESPONSE" && message.type !== "WORKSPACE_ERROR") || typeof message.requestId !== "string") return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId); clearTimeout(pending.timer);
    if (message.type === "WORKSPACE_RESPONSE") pending.resolve(message.result);
    else pending.reject(message.code === "SYNC_CHANGED" ? new SyncChangedError()
      : new SyncConnectError("unavailable", `reply_${typeof message.code === "string" && /^[A-Z_]{1,40}$/.test(message.code) ? message.code : "error"}`));
  }

  private endedWith?: string;
  private end(detail: string): void {
    if (this.closed) return;
    this.closed = true; this.endedWith = detail; clearInterval(this.renew);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new SyncConnectError("unavailable", detail)); }
    this.pending.clear();
    // Waiting requests then fail fast in send() (closed).
    for (const resume of this.waiting.splice(0)) resume();
    this.ended();
  }
}
