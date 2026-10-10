import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn, type IPty } from "node-pty";
import { TerminalMirror } from "./mirror";
import { closeResidentPty } from "./resident-processes";
import {HostExecutionBoundary} from "../agents/containment/host-boundary";
import {CloudOwnedWorkloadRegistry, type CloudWorkloadFence} from "../agents/containment/cloud-owned-workloads";
import {cloudWorkloadCustodyConfiguration, type CloudWorkloadCustody} from "../agents/containment/cloud-workload-custody";
import type {PreparedBoundary} from "../agents/containment/types";
import { CloudCustomizationRedactor } from "../agents/cloud-customization-redaction";
import {
  RESIDENT_FRAME_BYTES, RESIDENT_MAX_SESSIONS, ResidentEngineAuthoritySchema,
  ResidentPtyError, ResidentPtyRequestSchema, ResidentPtySnapshotSchema, ResidentWorkloadClassificationSchema,
  ResidentWorkloadFenceStatusSchema,
  type ResidentEngineAuthority, type ResidentPtyCreate, type ResidentPtyFrame,
  type ResidentPtyInput, type ResidentPtyRequest, type ResidentPtySession,
  type ResidentWorkloadFenceRequest, type ResidentWorkloadFenceStatus,
} from "./resident-protocol";

type Session = {
  info: ResidentPtySession; proc: IPty; mirror: TerminalMirror;
  redactor: CloudCustomizationRedactor; sequence: number; tail: Promise<unknown>;
  queuedBytes: number; paused: boolean; closed: boolean;
  exited: Promise<void>; exit: { exitCode: number; signal: number | null } | null;
  boundary:PreparedBoundary;
  inputs: Map<string, { sequence: number; digest: string }>;
};
type Connection = { socket: net.Socket; authority: ResidentEngineAuthority | null; requests: number };
type FenceOperation = "fence-workloads" | "join-workloads" | "drain-workloads" | "resume-workloads";
type WorkloadFence = { authority: ResidentEngineAuthority; request: ResidentWorkloadFenceRequest; ticket: CloudWorkloadFence;
  phase: ResidentWorkloadFenceStatus["phase"]; receipts: Partial<Record<FenceOperation, ResidentWorkloadFenceStatus>>;
  flight?: { op: FenceOperation; result: Promise<ResidentWorkloadFenceStatus> } };

/** Resident owner: engine sockets are replaceable attachments. Only the
 * supervisor, through this object's private control channel, changes authority
 * or stops the host. Never expose authorize/stop on the engine socket. */
export class ResidentPtyHost {
  private server: net.Server | null = null;
  private active: ResidentEngineAuthority | null = null;
  private engine: Connection | null = null;
  private fence = 0;
  private lastEngineId: string | null = null;
  private lastAuthority: ResidentEngineAuthority | null = null;
  private stopping = false;
  private stopFlight: Promise<void> | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly connections = new Set<Connection>();
  private pendingCreates = 0;
  private readonly pendingCreateFlights = new Set<Promise<ResidentPtySession>>();
  // Released receipts are bounded tombstones: delayed retries never rearm an
  // old ticket or transfer a proof to another attachment.
  private readonly workloadFences = new Map<string, WorkloadFence>();
  private readonly workloads:CloudOwnedWorkloadRegistry;
  private readonly executionBoundary:HostExecutionBoundary;

  constructor(private readonly options: {
    socketPath: string; root: string; additionalRoots?: readonly string[]; organizationId: string; workspaceId: string;
    projectRoot?:string;supervisorRuntime?:string;supervisorScript?:string;
    custody?:CloudWorkloadCustody;
    shell: string; identity: { uid: number; gid: number };
  }) {
    if (process.platform !== "linux" || !path.isAbsolute(options.shell) ||
      ![options.identity.uid, options.identity.gid].every(n => Number.isSafeInteger(n) && n >= 0) ||
      options.identity.uid !== process.geteuid?.() || options.identity.gid !== process.getegid?.())
      throw new ResidentPtyError("request_rejected");
    const configuration=options.custody ? cloudWorkloadCustodyConfiguration(options.custody) : null;
    if(options.custody?.controller.kind!==undefined&&options.custody.controller.kind!=="resident")
      throw new ResidentPtyError("request_rejected");
    this.workloads=new CloudOwnedWorkloadRegistry(options.custody ? {custody:options.custody} : {});
    this.executionBoundary=new HostExecutionBoundary({projectRoot:options.projectRoot ?? process.cwd(),
      supervisorRuntime:configuration?.toolchain.node ?? options.supervisorRuntime,
      supervisorScript:configuration?.toolchain.supervisor ?? options.supervisorScript,
      ...(options.custody ? {cloudWorkloadCustody:options.custody} : {})});
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
    const retained = [...this.workloadFences.values()].filter(fence => fence.phase !== "released");
    if (retained.some(fence => fence.authority !== this.lastAuthority || fence.request.mode !== "preserve" ||
      fence.phase !== "joined" || fence.flight)) throw new ResidentPtyError("authority_rejected");
    // Only the private root channel can advance authority. A host-committed
    // joined preserve proof survives a lost engine response or socket revoke.
    for (const fence of retained) {
      this.workloads.resume(fence.ticket);
      fence.phase = "released";
      fence.receipts["resume-workloads"] = this.fenceStatus(fence, "released");
    }
    this.fence = parsed.data.fence;
    this.active = parsed.data;
    this.lastAuthority = this.active;
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
  private requireWorkloadAdmission(): void {
    if (this.stopping || [...this.workloadFences.values()].some(fence => fence.phase !== "released"))
      throw new ResidentPtyError("host_unavailable");
  }
  private fenceStatus(fence: WorkloadFence, phase: ResidentWorkloadFenceStatus["phase"]): ResidentWorkloadFenceStatus {
    const owner = fence.authority;
    const authority = Object.freeze({ organizationId: owner.organizationId, workspaceId: owner.workspaceId,
      engineId: owner.engineId, generation: owner.generation, fence: owner.fence });
    return Object.freeze(ResidentWorkloadFenceStatusSchema.parse({ ...fence.request, authority,
      scope: "owner-process-groups", phase }));
  }
  private async applyWorkloadFence(connection: Connection, op: FenceOperation,
    request: ResidentWorkloadFenceRequest): Promise<ResidentWorkloadFenceStatus> {
    if (!this.workloads.custody || !connection.authority) throw new ResidentPtyError("request_rejected");
    let fence = this.workloadFences.get(request.requestId);
    if (fence && (fence.authority !== connection.authority || fence.request.mode !== request.mode))
      throw new ResidentPtyError("request_rejected");
    if (op === "fence-workloads") {
      if (!fence) {
        if (this.workloadFences.size >= 256) throw new ResidentPtyError("host_unavailable");
        fence = { authority: connection.authority, request: Object.freeze({ ...request }),
          ticket: this.workloads.fence({ preserveActive: request.mode === "preserve" }), phase: "fenced", receipts: {} };
        this.workloadFences.set(request.requestId, fence);
        fence.receipts[op] = this.fenceStatus(fence, "fenced");
      }
      return fence.receipts[op]!;
    }
    if (!fence || (op === "join-workloads" && request.mode !== "preserve") ||
      (op === "drain-workloads" && request.mode !== "drain")) throw new ResidentPtyError("request_rejected");
    if (fence.receipts[op]) return fence.receipts[op]!;
    if (fence.flight) {
      if (fence.flight.op !== op) throw new ResidentPtyError("request_rejected");
      return fence.flight.result;
    }
    if (fence.phase === "released" || (op === "resume-workloads" && fence.phase !== "joined" && fence.phase !== "drained"))
      throw new ResidentPtyError("request_rejected");
    const original = fence;
    const result = (async () => {
      if (op === "join-workloads" || op === "drain-workloads") {
        await Promise.allSettled([...this.pendingCreateFlights]);
        if (this.pendingCreates) throw new ResidentPtyError("host_unavailable");
        if (op === "join-workloads") await this.workloads.joinPending(original.ticket);
        else await this.workloads.drainOwned(original.ticket);
        original.phase = op === "join-workloads" ? "joined" : "drained";
      } else {
        if (original.request.mode === "preserve") this.workloads.resume(original.ticket);
        else this.workloads.resumeOwned(original.ticket);
        original.phase = "released";
      }
      // Commit before dispatch's final connection check or response delivery.
      return original.receipts[op] = this.fenceStatus(original, original.phase);
    })();
    original.flight = { op, result };
    try { return await result; } finally { original.flight = undefined; }
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
    if (request.op === "fence-workloads" || request.op === "join-workloads" ||
      request.op === "drain-workloads" || request.op === "resume-workloads")
      return this.applyWorkloadFence(connection, request.op, request.fence);
    if (request.op === "classify-workloads") {
      if(!this.workloads.custody)throw new ResidentPtyError("request_rejected");
      const authority=connection.authority!;
      const result=this.workloads.classifyWorkloads(request.census,{organizationId:authority.organizationId,
        workspaceId:authority.workspaceId,engineId:authority.engineId,generation:authority.generation,fence:authority.fence});
      return ResidentWorkloadClassificationSchema.parse({...result,
        complete:result.complete&&this.pendingCreates===0,pendingLaunches:result.pendingLaunches+this.pendingCreates,
        quietTerminals:this.pendingCreates ? [] : result.quietTerminals});
    }
    if(request.op==="inspect-workloads"){
      const view=await this.workloads.inspect();
      return {version:1,complete:view.complete&&this.pendingCreates===0,
        busy:this.pendingCreates>0||view.pendingLaunches>0||view.failedRetirements>0||view.workloadPids.length>0};
    }
    if (request.op === "list") return [...this.sessions.values()].map(session => ({ ...session.info }));
    if (request.op === "create") {
      this.requireWorkloadAdmission();
      this.pendingCreates++;
      const flight = this.create(connection, request.launch);
      this.pendingCreateFlights.add(flight);
      try { return await flight; }
      finally { this.pendingCreates--; this.pendingCreateFlights.delete(flight); }
    }
    const session = this.sessions.get(request.sessionId);
    if (!session) throw new ResidentPtyError("session_not_found");
    return this.serialize(session, async () => {
      this.requireAuthority(connection);
      if (session.closed) throw new ResidentPtyError("session_not_found");
      if (request.op === "cursor") return session.inputs.get(request.producerId)?.sequence ?? 0;
      if (request.op === "snapshot") {
        const snapshot = await session.mirror.snapshot();
        this.requireAuthority(connection);
        const parsed = ResidentPtySnapshotSchema.safeParse({ ...snapshot, sequence: session.sequence,
          ...(request.includeExit && session.info.exited && session.exit ? { exit: session.exit } : {}) });
        if (!parsed.success) throw new ResidentPtyError("snapshot_unavailable");
        return parsed.data;
      }
      if (request.op === "close") {
        if (!session.info.exited) {
          closeResidentPty(session.proc);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([session.exited, new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new ResidentPtyError("host_unavailable")), 2500);
            })]);
          } finally { clearTimeout(timer); }
        }
        await session.boundary.stopAndProve();
        await this.publishExit(session);
        session.closed = true; this.sessions.delete(request.sessionId);
        session.mirror.dispose();
        return true;
      }
      if (session.info.exited) throw new ResidentPtyError("session_exited");
      this.requireWorkloadAdmission();
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
    let allowed = false;
    for (const root of [this.options.root, ...this.options.additionalRoots ?? []]) {
      try { if (await realpath(root) !== root) continue; } catch { continue; }
      const relative = path.relative(root, cwd);
      if (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)) { allowed = true; break; }
    }
    if (!allowed) throw new ResidentPtyError("cwd_rejected");
    this.requireAuthority(connection); // Enrollment may change during realpath.
    this.requireWorkloadAdmission();
    const existing = (previous: Session): ResidentPtySession => {
      if (previous.info.actorUserId !== (launch.actorUserId ?? null) || previous.info.cwd !== cwd ||
        previous.info.registryWorkspaceId !== (launch.registryWorkspaceId ?? null) ||
        previous.info.environmentOwnerId !== (launch.environmentOwnerId ?? null) ||
        previous.info.brokerId !== (launch.brokerId ?? null))
        throw new ResidentPtyError("authority_rejected");
      return { ...previous.info };
    };
    const previous = this.sessions.get(launch.sessionId);
    if (previous) return existing(previous);
    if (this.sessions.size >= RESIDENT_MAX_SESSIONS) throw new ResidentPtyError("session_limit");
    // Human terminals retain cloud login-shell behavior; the explicit command
    // mode is used by the resident acceptance workload.
    const args = launch.command === undefined ? ["-l"] : ["--noprofile", "--norc", "-c", launch.command];
    const identity = this.options.identity;
    if (process.geteuid!() !== identity.uid || process.getegid!() !== identity.gid)
      throw new ResidentPtyError("spawn_failed");
    const owner: {session?: Session} = {};
    const control={kind:'terminal' as const,role:'workload' as const,
      terminalIdle:()=>Boolean(owner.session&&!owner.session.closed&&!owner.session.info.exited&&
        (!owner.session.info.lastInputAtMs||Date.now()-owner.session.info.lastInputAtMs>=10*60_000))};
    const boundary=await this.workloads.prepare(this.executionBoundary,{executionId:`resident-${randomUUID()}`,
      actor:'repo-code-task',providerId:'human-terminal',cwd,workspaceRoot:this.options.root},undefined,control);
    let proc: IPty;
    const mirror = new TerminalMirror(launch.cols, launch.rows);
    try {
      this.requireAuthority(connection);
      this.requireWorkloadAdmission();
      const published = this.sessions.get(launch.sessionId);
      if (published) {
        await boundary.stopAndProve();
        this.requireAuthority(connection);
        if (this.sessions.get(launch.sessionId) !== published || published.closed)
          throw new ResidentPtyError("session_not_found");
        mirror.dispose();
        return existing(published);
      }
      if (this.sessions.size >= RESIDENT_MAX_SESSIONS) throw new ResidentPtyError("session_limit");
      const original=boundary.wrapSpawn({command:this.options.shell,args,cwd,env:launch.env,stdio:'inherit'});
      try{proc=spawn(original.command,[...original.args],{cwd:original.cwd,env:{...original.env},
        cols:launch.cols,rows:launch.rows,name:'xterm-256color'});}
      catch(error){boundary.cancelUnstartedLaunch?.(original);throw error;}
      boundary.trackProcessGroup(proc.pid);
    } catch(error) {mirror.dispose();await boundary.stopAndProve();throw error;}
    let markExited!: () => void;
    const exited = new Promise<void>(resolve => { markExited = resolve; });
    const session: Session = {
      info: { sessionId: launch.sessionId, pid: proc.pid, cwd, cols: launch.cols, rows: launch.rows,
        createdAt: Date.now(), actorUserId: launch.actorUserId ?? null, exited: false,
        registryWorkspaceId: launch.registryWorkspaceId ?? null, environmentOwnerId: launch.environmentOwnerId ?? null,
        brokerId: launch.brokerId ?? null, githubShared: false, lastInputAtMs: 0 },
      proc, mirror, exited, exit: null,boundary,
      redactor: new CloudCustomizationRedactor(launch.redactValues ?? []),
      sequence: 0, tail: Promise.resolve(), inputs: new Map(), queuedBytes: 0, paused: false, closed: false,
    };
    owner.session=session;
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
      }).catch(() => this.stopAfterEventFailure());
    });
    proc.onExit(({ exitCode, signal }) => {
      // Close is itself serialized ahead of this mirror update. Resolve the
      // native exit witness before queueing so close cannot wait on itself.
      session.exit = { exitCode, signal: signal ?? null }; markExited();
      void this.serialize(session, async () => {
        if (session.closed) return;
        await session.boundary.stopAndProve();
        await this.publishExit(session);
      }).catch(() => this.stopAfterEventFailure());
    });
    return { ...session.info };
  }

  private serialize<T>(session: Session, work: () => Promise<T> | T): Promise<T> {
    const next = session.tail.then(work);
    session.tail = next.catch(() => undefined);
    return next;
  }

  private async publishExit(session: Session): Promise<void> {
    if (session.info.exited || !session.exit) return;
    await this.publish(session, session.redactor.finish("pty"));
    session.info.exited = true;
    if (this.engine) this.send(this.engine, { kind: "exit", sessionId: session.info.sessionId, ...session.exit });
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
    this.requireWorkloadAdmission();
    if (session.info.environmentOwnerId && session.info.environmentOwnerId !== input.actorUserId)
      throw new ResidentPtyError("authority_rejected");
    const digest = createHash("sha256").update(input.data).digest("hex");
    const previous = session.inputs.get(input.producerId);
    if (previous && input.sequence === previous.sequence) {
      if (digest !== previous.digest) throw new ResidentPtyError("input_conflict");
      return "duplicate";
    }
    if (input.sequence !== (previous?.sequence ?? 0) + 1) throw new ResidentPtyError("input_sequence");
    if (!previous && session.inputs.size >= 16) throw new ResidentPtyError("input_limit");
    if (session.info.actorUserId && session.info.actorUserId !== input.actorUserId) session.info.githubShared = true;
    session.proc.write(input.data);
    session.info.lastInputAtMs = Date.now();
    session.inputs.set(input.producerId, { sequence: input.sequence, digest });
    return "applied";
  }

  stop(): Promise<void> {
    return this.stopFlight ??= this.stopAll();
  }

  private stopAfterEventFailure(): void {
    // The host remains fenced and keeps its failed stop receipt for explicit
    // callers. An event callback has no caller to receive this rejection.
    void this.stop().catch(() => undefined);
  }

  private async stopAll(): Promise<void> {
    const ticket=this.workloads.fence();
    this.stopping = true; this.active = null; this.engine = null;
    for (const connection of this.connections) connection.socket.destroy();
    const server = this.server; this.server = null;
    const closed = server ? new Promise<void>(resolve => server.close(() => resolve())) : Promise.resolve();
    await Promise.allSettled([...this.pendingCreateFlights]);
    if (this.workloads.custody) await this.workloads.drainOwned(ticket);
    else await this.workloads.drain(ticket);
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
