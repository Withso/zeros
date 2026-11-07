import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createMessage, type BridgeMessage, type PtyCreateMessage, type PtyTerminalInfo } from "@zeros/protocol/messages";
import type { AppClient } from "../agents";
import { RECENT_ACTIVITY_MS } from "../activity";
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
  applicationEnvironment?: Readonly<Record<string, string>>;
  shellArgs?: string[];
  broadcast?: (frame: BridgeMessage) => void | Promise<void>;
  activity?: () => void;
  /** Private directory where restorable shells leave their last screen and
   * directory for the next worker on this disk. Without it nothing is kept. */
  records?: string;
  recordDelayMs?: number;
  /** The shell's live working directory; Linux exposes it under /proc. */
  workingDirectory?: (pid: number) => Promise<string>;
}
interface Session extends PtyTerminalInfo {
  native: TerminalProcess; mirror: TerminalMirror; descriptor?: FileHandle;
  cols: number; rows: number; owner?: AppClient;
  subscribers: Set<AppClient>; disposers: Array<{ dispose(): void }>;
  tail: Promise<void>; pendingBytes: number; paused: boolean; removed: boolean;
  attachments: number; hasOutput: boolean; exitPublished: boolean; lastActivityAt: number;
  exit?: { exitCode: number; signal?: number }; retirement?: Promise<void>;
  /** Asked for restore and shared, so its screen and directory are kept. */
  restorable: boolean; restored: boolean; recordTimer?: ReturnType<typeof setTimeout>;
}
/** What a restorable shell leaves for the next worker on this disk. */
interface TerminalRecord { version: 1; sessionId: string; cwd: string; cols: number; rows: number; screen: string; savedAt: number }
const RECORD_DELAY_MS = 2_000, RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60_000, RECORD_LIMIT = 64, RECORD_MAX_BYTES = 1024 * 1024;
// Matches the desktop's own line for a shell it had to start again.
const RESTORED_NOTICE = "\r\n\x1b[2m--- Previous terminal session restored. Starting new shell... ---\x1b[0m\r\n";
const isRecord = (value: unknown): value is TerminalRecord => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && typeof record.sessionId === "string" && typeof record.cwd === "string" && typeof record.screen === "string"
    && [record.cols, record.rows, record.savedAt].every(number => typeof number === "number" && Number.isFinite(number));
};
interface Pending { owner?: AppClient; cancelled: boolean; promise: Promise<Session> }

/** The workspace computer's name in its shells, as the owner chose it:
 * zeros@<number>-<the workspace's own repository names>. The number is stable
 * per workspace; names are reduced to characters safe inside a prompt. */
export function terminalName(workspaceId: string, repositories: readonly string[]): string {
  const number = 1000 + Number.parseInt(workspaceId.replace(/-/g, "").slice(0, 8), 16) % 9000;
  const names = repositories.map(repository => (repository.split("/").pop() ?? "").toLowerCase()
    .replace(/[^a-z0-9._]+/g, "-").replace(/^[-.]+|[-.]+$/g, "")).filter(Boolean);
  return `zeros@${Number.isFinite(number) ? number : 1000}-${names.join("+") || "workspace"}`;
}

/** Runs once before the first prompt, after the image's ~/.bashrc, so it wins
 * over the "[branch]:path" prompt but never over one the user sets later. */
const namePrompt = (name: string): string => `PS1='\\[\\e[32m\\]${name}\\[\\e[0m\\]:\\[\\e[34m\\]\\w\\[\\e[0m\\]\\$ '; unset PROMPT_COMMAND`;

const dim = (value: number | undefined, fallback: number): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(500, Math.max(2, Math.floor(value))) : fallback;
const nativeSpawn = async ({ shell, args, cwd, cols, rows, env }: TerminalSpawnOptions): Promise<TerminalProcess> => {
  const pty = await import("node-pty");
  // node-pty sets PWD to the spawn cwd, so env passes the shell its own.
  const [file, argv] = env.PWD ? ["/usr/bin/env", [`PWD=${env.PWD}`, shell, ...args]] : [shell, args];
  return pty.spawn(file, argv, { cwd, cols, rows, env, name: "xterm-256color" });
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
  constructor(private readonly scope: WorkspaceScope, private readonly options: Options = {}) {
    this.files = new CheckedFiles(scope);
    if (options.records) void this.pruneRecords(options.records);
  }

  get busy(): boolean { return this.pending.size > 0 || [...this.sessions.values()].some(session => !session.exit && Date.now() - session.lastActivityAt < RECENT_ACTIVITY_MS); }
  get runtimeBusy(): boolean { return this.pending.size > 0 || this.retiring.size > 0 || [...this.sessions.values()].some(session => !session.exit || session.pendingBytes > 0 || session.attachments > 0); }

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
        if (session && !session.exit && frame.data) try { session.native.write(frame.data); this.activity(session); } catch { /* Exit owns the final status. */ }
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
    // A stopping VM takes its shells with it. Keep each restorable one's last
    // screen and directory first; the kills below then leave the records alone.
    await Promise.all([...this.sessions.values()].map(session => {
      clearTimeout(session.recordTimer); session.recordTimer = undefined;
      return this.enqueue(session, () => this.saveRecord(session));
    }));
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
      // A restored shell is new, but its first client gets the saved screen
      // as a reattach, so the desktop repaints it and never relaunches a command.
      const reattached = current.attachments > 0 || current.restored;
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
    const restorable = message.restore === true && !pending.owner && !!this.options.records;
    const record = restorable ? await this.readRecord(message.sessionId) : undefined;
    const descriptor = record ? await this.files.directory(record.cwd).catch(() => this.files.directory(this.scope.root))
      : await this.files.directory(message.cwd ?? this.scope.root);
    let native: TerminalProcess | undefined;
    try {
      const cwd = await realpath(descriptorPath(descriptor));
      const cols = dim(message.cols, record?.cols ?? 80), rows = dim(message.rows, record?.rows ?? 24);
      native = await (this.options.spawn ?? nativeSpawn)({ shell: "/bin/bash", args: this.options.shellArgs ?? ["-l"],
        // Keep the descriptor owned by the worker while the native fork chdirs.
        cwd: `/proc/${process.pid}/fd/${descriptor.fd}`, cols, rows,
        // bash keeps an inherited PWD that names its working directory, so the
        // prompt shows the checkout instead of the held descriptor's /proc path.
        env: { ...workerChildEnvironment(this.options.environment, this.options.gitEnvironment, this.options.applicationEnvironment), TERM: "xterm-256color", PWD: cwd,
          PROMPT_COMMAND: namePrompt(terminalName(this.scope.workspace.id, [this.scope.workspace.repository])) },
      });
      await this.files.assertDescriptor(descriptor);
      const mirror = await this.mirror(cols, rows, record);
      const session: Session = { sessionId: message.sessionId, workspaceId: this.scope.workspace.id, cwd, createdAt: Date.now(), cols, rows,
        native, descriptor, mirror, owner: pending.owner,
        subscribers: new Set(), disposers: [], tail: Promise.resolve(), pendingBytes: 0, paused: false, removed: false,
        attachments: 0, hasOutput: !!record, exitPublished: false, lastActivityAt: Date.now(), restorable, restored: !!record };
      session.disposers.push(native.onData(data => this.data(session, data)), native.onExit(exit => this.exited(session, exit)));
      this.sessions.set(session.sessionId, session);
      if (pending.cancelled || this.disposed) { await this.retire(session, true); return session; }
      if (!session.owner) this.changed();
      this.scheduleRecord(session);
      return session;
    } catch (error) {
      try { native?.kill(); } catch { /* Already gone. */ }
      await descriptor.close(); throw error;
    }
  }

  private data(session: Session, data: string): void {
    if (session.removed || session.exit || !data) return;
    this.activity(session); this.scheduleRecord(session);
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

  private activity(session: Session): void { session.lastActivityAt = Date.now(); this.options.activity?.(); }

  private exited(session: Session, exit: { exitCode: number; signal?: number }): void {
    if (session.exit) return;
    session.exit = exit; this.options.activity?.();
    clearTimeout(session.recordTimer); session.recordTimer = undefined;
    // A shell that ended or was closed is not coming back. Only a stopping
    // worker's kills keep their records.
    if (session.restorable && !this.disposed) void this.enqueue(session, () => this.forgetRecord(session));
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
  private async mirror(cols: number, rows: number, record?: TerminalRecord): Promise<TerminalMirror> {
    if (!record) return this.options.mirror?.(cols, rows) ?? new TerminalMirror(cols, rows);
    // Parse the saved screen at the size it was serialized at, then fit it.
    const mirror = this.options.mirror?.(dim(record.cols, cols), dim(record.rows, rows)) ?? new TerminalMirror(dim(record.cols, cols), dim(record.rows, rows));
    mirror.write(record.screen + RESTORED_NOTICE); await mirror.flush(); mirror.resize(cols, rows);
    return mirror;
  }
  private recordPath(sessionId: string): string | undefined {
    return this.options.records && join(this.options.records, `${createHash("sha256").update(sessionId).digest("hex")}.json`);
  }
  private scheduleRecord(session: Session): void {
    if (!session.restorable || session.recordTimer || session.removed || session.exit) return;
    session.recordTimer = setTimeout(() => {
      session.recordTimer = undefined;
      void this.enqueue(session, () => this.saveRecord(session));
    }, this.options.recordDelayMs ?? RECORD_DELAY_MS);
    session.recordTimer.unref?.();
  }
  private async saveRecord(session: Session): Promise<void> {
    const path = this.recordPath(session.sessionId);
    if (!path || !session.restorable || session.removed || session.exit) return;
    const screen = await session.mirror.snapshot();
    let cwd = session.cwd;
    try { cwd = this.scope.path(await (this.options.workingDirectory ?? (pid => readlink(`/proc/${pid}/cwd`)))(session.native.pid), true); }
    catch { /* Outside the checkout or unreadable: keep where it started. */ }
    if (session.exit && !this.disposed) return;
    const body = JSON.stringify({ version: 1, sessionId: session.sessionId, cwd, cols: session.cols, rows: session.rows,
      screen: screen.data, savedAt: Date.now() } satisfies TerminalRecord);
    if (Buffer.byteLength(body) > RECORD_MAX_BYTES) return;
    await mkdir(this.options.records!, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, body, { mode: 0o600, flag: "wx" }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  }
  private async forgetRecord(session: Session): Promise<void> {
    const path = this.recordPath(session.sessionId);
    if (path) await rm(path, { force: true });
  }
  private async readRecord(sessionId: string): Promise<TerminalRecord | undefined> {
    const path = this.recordPath(sessionId);
    if (!path) return undefined;
    try {
      const raw = await readFile(path, "utf8");
      const value: unknown = Buffer.byteLength(raw) > RECORD_MAX_BYTES ? undefined : JSON.parse(raw);
      if (isRecord(value) && value.sessionId === sessionId && Date.now() - value.savedAt < RECORD_MAX_AGE_MS) return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    }
    // Unreadable, foreign or stale: the new shell's own record replaces it.
    await rm(path, { force: true }).catch(() => {});
    return undefined;
  }
  /** Records outlive the shells that wrote them only until a client restores
   * them; bound what closed tabs leave behind while the VM slept. */
  private async pruneRecords(directory: string): Promise<void> {
    try {
      const kept: Array<{ path: string; at: number }> = [];
      for (const name of await readdir(directory)) {
        const path = join(directory, name), { mtimeMs } = await stat(path);
        if (/^[0-9a-f]{64}\.json$/.test(name) && Date.now() - mtimeMs < RECORD_MAX_AGE_MS) kept.push({ path, at: mtimeMs });
        else if (!name.endsWith(".tmp") || Date.now() - mtimeMs > 60_000) await rm(path, { force: true });
      }
      for (const old of kept.sort((a, b) => b.at - a.at).slice(RECORD_LIMIT)) await rm(old.path, { force: true });
    } catch { /* No records yet. */ }
  }
  private async closeDescriptor(session: Session): Promise<void> { const descriptor = session.descriptor; session.descriptor = undefined; await descriptor?.close(); }
  private busyCount(): number { return this.pending.size + [...this.sessions.values()].filter(session => !session.exit).length; }
  private changed(): void { void Promise.resolve(this.options.broadcast?.(createMessage({ type: "PTY_TERMINALS_CHANGED", source: "engine" }))).catch(() => {}); }
}
