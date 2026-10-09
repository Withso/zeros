import net from "node:net";
import { lstatSync, realpathSync } from "node:fs";
import { z } from "zod";
import {
  RESIDENT_FRAME_BYTES, RESIDENT_MAX_SESSIONS, RESIDENT_PTY_PROTOCOL,
  ResidentWorkloadInspectionSchema, ResidentWorkloadCensusRequestSchema, ResidentWorkloadClassificationSchema,
  ResidentWorkloadFenceRequestSchema, ResidentWorkloadFenceStatusSchema,
  RESIDENT_LEGACY_CONTROL_BYTES, ResidentEngineAuthoritySchema, ResidentLegacyRetirementRequestSchema, ResidentLegacyRetirementReceiptSchema,
  residentLegacyRetirementReceiptMatchesRequest,
  residentWorkloadClassificationMatchesRequest, ResidentPtyError, ResidentPtyFrameSchema, ResidentPtySessionSchema, ResidentPtySnapshotSchema,
  type ResidentEngineAuthority, type ResidentPtyCreate, type ResidentPtyFrame,
  type ResidentPtyInput, type ResidentPtyRequest, type ResidentWorkloadCensusRequest, type ResidentWorkloadClassification,
  type ResidentWorkloadFenceRequest, type ResidentWorkloadFenceStatus,
  type ResidentLegacyRuntime, type ResidentLegacyRetirementReceipt,
} from "./resident-protocol";

type Request = ResidentPtyRequest extends infer R ? R extends { id: number } ? Omit<R, "id"> : never : never;
const LEGACY_CONTROL_SOCKET = "/run/zeros/resident-control.sock";

function legacyControlEndpointIdentity() {
  const directory = "/run/zeros", parent = lstatSync(directory, { bigint: true });
  const socket = lstatSync(LEGACY_CONTROL_SOCKET, { bigint: true });
  // VM root is unmapped in the exact 10003-only user namespace. The root
  // listener's GID remains mapped; the projected parent is engine-owned.
  if (!parent.isDirectory() || parent.uid !== 10003n || parent.gid !== 10003n ||
      (parent.mode & 0o7777n) !== 0o700n || realpathSync(directory) !== directory ||
      !socket.isSocket() || ![0n, 65534n].includes(socket.uid) || socket.gid !== 10003n ||
      (socket.mode & 0o7777n) !== 0o620n || socket.nlink !== 1n || socket.ino <= 0n)
    throw new ResidentPtyError("host_unavailable");
  return { dev: socket.dev, ino: socket.ino, ctimeNs: socket.ctimeNs, uid: socket.uid,
    parentDev: parent.dev, parentIno: parent.ino };
}

/** Cloud engine adapter. Disconnect retires this route, never the resident
 * sessions. Callers reconnect with fresh supervisor-issued authority. */
export class ResidentPtyClient {
  private socket: net.Socket | null = null;
  private nextId = 1;
  private ready = false;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void; reject(error: ResidentPtyError): void; timer: ReturnType<typeof setTimeout>;
  }>();
  private onEvent: ((event: Exclude<ResidentPtyFrame, { kind: "reply" | "error" }>) => void) | null = null;

  constructor(private readonly options: { socketPath: string; authority: ResidentEngineAuthority }) {}

  events(listener: typeof this.onEvent): void { this.onEvent = listener; }
  isConnected(): boolean { return this.ready && this.socket !== null && !this.socket.destroyed; }

  async connect(): Promise<void> {
    if (this.socket) throw new ResidentPtyError("host_unavailable");
    const socket = net.createConnection(this.options.socketPath);
    this.socket = socket;
    socket.setEncoding("utf8");
    let buffer = "";
    const unavailable = () => { if (this.socket === socket) this.disconnect(); };
    socket.on("error", unavailable);
    socket.on("close", unavailable);
    socket.on("data", (chunk: string) => {
      if (this.socket !== socket) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > RESIDENT_FRAME_BYTES) { unavailable(); return; }
      for (let end; (end = buffer.indexOf("\n")) !== -1;) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const frame = ResidentPtyFrameSchema.parse(JSON.parse(line));
          if (frame.kind === "reply" || frame.kind === "error") {
            const request = this.pending.get(frame.id);
            if (!request) continue;
            this.pending.delete(frame.id); clearTimeout(request.timer);
            if (frame.kind === "error") request.reject(new ResidentPtyError(frame.code));
            else request.resolve(frame.result);
          } else if (this.ready) this.onEvent?.(frame);
        } catch { unavailable(); return; }
      }
    });
    try {
      const result = await this.request({ op: "attach", protocol: RESIDENT_PTY_PROTOCOL, authority: this.options.authority }, true);
      if (result !== true || this.socket !== socket) throw new ResidentPtyError("authority_rejected");
      this.ready = true;
    } catch (error) { unavailable(); throw error; }
  }

  private request(request: Request, attaching = false): Promise<unknown> {
    const socket = this.socket;
    if (!socket || (!attaching && !this.ready) || socket.destroyed || this.pending.size >= 32)
      return Promise.reject(new ResidentPtyError("host_unavailable"));
    const id = this.nextId++;
    const line = JSON.stringify({ ...request, id }) + "\n";
    if (Buffer.byteLength(line) > RESIDENT_FRAME_BYTES) return Promise.reject(new ResidentPtyError("request_rejected"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new ResidentPtyError("host_unavailable"));
        this.disconnect();
      }, 5_000);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(line, error => { if (error && this.socket === socket) this.disconnect(); });
    });
  }

  async inspectWorkloads(){return ResidentWorkloadInspectionSchema.parse(await this.request({op:"inspect-workloads"}));}
  private async workloadFence(op: "fence-workloads" | "join-workloads" | "drain-workloads" | "resume-workloads",
    fence: ResidentWorkloadFenceRequest, phase: ResidentWorkloadFenceStatus["phase"]): Promise<ResidentWorkloadFenceStatus> {
    const parsed = ResidentWorkloadFenceRequestSchema.safeParse(fence);
    if (!parsed.success || (op === "join-workloads" && parsed.data.mode !== "preserve") ||
      (op === "drain-workloads" && parsed.data.mode !== "drain")) throw new ResidentPtyError("request_rejected");
    const source = this.options.authority;
    const authority = { organizationId: source.organizationId, workspaceId: source.workspaceId,
      engineId: source.engineId, generation: source.generation, fence: source.fence };
    const result = ResidentWorkloadFenceStatusSchema.safeParse(await this.request({ op, fence: parsed.data }));
    if (!result.success || result.data.requestId !== parsed.data.requestId || result.data.mode !== parsed.data.mode ||
      result.data.phase !== phase || (["organizationId", "workspaceId", "engineId", "generation", "fence"] as const)
        .some(key => result.data.authority[key] !== authority[key])) throw new ResidentPtyError("request_rejected");
    return result.data;
  }
  fenceWorkloads(fence: ResidentWorkloadFenceRequest) { return this.workloadFence("fence-workloads", fence, "fenced"); }
  joinPendingWorkloads(fence: ResidentWorkloadFenceRequest) { return this.workloadFence("join-workloads", fence, "joined"); }
  drainWorkloads(fence: ResidentWorkloadFenceRequest) { return this.workloadFence("drain-workloads", fence, "drained"); }
  resumeWorkloads(fence: ResidentWorkloadFenceRequest) { return this.workloadFence("resume-workloads", fence, "released"); }
  async classifyWorkloads(value: ResidentWorkloadCensusRequest): Promise<ResidentWorkloadClassification> {
    const parsed = ResidentWorkloadCensusRequestSchema.safeParse(value);
    if (!parsed.success) throw new ResidentPtyError("request_rejected");
    const authority = this.options.authority;
    const captured = {organizationId: authority.organizationId, workspaceId: authority.workspaceId,
      engineId: authority.engineId, generation: authority.generation, fence: authority.fence};
    const result = await this.request({op: "classify-workloads", census: parsed.data});
    if (!residentWorkloadClassificationMatchesRequest(result, parsed.data, captured))
      throw new ResidentPtyError("request_rejected");
    return ResidentWorkloadClassificationSchema.parse(result);
  }
  async list() { return z.array(ResidentPtySessionSchema).max(RESIDENT_MAX_SESSIONS).parse(await this.request({ op: "list" })); }
  async create(launch: ResidentPtyCreate) { return ResidentPtySessionSchema.parse(await this.request({ op: "create", launch })); }
  async snapshot(sessionId: string, includeExit = false) {
    return ResidentPtySnapshotSchema.parse(await this.request({ op: "snapshot", sessionId, ...(includeExit ? { includeExit: true as const } : {}) }));
  }
  async write(sessionId: string, input: ResidentPtyInput) {
    return z.enum(["applied", "duplicate"]).parse(await this.request({ op: "write", sessionId, input }));
  }
  async cursor(sessionId: string, producerId: string) {
    return z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(await this.request({ op: "cursor", sessionId, producerId }));
  }
  async resize(sessionId: string, cols: number, rows: number) { z.literal(true).parse(await this.request({ op: "resize", sessionId, cols, rows })); }
  async close(sessionId: string) { z.literal(true).parse(await this.request({ op: "close", sessionId })); }

  disconnect(): void {
    const socket = this.socket; this.socket = null; this.ready = false;
    socket?.destroy();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer); request.reject(new ResidentPtyError("host_unavailable"));
    }
    this.pending.clear();
  }
}

/** A fixed root-owned control endpoint, separate from the resident host. The
 * captured runtime/authority can only retire its original dedicated legacy
 * leaf; a receipt never rebinds this engine's immutable workload custody. */
export class ResidentLegacyControlClient {
  private readonly options: Readonly<{ socketPath: string; hostId: string;
    authority: ResidentEngineAuthority; runtime: ResidentLegacyRuntime }>;
  constructor(options: { socketPath?: string; hostId: string; authority: ResidentEngineAuthority; runtime: ResidentLegacyRuntime }) {
    this.options = Object.freeze({ socketPath: options.socketPath ?? LEGACY_CONTROL_SOCKET, hostId: options.hostId,
      authority: Object.freeze(ResidentEngineAuthoritySchema.parse(options.authority)), runtime: Object.freeze({ ...options.runtime }) });
  }

  retire(requestId: string): Promise<ResidentLegacyRetirementReceipt> {
    const parsed = ResidentLegacyRetirementRequestSchema.safeParse({ version: 1, operation: "retire-legacy-resident",
      requestId, hostId: this.options.hostId, authority: this.options.authority });
    if (!parsed.success) return Promise.reject(new ResidentPtyError("request_rejected"));
    const body = parsed.data, bytes = JSON.stringify(body) + "\n";
    if (Buffer.byteLength(bytes) > RESIDENT_LEGACY_CONTROL_BYTES) return Promise.reject(new ResidentPtyError("request_rejected"));
    let endpoint: ReturnType<typeof legacyControlEndpointIdentity> | null;
    try { endpoint = this.options.socketPath === LEGACY_CONTROL_SOCKET ? legacyControlEndpointIdentity() : null; }
    catch { return Promise.reject(new ResidentPtyError("host_unavailable")); }
    const assertEndpoint = () => {
      const original = endpoint;
      if (!original) return;
      const current = legacyControlEndpointIdentity();
      if ((["dev", "ino", "ctimeNs", "uid", "parentDev", "parentIno"] as const).some(key => current[key] !== original[key]))
        throw new ResidentPtyError("host_unavailable");
    };
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.options.socketPath);
      let buffer = "", settled = false;
      const timer = setTimeout(() => unavailable(), 30_000);
      const finish = (result: ResidentLegacyRetirementReceipt | null) => {
        if (settled) return;
        settled = true; clearTimeout(timer); socket.destroy();
        if (!result) reject(new ResidentPtyError("host_unavailable"));
        else resolve(Object.freeze({ ...result, proof: Object.freeze(result.proof), source: Object.freeze({ ...result.source,
          authority: Object.freeze(result.source.authority), runtime: Object.freeze(result.source.runtime), scope: Object.freeze(result.source.scope) }) }));
      };
      const unavailable = () => finish(null);
      socket.setEncoding("utf8"); socket.on("error", unavailable); socket.on("close", unavailable);
      socket.on("connect", () => {
        try { assertEndpoint(); socket.write(bytes, error => { if (error) unavailable(); }); }
        catch { unavailable(); }
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > RESIDENT_LEGACY_CONTROL_BYTES) { unavailable(); return; }
        const end = buffer.indexOf("\n"); if (end < 0) return;
        try {
          if (end !== buffer.length - 1) { unavailable(); return; }
          const frame = z.object({ result: ResidentLegacyRetirementReceiptSchema }).strict().parse(JSON.parse(buffer.slice(0, end)));
          if (!residentLegacyRetirementReceiptMatchesRequest(frame.result, body, this.options.runtime)) { unavailable(); return; }
          assertEndpoint();
          finish(frame.result);
        } catch { unavailable(); }
      });
    });
  }
}
