import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type Sqlite from "better-sqlite3";
import { z } from "zod";
import { CloudActionReceiptSchema, CloudActionSchema, type CloudActionEngineRequest, type CloudActionReceipt } from "@zeros/protocol/cloud-actions";
import { CloudActorProvenanceSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { isCloudAuthorizedActor, type CloudAuthorizedActor } from "./agents/cloud-actor-authority";
import { CloudCommandRuntimeError } from "./cloud-command-client";
import { isCloudLocalCommandQueue, type CloudLocalCommandQueue } from "./cloud-local-command-queue";
import { openSqlite } from "./db/sqlite";

const requestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), operationId: z.uuid() }).strict(),
  z.object({ kind: z.literal("begin"), action: CloudActionSchema, admissible: z.boolean() }).strict(),
  z.object({ kind: z.literal("settle"), operationId: z.uuid(), claimId: z.uuid(),
    outcome: CloudActionReceiptSchema.shape.outcome.unwrap(), turnId: CloudActionReceiptSchema.shape.turnId }).strict(),
]);
const stores = new WeakSet<object>(), active = new WeakMap<CloudLocalCommandQueue, CloudLocalCommandActionStore>();
export const isCloudLocalCommandActionStore = (value: unknown): value is CloudLocalCommandActionStore =>
  !!value && typeof value === "object" && stores.has(value);
type Row = { operation_id: string; conversation_id: string; execution_id: string; kind: CloudActionReceipt["kind"];
  request_id: string; request_sha256: string; actor: string; claim_id: string; state: CloudActionReceipt["state"];
  outcome: CloudActionReceipt["outcome"]; turn_id: string | null; boot_id: string; writer_epoch: string };

/** Only a genuine negotiated cloud queue can install this engine-private
 * source. FULL commits precede native callbacks. Replays and inherited claims
 * never authorize another dispatch; terminal persistence needs only its exact
 * engine claim, so an already known outcome survives actor disconnect/revoke. */
export class CloudLocalCommandActionStore {
  private readonly db: Sqlite.Database;
  private readonly maxReceipts: number;
  private closed = false;
  constructor(private readonly options: { file: string; queue: CloudLocalCommandQueue; engineLive(): boolean;
    authorize(actorSessionId: string, capability: "read" | "run"): CloudAuthorizedActor; maxReceipts?: number }) {
    if (!isCloudLocalCommandQueue(options.queue) || !options.queue.ownsDatabase(options.file) || active.has(options.queue))
      throw new CloudCommandRuntimeError("engine_authority_rejected");
    this.maxReceipts = options.maxReceipts ?? 100_000;
    if (!Number.isSafeInteger(this.maxReceipts) || this.maxReceipts < 1 || this.maxReceipts > 100_000)
      throw new CloudCommandRuntimeError("invalid_command");
    this.db = openSqlite(options.file, { fileMustExist: true });
    try {
      this.db.pragma("synchronous = FULL"); this.db.pragma("busy_timeout = 25");
      this.assertLive();
      this.options.queue.assertWriterWritable();
      this.db.exec(`CREATE TABLE IF NOT EXISTS local_command_actions(
        operation_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,execution_id TEXT NOT NULL,kind TEXT NOT NULL,
        request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,actor TEXT NOT NULL,claim_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,outcome TEXT,turn_id TEXT,boot_id TEXT NOT NULL,writer_epoch TEXT NOT NULL)`);
      this.transaction(() => {
        // Constructing another source is never continuity proof, even with
        // unchanged boot/writer metadata. The prior callback may have run.
        this.db.prepare("UPDATE local_command_actions SET state='uncertain',outcome='interrupted' WHERE state='dispatching'").run();
      });
      active.set(options.queue,this); stores.add(this);
    } catch (error) { this.db.close(); this.closed = true; throw error; }
  }
  private assertLive(): void {
    let live = false;
    try { live = !this.closed && this.options.engineLive() && this.options.queue.ownsDatabase(this.options.file); } catch { /* Fail closed. */ }
    if (!live) throw new CloudCommandRuntimeError("engine_authority_rejected");
    const writer = this.db.prepare("SELECT value FROM local_command_metadata WHERE key='writer'").get() as { value: string } | undefined;
    if (!writer || !isDeepStrictEqual(JSON.parse(writer.value),this.options.queue.scope) ||
        (this.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode !== "wal" ||
        (this.db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous !== 2)
      throw new CloudCommandRuntimeError("engine_authority_rejected");
  }
  private transaction<T>(run: () => T): T {
    try { return this.db.transaction(run)(); }
    catch (error) { if (error instanceof CloudCommandRuntimeError) throw error; throw new CloudCommandRuntimeError("command_storage_unavailable"); }
  }
  private authorize(sessionId: string | undefined, capability: "read" | "run"): CloudAuthorizedActor {
    try {
      if (!sessionId) throw new Error();
      const actor = this.options.authorize(sessionId,capability);
      if (!isCloudAuthorizedActor(actor)) {
        // A mistakenly asynchronous helper cannot grant authority or leak an
        // unhandled rejection. Authority remains synchronous and original.
        void Promise.resolve(actor).catch(() => undefined); throw new Error();
      }
      actor.assertLive(capability);
      if (!isDeepStrictEqual(actor.provenance.scope,this.options.queue.scope) || actor.provenance.actorSessionId !== sessionId)
        throw new Error();
      return actor;
    } catch { throw new CloudCommandRuntimeError("cloud_actor_authority_rejected"); }
  }
  private row(operationId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM local_command_actions WHERE operation_id=?").get(operationId) as Row | undefined;
  }
  private assertActor(actor: CloudAuthorizedActor, capability: "read" | "run"): void {
    try { actor.assertLive(capability); }
    catch { throw new CloudCommandRuntimeError("cloud_actor_authority_rejected"); }
  }
  private assertMutation(kind: "begin" | "settle"): void {
    this.options.queue.assertWriterWritable();
    if (kind === "begin" && !this.options.queue.accepting) throw new CloudCommandRuntimeError("cloud_command_writer_retired");
  }
  private view(row: Row, replayed: boolean): CloudActionReceipt {
    return CloudActionReceiptSchema.parse({ operationId: row.operation_id,conversationId: row.conversation_id,executionId: row.execution_id,
      kind: row.kind,requestId: row.request_id,state: row.state,outcome: row.outcome,turnId: row.turn_id,claimId: row.claim_id,replayed });
  }
  async request(input: CloudActionEngineRequest, actorSessionId?: string): Promise<unknown> {
    this.assertLive();
    const bytes = canonical(input), parsed = requestSchema.safeParse(input);
    if (!parsed.success) throw new CloudCommandRuntimeError("invalid_command");
    if (Buffer.byteLength(bytes) > 192 * 1024) throw new CloudCommandRuntimeError("command_limit");
    const request = parsed.data;
    const principal = request.kind === "settle" ? null : this.authorize(actorSessionId,request.kind === "read" ? "read" : "run");
    return this.transaction(() => {
      this.assertLive();
      if (request.kind !== "read") this.assertMutation(request.kind);
      if (principal) this.assertActor(principal,request.kind === "read" ? "read" : "run");
      const operationId = request.kind === "begin" ? request.action.operationId : request.operationId, previous = this.row(operationId);
      if (request.kind === "read") {
        if (!previous) throw new CloudCommandRuntimeError("command_not_found");
        this.assertActor(principal!,"read");
        return this.view(previous,true);
      }
      if (request.kind === "begin") {
        const actor = principal!.provenance.actor;
        const requestHash = createHash("sha256").update(canonical({ action: request.action, actor: { userId: actor.userId,deviceId: actor.deviceId,
          deviceKeyVersion: actor.deviceKeyVersion,fingerprint: actor.fingerprint } })).digest("hex");
        if (previous) {
          if (previous.request_sha256 !== requestHash || previous.conversation_id !== request.action.conversationId ||
              previous.execution_id !== request.action.executionId || previous.kind !== request.action.kind || previous.request_id !== request.action.requestId)
            throw new CloudCommandRuntimeError("command_conflict");
          this.assertActor(principal!,"run");
          this.assertMutation("begin");
          return this.view(previous,true);
        }
        if (!request.admissible) throw new CloudCommandRuntimeError("command_context_changed");
        if ((this.db.prepare("SELECT count(*) AS n FROM local_command_actions").get() as { n: number }).n >= this.maxReceipts)
          throw new CloudCommandRuntimeError("command_limit");
        const action = request.action;
        this.db.prepare(`INSERT INTO local_command_actions(operation_id,conversation_id,execution_id,kind,request_id,request_sha256,
          actor,claim_id,state,outcome,turn_id,boot_id,writer_epoch) VALUES(?,?,?,?,?,?,?,?,'dispatching',NULL,?,?,?)`)
          .run(action.operationId,action.conversationId,action.executionId,action.kind,action.requestId,requestHash,
            canonical(CloudActorProvenanceSchema.parse(principal!.provenance)),randomUUID(),action.kind === "steer" ? action.payload.turnId : null,
            this.options.queue.scope.bootId,this.options.queue.scope.writerEpoch);
        this.assertActor(principal!,"run");
        this.assertMutation("begin");
        return this.view(this.row(operationId)!,false);
      }
      if (!previous) throw new CloudCommandRuntimeError("command_not_found");
      if (previous.claim_id !== request.claimId || previous.boot_id !== this.options.queue.scope.bootId ||
          previous.writer_epoch !== this.options.queue.scope.writerEpoch) throw new CloudCommandRuntimeError("command_conflict");
      if (previous.state !== "dispatching") {
        if (previous.state !== "settled" || previous.outcome !== request.outcome || previous.turn_id !== request.turnId)
          throw new CloudCommandRuntimeError("command_conflict");
        return this.view(previous,true);
      }
      this.db.prepare("UPDATE local_command_actions SET state='settled',outcome=?,turn_id=? WHERE operation_id=?")
        .run(request.outcome,request.turnId,request.operationId);
      this.assertMutation("settle");
      return this.view(this.row(operationId)!,false);
    });
  }
  hasActiveWork(): boolean {
    if (this.closed) return true;
    this.assertLive(); return !!this.db.prepare("SELECT 1 FROM local_command_actions WHERE state='dispatching' LIMIT 1").get();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.db.close(); if (active.get(this.options.queue) === this) active.delete(this.options.queue);
  }
}
function canonical(value: unknown, budget = { nodes: 0 }, depth = 0): string {
  if (++budget.nodes > 20_000 || depth > 24) throw new CloudCommandRuntimeError("invalid_command");
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item,budget,depth + 1)).join(",")}]`;
  if (!value || typeof value !== "object" || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new CloudCommandRuntimeError("invalid_command");
  return `{${Object.keys(value).sort().map(key => {
    if (["__proto__","prototype","constructor"].includes(key)) throw new CloudCommandRuntimeError("invalid_command");
    return `${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key],budget,depth + 1)}`;
  }).join(",")}}`;
}
