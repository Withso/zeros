import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type { Stats } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CloudV2ControlFrame, CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import { GithubAuthenticationError, githubAuthenticationError, GITHUB_REQUEST_TIMEOUT_MS, GITHUB_SOCKET_TIMEOUT_MS } from "./github-failure";

export interface GithubToken { token: string; expiresAt: number }
export const githubTokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");
export interface GithubTokenRequest { purpose?: "git" | "gh"; failedTokenSha256?: string; timeoutMs?: number }
const unavailable = () => githubAuthenticationError();
interface Pending {
  id?: string; promise: Promise<GithubToken>; resolve: (token: GithubToken) => void; reject: (error: Error) => void;
  deadline: number; attempts: number; failure?: GithubAuthenticationError;
  request: GithubTokenRequest;
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
  get(request: GithubTokenRequest = {}): Promise<GithubToken> {
    if (this.disposed) return Promise.reject(unavailable());
    if (request.failedTokenSha256) {
      if (this.cached && githubTokenHash(this.cached.token) === request.failedTokenSha256) this.cached = undefined;
      if (this.pending && this.pending.request.failedTokenSha256 !== request.failedTokenSha256)
        this.finish(this.pending, githubAuthenticationError("connection-changed"));
    }
    if (this.online && this.cached && this.cached.expiresAt > this.now() + 10_000) return Promise.resolve(this.cached);
    if (this.pending) return this.pending.promise;
    let resolve!: Pending["resolve"], reject!: Pending["reject"];
    const promise = new Promise<GithubToken>((yes, no) => { resolve = yes; reject = no; });
    const timeout = Math.min(request.timeoutMs ?? Infinity, this.options.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS);
    if (timeout <= 0) return Promise.reject(unavailable());
    const pending: Pending = { promise, resolve, reject, request, attempts: 0, deadline: this.now() + timeout,
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
    if (githubTokenHash(frame.token) === pending.request.failedTokenSha256) { this.finish(pending, githubAuthenticationError("connection-expired")); return; }
    this.finish(pending, { token: frame.token, expiresAt: frame.expiresAt });
  }
  private dispatch(pending: Pending): void {
    if (this.pending !== pending || pending.id || pending.retry || !this.online) return;
    const remaining = pending.deadline - this.now();
    if (remaining <= 0 || pending.attempts >= 2) { this.finish(pending, pending.failure ?? unavailable()); return; }
    const id = randomUUID(); pending.id = id; pending.attempts++;
    const failed = () => { if (this.pending === pending && pending.id === id) this.failed(pending, unavailable()); };
    const purpose = pending.request.purpose ?? this.options.purpose;
    void this.send({ t: "request", id, kind: "github-token", ...(purpose ? { purpose } : {}),
      ...(pending.request.failedTokenSha256 ? { failedTokenSha256: pending.request.failedTokenSha256 } : {}) }, remaining)
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
    // Git reports a rejected password to erase; askpass alone cannot observe it.
    GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.https://github.com.helper", GIT_CONFIG_VALUE_1: `!'${join(dirname(askpassPath), "git-credential").replaceAll("'", "'\\''")}'` };
}

/** Same-user VM broker. The socket is private to the worker's Unix account;
 * agents and terminals intentionally share that workspace trust domain. */
export class GithubBroker {
  private server?: Server;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private disposed = false;
  private ownedSocket?: Stats;
  private ownedDirectory?: Stats;
  private readonly sockets = new Set<Socket>();
  constructor(readonly socketPath: string, private readonly token: (purpose: "git" | "gh", failedTokenSha256?: string) => Promise<GithubToken>, private readonly changed: () => void = () => {}) {}
  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("The GitHub broker is disposed."));
    if (this.server) return Promise.resolve();
    return this.starting ??= this.listen().finally(() => { this.starting = undefined; });
  }
  dispose(): Promise<void> {
    this.disposed = true;
    return this.stopping ??= this.stop();
  }
  private async listen(): Promise<void> {
    const directory = dirname(this.socketPath);
    let staging: string | undefined, bound: string | undefined, server: Server | undefined, owned: Stats | undefined;
    try {
      const created = await mkdir(directory, { recursive: true, mode: 0o700 });
      const parent = await lstat(directory);
      if (created) this.ownedDirectory = parent;
      if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700) throw new Error("The GitHub broker directory must be private.");
      if (await inspect(this.socketPath)) throw new Error("The GitHub broker socket is already in use.");
      staging = await mkdtemp(join(directory, ".bind-"));
      const binding = bound = join(staging, "socket");
      const listener = server = createServer(socket => this.accept(socket)); listener.maxConnections = 64;
      await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(binding, () => { listener.removeListener("error", reject); resolve(); }); });
      listener.on("error", () => {});
      owned = await lstat(bound);
      await chmod(bound, 0o600);
      await link(bound, this.socketPath); this.ownedSocket = owned;
      // libuv unlinks its original bind path on close, even if a foreign socket
      // replaced it. Publish a hard link and retire that private binding name.
      await unlinkOwnedSocket(bound, owned); await rmdir(staging); staging = undefined;
      this.server = listener;
    } catch (error) {
      if (bound) await unlinkOwnedSocket(bound, owned).catch(() => {});
      for (const socket of this.sockets) socket.destroy(); this.sockets.clear();
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      throw error;
    } finally {
      if (staging) await rmdir(staging).catch(() => {});
      if (!this.server) await this.cleanup().catch(() => {});
    }
  }
  private async stop(): Promise<void> {
    await this.starting?.catch(() => {});
    for (const socket of this.sockets) socket.destroy(); this.sockets.clear();
    const server = this.server; this.server = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await this.cleanup();
  }
  private async cleanup(): Promise<void> {
    await unlinkOwnedSocket(this.socketPath, this.ownedSocket); this.ownedSocket = undefined;
    if (!this.ownedDirectory) return;
    const directory = dirname(this.socketPath), current = await inspect(directory);
    if (current?.isDirectory() && sameInode(current, this.ownedDirectory)) await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
    });
    this.ownedDirectory = undefined;
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
        if (request.kind === "report-failure" && "purpose" in request && (request.purpose === "git" || request.purpose === "gh") &&
          "failedTokenSha256" in request && typeof request.failedTokenSha256 === "string" && request.failedTokenSha256.length === 64 && /^[a-f0-9]{64}$/.test(request.failedTokenSha256))
          return this.token(request.purpose, request.failedTokenSha256);
        throw unavailable();
      };
      void reply().then(value => { if (!socket.destroyed) socket.end(JSON.stringify(value) + "\n"); }, error => {
        if (!socket.destroyed) socket.end(JSON.stringify({ error: error instanceof GithubAuthenticationError ? error.reason : "unavailable" }) + "\n");
      });
    });
  }
}

async function inspect(path: string): Promise<Stats | undefined> {
  return lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
}
function sameInode(current: Stats, owned?: Stats): boolean {
  return !!owned && current.dev === owned.dev && current.ino === owned.ino && current.uid === owned.uid;
}
async function unlinkOwnedSocket(path: string, owned?: Stats): Promise<void> {
  if (!owned) return;
  const current = await inspect(path);
  if (!current?.isSocket() || !sameInode(current, owned)) return;
  const retirement = await mkdtemp(join(dirname(path), ".retire-")), captured = join(retirement, "socket");
  try {
    const moved = await rename(path, captured).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
    if (!moved) return;
    const entry = await lstat(captured);
    // Inspect the captured name: another broker can replace the public name
    // after its ownership read. Restore foreign captures without overwriting
    // a newer publication, and retain their private alias instead of deleting it.
    if (entry.isSocket() && sameInode(entry, owned)) await unlink(captured);
    else await link(captured, path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  } finally {
    await rmdir(retirement).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; });
  }
}
