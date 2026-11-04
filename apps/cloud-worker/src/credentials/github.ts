import { randomUUID } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { CloudV2ControlFrame, CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import { GithubAuthenticationError, githubAuthenticationError, GITHUB_REQUEST_TIMEOUT_MS, GITHUB_SOCKET_TIMEOUT_MS } from "./github-failure";

export interface GithubToken { token: string; expiresAt: number }
const unavailable = () => githubAuthenticationError();
interface Pending {
  id?: string; promise: Promise<GithubToken>; resolve: (token: GithubToken) => void; reject: (error: Error) => void;
  deadline: number; attempts: number; failure?: GithubAuthenticationError;
  timer: ReturnType<typeof setTimeout>; retry?: ReturnType<typeof setTimeout>;
}

/** One request flight per worker. Credentials exist only in process memory;
 * disconnection, refusal and expiry never replay the caller's Git command. */
export class GithubTokens {
  private online = false;
  private disposed = false;
  private cached?: GithubToken;
  private pending?: Pending;
  private readonly now: () => number;
  constructor(private readonly send: (frame: CloudV2WorkerFrame, timeoutMs: number) => Promise<boolean>, private readonly options: { now?: () => number; timeoutMs?: number; purpose?: "git" | "gh" } = {}) { this.now = options.now ?? Date.now; }
  connect(): void {
    if (this.disposed) return;
    this.online = true;
    if (this.pending) this.dispatch(this.pending);
  }
  invalidate(): void {
    this.cached = undefined;
    if (this.pending) this.finish(this.pending, githubAuthenticationError("connection-changed"));
  }
  disconnect(): void {
    this.online = false; this.cached = undefined;
    if (this.pending?.id) this.failed(this.pending, unavailable());
  }
  dispose(): void {
    this.disposed = true; this.online = false; this.cached = undefined;
    if (this.pending) this.finish(this.pending, unavailable());
  }
  get(): Promise<GithubToken> {
    if (this.disposed) return Promise.reject(unavailable());
    if (this.online && this.cached && this.cached.expiresAt > this.now() + 10_000) return Promise.resolve(this.cached);
    if (this.pending) return this.pending.promise;
    let resolve!: Pending["resolve"], reject!: Pending["reject"];
    const promise = new Promise<GithubToken>((yes, no) => { resolve = yes; reject = no; });
    const timeout = this.options.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS;
    const pending: Pending = { promise, resolve, reject, attempts: 0, deadline: this.now() + timeout,
      timer: setTimeout(() => this.finish(pending, pending.failure ?? unavailable()), timeout) };
    pending.timer.unref?.(); this.pending = pending;
    this.dispatch(pending);
    return promise;
  }
  receive(frame: Extract<CloudV2ControlFrame, { t: "reply" | "refusal" }>): void {
    const pending = this.pending;
    if (!pending || pending.id !== frame.id) return;
    if (this.now() >= pending.deadline) { this.finish(pending, pending.failure ?? unavailable()); return; }
    if (frame.t === "refusal") { this.failed(pending, githubAuthenticationError(frame.code)); return; }
    if (frame.expiresAt <= this.now() + 1000 || !frame.token || frame.token.length > 8192 || /[\0\r\n]/.test(frame.token)) { this.failed(pending, unavailable()); return; }
    this.finish(pending, { token: frame.token, expiresAt: frame.expiresAt });
  }
  private dispatch(pending: Pending): void {
    if (this.pending !== pending || pending.id || pending.retry || !this.online) return;
    const remaining = pending.deadline - this.now();
    if (remaining <= 0 || pending.attempts >= 2) { this.finish(pending, pending.failure ?? unavailable()); return; }
    const id = randomUUID(); pending.id = id; pending.attempts++;
    const failed = () => { if (this.pending === pending && pending.id === id) this.failed(pending, unavailable()); };
    void this.send({ t: "request", id, kind: "github-token", ...(this.options.purpose ? { purpose: this.options.purpose } : {}) }, remaining)
      .then(sent => { if (!sent) failed(); }, failed);
  }
  private failed(pending: Pending, error: GithubAuthenticationError): void {
    pending.id = undefined; this.cached = undefined;
    if (error.reason !== "unavailable" || pending.attempts >= 2) { this.finish(pending, error); return; }
    pending.failure ??= error;
    if (pending.deadline - this.now() <= 250) return;
    pending.retry = setTimeout(() => { pending.retry = undefined; this.dispatch(pending); }, 250);
    pending.retry.unref?.();
  }
  private finish(pending: Pending, result: GithubToken | GithubAuthenticationError): void {
    if (this.pending !== pending) return;
    this.pending = undefined; clearTimeout(pending.timer); clearTimeout(pending.retry);
    if (result instanceof GithubAuthenticationError) { this.cached = undefined; pending.reject(result); }
    else { this.cached = result; pending.resolve(result); }
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
  constructor(readonly socketPath: string, private readonly token: (purpose: "git" | "gh") => Promise<GithubToken>, private readonly changed: () => void = () => {}) {}
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
    this.sockets.add(socket); socket.setTimeout(GITHUB_SOCKET_TIMEOUT_MS, () => socket.destroy());
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
        if (request.kind === "token" || request.kind === "user-token") return this.token(request.kind === "user-token" ? "gh" : "git");
        throw unavailable();
      };
      void reply().then(value => { if (!socket.destroyed) socket.end(JSON.stringify(value) + "\n"); }, error => {
        if (!socket.destroyed) socket.end(JSON.stringify({ error: error instanceof GithubAuthenticationError ? error.reason : "unavailable" }) + "\n");
      });
    });
  }
}
