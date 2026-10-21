import { constants } from "node:fs";
import { open } from "node:fs/promises";
import WebSocket from "ws";
import { CLOUD_V2_MAX_FRAME_BYTES, CloudV2WorkerFrameSchema, type CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import type { Transport, TransportHandlers } from "./transport";

export const WORKER_TOKEN_FILE = "/home/user/.config/zeros/worker-token";
export type RelayStatus = "credential-unavailable" | "connected" | "disconnected" | "superseded" | "stopped" | "protocol-error";
interface RelayOptions {
  url: string;
  tokenFile?: string;
  retryBaseMs?: number;
  retryMaxMs?: number;
  onStatus?: (status: RelayStatus) => void;
}

/** Outbound-only relay connection. Authentication is reread from the owned
 * 0600 file on every attempt, including rotation while a VM is running. */
export class RelayTransport implements Transport {
  private socket?: WebSocket;
  private handlers?: TransportHandlers;
  private retry?: ReturnType<typeof setTimeout>;
  private ping?: ReturnType<typeof setInterval>;
  private connecting?: Promise<void>;
  private stopped = false;
  private attempt = 0;
  private readonly tokenFile: string;

  constructor(private readonly options: RelayOptions) {
    let url: URL;
    try { url = new URL(options.url); } catch { throw new Error("Invalid worker relay URL."); }
    if ((url.protocol !== "wss:" && !(url.protocol === "ws:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash)
      throw new Error("Invalid worker relay URL.");
    this.tokenFile = options.tokenFile ?? WORKER_TOKEN_FILE;
  }

  start(handlers: TransportHandlers): void {
    if (this.handlers || this.stopped) return;
    this.handlers = handlers; this.connect();
  }

  async send(frame: CloudV2WorkerFrame): Promise<boolean> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.stopped) return false;
    if (!CloudV2WorkerFrameSchema.safeParse(frame).success) return false;
    const payload = JSON.stringify(frame);
    if (Buffer.byteLength(payload) > CLOUD_V2_MAX_FRAME_BYTES || socket.bufferedAmount > 4 * 1024 * 1024) {
      // A reconnect backfills the durable state. Never retain an unbounded
      // in-memory queue of history or duplicate opaque app requests.
      socket.terminate(); return false;
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { socket.terminate(); resolve(false); }, 10_000);
      socket.send(payload, (error) => { clearTimeout(timer); resolve(!error); });
    });
  }

  async dispose(): Promise<void> {
    this.stopped = true; clearTimeout(this.retry); clearInterval(this.ping);
    await this.connecting;
    const socket = this.socket;
    if (socket && socket.readyState !== WebSocket.CLOSED) await new Promise<void>((resolve) => { socket.once("close", () => resolve()); socket.terminate(); });
  }

  private connect(): void {
    if (this.connecting || this.stopped) return;
    this.connecting = this.connectOnce().finally(() => { this.connecting = undefined; });
  }

  private async connectOnce(): Promise<void> {
    let token: string;
    try { token = await readWorkerToken(this.tokenFile); }
    catch {
      if (!this.stopped) { this.options.onStatus?.("credential-unavailable"); this.schedule(); }
      return;
    }
    if (this.stopped) return;
    const socket = new WebSocket(this.options.url, {
      headers: { Authorization: `Bearer ${token}` }, maxPayload: CLOUD_V2_MAX_FRAME_BYTES,
      handshakeTimeout: 10_000, followRedirects: false, perMessageDeflate: false,
    });
    this.socket = socket;
    socket.on("error", () => { /* Close owns reconnect. Never log headers or the server's response body. */ });
    socket.on("unexpected-response", (_request, response) => { response.resume(); socket.terminate(); });
    socket.on("open", () => {
      if (this.stopped || this.socket !== socket) { socket.terminate(); return; }
      this.attempt = 0;
      this.options.onStatus?.("connected");
      void Promise.resolve(this.handlers!.open()).catch(() => socket.close(4003));
      let alive = true;
      socket.on("pong", () => { alive = true; });
      this.ping = setInterval(() => {
        if (!alive) { socket.terminate(); return; }
        alive = false; socket.ping();
      }, 25_000);
      this.ping.unref?.();
    });
    socket.on("message", (data, binary) => {
      if (this.stopped || this.socket !== socket) return;
      if (binary) { socket.close(4003); return; }
      let frame: unknown;
      try { frame = JSON.parse(data.toString()); } catch { socket.close(4003); return; }
      // Config preparation may request a GitHub token; replies must continue
      // flowing while that asynchronous preparation is waiting for them.
      void this.handlers!.frame(frame).catch(() => socket.close(4003));
    });
    socket.on("close", (code) => {
      if (this.socket !== socket) return;
      this.socket = undefined; clearInterval(this.ping);
      this.handlers!.close();
      if (this.stopped) return;
      if (code === 4000 || code === 4001 || code === 4003) {
        this.stopped = true;
        this.options.onStatus?.(code === 4000 ? "superseded" : code === 4001 ? "stopped" : "protocol-error");
      } else { this.options.onStatus?.("disconnected"); this.schedule(); }
    });
  }

  private schedule(): void {
    if (this.stopped || this.retry) return;
    const base = Math.max(10, this.options.retryBaseMs ?? 1000);
    const ceiling = Math.max(base, this.options.retryMaxMs ?? 30_000);
    const delay = Math.min(ceiling, base * 2 ** Math.min(this.attempt++, 8));
    // Keep a positive minimum even at the bottom of the jitter range.
    this.retry = setTimeout(() => { this.retry = undefined; this.connect(); }, Math.max(base, Math.floor(delay * (0.8 + Math.random() * 0.2))));
  }
}

async function readWorkerToken(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Invalid credential file.");
    const token = (await file.readFile("utf8")).trim();
    if (!token || token.length > 8192 || /[\s\0]/.test(token)) throw new Error("Invalid credential file.");
    return token;
  } finally { await file.close(); }
}
