import type Sqlite from "better-sqlite3";
import { isDeepStrictEqual } from "node:util";
import type { BridgeMessage } from "@zeros/protocol/messages";
import { CloudAgentBootConversationSchema, CloudAgentBootIdentitySchema, CloudAgentCredentialRunInfoSchema,
  type CloudAgentBootConversation } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudBootCommandClaimSchema, type CloudBootCommandClaim } from "@zeros/protocol/cloud-commands";
import { CloudAgentCredentialActualUseSchema, CloudCompactControlFrameSchema, CloudEventReplayResultSchema,
  type CloudAgentCredentialActualUse, type CloudCompactControlFrame, type CloudEventCursor } from "@zeros/protocol/cloud-events";
import { canonicalCloudLocalCommandHistoryJson, CloudCompactControlEventSchema, CloudLocalCommandMirrorChangeSchema,
  type CloudCompactControlEvent } from "@zeros/protocol/cloud-local-mirror";
import { CloudLocalCommandQueue, isCloudLocalCommandQueue } from "./cloud-local-command-queue";
import { CloudEventRuntimeError } from "./cloud-event-client";
import { openSqlite } from "./db/sqlite";

const stores = new WeakSet<object>();
export const isCloudLocalCommandEventStore = (value: unknown): value is CloudLocalCommandEventStore =>
  !!value && typeof value === "object" && stores.has(value);
const MAX_BYTES = 64 * 1024 * 1024;
const CONTROL_TYPES = new Set(["AGENT_PERMISSION_REQUEST", "AGENT_PERMISSION_SETTLED", "AGENT_QUESTION_REQUEST", "AGENT_QUESTION_SETTLED"]);
type Owner = { resolver_id: string; kind: "permission" | "question"; command_id: string; claim_id: string;
  conversation_id: string; execution_id: string; turn_id: string; agent_id: string; settled: number };
type Command = { id: string; claim_id: string | null; execution_id: string | null; conversation_id: string; user_message_id: string;
  agent_id: string; writer_epoch: string; state: string; payload: string | null; actor: string; credential_run_info: string | null };

/** The same engine-private WAL/FULL database owns acceptance, replay and the
 * compact outbox. A local live cursor never means a CP mirror watermark. */
export class CloudLocalCommandEventStore {
  private readonly db: Sqlite.Database;
  private closed = false;
  private readonly maxEntries: number;
  readonly streamId: string;
  constructor(private readonly options: { file: string; queue: CloudLocalCommandQueue; engineLive(): boolean;
    maxEntries?: number; changed?(): void }) {
    if (!isCloudLocalCommandQueue(options.queue) || !options.queue.ownsDatabase(options.file)) throw new CloudEventRuntimeError("engine_authority_rejected");
    options.queue.durability();
    this.maxEntries = options.maxEntries ?? 8192;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > 8192)
      throw new CloudEventRuntimeError("invalid_event");
    this.streamId = options.queue.scope.engineInstanceId;
    this.db = openSqlite(options.file, { fileMustExist: true });
    try {
      this.db.pragma("synchronous = FULL"); this.db.pragma("busy_timeout = 25");
      this.assertLive();
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS local_command_streams(stream_id TEXT PRIMARY KEY,writer_epoch TEXT NOT NULL,
          head INTEGER NOT NULL,first_retained INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS local_command_events(stream_id TEXT NOT NULL,sequence INTEGER NOT NULL,frame TEXT NOT NULL,bytes INTEGER NOT NULL,
          PRIMARY KEY(stream_id,sequence));
        CREATE TABLE IF NOT EXISTS local_command_control_owners(resolver_id TEXT PRIMARY KEY,kind TEXT NOT NULL,command_id TEXT NOT NULL,
          claim_id TEXT NOT NULL,conversation_id TEXT NOT NULL,execution_id TEXT NOT NULL,turn_id TEXT NOT NULL,agent_id TEXT NOT NULL,settled INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS local_command_compact_controls(stream_id TEXT NOT NULL,sequence INTEGER NOT NULL,conversation_id TEXT NOT NULL,
          document TEXT NOT NULL,PRIMARY KEY(stream_id,sequence));
        CREATE TABLE IF NOT EXISTS local_command_credential_uses(command_id TEXT PRIMARY KEY,claim_id TEXT NOT NULL,conversation_id TEXT NOT NULL,
          provider TEXT NOT NULL,first_use_sequence INTEGER NOT NULL,document TEXT NOT NULL);
      `);
      this.db.prepare("INSERT OR IGNORE INTO local_command_streams VALUES(?,?,0,1)").run(this.streamId, options.queue.scope.writerEpoch);
      const stream = this.db.prepare("SELECT writer_epoch FROM local_command_streams WHERE stream_id=?").get(this.streamId) as { writer_epoch: string };
      if (stream.writer_epoch !== options.queue.scope.writerEpoch) throw new CloudEventRuntimeError("event_stream_changed");
      stores.add(this);
    } catch (error) { this.db.close(); throw error; }
  }
  private assertLive(): void {
    if (this.closed || !this.options.engineLive() || !this.options.queue.ownsDatabase(this.options.file)) throw new CloudEventRuntimeError("engine_authority_rejected");
    const writer = this.db.prepare("SELECT value FROM local_command_metadata WHERE key='writer'").get() as { value: string } | undefined;
    const journal = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const synchronous = this.db.prepare("PRAGMA synchronous").get() as { synchronous: number };
    if (!writer || !isDeepStrictEqual(JSON.parse(writer.value), this.options.queue.scope) ||
        journal.journal_mode !== "wal" || synchronous.synchronous !== 2)
      throw new CloudEventRuntimeError("engine_authority_rejected");
  }
  get head(): number {
    this.assertLive();
    return (this.db.prepare("SELECT head FROM local_command_streams WHERE stream_id=?").get(this.streamId) as { head: number }).head;
  }
  /** A flushed legacy prefix can be cut over only as an explicit missing
   * replay prefix; its absence never becomes reconstructed event evidence. */
  adoptSequence(sequence: number): void {
    this.assertLive();
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new CloudEventRuntimeError("invalid_event");
    if (sequence <= this.head) return;
    if (this.head !== 0) throw new CloudEventRuntimeError("event_conflict");
    this.db.prepare("UPDATE local_command_streams SET head=?,first_retained=? WHERE stream_id=?").run(sequence,sequence + 1,this.streamId);
  }
  private command(claim: CloudBootCommandClaim, dispatching = true): Command {
    CloudBootCommandClaimSchema.parse(claim);
    const row = this.db.prepare("SELECT * FROM local_commands WHERE id=?").get(claim.commandId) as Command | undefined;
    if (!row || row.claim_id !== claim.claimId || row.execution_id !== claim.executionId || row.conversation_id !== claim.conversationId ||
        row.user_message_id !== claim.payload.userMessageId || row.agent_id !== claim.payload.agentId || row.writer_epoch !== this.options.queue.scope.writerEpoch ||
        dispatching && row.state !== "dispatching" || !isDeepStrictEqual(JSON.parse(row.actor).actor, claim.actor) ||
        row.payload && !isDeepStrictEqual(JSON.parse(row.payload),claim.payload)) throw new CloudEventRuntimeError("event_conflict");
    return row;
  }
  bindControlOwner(resolverId: string, kind: "permission" | "question", claim: CloudBootCommandClaim): void {
    this.assertLive(); this.command(claim);
    if (!resolverId || resolverId.length > 128) throw new CloudEventRuntimeError("invalid_event");
    const owner: Owner = { resolver_id: resolverId,kind,command_id: claim.commandId,claim_id: claim.claimId,
      conversation_id: claim.conversationId,execution_id: claim.executionId,turn_id: claim.payload.userMessageId,agent_id: claim.payload.agentId,settled: 0 };
    const previous = this.db.prepare("SELECT * FROM local_command_control_owners WHERE resolver_id=?").get(resolverId) as Owner | undefined;
    if (previous) {
      if (!isDeepStrictEqual(previous,owner)) throw new CloudEventRuntimeError("event_conflict");
      return;
    }
    if ((this.db.prepare("SELECT count(*) AS n FROM local_command_control_owners").get() as { n: number }).n >= 8192)
      throw new CloudEventRuntimeError("event_buffer_exhausted");
    this.db.prepare("INSERT INTO local_command_control_owners VALUES(?,?,?,?,?,?,?,?,?)").run(...Object.values(owner));
  }
  credentialUse(claim: CloudBootCommandClaim, binding: CloudAgentBootConversation,
    nativeStage: "native_write" | "sdk_run_created"): CloudAgentCredentialActualUse | null {
    this.assertLive(); const row = this.command(claim);
    if (this.db.prepare("SELECT 1 FROM local_command_credential_uses WHERE command_id=?").get(claim.commandId)) return null;
    const metadata = CloudAgentBootConversationSchema.parse(binding);
    for (const [key,value] of Object.entries(this.options.queue.scope))
      if (metadata[key as keyof typeof metadata] !== value) throw new CloudEventRuntimeError("event_conflict");
    if (!row.credential_run_info) throw new CloudEventRuntimeError("event_conflict");
    const credentialRun = CloudAgentCredentialRunInfoSchema.parse(JSON.parse(row.credential_run_info));
    if (credentialRun.provider !== claim.payload.agentId) throw new CloudEventRuntimeError("event_conflict");
    const scope = CloudAgentBootIdentitySchema.parse(Object.fromEntries(Object.keys(CloudAgentBootIdentitySchema.shape)
      .map(key => [key, metadata[key as keyof typeof metadata]])));
    return CloudAgentCredentialActualUseSchema.parse({ version: 1,scope,conversationId: claim.conversationId,
      commandId: claim.commandId,turnId: claim.payload.userMessageId,executionId: claim.executionId,credentialRun,nativeStage,
      firstUseSequence: this.head + 1,eventSequence: this.head + 1 });
  }
  append(frame: BridgeMessage): void {
    this.assertLive();
    this.options.queue.assertWriterWritable();
    const cursor = frame.cloudStream;
    if (cursor?.streamId !== this.streamId || cursor.sequence !== this.head + 1) throw new CloudEventRuntimeError("event_conflict");
    const encoded = canonicalCloudLocalCommandHistoryJson(frame), bytes = Buffer.byteLength(encoded);
    if (bytes > 256 * 1024) throw new CloudEventRuntimeError("event_buffer_exhausted");
    this.db.transaction(() => {
      if (frame.type === "CLOUD_AGENT_CREDENTIAL_USED") {
        const use = CloudAgentCredentialActualUseSchema.parse(frame.use);
        const row = this.db.prepare("SELECT * FROM local_commands WHERE id=?").get(use.commandId) as Command | undefined;
        if (!row || row.state !== "dispatching" || row.execution_id !== use.executionId || row.conversation_id !== use.conversationId ||
            row.user_message_id !== use.turnId || row.writer_epoch !== this.options.queue.scope.writerEpoch || !row.credential_run_info ||
            !isDeepStrictEqual(JSON.parse(row.credential_run_info),use.credentialRun) || use.firstUseSequence !== cursor.sequence ||
            use.eventSequence !== cursor.sequence || this.db.prepare("SELECT 1 FROM local_command_credential_uses WHERE command_id=?").get(use.commandId))
          throw new CloudEventRuntimeError("event_conflict");
        this.db.prepare("INSERT INTO local_command_credential_uses VALUES(?,?,?,?,?,?)")
          .run(use.commandId,row.claim_id,use.conversationId,use.credentialRun.provider,use.firstUseSequence,canonicalCloudLocalCommandHistoryJson(use));
        this.db.prepare(`DELETE FROM local_command_credential_uses WHERE conversation_id=? AND provider=? AND command_id NOT IN
          (SELECT command_id FROM local_command_credential_uses WHERE conversation_id=? AND provider=? ORDER BY first_use_sequence DESC LIMIT 2)`)
          .run(use.conversationId,use.credentialRun.provider,use.conversationId,use.credentialRun.provider);
      }
      if (CONTROL_TYPES.has(frame.type)) this.captureControl(CloudCompactControlFrameSchema.parse(frame),cursor.sequence);
      this.db.prepare("INSERT INTO local_command_events VALUES(?,?,?,?)").run(this.streamId,cursor.sequence,encoded,bytes);
      this.db.prepare("DELETE FROM local_command_events WHERE stream_id=? AND sequence<=?").run(this.streamId,cursor.sequence - this.maxEntries);
      while ((this.db.prepare("SELECT coalesce(sum(bytes),0) AS n FROM local_command_events WHERE stream_id=?").get(this.streamId) as { n: number }).n > MAX_BYTES)
        this.db.prepare("DELETE FROM local_command_events WHERE stream_id=? AND sequence=(SELECT min(sequence) FROM local_command_events WHERE stream_id=?)")
          .run(this.streamId,this.streamId);
      const first = (this.db.prepare("SELECT min(sequence) AS n FROM local_command_events WHERE stream_id=?").get(this.streamId) as { n: number | null }).n ?? cursor.sequence + 1;
      this.db.prepare("UPDATE local_command_streams SET head=?,first_retained=? WHERE stream_id=?").run(cursor.sequence,first,this.streamId);
    })();
    if (CONTROL_TYPES.has(frame.type)) { try { this.options.changed?.(); } catch { /* Durable work stays pending. */ } }
  }
  private captureControl(frame: CloudCompactControlFrame, sequence: number): void {
    const resolver = "permissionId" in frame ? frame.permissionId : frame.questionId;
    const owner = this.db.prepare("SELECT * FROM local_command_control_owners WHERE resolver_id=?").get(resolver) as Owner | undefined;
    const request = "request" in frame;
    if (!owner || owner.kind !== ("permissionId" in frame ? "permission" : "question") || owner.agent_id !== frame.agentId ||
        frame.chatId !== undefined && owner.conversation_id !== frame.chatId || request && frame.request.sessionId !== owner.execution_id ||
        "sessionId" in frame && frame.sessionId !== owner.execution_id || "executionId" in frame && frame.executionId !== undefined && frame.executionId !== owner.execution_id ||
        owner.settled) throw new CloudEventRuntimeError("event_conflict");
    const event = CloudCompactControlEventSchema.parse({ version: 1,eventSequence: sequence,executionId: owner.execution_id,
      turnId: owner.turn_id,commandId: owner.command_id,frame });
    const control = this.db.prepare("SELECT revision,paused FROM local_command_controls WHERE conversation_id=?").get(owner.conversation_id) as { revision: number; paused: number };
    const change = CloudLocalCommandMirrorChangeSchema.parse({ sequence: 1,conversationId: owner.conversation_id,revision: control.revision,
      paused: !!control.paused,originWriterEpoch: this.options.queue.scope.writerEpoch,event });
    const { sequence: _unassigned, ...job } = change, document = canonicalCloudLocalCommandHistoryJson(job), bytes = Buffer.byteLength(document);
    const pending = this.db.prepare("SELECT count(*) AS n,coalesce(sum(bytes),0) AS bytes FROM local_command_outbox_jobs").get() as { n: number; bytes: number };
    if (pending.n >= 131072 || pending.bytes + bytes > 1024 * 1024 * 1024) throw new CloudEventRuntimeError("event_buffer_exhausted");
    this.db.prepare("INSERT INTO local_command_compact_controls VALUES(?,?,?,?)").run(this.streamId,sequence,owner.conversation_id,canonicalCloudLocalCommandHistoryJson(event));
    this.db.prepare("INSERT INTO local_command_outbox_jobs(conversation_id,priority,document,bytes) VALUES(?,0,?,?)").run(owner.conversation_id,document,bytes);
    if (!request) this.db.prepare("UPDATE local_command_control_owners SET settled=1 WHERE resolver_id=?").run(resolver);
  }
  controls(conversationId: string): CloudCompactControlEvent[] {
    this.assertLive();
    return (this.db.prepare("SELECT document FROM local_command_compact_controls WHERE stream_id=? AND conversation_id=? ORDER BY sequence")
      .all(this.streamId,conversationId) as { document: string }[]).map(row => CloudCompactControlEventSchema.parse(JSON.parse(row.document)));
  }
  credentialUses(conversationId: string): CloudAgentCredentialActualUse[] {
    this.assertLive();
    return (this.db.prepare("SELECT document FROM local_command_credential_uses WHERE conversation_id=? ORDER BY first_use_sequence")
      .all(conversationId) as { document: string }[]).map(row => CloudAgentCredentialActualUseSchema.parse(JSON.parse(row.document)));
  }
  replay(cursor: CloudEventCursor) {
    this.assertLive();
    const stream = this.db.prepare("SELECT head,first_retained FROM local_command_streams WHERE stream_id=?").get(this.streamId) as { head: number; first_retained: number };
    if (cursor.streamId !== this.streamId) throw new CloudEventRuntimeError("event_stream_changed");
    if (cursor.sequence > stream.head) throw new CloudEventRuntimeError("event_conflict");
    if (cursor.sequence < stream.first_retained - 1) throw new CloudEventRuntimeError("event_snapshot_required");
    const events = (this.db.prepare("SELECT sequence,frame FROM local_command_events WHERE stream_id=? AND sequence>? ORDER BY sequence LIMIT 128")
      .all(this.streamId,cursor.sequence) as { sequence: number; frame: string }[]).map(row => ({ sequence: row.sequence,frame: JSON.parse(row.frame) }));
    return CloudEventReplayResultSchema.parse({ streamId: this.streamId,head: stream.head,firstRetained: stream.first_retained,
      cursor: events.at(-1)?.sequence ?? cursor.sequence,events });
  }
  close(): void { if (this.closed) return; this.closed = true; this.db.close(); }
}
