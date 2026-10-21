import { randomUUID } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { CloudV2ControlFrame, CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";

export interface GithubToken { token: string; expiresAt: number }
const unavailable = () => new Error("GitHub authentication is unavailable. Reconnect GitHub and try again.");
interface Pending { id: string; resolve: (token: GithubToken) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

/** One request flight per worker. Credentials exist only in process memory;
 * disconnection, refusal and expiry never replay the caller's Git command. */
export class GithubTokens {
  private online = false;
  private cached?: GithubToken;
  private pending?: Pending;
  private flight?: Promise<GithubToken>;
  private readonly now: () => number;
  constructor(private readonly send: (frame: CloudV2WorkerFrame) => Promise<boolean>, private readonly options: { now?: () => number; timeoutMs?: number } = {}) { this.now = options.now ?? Date.now; }
  connect(): void { this.disconnect(); this.online = true; }
  invalidate(): void { this.cached = undefined; }
  disconnect(): void {
    this.online = false; this.cached = undefined;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(unavailable()); this.pending = undefined; }
    this.flight = undefined;
  }
  get(): Promise<GithubToken> {
    if (!this.online) return Promise.reject(unavailable());
    if (this.cached && this.cached.expiresAt > this.now() + 60_000) return Promise.resolve(this.cached);
    if (this.flight) return this.flight;
    const id = randomUUID();
    const pending = new Promise<GithubToken>((resolve, reject) => {
      const timer = setTimeout(() => this.refuse(id), this.options.timeoutMs ?? 15_000); timer.unref?.();
      this.pending = { id, resolve, reject, timer };
      void this.send({ t: "request", id, kind: "github-token" }).then(sent => { if (!sent) this.refuse(id); }, () => this.refuse(id));
    });
    const flight = pending.finally(() => { if (this.flight === flight) this.flight = undefined; }); this.flight = flight;
    return flight;
  }
  receive(frame: Extract<CloudV2ControlFrame, { t: "reply" | "refusal" }>): void {
    if (!this.pending || this.pending.id !== frame.id) return;
    if (frame.t === "refusal" || frame.expiresAt <= this.now() + 1000 || !frame.token || frame.token.length > 8192 || /[\0\r\n]/.test(frame.token)) { this.refuse(frame.id); return; }
    const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer);
    this.cached = { token: frame.token, expiresAt: frame.expiresAt }; pending.resolve(this.cached);
  }
  private refuse(id: string): void {
    if (this.pending?.id !== id) return;
    const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer); pending.reject(unavailable());
  }
}

export function githubEnvironment(socketPath: string, askpassPath: string): NodeJS.ProcessEnv {
  return { GH_ZEROS_BROKER_SOCKET: socketPath, GIT_ASKPASS: askpassPath, GIT_TERMINAL_PROMPT: "0",
    // Clear persistent helpers; askpass is the only source of HTTPS credentials.
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "" };
}

/** Same-user VM broker. The socket is private to the worker's Unix account;
 * agents and terminals intentionally share that workspace trust domain. */
export class GithubBroker {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  constructor(readonly socketPath: string, private readonly token: () => Promise<GithubToken>, private readonly changed: () => void = () => {}) {}
  async start(): Promise<void> {
    if (this.server) return;
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    const existing = await lstat(this.socketPath).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (existing) {
      if (!existing.isSocket() || existing.uid !== process.getuid?.() || await this.listening()) throw new Error("The GitHub broker socket is already in use.");
      await unlink(this.socketPath);
    }
    const server = createServer(socket => this.accept(socket)); server.maxConnections = 64;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.socketPath, () => { server.removeListener("error", reject); resolve(); }); });
    server.on("error", () => {}); this.server = server;
    await chmod(this.socketPath, 0o600);
  }
  async dispose(): Promise<void> {
    for (const socket of this.sockets) socket.destroy(); this.sockets.clear();
    const server = this.server; this.server = undefined;
    if (server) { await new Promise<void>(resolve => server.close(() => resolve())); await unlink(this.socketPath).catch(() => {}); }
  }
  private listening(): Promise<boolean> {
    return new Promise(resolve => {
      const socket = connect(this.socketPath); let settled = false;
      const finish = (value: boolean) => { if (!settled) { settled = true; socket.destroy(); resolve(value); } };
      socket.once("connect", () => finish(true)); socket.once("error", () => finish(false)); socket.setTimeout(500, () => finish(true));
    });
  }
  private accept(socket: Socket): void {
    this.sockets.add(socket); socket.setTimeout(20_000, () => socket.destroy());
    socket.on("error", () => {}); socket.once("close", () => this.sockets.delete(socket));
    let buffer = "", answered = false;
    socket.setEncoding("utf8");
    socket.on("data", (data: string) => {
      if (answered) return;
      buffer += data; if (Buffer.byteLength(buffer) > 1024) { answered = true; socket.destroy(); return; }
      if (!buffer.includes("\n")) return;
      answered = true;
      const reply = async () => {
        const request: unknown = JSON.parse(buffer.trim());
        if (!request || typeof request !== "object" || !("kind" in request)) throw unavailable();
        if (request.kind === "changed") { this.changed(); return { ok: true }; }
        if (request.kind === "token") return this.token();
        throw unavailable();
      };
      void reply().then(value => { if (!socket.destroyed) socket.end(JSON.stringify(value) + "\n"); }, () => { if (!socket.destroyed) socket.end('{"error":"unavailable"}\n'); });
    });
  }
}
