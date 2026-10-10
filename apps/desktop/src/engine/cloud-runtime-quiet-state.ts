import { CloudRuntimeQuietSnapshotSchema, type CloudRuntimeQuietSnapshot } from "@zeros/protocol/cloud-runtime-lifecycle";
import { z } from "zod";
export type { CloudRuntimeQuietSnapshot } from "@zeros/protocol/cloud-runtime-lifecycle";

export type CloudRuntimeQuietScope = Pick<CloudRuntimeQuietSnapshot, "workspaceId" | "organizationId" | "generation" | "engineInstanceId">;
export const CloudRuntimeHandoffRequestSchema = CloudRuntimeQuietSnapshotSchema.pick({ challenge: true,
  workspaceId: true, organizationId: true, generation: true, engineInstanceId: true }).extend({
  hostId: z.string().uuid(), fence: z.number().int().positive().safe(), expiresAtMs: z.number().int().positive().safe(),
}).strict();
export type CloudRuntimeHandoffRequest = z.infer<typeof CloudRuntimeHandoffRequestSchema>;
export type CloudRuntimeHandoffReceipt = CloudRuntimeHandoffRequest & {
  version: 1; phase: "draining" | "fenced"; activityRevision: number;
};
export const CloudRuntimeHandoffCommandSchema = z.object({ action: z.enum(["prepare", "cancel", "consume"]),
  request: CloudRuntimeHandoffRequestSchema }).strict();
export type CloudRuntimeHandoffCommand = z.infer<typeof CloudRuntimeHandoffCommandSchema>;
export type CloudRuntimeHandoffReply = CloudRuntimeHandoffCommand & { version: 1; accepted: boolean; receipt?: CloudRuntimeHandoffReceipt };
export interface CloudRuntimeHandoffControls {
  /** Null until the exact root-enrolled resident connection is healthy. */
  resident(): { hostId: string; fence: number } | null;
  /** Authority may remain valid after a failed durable flush. Cancellation
   * must then resume its record writer without claiming durable readiness. */
  scope?(): CloudRuntimeQuietScope | null;
  pauseClaims(): void;
  resumeClaims(): void;
  drained(): boolean;
  busy(): boolean;
  /** Synchronous admission barrier. Existing admitted work is never killed. */
  fence(enabled: boolean): void | Promise<void>;
  inspectUserProcesses(): Promise<boolean>;
  /** Flush durable writes and close/seal the old SQLite writer. */
  seal(): Promise<void>;
  /** Prove local writer/admission can resume, or throw and stay fenced. */
  unseal(): void;
}
type Handoff = { request: CloudRuntimeHandoffRequest; phase: "draining" | "fenced" | "consumed";
  revision: number; admissionFenced: boolean; sealing: boolean; cancelled: boolean; timer: ReturnType<typeof setTimeout> };
export interface CloudRuntimeQuietStateOptions {
  cloud(): boolean;
  scope(): CloudRuntimeQuietScope | null;
  activity(): { revision: number; quietForMs: number; recordSync: CloudRuntimeQuietSnapshot["recordSync"] };
  busy(): boolean;
  livePty(): boolean;
  presence(): CloudRuntimeQuietSnapshot["presence"];
  inspectUserProcesses(): Promise<boolean>;
  handoff?: CloudRuntimeHandoffControls;
}

/** The quiet snapshot remains read-only. Explicit resident handoff uses the
 * same authority/activity source and adds reversible admission and writer
 * barriers; only the root controller may consume them before retirement. */
export class CloudRuntimeQuietState {
  private handoff: Handoff | null = null;
  private preparing: Promise<CloudRuntimeHandoffReceipt | null> | null = null;
  private restoring: Promise<boolean> | null = null;
  constructor(private readonly options: CloudRuntimeQuietStateOptions) {}

  async handleHandoff(raw: CloudRuntimeHandoffCommand): Promise<CloudRuntimeHandoffReply | null> {
    const parsed = CloudRuntimeHandoffCommandSchema.safeParse(raw);
    if (!parsed.success || !this.options.handoff) return null;
    const { action, request } = parsed.data;
    if (action === "prepare") {
      const receipt = await this.prepareHandoff(request);
      return { version: 1, action, request, accepted: receipt !== null, ...(receipt ? { receipt } : {}) };
    }
    if (action === "consume") return { version: 1, action, request, accepted: this.consumeHandoff(request) };
    const state = this.handoff;
    const matches = state && Object.entries(state.request).every(([key, value]) => request[key as keyof typeof request] === value);
    return { version: 1, action, request, accepted: !!matches && await this.cancelHandoff(request.challenge) };
  }

  /** Explicit root/controller path, separate from read-only quiet evidence.
   * Calls share one scope/nonce and let an admitted turn finish naturally. */
  prepareHandoff(raw: CloudRuntimeHandoffRequest): Promise<CloudRuntimeHandoffReceipt | null> {
    const parsed = CloudRuntimeHandoffRequestSchema.safeParse(raw);
    if (!parsed.success || !this.options.handoff) return Promise.resolve(null);
    const request = parsed.data;
    if (request.expiresAtMs <= Date.now() || request.expiresAtMs > Date.now() + 900_000 || !this.sameSource(request))
      return Promise.resolve(null);
    if (this.handoff && (Object.entries(request).some(([key, value]) => this.handoff!.request[key as keyof typeof request] !== value) ||
      this.handoff.cancelled || this.handoff.phase === "consumed")) return Promise.resolve(null);
    if (!this.handoff) {
      const timer = setTimeout(() => { void this.cancelHandoff(request.challenge); }, request.expiresAtMs - Date.now());
      timer.unref?.();
      this.handoff = { request, phase: "draining", revision: this.options.activity().revision,
        admissionFenced: false, sealing: false, cancelled: false, timer };
      this.options.handoff.pauseClaims();
    }
    if (this.preparing) return this.preparing;
    const state = this.handoff;
    this.preparing = Promise.resolve().then(() => this.prepare(state)).finally(() => { this.preparing = null; });
    return this.preparing;
  }

  /** Root consumes immediately before retiring the old engine scope. A
   * consumed writer cannot be revived; rollback requires fresh enrollment. */
  consumeHandoff(request: CloudRuntimeHandoffRequest): boolean {
    const state = this.handoff;
    if (!CloudRuntimeHandoffRequestSchema.safeParse(request).success || !state ||
      Object.entries(state.request).some(([key, value]) => request[key as keyof typeof request] !== value)) return false;
    // Lost root replies must be recoverable. This exact consumed writer can
    // never resume, even when its original preparation deadline has passed.
    if (state.phase === "consumed") return true;
    if (state.phase !== "fenced" || state.cancelled || this.preparing || Date.now() >= state.request.expiresAtMs ||
      !this.sameSource(state.request) || this.options.activity().revision !== state.revision || this.handoffBusy()) return false;
    state.phase = "consumed"; clearTimeout(state.timer); return true;
  }

  async cancelHandoff(challenge: string): Promise<boolean> {
    const state = this.handoff;
    if (!state || state.request.challenge !== challenge || state.phase === "consumed") return false;
    state.cancelled = true;
    await this.preparing;
    return this.handoff !== state || await this.restore(state);
  }

  private sameSource(request: CloudRuntimeHandoffRequest): boolean {
    try {
      const scope = this.options.handoff?.scope ? this.options.handoff.scope() : this.options.scope();
      const resident = this.options.handoff?.resident();
      return this.options.cloud() && !!scope && !!resident && resident.hostId === request.hostId && resident.fence === request.fence &&
        Object.entries(scope).every(([key, value]) => request[key as keyof CloudRuntimeQuietScope] === value);
    } catch { return false; }
  }
  private handoffBusy(): boolean {
    try { return !this.options.handoff!.drained() || this.options.handoff!.busy() || this.options.activity().recordSync !== "ready"; }
    catch { return true; }
  }
  private restore(state: Handoff): Promise<boolean> {
    if (this.restoring) return this.restoring;
    const flight = this.restoreOriginal(state).finally(() => { if (this.restoring === flight) this.restoring = null; });
    this.restoring = flight;
    return flight;
  }
  private async restoreOriginal(state: Handoff): Promise<boolean> {
    if (this.handoff !== state || state.phase === "consumed") return false;
    clearTimeout(state.timer);
    if (!this.sameSource(state.request)) { state.cancelled = true; return false; }
    try {
      if (state.sealing) this.options.handoff!.unseal();
      if (state.admissionFenced) await this.options.handoff!.fence(false);
      // The async resident ACK may cross an authority replacement. Never
      // publish resumed claims using the earlier source check.
      if (this.handoff !== state || !this.sameSource(state.request)) return false;
      this.options.handoff!.resumeClaims();
      this.handoff = null; return true;
    } catch { state.cancelled = true; return false; }
  }
  private async prepare(state: Handoff): Promise<CloudRuntimeHandoffReceipt | null> {
    const controls = this.options.handoff!;
    const current = () => !state.cancelled && Date.now() < state.request.expiresAtMs && this.sameSource(state.request);
    const receipt = (): CloudRuntimeHandoffReceipt => ({ version: 1, ...state.request,
      phase: state.phase === "fenced" ? "fenced" : "draining", activityRevision: state.revision });
    try {
      if (!current()) return null;
      if (state.phase === "fenced") return receipt();
      if (this.handoffBusy()) return receipt();
      state.revision = this.options.activity().revision;
      state.admissionFenced = true; await controls.fence(true);
      let processes = true;
      try { processes = await controls.inspectUserProcesses(); } catch { /* Unknown is busy. */ }
      if (!current()) return null;
      if (processes || this.handoffBusy() || this.options.activity().revision !== state.revision) {
        await controls.fence(false); state.admissionFenced = false; return receipt();
      }
      state.sealing = true;
      await controls.seal();
      if (!current() || this.handoffBusy() || this.options.activity().revision !== state.revision) {
        state.cancelled = true; return null;
      }
      state.phase = "fenced";
      return receipt();
    } catch { state.cancelled = true; return null; }
    finally { if (!current()) await this.restore(state); }
  }

  async snapshot(challenge: string): Promise<CloudRuntimeQuietSnapshot | null> {
    if (!this.options.cloud() || !CloudRuntimeQuietSnapshotSchema.shape.challenge.safeParse(challenge).success) return null;
    try {
      const initialScope = this.options.scope();
      if (!initialScope) return null;
      const scope = { ...initialScope };
      const before = { ...this.options.activity() };
      const busy = this.options.busy(), pty = this.options.livePty(), presence = this.options.presence();
      let userProcesses: CloudRuntimeQuietSnapshot["userProcesses"];
      try { userProcesses = await this.options.inspectUserProcesses() ? "busy" : "idle"; }
      catch { userProcesses = "unknown"; }
      const after = this.options.activity(), current = this.options.scope();
      if (!this.options.cloud() || !current || current.workspaceId !== scope.workspaceId || current.organizationId !== scope.organizationId ||
          current.generation !== scope.generation || current.engineInstanceId !== scope.engineInstanceId) return null;
      const finalPresence = this.options.presence();
      const parsed = CloudRuntimeQuietSnapshotSchema.safeParse({ version: 1, challenge, ...scope,
        activityRevision: after.revision, quietForMs: after.quietForMs, recordSync: after.recordSync,
        stable: before.revision === after.revision, workloadBusy: busy || this.options.busy(), livePty: pty || this.options.livePty(),
        userProcesses, presence: presence === "present" || finalPresence === "present" ? "present" :
          presence === "unknown" || finalPresence === "unknown" ? "unknown" : "absent" });
      return parsed.success ? parsed.data : null;
    } catch { return null; }
  }
}
