import { realpath, type FileHandle } from "node:fs/promises";
import { createMessage, type BridgeMessage, type PtyCreateMessage, type PtyTerminalInfo } from "@zeros/protocol/messages";
import type { AppClient } from "../agents";
import { workerChildEnvironment } from "../drivers/shared/agent-environment";
import { CheckedFiles, descriptorPath } from "../workspace/checked-files";
import type { WorkspaceScope } from "../workspace/scope";
import { TerminalMirror } from "./mirror";

export interface TerminalProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  pause(): void;
  resume(): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}
export interface TerminalSpawnOptions { shell: string; args: string[]; cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv }
interface Options {
  spawn?: (options: TerminalSpawnOptions) => Promise<TerminalProcess>;
  mirror?: (cols: number, rows: number) => TerminalMirror;
  environment?: NodeJS.ProcessEnv;
  gitEnvironment?: NodeJS.ProcessEnv;
  shellArgs?: string[];
  broadcast?: (frame: BridgeMessage) => void | Promise<void>;
  activity?: () => void;
}
interface Session extends PtyTerminalInfo {
  native: TerminalProcess; mirror: TerminalMirror; descriptor?: FileHandle;
  cols: number; rows: number; owner?: AppClient;
  subscribers: Set<AppClient>; disposers: Array<{ dispose(): void }>;
  tail: Promise<void>; pendingBytes: number; paused: boolean; removed: boolean;
  attachments: number; hasOutput: boolean; exitPublished: boolean;
  exit?: { exitCode: number; signal?: number }; retirement?: Promise<void>;
}
interface Pending { owner?: AppClient; cancelled: boolean; promise: Promise<Session> }

const dim = (value: number | undefined, fallback: number): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(500, Math.max(2, Math.floor(value))) : fallback;
const nativeSpawn = async ({ shell, args, cwd, cols, rows, env }: TerminalSpawnOptions): Promise<TerminalProcess> => {
  const pty = await import("node-pty");
  return pty.spawn(shell, args, { cwd, cols, rows, env, name: "xterm-256color" });
};

/** Shared shells survive app disconnects. Each shell has a serialized screen
 * and subscription queue so replay and live bytes never overlap on reattach. */
export class Terminals {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, Pending>();
  private readonly retiredClients = new WeakSet<AppClient>();
  private readonly retiring = new Set<Promise<void>>();
  private readonly files: CheckedFiles;
  private disposed = false;
  constructor(private readonly scope: WorkspaceScope, private readonly options: Options = {}) { this.files = new CheckedFiles(scope); }

  get busy(): boolean { return this.pending.size > 0 || [...this.sessions.values()].some(session => !session.exit); }

  async handle(client: AppClient, frame: BridgeMessage): Promise<void> {
    if (this.disposed || this.retiredClients.has(client)) return;
    switch (frame.type) {
      case "PTY_CREATE": {
        try { await this.create(client, frame); }
        catch { if (!this.retiredClients.has(client)) await client.send(createMessage({ type: "PTY_EXIT", source: "engine", sessionId: frame.sessionId, exitCode: 1, signal: null, reason: "spawn-failed" })); }
        return;
      }
      case "PTY_LIST": {
        let terminals: PtyTerminalInfo[] = [];
        try {
          this.scope.assertId(frame.workspaceId);
          terminals = [...this.sessions.values()].filter(session => !session.owner && !session.removed).map(({ sessionId, workspaceId, cwd, createdAt, exit }) => ({ sessionId, workspaceId, cwd, createdAt, ...(exit ? { exited: true } : {}) }));
        } catch { /* A foreign workspace has no terminals here. */ }
        await client.send(createMessage({ type: "PTY_LIST_RESULT", source: "engine", requestId: frame.id, terminals })); return;
      }
      case "PTY_KILL": {
        const pending = this.pending.get(frame.sessionId);
        if (pending && (!pending.owner || pending.owner === client)) { pending.cancelled = true; await pending.promise.catch(() => {}); }
        const session = this.access(client, frame.sessionId);
        if (session) await this.retire(session, true);
        return;
      }
      case "PTY_WRITE": {
        const session = this.access(client, frame.sessionId);
        if (session && !session.exit) try { session.native.write(frame.data); } catch { /* Exit owns the final status. */ }
        return;
      }
      case "PTY_RESIZE": {
        const session = this.access(client, frame.sessionId);
        if (session) await this.enqueue(session, async () => { this.resize(session, frame.cols, frame.rows); });
        return;
      }
    }
  }

  detach(client: AppClient): void {
    this.retiredClients.add(client);
    for (const pending of this.pending.values()) if (pending.owner === client) pending.cancelled = true;
    for (const session of this.sessions.values()) {
      session.subscribers.delete(client);
      if (session.owner === client) void this.retire(session, true);
    }
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pending.values()].map(pending => pending.promise.catch(() => {})));
    await Promise.all([...this.sessions.values()].map(session => session.tail));
    await Promise.all(this.retiring);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pending.values()) pending.cancelled = true;
    for (const session of this.sessions.values()) void this.retire(session, true);
    await this.flush();
  }

  private access(client: AppClient, id: string): Session | undefined {
    const session = this.sessions.get(id);
    return session && !session.removed && (!session.owner || session.owner === client) ? session : undefined;
  }

  private async create(client: AppClient, message: PtyCreateMessage): Promise<void> {
    this.scope.assertId(message.workspaceId);
    if (message.loginProvider || !message.sessionId || message.sessionId.length > 1024 || message.sessionId.includes("\0")) throw new Error("Invalid terminal request.");
    // Validate a supplied cwd even when an id already refers to a live shell.
    this.scope.path(message.cwd ?? this.scope.root, true);
    let session = this.sessions.get(message.sessionId);
    if (session?.owner && session.owner !== client) throw new Error("Terminal is private.");
    if (session?.exit) { await this.retire(session, false); session = undefined; }
    if (!session) {
      let pending = this.pending.get(message.sessionId);
      if (pending?.owner && pending.owner !== client) throw new Error("Terminal is private.");
      if (!pending) {
        if (this.busyCount() >= 32) throw new Error("Too many open terminals.");
        for (const old of this.sessions.values()) {
          if (this.sessions.size + this.pending.size < 64) break;
          if (old.exit) await this.retire(old, false);
        }
        pending = { ...(message.ephemeral ? { owner: client } : {}), cancelled: false, promise: undefined! };
        this.pending.set(message.sessionId, pending);
        const current = pending;
        pending.promise = this.spawn(message, pending).finally(() => {
          if (this.pending.get(message.sessionId) === current) this.pending.delete(message.sessionId);
          this.options.activity?.();
        });
        this.options.activity?.();
      }
      session = await pending.promise;
    }
    const current = session;
    await this.enqueue(current, async () => {
      if (current.removed || this.retiredClients.has(client)) return;
      this.resize(current, message.cols, message.rows);
      const reattached = current.attachments > 0;
      const replay = reattached || current.hasOutput ? await current.mirror.snapshot() : { data: "", bytes: 0, truncated: false };
      if (current.removed || this.retiredClients.has(client)) return;
      await client.send(createMessage({ type: "PTY_CREATED", source: "engine", requestId: message.id, sessionId: current.sessionId,
        pid: current.native.pid, cwd: current.cwd, cols: current.cols, rows: current.rows, reattached,
        replay: replay.data, replayBytes: replay.bytes, replayTruncated: replay.truncated }));
      if (this.retiredClients.has(client)) return;
      current.attachments++; current.subscribers.add(client);
      if (current.exitPublished && current.exit) await client.send(this.exitFrame(current));
    });
  }

  private async spawn(message: PtyCreateMessage, pending: Pending): Promise<Session> {
    const descriptor = await this.files.directory(message.cwd ?? this.scope.root);
    let native: TerminalProcess | undefined;
    try {
      const cwd = await realpath(descriptorPath(descriptor));
      const cols = dim(message.cols, 80), rows = dim(message.rows, 24);
      native = await (this.options.spawn ?? nativeSpawn)({ shell: "/bin/bash", args: this.options.shellArgs ?? ["-l"],
        // Keep the descriptor owned by the worker while the native fork chdirs.
        cwd: `/proc/${process.pid}/fd/${descriptor.fd}`, cols, rows,
        env: { ...workerChildEnvironment(this.options.environment, this.options.gitEnvironment), TERM: "xterm-256color" },
      });
      await this.files.assertDescriptor(descriptor);
      const session: Session = { sessionId: message.sessionId, workspaceId: this.scope.workspace.id, cwd, createdAt: Date.now(), cols, rows,
        native, descriptor, mirror: this.options.mirror?.(cols, rows) ?? new TerminalMirror(cols, rows), owner: pending.owner,
        subscribers: new Set(), disposers: [], tail: Promise.resolve(), pendingBytes: 0, paused: false, removed: false,
        attachments: 0, hasOutput: false, exitPublished: false };
      session.disposers.push(native.onData(data => this.data(session, data)), native.onExit(exit => this.exited(session, exit)));
      this.sessions.set(session.sessionId, session);
      if (pending.cancelled || this.disposed) { await this.retire(session, true); return session; }
      if (!session.owner) this.changed();
      return session;
    } catch (error) {
      try { native?.kill(); } catch { /* Already gone. */ }
      await descriptor.close(); throw error;
    }
  }

  private data(session: Session, data: string): void {
    if (session.removed || session.exit || !data) return;
    const bytes = Buffer.byteLength(data); session.pendingBytes += bytes;
    if (!session.paused && session.pendingBytes >= 256 * 1024) { session.paused = true; try { session.native.pause(); } catch { /* Exit may have won. */ } }
    void this.enqueue(session, async () => {
      try {
        // Bytes accepted before exit still belong before PTY_EXIT, including
        // one-shot shells whose registry row is already being retired.
        session.hasOutput = true; session.mirror.write(data); await session.mirror.flush();
        await this.publish(session, createMessage({ type: "PTY_DATA", source: "engine", sessionId: session.sessionId, data }));
      } finally {
        session.pendingBytes -= bytes;
        if (session.paused && session.pendingBytes < 128 * 1024 && !session.exit && !session.removed) { session.paused = false; try { session.native.resume(); } catch { /* Exit may have won. */ } }
      }
    });
  }

  private exited(session: Session, exit: { exitCode: number; signal?: number }): void {
    if (session.exit) return;
    session.exit = exit; this.options.activity?.();
    void this.enqueue(session, async () => { session.exitPublished = true; await this.publish(session, this.exitFrame(session)); await this.closeDescriptor(session); });
    if (session.owner) void this.retire(session, false);
    else this.changed();
  }

  private exitFrame(session: Session): BridgeMessage {
    return createMessage({ type: "PTY_EXIT", source: "engine", sessionId: session.sessionId, exitCode: session.exit?.exitCode ?? 0, signal: session.exit?.signal ?? null });
  }
  private resize(session: Session, cols?: number, rows?: number): void {
    const width = dim(cols, session.cols), height = dim(rows, session.rows);
    if (session.cols === width && session.rows === height) return;
    if (!session.exit) try { session.native.resize(width, height); } catch { return; }
    session.cols = width; session.rows = height; session.mirror.resize(width, height);
  }
  private enqueue(session: Session, task: () => Promise<void>): Promise<void> {
    const result = session.tail.then(task); session.tail = result.catch(() => {}); return session.tail;
  }
  private async publish(session: Session, frame: BridgeMessage): Promise<void> {
    await Promise.all([...session.subscribers].filter(client => !this.retiredClients.has(client)).map(client => client.send(frame).catch(() => {})));
  }
  private retire(session: Session, kill: boolean): Promise<void> {
    if (session.retirement) return session.retirement;
    let finished!: () => void;
    const retirement = new Promise<void>(resolve => { finished = resolve; });
    // kill() may synchronously call the native exit handler, which also retires
    // ephemeral sessions. Publish the single cleanup promise before signalling.
    session.retirement = retirement; this.retiring.add(retirement);
    session.removed = true;
    if (this.sessions.get(session.sessionId) === session) this.sessions.delete(session.sessionId);
    if (kill && !session.exit) {
      try { session.native.kill(); } catch { /* Exit may have won the race. */ }
      this.exited(session, { exitCode: 0, signal: 15 });
    }
    void session.tail.then(async () => {
      for (const disposable of session.disposers) disposable.dispose();
      session.subscribers.clear(); session.mirror.dispose(); await this.closeDescriptor(session);
    }).catch(() => {}).finally(() => { this.retiring.delete(retirement); finished(); });
    if (!session.owner) this.changed(); this.options.activity?.();
    return retirement;
  }
  private async closeDescriptor(session: Session): Promise<void> { const descriptor = session.descriptor; session.descriptor = undefined; await descriptor?.close(); }
  private busyCount(): number { return this.pending.size + [...this.sessions.values()].filter(session => !session.exit).length; }
  private changed(): void { void Promise.resolve(this.options.broadcast?.(createMessage({ type: "PTY_TERMINALS_CHANGED", source: "engine" }))).catch(() => {}); }
}
