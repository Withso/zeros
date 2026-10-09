import { ResidentLegacyControlClient, ResidentPtyClient } from "./resident-client";
import { randomUUID } from "node:crypto";
import { coerceDim } from "./service";
import { cloudWorkloadCustodyInfrastructure, isCloudWorkloadCustody,
  type CloudWorkloadCustody } from "../agents/containment/cloud-workload-custody";
import type { CloudWorkloadOwnerChannel } from "../agents/containment/cloud-owned-workloads";
import { RESIDENT_FRAME_BYTES, ResidentEngineAuthoritySchema, ResidentPtyError, type ResidentEngineAuthority,
  type ResidentPtyCreate, type ResidentPtyFrame, type ResidentPtySession,
  type ResidentWorkloadCensusRequest, type ResidentWorkloadClassification,
  type ResidentWorkloadFenceRequest, type ResidentWorkloadFenceStatus,
  ResidentLegacyRetirementReceiptSchema, residentLegacyRetirementReceiptMatchesRequest,
  type ResidentLegacyRetirementReceipt, type ResidentLegacyRuntime } from "./resident-protocol";

type Event = Exclude<ResidentPtyFrame, { kind: "reply" | "error" }>;
export type ResidentWorkloadFence = Readonly<ResidentWorkloadFenceRequest>;
type Fence = { epoch: number; request: ResidentWorkloadFence; phase: "new" | ResidentWorkloadFenceStatus["phase"];
  flight?: Promise<void> };

/** Engine-local routing cache. The resident host owns every shell, mirror,
 * actor binding and input cursor; reconnect reconstructs this disposable view. */
export class ResidentTerminalService {
  private readonly client: ResidentPtyClient;
  private readonly options: { hostId: string; socketPath: string; authority: ResidentEngineAuthority };
  private readonly sessions = new Map<string, ResidentPtySession>();
  private readonly writes = new Map<string, { tail: Promise<unknown>; count: number }>();
  private listener: ((event: Event) => void) | null = null;
  private loading = 0;
  private operations = 0;
  private epoch = 0;
  private pendingEvents: Event[] = [];
  private pendingBytes = 0;
  private connected = false;
  private workRevision = 0;
  private readonly workloadFences = new Map<ResidentWorkloadFence, Fence>();
  private readonly legacyControl: ResidentLegacyControlClient | null;
  private readonly legacyRuntime: ResidentLegacyRuntime | null;
  private legacyRetirementState: { epoch: number; revision: number; requestId: string;
    receipt: ResidentLegacyRetirementReceipt | null; flight?: Promise<ResidentLegacyRetirementReceipt> } | null = null;

  constructor(options: { hostId: string; socketPath: string; authority: ResidentEngineAuthority;
    legacyControl?: { runtime: ResidentLegacyRuntime; socketPath?: string } }) {
    this.options = Object.freeze({ ...options, authority: Object.freeze(ResidentEngineAuthoritySchema.parse(options.authority)) });
    this.client = new ResidentPtyClient(this.options);
    this.legacyRuntime = options.legacyControl ? Object.freeze({ ...options.legacyControl.runtime }) : null;
    this.legacyControl = this.legacyRuntime ? new ResidentLegacyControlClient({ hostId: this.options.hostId,
      authority: this.options.authority, runtime: this.legacyRuntime, socketPath: options.legacyControl?.socketPath }) : null;
    this.client.events(event => this.receive(event));
  }

  events(listener: (event: Event) => void): void { this.listener = listener; }

  async connect(): Promise<void> {
    if (this.legacyRetirementState) throw new ResidentPtyError("host_unavailable");
    const epoch = this.epoch;
    this.loading++;
    try {
      await this.client.connect();
      const sessions = await this.client.list();
      if (epoch !== this.epoch || !this.client.isConnected()) throw new ResidentPtyError("host_unavailable");
      this.sessions.clear();
      for (const session of sessions) this.sessions.set(session.sessionId, session);
      this.connected = true;
    } finally { this.loading--; this.flushEvents(); }
  }

  list(): ResidentPtySession[] { return [...this.sessions.values()].map(session => ({ ...session })); }
  get(sessionId: string): ResidentPtySession | undefined {
    const session = this.sessions.get(sessionId); return session ? { ...session } : undefined;
  }
  has(sessionId: string): boolean { return this.sessions.get(sessionId)?.exited === false; }
  healthy(): boolean { return this.connected && this.client.isConnected(); }
  busy(): boolean { return (!this.legacyRetirementState?.receipt && (!this.healthy() || !!this.legacyRetirementState)) ||
    this.loading > 0 || this.operations > 0 || this.writes.size > 0; }
  hasRecentInput(): boolean { return [...this.sessions.values()].some(session => session.lastInputAtMs > 0 && Date.now() - session.lastInputAtMs < 10 * 60_000); }

  private assertAdmission(): void {
    if (this.legacyRetirementState || !this.healthy() || [...this.workloadFences.values()].some(fence => fence.phase !== "released"))
      throw new ResidentPtyError("host_unavailable");
  }
  private originalFence(ticket: ResidentWorkloadFence): Fence {
    const fence = this.workloadFences.get(ticket);
    if (!fence || fence.epoch !== this.epoch || !this.healthy()) throw new ResidentPtyError("request_rejected");
    return fence;
  }
  /** Close the local entry synchronously, before the original host ACK. An
   * unknown response retains this exact ticket for reconciliation. */
  fenceWorkloads(mode: ResidentWorkloadFenceRequest["mode"]): ResidentWorkloadFence {
    if (!this.healthy() || this.workloadFences.size >= 256 || !["preserve", "drain"].includes(mode))
      throw new ResidentPtyError("host_unavailable");
    const ticket = Object.freeze({ version: 1 as const, requestId: randomUUID(), mode });
    this.workloadFences.set(ticket, { epoch: this.epoch, request: ticket, phase: "new" });
    void this.ensureFence(ticket).catch(() => undefined);
    return ticket;
  }
  private async ensureFence(ticket: ResidentWorkloadFence): Promise<void> {
    const fence = this.originalFence(ticket);
    if (fence.phase !== "new") return;
    if (!fence.flight) {
      this.operations++;
      fence.flight = this.client.fenceWorkloads(fence.request).then(() => {
        this.originalFence(ticket); fence.phase = "fenced";
      }).finally(() => { this.operations--; fence.flight = undefined; });
    }
    await fence.flight;
  }
  async joinPendingWorkloads(ticket: ResidentWorkloadFence): Promise<void> {
    const fence = this.originalFence(ticket);
    if (fence.request.mode !== "preserve" || fence.phase === "released") throw new ResidentPtyError("request_rejected");
    await this.ensureFence(ticket);
    this.operations++;
    try { await this.client.joinPendingWorkloads(fence.request); this.originalFence(ticket); fence.phase = "joined"; }
    finally { this.operations--; }
  }
  /** Original-owner group retirement only; the current engine separately
   * verifies aggregate whole-tree quiescence after both owners are fenced. */
  async drainWorkloads(ticket: ResidentWorkloadFence): Promise<void> {
    const fence = this.originalFence(ticket);
    if (fence.request.mode !== "drain" || fence.phase === "released") throw new ResidentPtyError("request_rejected");
    await this.ensureFence(ticket);
    this.operations++;
    try { await this.client.drainWorkloads(fence.request); this.originalFence(ticket); fence.phase = "drained"; }
    finally { this.operations--; }
  }
  async resumeWorkloads(ticket: ResidentWorkloadFence): Promise<void> {
    const fence = this.originalFence(ticket);
    if (fence.phase === "released") return;
    if (fence.phase !== "joined" && fence.phase !== "drained") throw new ResidentPtyError("request_rejected");
    this.operations++;
    try { await this.client.resumeWorkloads(fence.request); this.originalFence(ticket); fence.phase = "released"; }
    finally { this.operations--; }
  }

  /** Fresh read from the original authenticated resident owner. Missing or
   * incomplete proof is busy. Session metadata cannot prove descendant
   * quiescence; the root owner must retire or replace unsupported hosts. */
  async inspectWorkloads():Promise<boolean>{
    if (this.legacyRetirementState?.receipt) return this.busy();
    const epoch=this.epoch;
    if(this.busy())return true;
    try{
      const view=await this.client.inspectWorkloads();
      if(epoch!==this.epoch||this.busy())return true;
      return !view.complete||view.busy;
    }catch(error){
      if(!(error instanceof ResidentPtyError)||error.code!=="request_rejected"||epoch!==this.epoch||this.busy())return true;
      try{
        await this.client.list();
        // Even a fresh empty legacy list can omit reparented descendants.
        // It is provenance for the root owner, never kernel custody proof.
        return true;
      }catch{return true;}
    }
  }

  /** Eligibility for a bounded, explicit root retirement, never an idle
   * exemption. Even exited/empty metadata stays busy until whole-leaf proof. */
  async readLegacyRetirementCandidate(): Promise<boolean> {
    const epoch = this.epoch, revision = this.workRevision;
    const current = () => epoch === this.epoch && revision === this.workRevision && !this.busy() && !this.legacyRetirementState &&
      !this.hasRecentInput() && ![...this.workloadFences.values()].some(fence => fence.phase !== "released");
    if (!current()) return false;
    try { await this.client.inspectWorkloads(); return false; }
    catch (error) {
      if (!(error instanceof ResidentPtyError) || error.code !== "request_rejected" || !current()) return false;
      try {
        const rows = await this.client.list();
        return current() && rows.every(row => row.exited && (row.lastInputAtMs === 0 || Date.now() - row.lastInputAtMs >= 10 * 60_000));
      } catch { return false; }
    }
  }

  requiresFreshView(): boolean { return this.legacyRetirementState !== null; }
  get legacyRetirementReceipt(): ResidentLegacyRetirementReceipt | null { return this.legacyRetirementState?.receipt ?? null; }

  async retireLegacyWorkloads(): Promise<ResidentLegacyRetirementReceipt> {
    if (!this.legacyControl || !this.legacyRuntime) throw new ResidentPtyError("host_unavailable");
    let state = this.legacyRetirementState;
    if (!state) {
      const epoch = this.epoch, revision = this.workRevision;
      if (!await this.readLegacyRetirementCandidate() || epoch !== this.epoch || revision !== this.workRevision || this.busy())
        throw new ResidentPtyError("host_unavailable");
      state = { epoch, revision, requestId: randomUUID(), receipt: null };
      // Synchronously close create/write/resize before the root request. A
      // timeout retains this exact request and cannot reopen old authority.
      this.legacyRetirementState = state;
    }
    if (state.receipt) return state.receipt;
    if (state.epoch !== this.epoch || state.revision !== this.workRevision) throw new ResidentPtyError("host_unavailable");
    if (!state.flight) {
      const original = state;
      this.operations++;
      state.flight = this.legacyControl.retire(state.requestId).then(value => {
        if (this.legacyRetirementState !== original || original.epoch !== this.epoch || original.revision !== this.workRevision ||
            !residentLegacyRetirementReceiptMatchesRequest(value, { version: 1, operation: "retire-legacy-resident",
              requestId: original.requestId, hostId: this.options.hostId, authority: this.options.authority }, this.legacyRuntime!))
          throw new ResidentPtyError("host_unavailable");
        const result = ResidentLegacyRetirementReceiptSchema.parse(value);
        original.receipt = Object.freeze({ ...result, proof: Object.freeze(result.proof), source: Object.freeze({ ...result.source,
          authority: Object.freeze(result.source.authority), runtime: Object.freeze(result.source.runtime), scope: Object.freeze(result.source.scope) }) });
        this.epoch++; this.connected = false; this.client.disconnect(); this.sessions.clear();
        this.pendingEvents = []; this.pendingBytes = 0;
        return original.receipt;
      }).finally(() => { this.operations--; original.flight = undefined; });
    }
    return state.flight;
  }

  async classifyWorkloads(census: ResidentWorkloadCensusRequest): Promise<ResidentWorkloadClassification> {
    const epoch = this.epoch;
    if (this.busy()) throw new ResidentPtyError("host_unavailable");
    const result = await this.client.classifyWorkloads(census);
    if (epoch !== this.epoch || this.busy()) throw new ResidentPtyError("host_unavailable");
    return result;
  }

  /** The root-projected resident birth and this original attachment select the
   * owner. A returned classification still needs the registry's same-census
   * kernel checks; no session list or caller PID can grant an exemption. */
  workloadOwner(custody: CloudWorkloadCustody): CloudWorkloadOwnerChannel {
    if (this.legacyRetirementState || !isCloudWorkloadCustody(custody) || custody.controller.kind !== "engine")
      throw new ResidentPtyError("host_unavailable");
    custody.assertLive();
    const owners = cloudWorkloadCustodyInfrastructure(custody).filter(owner => owner.kind === "resident" &&
      owner.controlDirectory?.endsWith(`/engine-workload-${this.options.hostId}`));
    if (owners.length !== 1) throw new ResidentPtyError("host_unavailable");
    const epoch = this.epoch, source = this.options.authority;
    const authority = Object.freeze({ organizationId: source.organizationId, workspaceId: source.workspaceId,
      engineId: source.engineId, generation: source.generation, fence: source.fence });
    const owner = Object.freeze({ pid: owners[0]!.pid, startToken: owners[0]!.startToken });
    const assertLive = () => {
      if (epoch !== this.epoch || this.busy()) throw new ResidentPtyError("host_unavailable");
    };
    assertLive();
    return Object.freeze({ authority, owner, assertLive,
      classifyWorkloads: async (request: ResidentWorkloadCensusRequest) => {
        assertLive();
        const result = await this.classifyWorkloads(request);
        assertLive();
        return result;
      },
    });
  }

  async create(launch: ResidentPtyCreate): Promise<ResidentPtySession> {
    this.assertAdmission();
    this.workRevision++;
    this.loading++;
    let session: ResidentPtySession;
    try {
      session = await this.client.create({ ...launch, cols: coerceDim(launch.cols, 80), rows: coerceDim(launch.rows, 24) });
      this.sessions.set(session.sessionId, session);
    } finally { this.loading--; this.flushEvents(); }
    return { ...session };
  }

  async snapshot(sessionId: string) {
    this.operations++;
    try { return await this.client.snapshot(sessionId, true); }
    finally { this.operations--; }
  }

  write(sessionId: string, data: string, actorUserId: string | null): Promise<void> {
    try { this.assertAdmission(); } catch (error) { return Promise.reject(error); }
    this.workRevision++;
    const state = this.writes.get(sessionId) ?? { tail: Promise.resolve(), count: 0 };
    if (state.count >= 32) return Promise.reject(new ResidentPtyError("input_limit"));
    state.count++; this.writes.set(sessionId, state);
    const next = state.tail.then(async () => {
      this.assertAdmission();
      // Exactly one fenced engine owns this producer. Read the host cursor so
      // replacement never resets input ordering or consumes another producer
      // slot. The private protocol still supports replaying an uncertain write
      // with the same producer/sequence when its original caller retains it.
      const sequence = await this.client.cursor(sessionId, this.options.hostId) + 1;
      this.assertAdmission();
      await this.client.write(sessionId, { producerId: this.options.hostId, sequence, data, actorUserId });
      const session = this.sessions.get(sessionId);
      if (session) session.lastInputAtMs = Date.now();
      if (session?.actorUserId && session.actorUserId !== actorUserId) session.githubShared = true;
    });
    state.tail = next.catch(() => undefined).finally(() => {
      if (--state.count === 0 && this.writes.get(sessionId) === state) this.writes.delete(sessionId);
    });
    return next;
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    this.assertAdmission();
    this.workRevision++;
    this.operations++;
    try {
      const previous = this.sessions.get(sessionId);
      cols = coerceDim(cols, previous?.cols ?? 80); rows = coerceDim(rows, previous?.rows ?? 24);
      await this.client.resize(sessionId, cols, rows);
      const session = this.sessions.get(sessionId);
      if (session) { session.cols = cols; session.rows = rows; }
    } finally { this.operations--; }
  }

  async close(sessionId: string): Promise<void> {
    if (this.legacyRetirementState?.receipt) { this.sessions.delete(sessionId); return; }
    this.workRevision++;
    this.operations++;
    try { await this.client.close(sessionId); this.sessions.delete(sessionId); }
    finally { this.operations--; }
  }

  async closeAll(): Promise<void> {
    for (const id of this.sessions.keys()) await this.close(id);
  }

  disconnect(): void {
    this.epoch++;
    this.connected = false; this.client.disconnect(); this.pendingEvents = []; this.pendingBytes = 0;
  }

  private receive(event: Event): void {
    if (this.loading) {
      this.pendingBytes += event.kind === "data" ? Buffer.byteLength(event.data) : 128;
      if (this.pendingBytes > RESIDENT_FRAME_BYTES || this.pendingEvents.length >= 4096) {
        this.disconnect(); return;
      }
      this.pendingEvents.push(event); return;
    }
    const session = this.sessions.get(event.sessionId);
    if (!session) return;
    if (event.kind === "exit") session.exited = true;
    this.listener?.(event);
  }

  private flushEvents(): void {
    if (this.loading) return;
    const events = this.pendingEvents; this.pendingEvents = []; this.pendingBytes = 0;
    for (const event of events) this.receive(event);
  }
}
