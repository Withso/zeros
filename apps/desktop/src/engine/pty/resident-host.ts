import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn, type IPty } from "node-pty";
import { TerminalMirror } from "./mirror";
import { closeResidentPty } from "./resident-processes";
import { CloudCustomizationRedactor } from "../agents/cloud-customization-redaction";
import {
  RESIDENT_FRAME_BYTES, RESIDENT_MAX_SESSIONS, ResidentEngineAuthoritySchema,
  ResidentPtyError, ResidentPtyRequestSchema, ResidentPtySnapshotSchema,
  type ResidentEngineAuthority, type ResidentPtyCreate, type ResidentPtyFrame,
  type ResidentPtyInput, type ResidentPtyRequest, type ResidentPtySession,
} from "./resident-protocol";

type Session = {
  info: ResidentPtySession; proc: IPty; mirror: TerminalMirror;
  redactor: CloudCustomizationRedactor; sequence: number; tail: Promise<unknown>;
  queuedBytes: number; paused: boolean; closed: boolean;
  inputs: Map<string, { sequence: number; digest: string }>;
};
type Connection = { socket: net.Socket; authority: ResidentEngineAuthority | null; requests: number };

/** Resident owner: engine sockets are replaceable attachments. Only the
 * supervisor, through this object's private control channel, changes authority
 * or stops the host. Never expose authorize/stop on the engine socket. */
export class ResidentPtyHost {
  private server: net.Server | null = null;
  private active: ResidentEngineAuthority | null = null;
  private engine: Connection | null = null;
  private fence = 0;
  private lastEngineId: string | null = null;
  private stopping = false;
  private stopFlight: Promise<void> | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly connections = new Set<Connection>();

  constructor(private readonly options: {
    socketPath: string; root: string; organizationId: string; workspaceId: string;
    shell: string; identity: { uid: number; gid: number };
  }) {
    if (process.platform !== "linux" || !path.isAbsolute(options.shell) ||
      ![options.identity.uid, options.identity.gid].every(n => Number.isSafeInteger(n) && n > 0))
      throw new ResidentPtyError("request_rejected");
  }

  async start(): Promise<void> {
    if (this.server || this.stopping) throw new ResidentPtyError("host_unavailable");
    const directory = path.dirname(this.options.socketPath);
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid!() ||
      (metadata.mode & 0o077) || await realpath(directory) !== directory ||
      await realpath(this.options.root) !== this.options.root)
      throw new ResidentPtyError("request_rejected");
    // listen fails if another host owns this path; never unlink a live peer.
    const server = net.createServer(socket => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", () => reject(new ResidentPtyError("host_unavailable")));
      server.listen(this.options.socketPath, () => resolve());
    });
    this.server = server;
    await chmod(this.options.socketPath, 0o600);
  }

  authorize(value: ResidentEngineAuthority): void {
    const parsed = ResidentEngineAuthoritySchema.safeParse(value);
    if (this.stopping || !parsed.success || parsed.data.organizationId !== this.options.organizationId ||
      parsed.data.workspaceId !== this.options.workspaceId || parsed.data.fence <= this.fence ||
      parsed.data.engineId === this.lastEngineId)
      throw new ResidentPtyError("authority_rejected");
    this.fence = parsed.data.fence;
    this.active = parsed.data;
    this.lastEngineId = parsed.data.engineId;
    this.engine?.socket.destroy(); this.engine = null;
  }

  /** Close admission without stopping user jobs. A subsequent enrollment must
   * have a strictly higher fence, including rollback into an older generation. */
  revoke(fence: number): void {
    if (!Number.isSafeInteger(fence) || fence <= this.fence) throw new ResidentPtyError("authority_rejected");
    this.fence = fence; this.active = null;
    this.engine?.socket.destroy(); this.engine = null;
  }

  private requireAuthority(connection: Connection): void {
    if (this.stopping || !this.active || connection !== this.engine || connection.authority !== this.active ||
      connection.socket.destroyed) throw new ResidentPtyError("authority_rejected");
  }

  private send(connection: Connection, frame: ResidentPtyFrame): void {
    const line = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(line) > RESIDENT_FRAME_BYTES || connection.socket.writableLength > RESIDENT_FRAME_BYTES) {
      connection.socket.destroy(); return;
    }
    if (!connection.socket.destroyed) connection.socket.write(line);
  }

  private accept(socket: net.Socket): void {
    if (this.stopping || this.connections.size >= 4) { socket.destroy(); return; }
    const connection: Connection = { socket, authority: null, requests: 0 };
    this.connections.add(connection);
    socket.setEncoding("utf8"); socket.setTimeout(5_000);
    let buffer = "";
    socket.on("error", () => socket.destroy());
    socket.on("timeout", () => socket.destroy());
    socket.on("close", () => {
      this.connections.delete(connection);
      if (this.engine === connection) this.engine = null;
      // No PTY shutdown here: a socket is not the workload lifetime owner.
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > RESIDENT_FRAME_BYTES) { socket.destroy(); return; }
      for (let end; (end = buffer.indexOf("\n")) !== -1;) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (++connection.requests > 32) { socket.destroy(); return; }
        void this.dispatch(connection, line).finally(() => { connection.requests--; });
      }
    });
  }

  private async dispatch(connection: Connection, line: string): Promise<void> {
    let id: number | undefined;
    try {
      const raw = JSON.parse(line) as { id?: unknown };
      if (Number.isSafeInteger(raw?.id) && Number(raw.id) > 0) id = Number(raw.id);
      const parsed = ResidentPtyRequestSchema.safeParse(raw);
      if (!parsed.success) throw new ResidentPtyError("request_rejected");
      const request = parsed.data;
      id = request.id;
      if (request.op === "attach") {
        const active = this.active, supplied = request.authority;
        if (!active || connection.authority || this.stopping ||
          ["organizationId", "workspaceId", "engineId", "generation", "fence"].some(key =>
            active[key as keyof ResidentEngineAuthority] !== supplied[key as keyof ResidentEngineAuthority]) ||
          !timingSafeEqual(Buffer.from(active.token), Buffer.from(supplied.token)))
          throw new ResidentPtyError("authority_rejected");
        this.engine?.socket.destroy(); this.engine = connection; connection.authority = active;
        connection.socket.setTimeout(0);
        this.send(connection, { kind: "reply", id, result: true });
        return;
      }
      this.requireAuthority(connection);
      const result = await this.apply(connection, request);
      this.requireAuthority(connection);
      this.send(connection, { kind: "reply", id, result });
    } catch (error) {
      if (id !== undefined) this.send(connection, { kind: "error", id,
        code: error instanceof ResidentPtyError ? error.code : "request_rejected" });
      else connection.socket.destroy();
    }
  }

  private async apply(connection: Connection, request: Exclude<ResidentPtyRequest, { op: "attach" }>): Promise<unknown> {
    if (request.op === "list") return [...this.sessions.values()].map(session => ({ ...session.info }));
    if (request.op === "create") return this.create(connection, request.launch);
    const session = this.sessions.get(request.sessionId);
    if (!session) throw new ResidentPtyError("session_not_found");
    return this.serialize(session, async () => {
      this.requireAuthority(connection);
      if (session.closed) throw new ResidentPtyError("session_not_found");
      if (request.op === "snapshot") {
        const snapshot = await session.mirror.snapshot();
        this.requireAuthority(connection);
        const parsed = ResidentPtySnapshotSchema.safeParse({ ...snapshot, sequence: session.sequence });
        if (!parsed.success) throw new ResidentPtyError("snapshot_unavailable");
        return parsed.data;
      }
      if (request.op === "close") {
        session.closed = true; this.sessions.delete(request.sessionId);
        if (!session.info.exited) closeResidentPty(session.proc);
        session.mirror.dispose();
        return true;
      }
      if (session.info.exited) throw new ResidentPtyError("session_exited");
      if (request.op === "write") return this.write(session, request.input);
      session.proc.resize(request.cols, request.rows);
      session.mirror.resize(request.cols, request.rows);
      session.info.cols = request.cols; session.info.rows = request.rows;
      return true;
    });
  }

  private async create(connection: Connection, launch: ResidentPtyCreate): Promise<ResidentPtySession> {
    let cwd: string;
    try { cwd = await realpath(launch.cwd); }
    catch { throw new ResidentPtyError("cwd_rejected"); }
    const relative = path.relative(this.options.root, cwd);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
      throw new ResidentPtyError("cwd_rejected");
    this.requireAuthority(connection); // Enrollment may change during realpath.
    const previous = this.sessions.get(launch.sessionId);
    if (previous) {
      if (previous.info.actorUserId !== (launch.actorUserId ?? null) || previous.info.cwd !== cwd)
        throw new ResidentPtyError("authority_rejected");
      return { ...previous.info };
    }
    if (this.sessions.size >= RESIDENT_MAX_SESSIONS) throw new ResidentPtyError("session_limit");
    // Human terminals retain the existing cloud login-shell behavior. The
    // explicit command mode is for the contained acceptance workload only.
    const args = launch.command === undefined ? ["-l"] : ["--noprofile", "--norc", "-c", launch.command];
    const identity = this.options.identity;
    // node-pty drops uid/gid in its native fork before exec applies the user
    // environment. A dynamically linked privilege-drop helper would load
    // LD_PRELOAD before dropping authority. The qualified namespace launcher
    // must already have cleared supplementary groups, since node-pty does not.
    const alreadyHuman = process.getuid!() === identity.uid && process.getgid!() === identity.gid;
    if (!alreadyHuman && (process.getuid!() !== 0 || process.getgroups!().length !== 0))
      throw new ResidentPtyError("spawn_failed");
    let proc: IPty;
    const mirror = new TerminalMirror(launch.cols, launch.rows);
    try {
      proc = spawn(this.options.shell, args, { cwd, env: { ...launch.env },
        uid: identity.uid, gid: identity.gid, cols: launch.cols, rows: launch.rows, name: "xterm-256color" });
    } catch { mirror.dispose(); throw new ResidentPtyError("spawn_failed"); }
    const session: Session = {
      info: { sessionId: launch.sessionId, pid: proc.pid, cwd, cols: launch.cols, rows: launch.rows,
        createdAt: Date.now(), actorUserId: launch.actorUserId ?? null, exited: false },
      proc, mirror,
      redactor: new CloudCustomizationRedactor(launch.redactValues ?? []),
      sequence: 0, tail: Promise.resolve(), inputs: new Map(), queuedBytes: 0, paused: false, closed: false,
    };
    this.sessions.set(launch.sessionId, session);
    proc.onData(data => {
      const bytes = Buffer.byteLength(data);
      session.queuedBytes += bytes;
      if (!session.paused) { proc.pause(); session.paused = true; }
      void this.serialize(session, async () => {
        if (!session.closed) await this.publish(session, session.redactor.stream("pty", data));
      }).finally(() => {
        session.queuedBytes -= bytes;
        if (!session.queuedBytes && !session.closed && !session.info.exited) { session.paused = false; proc.resume(); }
      }).catch(() => this.stop());
    });
    proc.onExit(({ exitCode, signal }) => {
      void this.serialize(session, async () => {
        if (session.closed) return;
        await this.publish(session, session.redactor.finish("pty"));
        session.info.exited = true;
        if (this.engine) this.send(this.engine, { kind: "exit", sessionId: launch.sessionId, exitCode, signal: signal ?? null });
      }).catch(() => this.stop());
    });
    return { ...session.info };
  }

  private serialize<T>(session: Session, work: () => Promise<T> | T): Promise<T> {
    const next = session.tail.then(work);
    session.tail = next.catch(() => undefined);
    return next;
  }

  private async publish(session: Session, data: string): Promise<void> {
    if (!data) return;
    // Redaction can expand a short literal; bound each wire frame and avoid
    // splitting a surrogate pair while retaining the exact terminal stream.
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(offset + 64 * 1024, data.length);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
      const chunk = data.slice(offset, end); offset = end;
      session.mirror.write(chunk);
    // Serialize mirror parsing with snapshot watermarks. Output arriving while
    // a snapshot drains stays queued and is published strictly after its cursor.
      await session.mirror.flush();
      session.sequence++;
      if (this.engine) this.send(this.engine, { kind: "data", sessionId: session.info.sessionId, sequence: session.sequence, data: chunk });
    }
  }

  private write(session: Session, input: ResidentPtyInput): "applied" | "duplicate" {
    const digest = createHash("sha256").update(input.data).digest("hex");
    const previous = session.inputs.get(input.producerId);
    if (previous && input.sequence === previous.sequence) {
      if (digest !== previous.digest) throw new ResidentPtyError("input_conflict");
      return "duplicate";
    }
    if (input.sequence !== (previous?.sequence ?? 0) + 1) throw new ResidentPtyError("input_sequence");
    if (!previous && session.inputs.size >= 16) throw new ResidentPtyError("input_limit");
    session.proc.write(input.data);
    session.inputs.set(input.producerId, { sequence: input.sequence, digest });
    return "applied";
  }

  stop(): Promise<void> {
    return this.stopFlight ??= this.stopAll();
  }

  private async stopAll(): Promise<void> {
    this.stopping = true; this.active = null; this.engine = null;
    for (const connection of this.connections) connection.socket.destroy();
    const server = this.server; this.server = null;
    const closed = server ? new Promise<void>(resolve => server.close(() => resolve())) : Promise.resolve();
    for (const session of this.sessions.values()) {
      session.closed = true;
      if (!session.info.exited) closeResidentPty(session.proc);
      await session.tail;
      session.mirror.dispose();
    }
    this.sessions.clear();
    await closed;
    if (server) await unlink(this.options.socketPath).catch(() => undefined);
  }
}
