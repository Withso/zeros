import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type Sqlite from "better-sqlite3";
import { z } from "zod";
import {
  CloudBootCommandClientRequestSchema, CloudBootCommandClaimSchema, CloudBootCommandEntrySchema, CloudBootCommandSnapshotSchema,
  CloudBootCommandMutationSchema, CloudBootCommandEngineRequestSchema, CloudNativeResultSchema, CloudGoalSnapshotSchema,
  type CloudBootCommandEngineRequest, type CloudBootCommandMutation, type CloudCommandResult, type CloudBootCommandSnapshot,
  type CloudBootCommandClaim,
} from "@zeros/protocol/cloud-commands";
import { CloudCommandActorSchema, type CloudCommandActor } from "@zeros/protocol/cloud-actors";
import { CloudAgentBootScopeSchema, CloudActorProvenanceSchema, CloudAgentCredentialRunInfoSchema,
  type CloudAgentCredentialRunInfo } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudLocalCommandMirrorBatchSchema, CloudLocalCommandMirrorAckSchema, cloudLocalCommandMirrorAckMatchesBatch,
  type CloudLocalCommandMirrorAck as VerifiedMirrorAck } from "@zeros/protocol/cloud-local-mirror";
import type { CloudActorAuthorityRegistry, CloudAuthorizedActor } from "./agents/cloud-agent-lease";
import { CloudLocalCommandHistorySchema, CloudLocalCommandHistoryHeadSchema, canonicalCloudLocalCommandHistoryJson,
  CloudLocalCommandHistoryManifestSchema, CloudLocalCommandHistoryRecordSchema, CloudLocalCommandHistoryPartSchema, CloudLocalCommandMirrorChangeSchema,
  cloudLocalCommandHistoryHeadMatchesManifest, CLOUD_LOCAL_COMMAND_HISTORY_BUNDLE_MAX_BYTES,
  type CloudLocalCommandHistoryHead, type CloudLocalCommandHistorySource,
  type CloudLocalCommandMirrorChange as SharedChange, type CloudLocalCommandMirrorBatch as SharedBatch,
  type CloudLocalCommandMirrorAck as SharedAck } from "@zeros/protocol/cloud-local-mirror";
import { CloudCommandRuntimeError } from "./cloud-command-client";
import { openSqlite } from "./db/sqlite";
import type { CloudLocalCommandHistoryCapture, CloudLocalCommandHistoryDocument } from "./cloud-local-command-queue-history";

// This store is selected only by the explicitly negotiated cloud mode. Local
// workspaces and legacy cloud generations keep their existing command source.
const uuid = z.uuid();
const identity = CloudBootCommandSnapshotSchema.shape.conversationId;
const sequence = z.number().int().safe().nonnegative();
const WriterSchema = CloudAgentBootScopeSchema;
export type CloudLocalCommandWriter = z.infer<typeof WriterSchema>;
const WatermarksSchema = z.object({ recordSequence: sequence, eventSequence: sequence }).strict();
export type CloudLocalCommandHistory = z.infer<typeof WatermarksSchema>;
const HistoryMutationSchema = WatermarksSchema.extend({ conversationId: identity, mutationId: uuid,
  operation: z.enum(["edit", "delete", "prune", "repair"]), deleted: z.boolean() }).strict();
export type CloudLocalCommandHistoryMutation = z.infer<typeof HistoryMutationSchema>;
type ActorProvenance = ReturnType<CloudActorAuthorityRegistry["authorizeCurrent"]>["provenance"];
type ActorAuthority = Pick<CloudActorAuthorityRegistry, "authorizeCurrent" | "reauthorizeRecorded">;

const localQueues = new WeakSet<object>();
export const isCloudLocalCommandQueue = (value: unknown): value is CloudLocalCommandQueue =>
  !!value && typeof value === "object" && localQueues.has(value);

const DEFAULT_LIMITS = { pending: 32, commands: 100_000, conversations: 10_000, operations: 200_000,
  promptBytes: 64 * 1024 * 1024, journalEntries: 4096, journalBytes: 64 * 1024 * 1024,
  historyBytes: 1024 * 1024 * 1024, historyJobs: 131_072 };
const MAX_CHANGE_BYTES = 256 * 1024;
const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_BATCH_ENTRIES = 32;
type Limits = typeof DEFAULT_LIMITS;
type CommandRow = { id: string; conversation_id: string; position: number; state: CloudBootCommandSnapshot["receipts"][number]["state"];
  payload: string | null; actor: string; user_message_id: string; agent_id: string; writer_epoch: string; generation: number;
  execution_id: string | null; claim_id: string | null; result: string | null; result_code: string | null;
  goal_revision: number | null; goal_sequence: number; created_at: string; updated_at: string;
  history: string | null; mirror_history_head: string | null; credential_run_info: string | null; mirror_dirty: number };
type ControlRow = { conversation_id: string; revision: number; paused: number; next_position: number; mirror_dirty: number };
export type CloudLocalCommandChange = SharedChange;
export type CloudLocalCommandMirrorBatch = SharedBatch;
export type CloudLocalCommandMirrorAck = SharedAck;

type Options = { file: string; scope: CloudLocalCommandWriter; actors: ActorAuthority; engineLive(): boolean;
  /** Must return a locally committed transcript/terminal watermark, never a CP
   * response. Settlement records it atomically with the exact native outcome. */
  history(result?: CloudCommandResult): CloudLocalCommandHistory;
  /** Synchronous capture from the existing NORMAL transcript DB. The FULL
   * transaction validates and retains all canonical bytes before publishing a
   * receipt/head. Missing capture is an explicit incomplete outcome. */
  captureHistory?(input: { scope: Readonly<CloudLocalCommandWriter>; conversationId: string;
    source: CloudLocalCommandHistorySource; nativeResult: unknown; restoreRevision: number;
    eventSequence: number; claimId: string | null }): CloudLocalCommandHistoryCapture;
  /** Only checks already confirmed cached authority/material. It cannot fetch
   * on Send. A desired-but-unready revision parks the queued intent. */
  ready(payload: CloudBootCommandClaim["payload"], actor: ActorProvenance, conversationId: string): boolean;
  /** Synchronous, engine-owned selection before the FULL dispatch marker.
   * A paused or unready source parks the intent without a native reservation. */
  selectExecution?(input: { commandId: string; claimId: string; conversationId: string;
    payload: CloudBootCommandClaim["payload"]; actor: CloudAuthorizedActor; candidateExecutionId: string }):
    { executionId: string; credentialRun?: CloudAgentCredentialRunInfo } | null;
  selectionRolledBack?(claimId: string): void;
  now?(): number; limits?: Partial<Limits> };

/** At-most-once dispatch within an immutable, CP-negotiated boot writer.
 * A missing/rolled-back ledger is not proof that an old intent never ran.
 * Nonterminal inherited intent is quarantined; only an explicit new intent can
 * run after inspection. Neither mirror loss nor Resume replays it.
 *
 * The dedicated engine-only database uses WAL/FULL. SQLite commits are durable
 * under the host filesystem's fsync contract; they cannot make native effects
 * atomic or survive arbitrary storage rollback/VM loss. Local DB settings and
 * legacy CP command dispatch are untouched. */
export class CloudLocalCommandQueue {
  readonly scope: Readonly<CloudLocalCommandWriter>;
  private readonly db: Sqlite.Database;
  private readonly limits: Limits;
  private readonly now: () => number;
  private closed = false;
  private claimsPaused = false;

  constructor(private readonly options: Options) {
    this.scope = Object.freeze(WriterSchema.parse(options.scope));
    this.now = options.now ?? Date.now;
    this.limits = { ...DEFAULT_LIMITS };
    for (const key of Object.keys(options.limits ?? {}) as Array<keyof Limits>) {
      const limit = options.limits![key];
      if (limit === undefined || !Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_LIMITS[key])
        throw new CloudCommandRuntimeError("invalid_command");
      this.limits[key] = limit;
    }
    this.db = openSqlite(options.file);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 25");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS local_command_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS local_command_controls(
          conversation_id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0,paused INTEGER NOT NULL DEFAULT 0,
          next_position INTEGER NOT NULL DEFAULT 1,mirror_dirty INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS local_commands(
          id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES local_command_controls(conversation_id),
          position INTEGER NOT NULL,state TEXT NOT NULL,payload TEXT,actor TEXT NOT NULL,user_message_id TEXT NOT NULL,agent_id TEXT NOT NULL,
          writer_epoch TEXT NOT NULL,generation INTEGER NOT NULL,execution_id TEXT,claim_id TEXT UNIQUE,
          result TEXT,result_code TEXT,goal_revision INTEGER,goal_sequence INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,updated_at TEXT NOT NULL,history TEXT,mirror_history_head TEXT,credential_run_info TEXT,mirror_dirty INTEGER NOT NULL DEFAULT 0,
          UNIQUE(conversation_id,position),UNIQUE(conversation_id,user_message_id));
        CREATE INDEX IF NOT EXISTS local_commands_queue ON local_commands(conversation_id,state,position);
        CREATE TABLE IF NOT EXISTS local_command_operations(
          id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,
          actor_sha256 TEXT NOT NULL,revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS local_command_journal(
          sequence INTEGER NOT NULL,writer_epoch TEXT NOT NULL,document TEXT NOT NULL,bytes INTEGER NOT NULL,
          PRIMARY KEY(writer_epoch,sequence));
        CREATE TABLE IF NOT EXISTS local_command_mirror_batches(
          writer_epoch TEXT PRIMARY KEY,batch_id TEXT NOT NULL,after_sequence INTEGER NOT NULL,through_sequence INTEGER NOT NULL,
          document TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS local_command_history_heads(conversation_id TEXT PRIMARY KEY,restore_revision INTEGER NOT NULL,document TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS local_command_history_mutations(mutation_id TEXT PRIMARY KEY,writer_epoch TEXT NOT NULL,
          conversation_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,history_head TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS local_command_history_documents(sha256 TEXT PRIMARY KEY,kind TEXT NOT NULL,document TEXT NOT NULL,bytes INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS local_command_outbox_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL,
          priority INTEGER NOT NULL,document TEXT NOT NULL,bytes INTEGER NOT NULL,history_manifest_sha256 TEXT);
        CREATE INDEX IF NOT EXISTS local_command_outbox_jobs_conversation ON local_command_outbox_jobs(conversation_id,priority,id);
        CREATE TABLE IF NOT EXISTS local_command_history_limits(conversation_id TEXT NOT NULL,sha256 TEXT NOT NULL,
          PRIMARY KEY(conversation_id,sha256));
      `);
      if (!(this.db.prepare("PRAGMA table_info(local_commands)").all() as { name: string }[]).some(column => column.name === "mirror_history_head"))
        this.db.exec("ALTER TABLE local_commands ADD COLUMN mirror_history_head TEXT");
      if (!(this.db.prepare("PRAGMA table_info(local_command_outbox_jobs)").all() as { name: string }[]).some(column => column.name === "history_manifest_sha256"))
        this.db.exec("ALTER TABLE local_command_outbox_jobs ADD COLUMN history_manifest_sha256 TEXT");
      this.transaction(() => {
        // Older retained ledgers have no read-fence counter. Seed them before
        // any recovery installs; a live populated ledger may never read as new.
        if (this.metadata("historyReadRevision") === null &&
            this.db.prepare("SELECT 1 FROM local_command_history_heads LIMIT 1").get())
          this.setMetadata("historyReadRevision", "1");
        this.readHistoryRevision();
        const previous = this.metadata("writer");
        if (previous) {
          const writer = WriterSchema.parse(JSON.parse(previous));
          if (writer.organizationId !== this.scope.organizationId || writer.workspaceId !== this.scope.workspaceId)
            throw new CloudCommandRuntimeError("engine_authority_rejected");
          if (writer.writerEpoch === this.scope.writerEpoch && this.metadata("sealedWriter") === this.scope.writerEpoch)
            throw new CloudCommandRuntimeError("cloud_command_writer_retired");
          // No process-start flag or self-reported checkpoint head is accepted
          // as continuity proof. Both queued and dispatching rows may be stale.
          const inherited = this.db.prepare("SELECT * FROM local_commands WHERE state IN ('queued','dispatching') ORDER BY conversation_id,position").all() as CommandRow[];
          for (const row of inherited) {
            const history = this.incompleteHistory(row, "recovery_uncertain");
            this.db.prepare("UPDATE local_commands SET state='uncertain',payload=NULL,result_code=?,history=?,updated_at=?,mirror_dirty=1 WHERE id=?")
              .run(row.state === "dispatching" ? "engine_interrupted" : "queue_recovery_required", canonicalCloudLocalCommandHistoryJson(history.history), this.timestamp(), row.id);
            this.db.prepare("UPDATE local_command_controls SET paused=1,revision=revision+1,mirror_dirty=1 WHERE conversation_id=?")
              .run(row.conversation_id);
          }
          if (writer.writerEpoch !== this.scope.writerEpoch) {
            // Old journal entries/batches remain inspectable in the artifact;
            // they are never published as the new writer's runnable state.
            this.setMetadata("mirrorHead", "0");
            this.setMetadata("journalHead", "0");
          }
        }
        this.setMetadata("writer", canonical(this.scope));
        this.setMetadata("schema", "1");
        this.materializeDirty();
      });
    } catch (error) { this.db.close(); this.closed = true; throw error; }
    localQueues.add(this);
  }

  private metadata(key: string): string | null {
    return (this.db.prepare("SELECT value FROM local_command_metadata WHERE key=?").get(key) as { value: string } | undefined)?.value ?? null;
  }
  private setMetadata(key: string, value: string): void {
    this.db.prepare("INSERT INTO local_command_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key,value);
  }
  private readHistoryRevision(): number {
    const value = this.metadata("historyReadRevision");
    if (value !== null && !/^(?:0|[1-9][0-9]*)$/.test(value))
      throw new CloudCommandRuntimeError("command_storage_unavailable");
    const revision = value === null ? 0 : Number(value);
    if (!Number.isSafeInteger(revision) || revision < 0 ||
        revision === 0 && this.db.prepare("SELECT 1 FROM local_command_history_heads LIMIT 1").get())
      throw new CloudCommandRuntimeError("command_storage_unavailable");
    return revision;
  }
  private timestamp(): string { return new Date(this.now()).toISOString(); }
  private transaction<T>(fn: () => T): T {
    try { return this.db.transaction(fn)(); }
    catch (error) { if (error instanceof CloudCommandRuntimeError) throw error; throw new CloudCommandRuntimeError("command_storage_unavailable"); }
  }
  private live(): void {
    if (this.closed || !this.options.engineLive()) throw new CloudCommandRuntimeError("engine_authority_rejected");
  }
  private actor(sessionId: string | undefined, capability: "read" | "run" | "edit"): ActorProvenance {
    if (!sessionId) throw new CloudCommandRuntimeError("cloud_actor_authority_rejected");
    try {
      const { provenance } = this.options.actors.authorizeCurrent(sessionId,capability);
      // The registry verifies actual owner/share/general-access grant identity,
      // revision and owner epoch; a role or the funding owner alone is not a
      // grant. Keep the confirmed provenance exact in the committed ledger.
      CloudActorProvenanceSchema.parse(provenance);
      if (canonical(provenance.scope) !== canonical(this.scope)) throw new Error("foreign scope");
      return provenance;
    } catch { throw new CloudCommandRuntimeError("cloud_actor_authority_rejected"); }
  }

  handle(raw: unknown, context: { writerEpoch: string; actorSessionId?: string }): unknown {
    this.live();
    if (context.writerEpoch !== this.scope.writerEpoch) throw new CloudCommandRuntimeError("cloud_command_writer_retired");
    // Canonicalize before parsing nested unknown bubble data to bound complexity
    // and reject cycles/prototype keys without leaking their content.
    canonical(raw);
    const engine = CloudBootCommandEngineRequestSchema.safeParse(raw);
    if (!engine.success) throw new CloudCommandRuntimeError("invalid_command");
    const value = engine.data;
    if (value.kind !== "read" && value.kind !== "snapshot") this.assertWriterWritable();
    if (value.kind === "claim" && !this.accepting) return null;
    if (value.kind === "mutate" && !this.accepting) throw new CloudCommandRuntimeError("cloud_command_writer_retired");
    if (value.kind === "claim") return this.claim(value);
    if (value.kind === "settle") return this.settle(value.result);
    if (value.kind === "confirm-goal") return this.confirmGoal(value);
    const input = value.kind === "mutate" ? { kind: value.kind, mutation: value.mutation } : value;
    const parsed = CloudBootCommandClientRequestSchema.safeParse(input);
    if (!parsed.success) throw new CloudCommandRuntimeError("invalid_command");
    const request = parsed.data;
    if (request.kind === "read") {
      this.actor(context.actorSessionId,"read");
      const row = this.row(request.commandId);
      if (!row) throw new CloudCommandRuntimeError("command_not_found");
      return { ...this.entry(row), conversationId: row.conversation_id };
    }
    if (request.kind === "snapshot") {
      this.actor(context.actorSessionId,"read");
      return this.transaction(() => this.snapshot(request.conversationId));
    }
    const actor = this.actor(context.actorSessionId,request.kind === "mutate" && request.mutation.action.kind === "edit" ? "edit" : "run");
    if (request.kind === "stop") return this.stop(request.conversationId,request.operationId,actor);
    if (value.kind !== "mutate" || ![null,"command_context_changed","command_not_found"].includes(value.admissionError))
      throw new CloudCommandRuntimeError("invalid_command");
    return this.mutate(request.mutation,actor,value.admissionError);
  }

  private control(conversationId: string): ControlRow {
    if (!identity.safeParse(conversationId).success) throw new CloudCommandRuntimeError("invalid_command");
    let row = this.db.prepare("SELECT * FROM local_command_controls WHERE conversation_id=?").get(conversationId) as ControlRow | undefined;
    if (!row) {
      if (this.count("local_command_controls") >= this.limits.conversations) throw new CloudCommandRuntimeError("command_limit");
      this.db.prepare("INSERT INTO local_command_controls(conversation_id) VALUES(?)").run(conversationId);
      row = { conversation_id: conversationId, revision: 0, paused: 0, next_position: 1, mirror_dirty: 0 };
    }
    if (row.revision >= Number.MAX_SAFE_INTEGER - 1 || row.next_position >= Number.MAX_SAFE_INTEGER - 1)
      throw new CloudCommandRuntimeError("command_limit");
    return row;
  }
  private count(table: "local_command_controls" | "local_command_operations" | "local_command_history_mutations" | "local_commands" | "local_command_journal", where = ""): number {
    return (this.db.prepare(`SELECT count(*) AS n FROM ${table} ${where}`).get() as { n: number }).n;
  }
  private row(commandId: string): CommandRow | undefined {
    return this.db.prepare("SELECT * FROM local_commands WHERE id=?").get(commandId) as CommandRow | undefined;
  }
  private entry(row: CommandRow): z.infer<typeof CloudBootCommandEntrySchema> {
    return CloudBootCommandEntrySchema.parse({ commandId: row.id, position: row.position, state: row.state,
      payload: row.state === "queued" || row.state === "dispatching" ? JSON.parse(row.payload!) : null,
      executionId: row.execution_id, generation: row.generation, resultCode: row.result_code,
      ...(row.result ? { result: JSON.parse(row.result) } : {}), createdAt: row.created_at, updatedAt: row.updated_at });
  }
  private goal(row: CommandRow): z.infer<typeof CloudGoalSnapshotSchema> | undefined {
    const result = row.result ? CloudNativeResultSchema.parse(JSON.parse(row.result)) : null;
    return result?.goal !== undefined ? { version: 1, conversationId: row.conversation_id, revision: row.goal_revision ?? 0, goal: result.goal } : undefined;
  }
  private snapshot(conversationId: string): CloudBootCommandSnapshot {
    const control = this.control(conversationId);
    const pending = this.db.prepare("SELECT * FROM local_commands WHERE conversation_id=? AND state IN ('queued','dispatching') ORDER BY position LIMIT 32")
      .all(conversationId) as CommandRow[];
    const receipts = this.db.prepare("SELECT * FROM local_commands WHERE conversation_id=? AND state NOT IN ('queued','dispatching') ORDER BY position DESC LIMIT 50")
      .all(conversationId) as CommandRow[];
    const latestGoal = this.db.prepare("SELECT * FROM local_commands WHERE conversation_id=? AND goal_revision IS NOT NULL ORDER BY goal_revision DESC LIMIT 1")
      .get(conversationId) as CommandRow | undefined;
    return CloudBootCommandSnapshotSchema.parse({ version: 1, conversationId, revision: control.revision, paused: Boolean(control.paused),
      pending: pending.map(row => this.entry(row)), receipts: receipts.reverse().map(row => this.entry(row)),
      ...(latestGoal ? { nativeGoal: this.goal(latestGoal) } : {}) });
  }
  private bump(conversationId: string): void {
    this.control(conversationId);
    this.db.prepare("UPDATE local_command_controls SET revision=revision+1 WHERE conversation_id=?").run(conversationId);
  }
  private actorHash(actor: ActorProvenance): string {
    const { userId, deviceId, deviceKeyVersion, fingerprint } = actor.actor;
    return hash({ userId, deviceId, deviceKeyVersion, fingerprint });
  }
  private replay(operationId: string, conversationId: string, content: unknown, actor: ActorProvenance): CloudBootCommandSnapshot | null {
    const row = this.db.prepare("SELECT * FROM local_command_operations WHERE id=?").get(operationId) as
      { conversation_id: string; request_sha256: string; actor_sha256: string } | undefined;
    if (!row) return null;
    if (row.conversation_id !== conversationId || row.request_sha256 !== hash(content) || row.actor_sha256 !== this.actorHash(actor))
      throw new CloudCommandRuntimeError("command_conflict");
    return { ...this.snapshot(conversationId), replayed: true };
  }
  private remember(operationId: string, conversationId: string, content: unknown, actor: ActorProvenance): void {
    this.db.prepare("INSERT INTO local_command_operations(id,conversation_id,request_sha256,actor_sha256,revision) VALUES(?,?,?,?,?)")
      .run(operationId,conversationId,hash(content),this.actorHash(actor),this.control(conversationId).revision);
  }
  private retainedBytes(): number {
    return (this.db.prepare("SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) AS n FROM local_commands").get() as { n: number }).n;
  }
  private mutableCapacity(): void {
    if (this.count("local_command_operations") + this.count("local_command_history_mutations") >= this.limits.operations || !this.journalCapacity(true))
      throw new CloudCommandRuntimeError("command_limit");
  }
  private mutate(mutation: CloudBootCommandMutation, actor: ActorProvenance, admissionError: string | null): CloudBootCommandSnapshot {
    const parsed = CloudBootCommandMutationSchema.parse(mutation);
    if (Buffer.byteLength(canonical(parsed)) > 192 * 1024) throw new CloudCommandRuntimeError("command_limit");
    return this.transaction(() => {
      const replay = this.replay(parsed.operationId,parsed.conversationId,parsed,actor);
      if (replay) return replay;
      if (admissionError) throw new CloudCommandRuntimeError(admissionError);
      const control = this.control(parsed.conversationId);
      if (control.revision !== parsed.expectedRevision) throw new CloudCommandRuntimeError("command_conflict");
      this.mutableCapacity();
      const action = parsed.action;
      let changed: CommandRow | undefined;
      if (action.kind === "enqueue" || action.kind === "fork" || action.kind === "edit") {
        const previous = action.kind === "edit" ? this.row(action.commandId) : undefined;
        const bytes = Buffer.byteLength(canonical(action.payload));
        if (this.retainedBytes() - (previous?.payload ? Buffer.byteLength(previous.payload) : 0) + bytes > this.limits.promptBytes)
          throw new CloudCommandRuntimeError("command_limit");
      }
      if (action.kind === "enqueue" || action.kind === "fork") {
        if (this.count("local_commands", "WHERE state IN ('queued','dispatching')") >= this.limits.pending ||
            this.count("local_commands") >= this.limits.commands) throw new CloudCommandRuntimeError("command_limit");
        const retained = this.db.prepare("SELECT coalesce(sum(bytes),0) AS n FROM local_command_history_documents").get() as { n: number };
        const pending = this.count("local_commands", "WHERE state IN ('queued','dispatching')");
        if (retained.n + (pending + 1) * CLOUD_LOCAL_COMMAND_HISTORY_BUNDLE_MAX_BYTES > this.limits.historyBytes)
          throw new CloudCommandRuntimeError("command_limit");
        const duplicate = this.db.prepare("SELECT 1 FROM local_commands WHERE id=? OR (conversation_id=? AND user_message_id=?)")
          .get(action.commandId,parsed.conversationId,action.payload.userMessageId);
        if (duplicate) throw new CloudCommandRuntimeError("command_conflict");
        const timestamp = this.timestamp();
        this.db.prepare(`INSERT INTO local_commands(id,conversation_id,position,state,payload,actor,user_message_id,agent_id,writer_epoch,generation,created_at,updated_at)
          VALUES(?,?,?,'queued',?,?,?,?,?,?,?,?)`).run(action.commandId,parsed.conversationId,control.next_position,
            canonical(action.payload),canonical(actor),action.payload.userMessageId,action.payload.agentId,this.scope.writerEpoch,this.scope.generation,timestamp,timestamp);
        this.db.prepare("UPDATE local_command_controls SET next_position=next_position+1 WHERE conversation_id=?").run(parsed.conversationId);
        changed = this.row(action.commandId)!;
      } else if (action.kind === "pause" || action.kind === "resume") {
        if (this.claimsPaused && action.kind === "resume") throw new CloudCommandRuntimeError("command_conflict");
        this.db.prepare("UPDATE local_command_controls SET paused=? WHERE conversation_id=?").run(action.kind === "pause" ? 1 : 0,parsed.conversationId);
      } else {
        const previous = this.row(action.commandId);
        if (!previous || previous.conversation_id !== parsed.conversationId || previous.state !== "queued" ||
          (action.kind === "edit" && action.payload.userMessageId !== previous.user_message_id)) throw new CloudCommandRuntimeError("command_conflict");
        this.db.prepare("UPDATE local_commands SET state=?,payload=?,actor=?,result_code=?,updated_at=?,history=? WHERE id=?")
          .run(action.kind === "edit" ? "queued" : "cancelled", action.kind === "edit" ? canonical(action.payload) : null,
            action.kind === "edit" ? canonical(actor) : previous.actor,action.kind === "remove" ? "removed_before_dispatch" : null,this.timestamp(),
            action.kind === "remove" ? canonicalCloudLocalCommandHistoryJson(this.incompleteHistory(previous, "capture_unavailable").history) : previous.history,action.commandId);
        changed = this.row(action.commandId)!;
      }
      this.bump(parsed.conversationId);
      this.remember(parsed.operationId,parsed.conversationId,parsed,actor);
      this.journal(parsed.conversationId,changed);
      return { ...this.snapshot(parsed.conversationId), replayed: false };
    });
  }
  private stop(conversationId: string, operationId: string, actor: ActorProvenance): CloudBootCommandSnapshot {
    const content = { kind: "stop", conversationId };
    return this.transaction(() => {
      const replay = this.replay(operationId,conversationId,content,actor);
      if (replay) return replay;
      const control = this.control(conversationId);
      const capacity = this.count("local_command_operations") < this.limits.operations;
      // Receipt exhaustion is permanent for new mutations. Repeated unrecorded
      // Stops are monotonic: they never unpause or cause unbounded row growth.
      if (capacity || !control.paused) {
        this.db.prepare("UPDATE local_command_controls SET paused=1 WHERE conversation_id=?").run(conversationId);
        this.bump(conversationId);
        if (capacity) this.remember(operationId,conversationId,content,actor);
        this.journal(conversationId,undefined,true);
      }
      return { ...this.snapshot(conversationId), replayed: false };
    });
  }
  private claim(input: Extract<CloudBootCommandEngineRequest, { kind: "claim" }>): CloudBootCommandClaim | null {
    if (!identity.safeParse(input.conversationId).success || !identity.safeParse(input.executionId).success ||
        (input.claimId !== undefined && !uuid.safeParse(input.claimId).success)) throw new CloudCommandRuntimeError("invalid_command");
    let selectedClaimId: string | null = null;
    try { return this.transaction(() => {
      if (input.claimId) {
        const previous = this.db.prepare("SELECT * FROM local_commands WHERE claim_id=?").get(input.claimId) as CommandRow | undefined;
        if (previous) {
          if (previous.conversation_id !== input.conversationId || previous.execution_id !== input.executionId || previous.writer_epoch !== this.scope.writerEpoch)
            throw new CloudCommandRuntimeError("command_conflict");
          return previous.state === "dispatching" ? this.claimView(previous) : null;
        }
      }
      if (this.claimsPaused) return null;
      const control = this.control(input.conversationId);
      if (this.db.prepare("SELECT 1 FROM local_commands WHERE conversation_id=? AND state='dispatching'").get(input.conversationId)) return null;
      const queued = this.db.prepare("SELECT * FROM local_commands WHERE conversation_id=? AND state='queued' ORDER BY position").all(input.conversationId) as CommandRow[];
      const row = queued.find(row => !control.paused || JSON.parse(row.payload!).operation?.kind === "goal");
      if (!row) return null;
      if (row.writer_epoch !== this.scope.writerEpoch) throw new CloudCommandRuntimeError("cloud_command_writer_retired");
      const provenance: ActorProvenance = JSON.parse(row.actor);
      // A revoked actor is still durably claimed and settled cancelled; an
      // authorized actor with a pending background credential update waits.
      let principal: CloudAuthorizedActor | null = null;
      try { principal = this.options.actors.reauthorizeRecorded(provenance,"run"); } catch { /* cancelled claim below */ }
      const authorized = principal !== null;
      if (authorized && !this.options.ready(JSON.parse(row.payload!),provenance,row.conversation_id)) return null;
      if (!this.journalCapacity(false)) return null;
      const claimId = input.claimId ?? randomUUID();
      const selected = principal && this.options.selectExecution ? this.options.selectExecution({ commandId: row.id,
        claimId, conversationId: row.conversation_id, payload: JSON.parse(row.payload!), actor: principal,
        candidateExecutionId: input.executionId }) : { executionId: input.executionId };
      if (!selected) return null;
      if (principal && this.options.selectExecution) selectedClaimId = claimId;
      if (!identity.safeParse(selected.executionId).success) throw new CloudCommandRuntimeError("command_conflict");
      const credentialRun = selected.credentialRun ? CloudAgentCredentialRunInfoSchema.parse(selected.credentialRun) : null;
      if (credentialRun && (credentialRun.bootId !== this.scope.bootId || credentialRun.writerEpoch !== this.scope.writerEpoch ||
          credentialRun.fundingOwnerUserId !== this.scope.fundingOwnerUserId || credentialRun.fundingOwnerEpoch !== this.scope.fundingOwnerEpoch ||
          credentialRun.provider !== row.agent_id)) throw new CloudCommandRuntimeError("command_conflict");
      this.db.prepare("UPDATE local_commands SET state='dispatching',execution_id=?,claim_id=?,credential_run_info=?,updated_at=? WHERE id=?")
        .run(selected.executionId,claimId,credentialRun ? canonical(credentialRun) : null,this.timestamp(),row.id);
      this.bump(input.conversationId);
      const claimed = this.row(row.id)!;
      this.journal(input.conversationId,claimed);
      return this.claimView(claimed);
    }); } catch (error) {
      if (selectedClaimId) this.options.selectionRolledBack?.(selectedClaimId);
      throw error;
    }
  }
  private claimView(row: CommandRow): CloudBootCommandClaim {
    let actor: CloudCommandActor | undefined;
    try {
      const provenance: ActorProvenance = JSON.parse(row.actor);
      const current = this.options.actors.reauthorizeRecorded(provenance,"run").provenance;
      if (canonical(current.scope) !== canonical(this.scope)) throw new Error("foreign actor");
      actor = CloudCommandActorSchema.parse(current.actor);
    } catch { /* A durable claim with denied authority is settled cancelled. */ }
    return CloudBootCommandClaimSchema.parse({ commandId: row.id, claimId: row.claim_id, conversationId: row.conversation_id,
      executionId: row.execution_id, payload: JSON.parse(row.payload!), dispatchAllowed: actor !== undefined, ...(actor ? { actor } : {}) });
  }

  /** Engine-private exact claim proof; execution IDs can be reused by warm
   * turns, so neither a native ID nor user-message ID alone is a lookup key. */
  authorizeClaim(value: CloudBootCommandClaim) {
    this.live(); const claim = CloudBootCommandClaimSchema.parse(value), row = this.row(claim.commandId);
    if (!row || row.state !== "dispatching" || row.writer_epoch !== this.scope.writerEpoch ||
        row.conversation_id !== claim.conversationId || row.claim_id !== claim.claimId || row.execution_id !== claim.executionId ||
        canonical(JSON.parse(row.payload!)) !== canonical(claim.payload)) throw new CloudCommandRuntimeError("command_conflict");
    try {
      const principal = this.options.actors.reauthorizeRecorded(JSON.parse(row.actor), "run");
      if (!claim.dispatchAllowed || !isDeepStrictEqual(principal.provenance.actor, claim.actor)) throw new Error("Actor changed");
      return principal;
    } catch { throw new CloudCommandRuntimeError("cloud_actor_authority_rejected"); }
  }
  private settle(input: CloudCommandResult): CloudBootCommandSnapshot {
    const parsed = z.object({ commandId: uuid, claimId: uuid, state: z.enum(["succeeded","failed","cancelled"]),
      resultCode: CloudBootCommandEntrySchema.shape.resultCode, result: CloudNativeResultSchema.optional() }).strict().safeParse(input);
    if (!parsed.success) throw new CloudCommandRuntimeError("invalid_command");
    const result = parsed.data;
    return this.transaction(() => {
      const row = this.row(result.commandId);
      if (!row || row.claim_id !== result.claimId || row.writer_epoch !== this.scope.writerEpoch) throw new CloudCommandRuntimeError("command_conflict");
      const previous = row.result ? CloudNativeResultSchema.parse(JSON.parse(row.result)) : null;
      const combined = previous || result.result ? { ...previous, ...result.result, version: 1 as const,
        ...(row.goal_revision !== null && previous?.goal !== undefined ? { goal: previous.goal } : {}) } : null;
      if (combined?.terminal) {
        const terminal = combined.terminal;
        if (terminal.commandId !== row.id || terminal.conversationId !== row.conversation_id || terminal.executionId !== row.execution_id ||
          terminal.turnId !== row.user_message_id || terminal.agentId !== row.agent_id ||
          terminal.status !== ({ succeeded: "completed", failed: "failed", cancelled: "cancelled" } as const)[result.state])
          throw new CloudCommandRuntimeError("command_conflict");
      }
      if (row.state !== "dispatching") {
        if (row.state !== result.state || row.result_code !== result.resultCode || canonical(previous) !== canonical(combined))
          throw new CloudCommandRuntimeError("command_conflict");
        return { ...this.snapshot(row.conversation_id), replayed: true };
      }
      const completed = { ...row, result: combined ? canonical(combined) : null };
      const publication = this.captureHistory(completed, result);
      if (combined && Buffer.byteLength(canonical(combined)) > 192 * 1024) throw new CloudCommandRuntimeError("command_limit");
      const goalRevision = combined?.goal !== undefined ? row.goal_revision ?? this.control(row.conversation_id).revision + 1 : null;
      this.db.prepare("UPDATE local_commands SET state=?,payload=NULL,result_code=?,result=?,goal_revision=?,history=?,mirror_history_head=?,updated_at=? WHERE id=?")
        .run(result.state,result.resultCode,combined ? canonical(combined) : null,goalRevision,canonicalCloudLocalCommandHistoryJson(publication.history),
          canonicalCloudLocalCommandHistoryJson(publication.mirrorHead),this.timestamp(),row.id);
      this.bump(row.conversation_id);
      this.journal(row.conversation_id,this.row(row.id)!,true);
      return { ...this.snapshot(row.conversation_id), replayed: false };
    });
  }
  /** Called with the genuine factory selection before a native launch. A later
   * cache update cannot change the account charged to this exact turn. */
  recordCredentialSelection(claim: CloudBootCommandClaim, value: CloudAgentCredentialRunInfo): void {
    this.live();
    const info = CloudAgentCredentialRunInfoSchema.parse(value);
    if (info.bootId !== this.scope.bootId || info.writerEpoch !== this.scope.writerEpoch || info.fundingOwnerUserId !== this.scope.fundingOwnerUserId ||
        info.fundingOwnerEpoch !== this.scope.fundingOwnerEpoch)
      throw new CloudCommandRuntimeError("command_conflict");
    this.transaction(() => {
      const row = this.row(claim.commandId);
      if (!row || row.state !== "dispatching" || row.claim_id !== claim.claimId || row.execution_id !== claim.executionId || row.writer_epoch !== this.scope.writerEpoch)
        throw new CloudCommandRuntimeError("command_conflict");
      if (row.credential_run_info) {
        if (row.credential_run_info !== canonical(info)) throw new CloudCommandRuntimeError("command_conflict");
        return;
      }
      const payload = JSON.parse(row.payload!) as CloudBootCommandClaim["payload"];
      if (payload.agentId !== info.provider) throw new CloudCommandRuntimeError("command_conflict");
      this.db.prepare("UPDATE local_commands SET credential_run_info=? WHERE id=?").run(canonical(info),row.id);
      this.bump(row.conversation_id);
      this.journal(row.conversation_id,this.row(row.id)!);
    });
  }
  private confirmGoal(input: Extract<CloudBootCommandEngineRequest, { kind: "confirm-goal" }>): z.infer<typeof CloudGoalSnapshotSchema> {
    const parsed = z.object({ kind: z.literal("confirm-goal"), commandId: uuid, claimId: uuid, sequence: sequence.positive(),
      goal: CloudGoalSnapshotSchema.shape.goal }).strict().safeParse(input);
    if (!parsed.success) throw new CloudCommandRuntimeError("invalid_command");
    return this.transaction(() => {
      const row = this.row(parsed.data.commandId);
      if (!row || row.claim_id !== input.claimId || row.writer_epoch !== this.scope.writerEpoch) throw new CloudCommandRuntimeError("command_conflict");
      const previous = row.result ? CloudNativeResultSchema.parse(JSON.parse(row.result)) : null;
      if (input.sequence <= row.goal_sequence) {
        if (input.sequence === row.goal_sequence && canonical(previous?.goal ?? null) !== canonical(input.goal)) throw new CloudCommandRuntimeError("command_conflict");
        return this.goal(row)!;
      }
      if (row.state !== "dispatching" || JSON.parse(row.payload!).agentId !== "codex" || !this.claimView(row).dispatchAllowed)
        throw new CloudCommandRuntimeError("command_conflict");
      this.mutableCapacity();
      const result = { ...previous, version: 1 as const, goal: input.goal };
      const revision = this.control(row.conversation_id).revision + 1;
      this.db.prepare("UPDATE local_commands SET result=?,goal_sequence=?,goal_revision=? WHERE id=?")
        .run(canonical(result),input.sequence,revision,row.id);
      this.bump(row.conversation_id);
      this.journal(row.conversation_id,this.row(row.id)!);
      return this.goal(this.row(row.id)!)!;
    });
  }

  private journalCapacity(reserve: boolean, bytes = MAX_CHANGE_BYTES, entries = 1): boolean {
    const used = this.db.prepare("SELECT count(*) AS entries,coalesce(sum(bytes),0) AS bytes FROM local_command_journal").get() as { entries: number; bytes: number };
    const reserveEntries = reserve ? this.limits.pending * 4 : 0;
    const reserveBytes = reserve ? this.limits.pending * MAX_CHANGE_BYTES * 2 : 0;
    return used.entries + entries + reserveEntries <= this.limits.journalEntries && used.bytes + bytes + reserveBytes <= this.limits.journalBytes;
  }
  private journal(conversationId: string, row?: CommandRow, essential = false): void {
    const control = this.control(conversationId);
    const next = Number(this.metadata("journalHead") ?? "0") + 1;
    if (!Number.isSafeInteger(next)) throw new CloudCommandRuntimeError("command_limit");
    const mirrorHead = row?.mirror_history_head ? CloudLocalCommandHistoryHeadSchema.parse(JSON.parse(row.mirror_history_head)) : null;
    const separateHead = mirrorHead && row?.history && canonicalCloudLocalCommandHistoryJson(mirrorHead.history) !== row.history;
    const change: CloudLocalCommandChange = { sequence: next, conversationId, revision: control.revision, paused: Boolean(control.paused),
      ...(row ? { originWriterEpoch: row.writer_epoch, entry: this.entry(row), actor: JSON.parse(row.actor),
        intent: { userMessageId: row.user_message_id, agentId: row.agent_id },
        ...(this.goal(row) ? { nativeGoal: this.goal(row) } : {}), ...(row.history ? { history: CloudLocalCommandHistorySchema.parse(JSON.parse(row.history)) } : {}),
        ...(separateHead ? {} : mirrorHead ? { historyHead: mirrorHead } :
          row.history && this.currentHistoryHead(conversationId)?.source.kind === "command" &&
          (this.currentHistoryHead(conversationId)!.source as Extract<CloudLocalCommandHistorySource, { kind: "command" }>).commandId === row.id
          ? { historyHead: this.currentHistoryHead(conversationId)! } : {}),
        ...(row.credential_run_info ? { credentialRun: CloudAgentCredentialRunInfoSchema.parse(JSON.parse(row.credential_run_info)) } : {}) } : {}) };
    const changes = [change, ...(separateHead ? [{ sequence: next + 1, conversationId, revision: control.revision,
      paused: !!control.paused, historyHead: mirrorHead! }] : [])];
    const documents = changes.map(value => canonicalCloudLocalCommandHistoryJson(value)), bytes = documents.reduce((sum,value) => sum + Buffer.byteLength(value),0);
    if (documents.some(value => Buffer.byteLength(value) > MAX_CHANGE_BYTES) || !Number.isSafeInteger(next + changes.length - 1))
      throw new CloudCommandRuntimeError("command_limit");
    if (!this.journalCapacity(false,bytes,changes.length)) {
      if (!essential) throw new CloudCommandRuntimeError("command_limit");
      // Preserve local Stop/terminal completion under backlog exhaustion. Dirty
      // rows are bounded by the ledger caps and get a fresh ordered journal
      // sequence before more general work is admitted after ACK frees capacity.
      this.db.prepare("UPDATE local_command_controls SET mirror_dirty=1 WHERE conversation_id=?").run(conversationId);
      if (row) this.db.prepare("UPDATE local_commands SET mirror_dirty=1 WHERE id=?").run(row.id);
      return;
    }
    documents.forEach((document,index) => this.db.prepare("INSERT INTO local_command_journal(sequence,writer_epoch,document,bytes) VALUES(?,?,?,?)")
      .run(next + index,this.scope.writerEpoch,document,Buffer.byteLength(document)));
    this.setMetadata("journalHead",String(next + changes.length - 1));
    this.db.prepare("UPDATE local_command_controls SET mirror_dirty=0 WHERE conversation_id=?").run(conversationId);
    if (row) this.db.prepare("UPDATE local_commands SET mirror_dirty=0 WHERE id=?").run(row.id);
  }
  private materializeDirty(): void {
    const rows = this.db.prepare("SELECT * FROM local_commands WHERE mirror_dirty=1 ORDER BY conversation_id,position").all() as CommandRow[];
    for (const row of rows) { if (!this.journalCapacity(false)) return; this.journal(row.conversation_id,row,true); }
    const controls = this.db.prepare("SELECT * FROM local_command_controls WHERE mirror_dirty=1 ORDER BY conversation_id").all() as ControlRow[];
    for (const control of controls) { if (!this.journalCapacity(false)) return; this.journal(control.conversation_id,undefined,true); }
  }
  currentHistoryHead(conversationId: string): CloudLocalCommandHistoryHead | null {
    this.live();
    const row = this.db.prepare("SELECT document FROM local_command_history_heads WHERE conversation_id=?").get(conversationId) as { document: string } | undefined;
    return row ? CloudLocalCommandHistoryHeadSchema.parse(JSON.parse(row.document)) : null;
  }
  /** Passive original-ledger fence for async NORMAL reads. Current-head
   * installation owns the counter in the same FULL transaction. */
  get historyReadRevision(): number {
    this.live(); return this.readHistoryRevision();
  }
  /** Exact durable CP ACK cursor, never the local journal or NORMAL head.
   * Reading it cannot assign a flight, renew authority or publish work. */
  get mirroredSequence(): number {
    this.live();
    const value = this.metadata("mirrorHead");
    if (value === null) return 0;
    if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value))
      throw new CloudCommandRuntimeError("command_storage_unavailable");
    const sequence = Number(value);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new CloudCommandRuntimeError("command_storage_unavailable");
    return sequence;
  }
  /** The engine calls this after an authorized NORMAL edit/delete commits and
   * before acknowledging it. No original mutation redactor is pinned here, so
   * the durable current head is honestly incomplete; native turn audit and
   * previously captured canonical bytes stay immutable. */
  publishHistoryMutation(raw: CloudLocalCommandHistoryMutation): CloudLocalCommandHistoryHead {
    this.assertWriterWritable();
    if (!this.accepting) throw new CloudCommandRuntimeError("cloud_command_writer_retired");
    const parsed = HistoryMutationSchema.safeParse(raw);
    if (!parsed.success) throw new CloudCommandRuntimeError("invalid_command");
    const input = parsed.data, requestSha256 = hash(input);
    return this.transaction(() => {
      const previous = this.db.prepare("SELECT * FROM local_command_history_mutations WHERE mutation_id=?").get(input.mutationId) as
        { writer_epoch: string; conversation_id: string; request_sha256: string; history_head: string } | undefined;
      if (previous) {
        if (previous.writer_epoch !== this.scope.writerEpoch || previous.conversation_id !== input.conversationId || previous.request_sha256 !== requestSha256)
          throw new CloudCommandRuntimeError("command_conflict");
        const head = CloudLocalCommandHistoryHeadSchema.parse(JSON.parse(previous.history_head));
        if (head.originWriterEpoch !== this.scope.writerEpoch || head.source.kind !== "mutation" || head.source.mutationId !== input.mutationId ||
            head.source.operation !== input.operation || head.deleted !== input.deleted || head.history.recordSequence !== input.recordSequence ||
            head.history.eventSequence !== input.eventSequence || !("incompleteReason" in head.history) || head.history.incompleteReason !== "capture_unavailable")
          throw new CloudCommandRuntimeError("command_storage_unavailable");
        return head;
      }
      const marks = WatermarksSchema.parse(this.options.history());
      if (marks.recordSequence !== input.recordSequence || marks.eventSequence !== input.eventSequence)
        throw new CloudCommandRuntimeError("command_conflict");
      this.mutableCapacity(); this.control(input.conversationId);
      const head = CloudLocalCommandHistoryHeadSchema.parse({ originWriterEpoch: this.scope.writerEpoch,
        source: { kind: "mutation", mutationId: input.mutationId, operation: input.operation }, deleted: input.deleted,
        history: { restoreRevision: this.nextRestoreRevision(input.conversationId), ...marks, incompleteReason: "capture_unavailable" } });
      const document = this.historyJobDocument({ historyHead: head });
      const jobs = this.db.prepare("SELECT count(*) AS n,coalesce(sum(bytes),0) AS bytes FROM local_command_outbox_jobs").get() as { n: number; bytes: number };
      if (jobs.n + 1 + this.limits.pending * 4 > this.limits.historyJobs ||
          jobs.bytes + Buffer.byteLength(document) + this.limits.pending * MAX_CHANGE_BYTES * 2 > this.limits.historyBytes)
        throw new CloudCommandRuntimeError("command_limit");
      this.saveHistoryHead(input.conversationId,head);
      this.historyJob(input.conversationId,{ historyHead: head });
      this.db.prepare("INSERT INTO local_command_history_mutations VALUES(?,?,?,?,?)").run(input.mutationId,this.scope.writerEpoch,input.conversationId,
        requestSha256,canonicalCloudLocalCommandHistoryJson(head));
      return head;
    });
  }
  private historySource(row: CommandRow): CloudLocalCommandHistorySource {
    return { kind: "command", commandId: row.id, intent: { userMessageId: row.user_message_id, agentId: row.agent_id },
      executionId: row.execution_id, nativeResultSha256: row.result ? createHash("sha256").update(canonicalCloudLocalCommandHistoryJson(JSON.parse(row.result))).digest("hex") : null };
  }
  private nextRestoreRevision(conversationId: string): number {
    const next = (this.currentHistoryHead(conversationId)?.history.restoreRevision ?? 0) + 1;
    if (!Number.isSafeInteger(next)) throw new CloudCommandRuntimeError("command_limit");
    return next;
  }
  private saveHistoryHead(conversationId: string, head: CloudLocalCommandHistoryHead): void {
    if (!this.db.inTransaction) throw new CloudCommandRuntimeError("command_storage_unavailable");
    const parsed = CloudLocalCommandHistoryHeadSchema.parse(head), previous = this.currentHistoryHead(conversationId);
    if (previous && (parsed.history.restoreRevision < previous.history.restoreRevision ||
        parsed.history.restoreRevision === previous.history.restoreRevision && canonicalCloudLocalCommandHistoryJson(parsed) !== canonicalCloudLocalCommandHistoryJson(previous)))
      throw new CloudCommandRuntimeError("command_conflict");
    const currentRevision = this.readHistoryRevision();
    if (previous && canonicalCloudLocalCommandHistoryJson(parsed) === canonicalCloudLocalCommandHistoryJson(previous)) return;
    const revision = currentRevision + 1;
    if (!Number.isSafeInteger(revision)) throw new CloudCommandRuntimeError("command_storage_unavailable");
    this.db.prepare(`INSERT INTO local_command_history_heads(conversation_id,restore_revision,document) VALUES(?,?,?)
      ON CONFLICT(conversation_id) DO UPDATE SET restore_revision=excluded.restore_revision,document=excluded.document`)
      .run(conversationId,parsed.history.restoreRevision,canonicalCloudLocalCommandHistoryJson(parsed));
    this.setMetadata("historyReadRevision",String(revision));
  }
  private incompleteHistory(row: CommandRow, reason: "capture_unavailable" | "recovery_uncertain", result?: CloudCommandResult): CloudLocalCommandHistoryHead {
    let known: CloudLocalCommandHistory | null = null;
    if (reason !== "recovery_uncertain") { try { known = WatermarksSchema.parse(this.options.history(result)); } catch { /* Unknown source remains explicit. */ } }
    const head = CloudLocalCommandHistoryHeadSchema.parse({ originWriterEpoch: row.writer_epoch, source: this.historySource(row), deleted: false,
      history: { restoreRevision: this.nextRestoreRevision(row.conversation_id), recordSequence: known?.recordSequence ?? null,
        eventSequence: known?.eventSequence ?? null, incompleteReason: reason } });
    this.saveHistoryHead(row.conversation_id,head); return head;
  }

  private document(sha256: string): { kind: "record" | "manifest"; document: string; bytes: number } | undefined {
    const saved = this.db.prepare("SELECT kind,document,bytes FROM local_command_history_documents WHERE sha256=?").get(sha256) as
      { kind: "record" | "manifest"; document: string; bytes: number } | undefined;
    if (!saved) return undefined;
    const parsed: unknown = JSON.parse(saved.document);
    if ((saved.kind !== "record" && saved.kind !== "manifest") || saved.bytes !== Buffer.byteLength(saved.document) ||
        createHash("sha256").update(saved.document).digest("hex") !== sha256 ||
        canonicalCloudLocalCommandHistoryJson(saved.kind === "record" ? CloudLocalCommandHistoryRecordSchema.parse(parsed) :
          CloudLocalCommandHistoryManifestSchema.parse(parsed)) !== saved.document)
      throw new CloudCommandRuntimeError("command_storage_unavailable");
    return saved;
  }
  private historyJobDocument(value: Pick<SharedChange, "historyPart" | "historyHead">): string {
    if (value.historyPart) {
      const part = CloudLocalCommandHistoryPartSchema.parse(value.historyPart);
      return canonicalCloudLocalCommandHistoryJson({ historyPart: { version: part.version, kind: part.kind, sha256: part.sha256,
        index: part.index, count: part.count, bytes: part.bytes } });
    }
    return canonicalCloudLocalCommandHistoryJson({ historyHead: CloudLocalCommandHistoryHeadSchema.parse(value.historyHead) });
  }
  private historyJob(conversationId: string, value: Pick<SharedChange, "historyPart" | "historyHead">, manifestSha256: string | null = null): void {
    const document = this.historyJobDocument(value), priority = value.historyHead && !("manifestSha256" in value.historyHead.history) ? 0 : 10;
    this.db.prepare("INSERT INTO local_command_outbox_jobs(conversation_id,priority,document,bytes,history_manifest_sha256) VALUES(?,?,?,?,?)")
      .run(conversationId,priority,document,Buffer.byteLength(document),manifestSha256);
  }
  /** All bytes, references and the known native result are checked before any
   * FULL publication. Capturing NORMAL rows cannot authorize a native replay. */
  private captureHistory(row: CommandRow, result: CloudCommandResult): { history: SharedChange["history"] & {};
    mirrorHead: CloudLocalCommandHistoryHead } {
    const fallback = (reason: "capture_unavailable" | "capture_conflict" | "history_limit") => {
      const head = this.incompleteHistory(row, "capture_unavailable", result);
      if (reason !== "capture_unavailable") {
        const changed = CloudLocalCommandHistoryHeadSchema.parse({ ...head, history: { ...head.history, incompleteReason: reason } });
        // The original fallback has not escaped this FULL transaction.
        this.db.prepare("DELETE FROM local_command_history_heads WHERE conversation_id=?").run(row.conversation_id);
        this.saveHistoryHead(row.conversation_id,changed); return { history: changed.history, mirrorHead: changed };
      }
      return { history: head.history, mirrorHead: head };
    };
    if (!this.options.captureHistory) return fallback("capture_unavailable");
    let capture: CloudLocalCommandHistoryCapture, documents: readonly CloudLocalCommandHistoryDocument[], head: CloudLocalCommandHistoryHead;
    try {
      const marks = WatermarksSchema.parse(this.options.history(result));
      const restoreRevision = this.nextRestoreRevision(row.conversation_id) + 1;
      if (!Number.isSafeInteger(restoreRevision)) throw new Error();
      capture = this.options.captureHistory({ scope: this.scope, conversationId: row.conversation_id, source: this.historySource(row),
        nativeResult: row.result ? JSON.parse(row.result) : null, restoreRevision, eventSequence: marks.eventSequence, claimId: row.claim_id });
      head = CloudLocalCommandHistoryHeadSchema.parse(capture.historyHead);
      if (head.originWriterEpoch !== row.writer_epoch || canonicalCloudLocalCommandHistoryJson(head.source) !== canonicalCloudLocalCommandHistoryJson(this.historySource(row)) ||
          head.history.restoreRevision !== restoreRevision || canonicalCloudLocalCommandHistoryJson(capture.nativeResult) !==
            canonicalCloudLocalCommandHistoryJson(row.result ? JSON.parse(row.result) : null)) throw new Error();
      if (!("manifestSha256" in head.history)) {
        if (capture.documents.length || capture.manifest) throw new Error();
        const after = WatermarksSchema.parse(this.options.history(result));
        if ((head.history.recordSequence !== null && (head.history.recordSequence !== after.recordSequence || marks.recordSequence !== after.recordSequence)) ||
            (head.history.eventSequence !== null && (head.history.eventSequence !== after.eventSequence || marks.eventSequence !== after.eventSequence))) throw new Error();
        this.saveHistoryHead(row.conversation_id,head); return { history: head.history, mirrorHead: head };
      }
      const after = WatermarksSchema.parse(this.options.history(result));
      if (!isDeepStrictEqual(marks,after) || head.history.recordSequence !== after.recordSequence || head.history.eventSequence !== after.eventSequence)
        throw new Error();
      const manifest = CloudLocalCommandHistoryManifestSchema.parse(capture.manifest);
      if (!isDeepStrictEqual(manifest.scope,this.scope) || manifest.conversationId !== row.conversation_id ||
          !cloudLocalCommandHistoryHeadMatchesManifest(head,manifest,head.history.manifestSha256)) throw new Error();
      documents = capture.documents;
      if (documents.length > 16_385 || new Set(documents.map(item => item.sha256)).size !== documents.length) throw new Error();
      const supplied = new Map<string, { kind: string; document: string; bytes: number }>();
      for (const item of documents) {
        if (item.kind !== "record" && item.kind !== "manifest") throw new Error();
        const bytes = Buffer.byteLength(item.canonicalDocument), sha256 = createHash("sha256").update(item.canonicalDocument).digest("hex");
        const decoded: unknown = JSON.parse(item.canonicalDocument);
        if (sha256 !== item.sha256 || canonicalCloudLocalCommandHistoryJson(decoded) !== item.canonicalDocument) throw new Error();
        const value = item.kind === "manifest" ? CloudLocalCommandHistoryManifestSchema.parse(decoded) : CloudLocalCommandHistoryRecordSchema.parse(decoded);
        if (value.conversationId !== row.conversation_id || canonicalCloudLocalCommandHistoryJson(value) !== item.canonicalDocument) throw new Error();
        const parts = item.parts.map(part => CloudLocalCommandHistoryPartSchema.parse(part));
        if (!parts.length || parts.length !== parts[0]!.count || parts.some((part,index) => part.kind !== item.kind || part.sha256 !== sha256 ||
            part.index !== index || part.bytes !== bytes || part.count !== parts.length) ||
            !Buffer.concat(parts.map(part => Buffer.from(part.data,"base64"))).equals(Buffer.from(item.canonicalDocument))) throw new Error();
        const old = this.document(sha256);
        if (old && (old.kind !== item.kind || old.document !== item.canonicalDocument || old.bytes !== bytes)) throw new Error();
        supplied.set(sha256,{ kind: item.kind, document: item.canonicalDocument, bytes });
      }
      const savedManifest = supplied.get(head.history.manifestSha256) ?? this.document(head.history.manifestSha256);
      if (!savedManifest || savedManifest.kind !== "manifest" || savedManifest.document !== canonicalCloudLocalCommandHistoryJson(manifest)) throw new Error();
      const refs = new Set(manifest.records.map(ref => ref.sha256)); refs.add(head.history.manifestSha256);
      if (documents.some(item => !refs.has(item.sha256))) throw new Error();
      let bundleBytes = savedManifest.bytes;
      for (const ref of manifest.records) {
        const bytes = supplied.get(ref.sha256) ?? this.document(ref.sha256);
        if (!bytes || bytes.kind !== "record") throw new Error();
        const record = CloudLocalCommandHistoryRecordSchema.parse(JSON.parse(bytes.document));
        if (record.conversationId !== row.conversation_id || record.entityKind !== ref.entityKind || record.entityId !== ref.entityId ||
            record.schemaVersion !== ref.schemaVersion || record.sourceRevision !== ref.sourceRevision || record.sourceRevision > manifest.recordSequence) throw new Error();
        bundleBytes += bytes.bytes;
      }
      if (bundleBytes > CLOUD_LOCAL_COMMAND_HISTORY_BUNDLE_MAX_BYTES) return fallback("history_limit");
      if ([...refs].some(sha256 => this.db.prepare("SELECT 1 FROM local_command_history_limits WHERE conversation_id=? AND sha256=?")
        .get(row.conversation_id,sha256))) return fallback("history_limit");
    } catch { return fallback("capture_conflict"); }
    const total = this.db.prepare("SELECT coalesce(sum(bytes),0) AS n FROM local_command_history_documents").get() as { n: number };
    const jobs = this.db.prepare("SELECT count(*) AS n,coalesce(sum(bytes),0) AS bytes FROM local_command_outbox_jobs").get() as { n: number; bytes: number };
    const added = documents.reduce((sum,item) => sum + (this.document(item.sha256) ? 0 : Buffer.byteLength(item.canonicalDocument)),0);
    const jobBytes = Buffer.byteLength(this.historyJobDocument({ historyHead: head })) + documents.reduce((sum,item) => sum +
      item.parts.reduce((count,part) => count + Buffer.byteLength(this.historyJobDocument({ historyPart: part })),0),0);
    // Bulk staging cannot consume the compact control/Stop metadata budget.
    // This reserve is separate from both CAS artifact bytes and the journal
    // reserve used later when assigning a stable flight.
    const controlJobs = this.limits.pending * 4, controlBytes = this.limits.pending * MAX_CHANGE_BYTES * 2;
    if (total.n + added > this.limits.historyBytes || jobs.bytes + jobBytes + controlBytes > this.limits.historyBytes ||
        jobs.n + documents.reduce((count,item) => count + item.parts.length,1) + controlJobs > this.limits.historyJobs) return fallback("history_limit");
    for (const item of documents) {
      this.db.prepare("INSERT OR IGNORE INTO local_command_history_documents(sha256,kind,document,bytes) VALUES(?,?,?,?)")
        .run(item.sha256,item.kind,item.canonicalDocument,Buffer.byteLength(item.canonicalDocument));
      for (const part of item.parts) this.historyJob(row.conversation_id,{ historyPart: part },"manifestSha256" in head.history ? head.history.manifestSha256 : null);
    }
    this.historyJob(row.conversation_id,{ historyHead: head },"manifestSha256" in head.history ? head.history.manifestSha256 : null);
    this.saveHistoryHead(row.conversation_id,head);
    // The receipt is immediate, while remote restore remains explicitly
    // incomplete until the immutable parts and final head reach CP.
    const mirrorHead = CloudLocalCommandHistoryHeadSchema.parse({ ...head, history: { restoreRevision: head.history.restoreRevision - 1,
      recordSequence: head.history.recordSequence, eventSequence: head.history.eventSequence, incompleteReason: "capture_unavailable" } });
    return { history: head.history, mirrorHead };
  }

  private verifyHistoryHead(conversationId: string, head: CloudLocalCommandHistoryHead): void {
    if (head.source.kind === "command") {
      const row = this.row(head.source.commandId);
      if (!row || row.conversation_id !== conversationId || row.writer_epoch !== head.originWriterEpoch ||
          canonicalCloudLocalCommandHistoryJson(this.historySource(row)) !== canonicalCloudLocalCommandHistoryJson(head.source))
        throw new CloudCommandRuntimeError("command_storage_unavailable");
    }
    if (!("manifestSha256" in head.history)) return;
    const saved = this.document(head.history.manifestSha256);
    if (!saved || saved.kind !== "manifest") throw new CloudCommandRuntimeError("command_storage_unavailable");
    const manifest = CloudLocalCommandHistoryManifestSchema.parse(JSON.parse(saved.document));
    if (manifest.conversationId !== conversationId || manifest.scope.organizationId !== this.scope.organizationId ||
        manifest.scope.workspaceId !== this.scope.workspaceId || !cloudLocalCommandHistoryHeadMatchesManifest(head,manifest,head.history.manifestSha256))
      throw new CloudCommandRuntimeError("command_storage_unavailable");
    let bytes = saved.bytes;
    for (const ref of manifest.records) {
      const document = this.document(ref.sha256);
      if (!document || document.kind !== "record") throw new CloudCommandRuntimeError("command_storage_unavailable");
      const record = CloudLocalCommandHistoryRecordSchema.parse(JSON.parse(document.document));
      if (record.conversationId !== conversationId || record.entityKind !== ref.entityKind || record.entityId !== ref.entityId ||
          record.schemaVersion !== ref.schemaVersion || record.sourceRevision !== ref.sourceRevision || ref.sourceRevision > manifest.recordSequence)
        throw new CloudCommandRuntimeError("command_storage_unavailable");
      bytes += document.bytes;
    }
    if (bytes > CLOUD_LOCAL_COMMAND_HISTORY_BUNDLE_MAX_BYTES) throw new CloudCommandRuntimeError("command_storage_unavailable");
  }

  /** Assign at most one next flight's bytes. Parts stay unsequenced until then,
   * so a different conversation's control cannot sit behind a 16 MiB prefix.
   * Assigned retries are immutable and retain their original sequence. */
  private materializeHistoryJobs(): void {
    const after = Number(this.metadata("mirrorHead") ?? "0");
    const pending = this.db.prepare("SELECT bytes FROM local_command_journal WHERE writer_epoch=? AND sequence>? ORDER BY sequence LIMIT ?")
      .all(this.scope.writerEpoch,after,MAX_BATCH_ENTRIES) as { bytes: number }[];
    let bytes = 512, entries = 0;
    for (const row of pending) { if (bytes + row.bytes > MAX_BATCH_BYTES) return; bytes += row.bytes; entries++; }
    type Job = { id: number; conversation_id: string; priority: number; document: string; bytes: number };
    const assign = (job: Job): boolean => {
      const control = this.control(job.conversation_id), next = Number(this.metadata("journalHead") ?? "0") + 1;
      if (!Number.isSafeInteger(next)) throw new CloudCommandRuntimeError("command_limit");
      if (job.bytes !== Buffer.byteLength(job.document)) throw new CloudCommandRuntimeError("command_storage_unavailable");
      const staged = JSON.parse(job.document);
      if (!staged || typeof staged !== "object" || Array.isArray(staged) || Object.hasOwn(staged,"sequence") ||
          (staged.conversationId !== undefined && staged.conversationId !== job.conversation_id) ||
          (staged.revision !== undefined && (!Number.isSafeInteger(staged.revision) || staged.revision < 0 || staged.revision > control.revision)) ||
          (staged.paused !== undefined && typeof staged.paused !== "boolean"))
        throw new CloudCommandRuntimeError("command_storage_unavailable");
      if (staged.historyPart) {
        const reference = staged.historyPart, saved = this.document(reference.sha256);
        if (!saved || JSON.parse(saved.document).conversationId !== job.conversation_id) throw new CloudCommandRuntimeError("command_storage_unavailable");
        const part = CloudLocalCommandHistoryPartSchema.parse({ ...reference, data: Buffer.from(saved.document)
          .subarray(reference.index * 128 * 1024,(reference.index + 1) * 128 * 1024).toString("base64") });
        if (part.kind !== saved.kind || part.bytes !== saved.bytes || (reference.data !== undefined && reference.data !== part.data))
          throw new CloudCommandRuntimeError("command_storage_unavailable");
        staged.historyPart = part;
      }
      const change = CloudLocalCommandMirrorChangeSchema.parse({ ...staged, sequence: next, conversationId: job.conversation_id,
        revision: control.revision, paused: !!control.paused });
      if (change.historyHead) this.verifyHistoryHead(job.conversation_id,change.historyHead);
      if (change.event) {
        const event = change.event, row = event.commandId ? this.row(event.commandId) : null;
        if (!row || row.conversation_id !== job.conversation_id || row.writer_epoch !== change.originWriterEpoch ||
            row.execution_id !== event.executionId || row.user_message_id !== event.turnId || row.agent_id !== event.frame.agentId ||
            (event.frame.chatId !== undefined && event.frame.chatId !== job.conversation_id))
          throw new CloudCommandRuntimeError("command_storage_unavailable");
      }
      const document = canonicalCloudLocalCommandHistoryJson(change), size = Buffer.byteLength(document);
      if (bytes + size > MAX_BATCH_BYTES || !this.journalCapacity(job.priority !== 0,size)) return false;
      this.db.prepare("INSERT INTO local_command_journal(sequence,writer_epoch,document,bytes) VALUES(?,?,?,?)")
        .run(next,this.scope.writerEpoch,document,size);
      this.setMetadata("journalHead",String(next));
      this.db.prepare("DELETE FROM local_command_outbox_jobs WHERE id=?").run(job.id);
      bytes += size; entries++; return true;
    };
    // Compact controls/current incomplete heads consume their reserved metadata
    // capacity before bulk. They never reorder an already persisted flight.
    const controls = this.db.prepare("SELECT * FROM local_command_outbox_jobs WHERE priority=0 ORDER BY id LIMIT ?")
      .all(MAX_BATCH_ENTRIES) as Job[];
    for (const job of controls) { if (entries >= MAX_BATCH_ENTRIES || !assign(job)) return; }
    // Choose bounded prefixes per conversation, not the first 128 global jobs.
    // The persistent round-robin cursor also prevents long older chats from
    // starving later chats when more than one flight's conversations are ready.
    const cursor = this.metadata("historyJobCursor") ?? "";
    const conversations = this.db.prepare(`SELECT DISTINCT conversation_id FROM local_command_outbox_jobs WHERE priority>0
      ORDER BY CASE WHEN conversation_id>? THEN 0 ELSE 1 END,conversation_id LIMIT 128`).all(cursor) as { conversation_id: string }[];
    const prefixes = conversations.map(({ conversation_id }) => ({ conversationId: conversation_id,
      jobs: this.db.prepare("SELECT id FROM local_command_outbox_jobs WHERE conversation_id=? AND priority>0 ORDER BY priority,id LIMIT 4")
        .all(conversation_id) as { id: number }[], blocked: false }));
    for (let round = 0; round < 4; round++) for (const prefix of prefixes) {
      if (entries >= MAX_BATCH_ENTRIES) return;
      if (prefix.blocked || !prefix.jobs[round]) continue;
      if (round === 0) this.setMetadata("historyJobCursor",prefix.conversationId);
      const job = this.db.prepare("SELECT * FROM local_command_outbox_jobs WHERE id=?").get(prefix.jobs[round]!.id) as Job;
      // Failure to fit fences this conversation's entire remaining prefix.
      // A smaller manifest/head must never skip its own unsubmitted part.
      if (!assign(job)) prefix.blocked = true;
    }
  }

  /** Called only inside the exact persisted flight's FULL ACK transaction.
   * Remote quota is current restore authority, not an edit to the native audit. */
  private applyMirrorHistoryLimits(batch: SharedBatch, limits: NonNullable<SharedAck["historyLimits"]>): void {
    if (!this.db.inTransaction || !cloudLocalCommandMirrorAckMatchesBatch({ version: 1, writerEpoch: this.scope.writerEpoch,
      batchId: batch.batchId, through: batch.through, historyLimits: limits },batch)) throw new CloudCommandRuntimeError("command_response_invalid");
    for (const limit of limits) {
      this.db.prepare("INSERT OR IGNORE INTO local_command_history_limits(conversation_id,sha256) VALUES(?,?)").run(limit.conversationId,limit.sha256);
      const previous = this.currentHistoryHead(limit.conversationId);
      const candidates = this.db.prepare(`SELECT DISTINCT coalesce(history_manifest_sha256,json_extract(document,'$.historyHead.history.manifestSha256')) AS sha256
        FROM local_command_outbox_jobs WHERE conversation_id=? AND
        (history_manifest_sha256 IS NOT NULL OR json_extract(document,'$.historyHead.history.manifestSha256') IS NOT NULL)`).all(limit.conversationId) as { sha256: string }[];
      if (previous && "manifestSha256" in previous.history) candidates.push({ sha256: previous.history.manifestSha256 });
      let currentAffected = false;
      // Feedback can arrive after a newer complete or incomplete head was
      // captured. Retire only the rejected bundles, including their final
      // heads; an unrelated newer snapshot and compact controls stay intact.
      for (const sha256 of new Set(candidates.map(candidate => candidate.sha256))) {
        const saved = this.document(sha256);
        if (!saved || saved.kind !== "manifest") throw new CloudCommandRuntimeError("command_storage_unavailable");
        const manifest = CloudLocalCommandHistoryManifestSchema.parse(JSON.parse(saved.document));
        if (manifest.conversationId !== limit.conversationId || manifest.scope.organizationId !== this.scope.organizationId ||
            manifest.scope.workspaceId !== this.scope.workspaceId) throw new CloudCommandRuntimeError("command_storage_unavailable");
        if (sha256 !== limit.sha256 && manifest.records.every(ref => ref.sha256 !== limit.sha256)) continue;
        if (previous && "manifestSha256" in previous.history && previous.history.manifestSha256 === sha256) currentAffected = true;
        this.db.prepare("DELETE FROM local_command_outbox_jobs WHERE conversation_id=? AND history_manifest_sha256=?").run(limit.conversationId,sha256);
        // Compatibility with already staged jobs before the private reference
        // column existed. Their immutable manifest is still digest-verified.
        for (const ref of [sha256,...manifest.records.map(record => record.sha256)]) this.db.prepare(`DELETE FROM local_command_outbox_jobs
          WHERE conversation_id=? AND history_manifest_sha256 IS NULL AND
          (json_extract(document,'$.historyPart.sha256')=? OR json_extract(document,'$.historyHead.history.manifestSha256')=?)`)
          .run(limit.conversationId,ref,ref);
      }
      this.db.prepare("DELETE FROM local_command_outbox_jobs WHERE conversation_id=? AND json_extract(document,'$.historyPart.sha256')=?")
        .run(limit.conversationId,limit.sha256);
      if (!previous || !currentAffected) continue;
      const head = CloudLocalCommandHistoryHeadSchema.parse({ ...previous, history: { restoreRevision: this.nextRestoreRevision(limit.conversationId),
        recordSequence: previous.history.recordSequence, eventSequence: previous.history.eventSequence, incompleteReason: "history_limit" } });
      this.saveHistoryHead(limit.conversationId,head);
      this.historyJob(limit.conversationId,{ historyHead: head });
    }
  }

  peekMirrorBatch(): CloudLocalCommandMirrorBatch | null {
    this.live();
    return this.transaction(() => {
      const previous = this.db.prepare("SELECT document FROM local_command_mirror_batches WHERE writer_epoch=?").get(this.scope.writerEpoch) as { document: string } | undefined;
      if (previous) return JSON.parse(previous.document);
      this.materializeDirty();
      this.materializeHistoryJobs();
      const after = Number(this.metadata("mirrorHead") ?? "0");
      const rows = this.db.prepare("SELECT sequence,document,bytes FROM local_command_journal WHERE writer_epoch=? AND sequence>? ORDER BY sequence LIMIT ?")
        .all(this.scope.writerEpoch,after,MAX_BATCH_ENTRIES + 1) as Array<{ sequence: number; document: string; bytes: number }>;
      if (!rows.length) return null;
      const changes: CloudLocalCommandChange[] = [];
      let bytes = 512;
      for (let index = 0; index < rows.length && changes.length < MAX_BATCH_ENTRIES; index++) {
        const row = rows[index]!;
        if (row.sequence !== after + changes.length + 1) throw new CloudCommandRuntimeError("command_storage_unavailable");
        const change: SharedChange = JSON.parse(row.document);
        const paired = change.entry && !["queued","dispatching"].includes(change.entry.state) && change.history &&
          "manifestSha256" in change.history && !change.historyHead;
        const following = paired ? rows[index + 1] : undefined;
        if (paired && (!following || following.sequence !== row.sequence + 1)) throw new CloudCommandRuntimeError("command_storage_unavailable");
        if (bytes + row.bytes + (following?.bytes ?? 0) > MAX_BATCH_BYTES || changes.length + (paired ? 2 : 1) > MAX_BATCH_ENTRIES) break;
        changes.push(change); bytes += row.bytes;
        if (following) { changes.push(JSON.parse(following.document)); bytes += following.bytes; index++; }
      }
      const batch: CloudLocalCommandMirrorBatch = { version: 1, bootId: this.scope.bootId, writerEpoch: this.scope.writerEpoch,
        batchId: randomUUID(), after, through: changes.at(-1)!.sequence, changes };
      CloudLocalCommandMirrorBatchSchema.parse(batch);
      this.db.prepare("INSERT INTO local_command_mirror_batches(writer_epoch,batch_id,after_sequence,through_sequence,document) VALUES(?,?,?,?,?)")
        .run(this.scope.writerEpoch,batch.batchId,after,batch.through,canonicalCloudLocalCommandHistoryJson(batch));
      return batch;
    });
  }
  acknowledgeMirror(value: VerifiedMirrorAck): void {
    this.live();
    const parsed = CloudLocalCommandMirrorAckSchema.safeParse(value);
    if (!parsed.success || parsed.data.writerEpoch !== this.scope.writerEpoch) throw new CloudCommandRuntimeError("command_response_invalid");
    this.transaction(() => {
      const row = this.db.prepare("SELECT batch_id,after_sequence,through_sequence,document FROM local_command_mirror_batches WHERE writer_epoch=?").get(this.scope.writerEpoch) as
        { batch_id: string; after_sequence: number; through_sequence: number; document: string } | undefined;
      let document: unknown;
      try { document = row && row.document.length <= MAX_BATCH_BYTES ? JSON.parse(row.document) : null; }
      catch { throw new CloudCommandRuntimeError("command_response_invalid"); }
      const batch = CloudLocalCommandMirrorBatchSchema.safeParse(document);
      if (!row || !batch.success || batch.data.bootId !== this.scope.bootId || batch.data.writerEpoch !== this.scope.writerEpoch ||
          batch.data.batchId !== row.batch_id || batch.data.after !== row.after_sequence || batch.data.through !== row.through_sequence ||
          batch.data.after !== Number(this.metadata("mirrorHead") ?? "0") || !cloudLocalCommandMirrorAckMatchesBatch(parsed.data, batch.data) ||
          batch.data.changes.some(change => change.entry && ["queued", "dispatching"].includes(change.entry.state) &&
            (!change.actor || !isDeepStrictEqual(change.actor.scope, this.scope) || change.entry.generation !== this.scope.generation)))
        throw new CloudCommandRuntimeError("command_response_invalid");
      // Feedback publishes a separate current head inside this same FULL
      // transaction; the immutable native audit and exact flight stay intact
      // if any later cursor/prune step fails.
      if (parsed.data.historyLimits?.length) this.applyMirrorHistoryLimits(batch.data, parsed.data.historyLimits);
      this.setMetadata("mirrorHead",String(parsed.data.through));
      this.db.prepare("DELETE FROM local_command_journal WHERE writer_epoch=? AND sequence<=?").run(this.scope.writerEpoch,parsed.data.through);
      this.db.prepare("DELETE FROM local_command_mirror_batches WHERE writer_epoch=?").run(this.scope.writerEpoch);
      this.materializeDirty();
    });
  }
  mirrorDrained(): boolean {
    if (this.closed) return false;
    return !this.db.prepare("SELECT 1 FROM local_command_journal WHERE writer_epoch=? LIMIT 1").get(this.scope.writerEpoch) &&
      !this.db.prepare("SELECT 1 FROM local_commands WHERE mirror_dirty=1 LIMIT 1").get() &&
      !this.db.prepare("SELECT 1 FROM local_command_controls WHERE mirror_dirty=1 LIMIT 1").get() &&
      !this.db.prepare("SELECT 1 FROM local_command_outbox_jobs LIMIT 1").get();
  }
  pauseClaims(): void { this.claimsPaused = true; }
  resumeClaims(): void { this.live(); if (this.accepting) this.claimsPaused = false; }
  get accepting(): boolean {
    this.live(); return this.metadata("acceptanceFenced") !== this.scope.writerEpoch && this.metadata("sealedWriter") !== this.scope.writerEpoch;
  }
  /** A frozen writer can still serve exact passive receipts/replay. No native
   * callback, late control or terminal publication may change its seal. */
  assertWriterWritable(): void {
    this.live();
    if (this.metadata("sealedWriter") === this.scope.writerEpoch) throw new CloudCommandRuntimeError("cloud_command_writer_retired");
  }
  fenceAcceptance(): void {
    this.live(); this.claimsPaused = true;
    this.transaction(() => {
      if (this.metadata("acceptanceFenced") === this.scope.writerEpoch) return;
      this.assertWriterWritable(); this.setMetadata("acceptanceFenced",this.scope.writerEpoch);
      // A stopped generation never supplies runnable claims to its successor.
      // Preserve exact intent/audit, and expose held work as explicitly
      // uncertain rather than treating mirror absence as non-execution proof.
      const rows = this.db.prepare("SELECT * FROM local_commands WHERE state='queued' AND writer_epoch=?").all(this.scope.writerEpoch) as CommandRow[];
      for (const row of rows) {
        const history = this.incompleteHistory(row,"recovery_uncertain");
        this.db.prepare("UPDATE local_commands SET state='uncertain',payload=NULL,result_code='queue_recovery_required',history=?,updated_at=?,mirror_dirty=1 WHERE id=?")
          .run(canonicalCloudLocalCommandHistoryJson(history.history),this.timestamp(),row.id);
        this.db.prepare("UPDATE local_command_controls SET paused=1,revision=revision+1,mirror_dirty=1 WHERE conversation_id=?").run(row.conversation_id);
      }
      this.materializeDirty();
    });
  }
  durability(): { journalMode: "wal"; synchronous: "full" } {
    const journal = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const durability = this.db.prepare("PRAGMA synchronous").get() as { synchronous: number };
    if (journal.journal_mode !== "wal" || durability.synchronous !== 2) throw new CloudCommandRuntimeError("command_storage_unavailable");
    return { journalMode: "wal", synchronous: "full" };
  }
  /** Only internal companion stores may attach to this original handle. A
   * copied SQLite file with identical writer metadata is another ledger. */
  ownsDatabase(file: string): boolean {
    try {
      this.live();
      const main = (this.db.prepare("PRAGMA database_list").all() as { name: string; file: string }[]).find(row => row.name === "main");
      return !!main?.file && realpathSync(main.file) === realpathSync(file);
    } catch { return false; }
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}

function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function canonical(value: unknown, budget = { nodes: 0 }, depth = 0): string {
  if (++budget.nodes > 20_000 || depth > 24) throw new CloudCommandRuntimeError("invalid_command");
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item,budget,depth+1)).join(",")}]`;
  if (!value || typeof value !== "object" || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new CloudCommandRuntimeError("invalid_command");
  return `{${Object.keys(value).sort().map(key => {
    if (key.length > 256 || ["__proto__","prototype","constructor"].includes(key)) throw new CloudCommandRuntimeError("invalid_command");
    return `${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key],budget,depth+1)}`;
  }).join(",")}}`;
}
