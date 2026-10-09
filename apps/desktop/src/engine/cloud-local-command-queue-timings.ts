import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CloudAgentTurnTimingsSchema, type CloudAgentTurnTimingRecord, type CloudAgentTurnTimingsPacket,
  type CloudNativePromptStage, type CloudAgentTurnDependency } from "@zeros/protocol/cloud-events";

const identity = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const intentSchema = z.object({ commandId: z.uuid(), conversationId: identity, turnId: identity,
  provider: z.enum(["claude", "codex", "cursor"]) }).strict();
type Intent = z.infer<typeof intentSchema>;
type Claim = Intent & { executionId: string };
type Stage = CloudAgentTurnTimingRecord["stage"];
type Scope = { organizationId: string; workspaceId: string; generation: number; engineInstanceId: string };
type Limits = { total: number; perConversation: number; bytes: number; retentionMs: number };
type Options = { scope: Scope; mode: "legacy" | "boot-owner-v1"; bootId?: string; writerEpoch?: string;
  now?(): number; limits?: Partial<Limits> };
const MAX: Limits = { total: 256, perConversation: 32, bytes: 128 * 1024, retentionMs: 10 * 60_000 };
const nativeStages = new Set<CloudNativePromptStage>(["native_write", "native_acceptance_ack", "sdk_run_created"]);
const engineStages = new Set<Stage>(["accepted", "dispatch_committed", "first_delta", "typed_auth_failure", "terminal_committed"]);
const dependencies = new Set<CloudAgentTurnDependency>(["commands.mutate", "commands.claim", "credentials.admit", "credentials.validate", "records.settle_barrier"]);
type Context = { intent: Intent; executionId: string | null; stages: Set<Stage>; receivedAtMs: number };

/** Observations only. This class cannot authorize, enqueue or dispatch work.
 * Native callbacks supply only a closed stage; the engine captures ownership
 * and samples its own monotonic clock. Missing/evicted evidence is explicit. */
export class CloudAgentTurnTimings {
  private readonly clockId = randomUUID();
  private readonly contexts = new Map<string, Context>();
  private readonly executions = new Map<string, string>();
  private rows: CloudAgentTurnTimingRecord[] = [];
  private readonly limits: Limits;
  private readonly now: () => number;
  private sequence = 0;
  private lastAt = 0;
  private truncated = false;
  private unknown = false;
  private retired = false;
  private readonly options: Omit<Options, "now" | "limits">;
  constructor(options: Options) {
    const scope: Scope = Object.freeze({ organizationId: options.scope.organizationId,
      workspaceId: options.scope.workspaceId, generation: options.scope.generation,
      engineInstanceId: options.scope.engineInstanceId });
    this.options = Object.freeze({ scope, mode: options.mode,
      bootId: options.bootId, writerEpoch: options.writerEpoch });
    this.now = options.now ?? (() => performance.now());
    this.limits = { ...MAX };
    for (const key of Object.keys(options.limits ?? {}) as Array<keyof Limits>) {
      const value = options.limits![key];
      if (value === undefined || !Number.isSafeInteger(value) || value < (key === "bytes" ? 2 : 1) || value > MAX[key]) throw new Error("invalid turn timing bound");
      this.limits[key] = value;
    }
    CloudAgentTurnTimingsSchema.parse({ version: 1, ...scope, mode: options.mode,
      bootId: options.bootId ?? null, writerEpoch: options.writerEpoch ?? null, clockId: this.clockId,
      conversationId: "initial", sampledAtMs: 0, coverage: { truncated: false, retired: false, unknown: false }, records: [] });
  }
  private time(): number {
    const now = this.now();
    if (!Number.isFinite(now) || now < this.lastAt || now < 0 || now > Number.MAX_SAFE_INTEGER) { this.unknown = true; return this.lastAt; }
    this.lastAt = now; return now;
  }
  private same(context: Context, value: Intent): boolean {
    return context.intent.commandId === value.commandId && context.intent.conversationId === value.conversationId &&
      context.intent.turnId === value.turnId && context.intent.provider === value.provider;
  }
  receive(value: Intent): boolean {
    if (this.retired) return false;
    const parsed = intentSchema.safeParse(value); if (!parsed.success) { this.unknown = true; return false; }
    const previous = this.contexts.get(value.commandId);
    if (previous) return this.same(previous, parsed.data);
    if (this.contexts.size >= this.limits.total) {
      const first = this.contexts.keys().next().value!; const old = this.contexts.get(first)!;
      this.contexts.delete(first);
      if (old.executionId && this.executions.get(old.executionId) === first) this.executions.delete(old.executionId);
      this.rows = this.rows.filter(row => row.commandId !== first); this.truncated = true;
    }
    const context: Context = { intent: parsed.data, executionId: null, stages: new Set(), receivedAtMs: this.time() };
    this.contexts.set(value.commandId, context);
    return this.append(context, "engine_received");
  }
  bindClaim(value: Claim): boolean {
    if (this.retired || !identity.safeParse(value.executionId).success) return false;
    const context = this.contexts.get(value.commandId);
    if (!context || !this.same(context, value) || context.executionId && context.executionId !== value.executionId) return false;
    context.executionId = value.executionId; this.executions.set(value.executionId, value.commandId);
    // Before a real claim there is no execution identity to observe. Once the
    // claim is confirmed, all earlier marks keep their original timestamps.
    this.rows = this.rows.map(row => row.commandId === value.commandId ? { ...row, executionId: value.executionId } : row);
    this.prune(this.time());
    return this.append(context, "dispatch_committed");
  }
  lookupExecution(executionId: string): Claim | null {
    const id = this.executions.get(executionId), context = id && this.contexts.get(id);
    return !this.retired && context && context.executionId === executionId ? { ...context.intent, executionId } : null;
  }
  native(value: Claim, stage: CloudNativePromptStage): boolean {
    const context = this.contexts.get(value.commandId);
    if (this.retired || !nativeStages.has(stage) || !context || !this.same(context, value) || context.executionId !== value.executionId ||
      this.executions.get(value.executionId) !== value.commandId) return false;
    return this.append(context, stage);
  }
  mark(commandId: string, stage: Stage, output?: { outputKind: "text" | "tool"; receivedAtMs?: number }): boolean {
    const context = this.contexts.get(commandId);
    if (this.retired || !context || !engineStages.has(stage)) return false;
    if (output && (stage !== "first_delta" || (output.outputKind !== "text" && output.outputKind !== "tool"))) {
      this.unknown = true; return false;
    }
    if (stage === "first_delta" && !output) this.unknown = true;
    if (output?.receivedAtMs !== undefined && (!Number.isFinite(output.receivedAtMs) || output.receivedAtMs < context.receivedAtMs)) {
      this.unknown = true; return false;
    }
    return this.append(context, stage, undefined, output?.receivedAtMs, output?.outputKind);
  }
  dependency(commandId: string, dependency: CloudAgentTurnDependency, stage: "cp_request_started" | "cp_request_finished", atMs?: number): boolean {
    const context = this.contexts.get(commandId);
    if (this.retired || !context || !dependencies.has(dependency) || (stage !== "cp_request_started" && stage !== "cp_request_finished")) return false;
    return this.append(context, stage, dependency, atMs);
  }
  private append(context: Context, stage: Stage, dependency?: CloudAgentTurnDependency, atMs?: number,
    outputKind?: "text" | "tool"): boolean {
    if (!dependency && context.stages.has(stage)) return false;
    const sampled = this.time();
    if (atMs !== undefined && (!Number.isFinite(atMs) || atMs < 0 || atMs > sampled)) { this.unknown = true; return false; }
    if (!dependency) context.stages.add(stage);
    if (stage === "engine_received") context.receivedAtMs = atMs ?? sampled;
    if (++this.sequence > Number.MAX_SAFE_INTEGER) { this.retire(); return false; }
    this.rows.push({ sequence: this.sequence, ...context.intent, executionId: context.executionId,
      stage, atMs: atMs ?? sampled, ...(dependency ? { dependency } : {}), ...(outputKind ? { outputKind } : {}) });
    this.prune(sampled); return true;
  }
  private prune(now: number): void {
    const retained = this.rows.filter(row => now - row.atMs <= this.limits.retentionMs);
    if (retained.length !== this.rows.length) this.truncated = true;
    this.rows = retained;
    const counts = new Map<string, number>();
    for (let index = this.rows.length - 1; index >= 0; index--) {
      const row = this.rows[index]!, count = (counts.get(row.conversationId) ?? 0) + 1;
      counts.set(row.conversationId, count);
      if (count > this.limits.perConversation) { this.rows.splice(index, 1); this.truncated = true; }
    }
    while (this.rows.length && (this.rows.length > this.limits.total || this.retainedBytes() > this.limits.bytes)) { this.rows.shift(); this.truncated = true; }
  }
  retainedBytes(): number { return Buffer.byteLength(JSON.stringify(this.rows)); }
  retainedCount(): number { return this.rows.length; }
  get active(): boolean { return !this.retired; }
  sample(conversationId: string): CloudAgentTurnTimingsPacket {
    const sampledAtMs = this.time(); this.prune(sampledAtMs);
    return CloudAgentTurnTimingsSchema.parse({ version: 1, ...this.options.scope,
      mode: this.options.mode, bootId: this.options.bootId ?? null, writerEpoch: this.options.writerEpoch ?? null,
      clockId: this.clockId, conversationId, sampledAtMs,
      coverage: { truncated: this.truncated, retired: this.retired, unknown: this.unknown },
      records: this.rows.filter(row => row.conversationId === conversationId) });
  }
  retire(): void { this.retired = true; this.unknown = true; this.rows = []; this.contexts.clear(); this.executions.clear(); }
}
