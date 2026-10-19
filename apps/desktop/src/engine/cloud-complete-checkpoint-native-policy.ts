import { createHash } from "node:crypto";
import { z } from "zod";
import { CloudActorProvenanceSchema, CloudAgentBootScopeSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudBootCommandMutationSchema, CloudBootCommandClaimSchema, CloudBootCommandEntrySchema } from "@zeros/protocol/cloud-commands";
import { CloudCommandActorSchema } from "@zeros/protocol/cloud-actors";
import { CloudAcceptedWorkCommandSchema } from "@zeros/protocol/cloud-accepted-work";
import { CloudAgentCredentialActualUseSchema, CloudCompactControlFrameSchema } from "@zeros/protocol/cloud-events";
import { CloudCompactControlEventSchema, CloudLocalCommandMirrorChangeSchema, CloudLocalCommandMirrorBatchSchema, CloudLocalCommandWriterSealSchema,
  CloudLocalCommandWriterSealAckSchema } from "@zeros/protocol/cloud-local-mirror";
import { CloudAgentCredentialControlAcknowledgementSchema, CloudAgentCredentialControlSelectorSchema } from "./cloud-local-command-queue-start-fences";
import layout from "./cloud-complete-checkpoint-layout.json";

/** Exact current schema profile; regenerate with generate-complete-checkpoint-layout.ts.
 * Unknown objects/columns or populated unsupported records refuse the export.
 * Rows are inert historical data. They are never inserted into native queues.
 * User text, secrets and provider conversation data are not pattern filtered. */
export const PERIODIC_NATIVE_POLICY = { version: 1, layout, normal: {
  attachments: "data", chat_messages: "data", chats: "data", code_review_comments: "data",
  code_review_threads: "data", code_review_requests: "data", diff_comments: "data", detach_state: "data",
  local_orchestration_card_answers: "data", local_orchestration_family_workspaces: "data",
  local_orchestration_follows: "data", local_orchestration_human_stops: "data", local_orchestration_links: "data",
  local_orchestration_message_origins: "data", local_orchestration_notifications: "data",
  local_orchestration_requests: "data", local_orchestration_shares: "data", port_forwards: "data",
  remote_restricted_workspaces: "data", repos: "data", reset_undo: "data", schema_migrations: "data",
  settings: "data", sync_meta: "data", sync_tombstones: "data", terminal_sessions: "data", turns: "data",
  workspace_lifecycle_journal: "data", workspace_meta: "data", workspaces: "data",
  // FTS is solely a generated index of chat_messages. These exact cursors are
  // machine delivery/maintenance state, never user records or recovery input.
  chat_messages_fts: "regenerate", chat_messages_fts_config: "regenerate", chat_messages_fts_data: "regenerate",
  chat_messages_fts_docsize: "regenerate", chat_messages_fts_idx: "regenerate",
  janitor_state: "data", sync_state: "data", cloud_record_sync_state: "data",
  // Mac receive-replica/copy machinery has no qualified cloud-native mapping.
  // A populated mixed layout is refused rather than dropping its user data.
  cloud_device_registrations: "empty", cloud_replica_local_state: "empty", cloud_replica_entries: "empty",
  cloud_replica_apply_journal: "empty", cloud_replica_divergences: "empty", cloud_workspace_fork_jobs: "empty",
  cloud_workspace_fork_job_entries: "empty", cloud_workspace_fork_job_records: "empty",
}, ledger: {
  local_accepted_work: "reservation", local_commands: "command", local_command_actions: "action", local_command_metadata: "metadata",
  local_command_compact_controls: "control", local_command_control_owners: "resolver", local_command_controls: "data",
  local_command_events: "event", local_command_history_documents: "data", local_command_history_heads: "data",
  local_command_history_limits: "data", local_command_history_mutations: "data", local_command_journal: "change",
  local_command_mirror_batches: "batch", local_command_operations: "data", local_command_outbox_jobs: "outbox",
  local_command_streams: "data", local_turn_journal: "data",
  // Exact platform authority tables, never tenant credential files. Counters
  // and row counts are retained in coverage; their grants/ACKs are not exported.
  local_command_credential_uses: "authority", local_command_writer_seals: "authority",
  local_credential_control_metadata: "authority", local_credential_control_operations: "authority",
  local_credential_control_scopes: "authority", local_credential_retirement_floors: "authority",
  local_credential_start_fences: "authority",
} } as const;
export type PeriodicDatabase = "normal" | "ledger";
export const nativeLayout = layout;
export function nativeRefuse(): never { throw new Error("complete native export refused"); }
type Row = Record<string, unknown>;
function record(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) nativeRefuse();
  return value as Row;
}
function parsed(value: unknown): Row {
  if (typeof value !== "string") nativeRefuse();
  return record(JSON.parse(value));
}
function omit(row: Row, keys: readonly string[]): Row { return Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key))); }
function attribution(value: unknown) { return CloudActorProvenanceSchema.parse(value).actor; }
const frameKeys: Record<string, string[]> = {
  AGENT_SESSION_UPDATE: ["agentId", "notification", "executionId", "chatId"],
  AGENT_PERMISSION_REQUEST: ["agentId", "permissionId", "request", "chatId"],
  AGENT_PERMISSION_SETTLED: ["agentId", "permissionId", "sessionId", "executionId", "chatId", "answeredBy"],
  AGENT_QUESTION_REQUEST: ["agentId", "questionId", "request", "chatId"],
  AGENT_QUESTION_SETTLED: ["agentId", "questionId", "outcome", "chatId", "answeredBy"],
  AGENT_PROMPT_COMPLETE: ["requestId", "agentId", "sessionId", "executionId", "stopReason", "response"],
  AGENT_PROMPT_FAILED: ["requestId", "agentId", "sessionId", "executionId", "error", "failure", "activeTurn"],
  DB_CHANGED: ["kinds", "workspaceIds", "gitRefsChanged", "designRecognitionChanged", "chatIds", "cloudHistoryRestore"],
  CLOUD_AGENT_CREDENTIAL_USED: ["use"],
};
const updateKinds = new Set(["user_message_recorded", "goal_update", "safety_review_retry_available", "turn_state",
  "user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update",
  "available_commands_update", "available_subagents_update", "background_tasks_update", "workflow_progress_update",
  "current_mode_update", "current_effort_update", "model_fallback", "current_model_update", "mode_switch", "error_notice",
  "message_parent_update", "message_retraction", "tool_result_retraction", "usage_update", "turn_usage_update",
  "session_info_update", "provider_binding_update", "provider_binding_detached"]);
function inertFrame(value: unknown): Row {
  const frame = record(value);
  if (typeof frame.type !== "string" || !Object.hasOwn(frameKeys, frame.type)
    || Object.keys(frame).some(key => !["id", "source", "timestamp", "type", "cloudStream", ...frameKeys[frame.type as string]!].includes(key))) nativeRefuse();
  if (frame.type === "CLOUD_AGENT_CREDENTIAL_USED") {
    CloudAgentCredentialActualUseSchema.parse(frame.use);
    // This event contains only platform-use evidence, not user transcript.
    return { type: "platform_credential_use_omitted" };
  }
  // These are the fixed top-level runtime binding fields, never recursive
  // matching in user-authored JSON. User text and tool results stay byte-exact.
  const result = omit(frame, ["cloudStream", "sessionId", "executionId", "cloudHistoryRestore"]);
  if (frame.type === "AGENT_SESSION_UPDATE") {
    const notification = record(frame.notification), update = record(notification.update);
    if (Object.keys(notification).some(key => !["sessionId", "executionId", "update"].includes(key))
      || typeof update.sessionUpdate !== "string" || !updateKinds.has(update.sessionUpdate)) nativeRefuse();
    result.notification = { update };
  }
  if (["AGENT_PERMISSION_REQUEST", "AGENT_QUESTION_REQUEST"].includes(frame.type))
    result.request = omit(record(frame.request), ["sessionId", "executionId"]);
  return result;
}
function control(value: unknown): Row {
  const event = record(value);
  CloudCompactControlFrameSchema.parse(event.frame);
  return { ...omit(event, ["executionId"]), frame: inertFrame(event.frame) };
}
function change(value: unknown): Row {
  const original = CloudLocalCommandMirrorChangeSchema.parse(value);
  const result = omit(original, ["actor", "credentialRun"]);
  if (original.actor) result.actor = attribution(original.actor);
  if (original.entry) result.entry = omit(original.entry, ["executionId", "claimId"]);
  if (original.event) result.event = control(original.event);
  return result;
}
const reservationSchema = z.object({ command: CloudAcceptedWorkCommandSchema,
  actor: CloudActorProvenanceSchema, capabilityId: z.string(), kid: z.string(), capabilityExpiresAtMs: z.number() }).strict();
const metadataKeys = new Set(["writer", "schema", "historyReadRevision", "mirrorHead", "journalHead", "turnJournalAck",
  "historyProjectionWriter", "historyProjectionCursor", "historyProjectionParts", "historyJobCursor", "sealedWriter", "acceptanceFenced"]);
const rowOmissions: Record<string, readonly string[]> = {
  command: ["claim_id", "execution_id", "credential_run_info", "mirror_dirty"],
  action: ["claim_id", "execution_id"], reservation: ["receipt"], resolver: ["claim_id", "execution_id", "resolver_id"],
};
// The policy digest includes the output representation, omitted authority and
// closed record vocabulary as well as the native SQLite layout. Code/schema
// changes still require a new qualified runtime pin; this is not self-attestation.
export const periodicNativePolicySha256 = createHash("sha256").update(JSON.stringify({ ...PERIODIC_NATIVE_POLICY,
  output: { version: 1, rowOmissions, frameKeys, updateKinds: [...updateKinds], metadataKeys: [...metadataKeys],
    cell: "sqlite-scalar-or-canonical-base64-v1", coverage: "all-tables-original-and-exported-counts-v1" },
})).digest("hex");
const uid = z.string().uuid(), sha = z.string().regex(/^[a-f0-9]{64}$/), sequence = z.number().int().nonnegative().safe();
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/).refine(value => Number.isSafeInteger(Number(value)));
function checkManagedRecord(table: string, row: Row): void {
  switch (table) {
    case "local_command_credential_uses":
      CloudAgentCredentialActualUseSchema.parse(parsed(row.document)); uid.parse(row.command_id); uid.parse(row.claim_id); return;
    case "local_command_writer_seals":
      CloudLocalCommandWriterSealSchema.parse(parsed(row.document));
      if (row.ack !== null) CloudLocalCommandWriterSealAckSchema.parse(parsed(row.ack));
      uid.parse(row.writer_epoch); return;
    case "local_credential_control_metadata":
      if (row.key === "scope") { CloudAgentBootScopeSchema.parse(parsed(row.value)); return; }
      if (row.key === "revision") { decimal.parse(row.value); return; }
      return nativeRefuse();
    case "local_credential_control_scopes":
      CloudAgentBootScopeSchema.parse(parsed(row.scope)); decimal.parse(row.revision); uid.parse(row.writer_epoch);
      z.union([z.literal(0), z.literal(1)]).parse(row.retired); return;
    case "local_credential_control_operations":
      uid.parse(row.request_id); uid.parse(row.writer_epoch); sha.parse(row.request_sha256); sequence.parse(row.ack_bytes);
      z.union([z.literal(0), z.literal(1)]).parse(row.ack_delivered);
      if (row.acknowledgement !== null) {
        CloudAgentCredentialControlAcknowledgementSchema.parse(parsed(row.acknowledgement));
        if (Buffer.byteLength(String(row.acknowledgement)) !== row.ack_bytes) nativeRefuse();
      } else if (row.ack_bytes !== 0 || row.ack_delivered !== 0) nativeRefuse();
      return;
    case "local_credential_retirement_floors":
      uid.parse(row.mutation_id); uid.parse(row.writer_epoch); uid.parse(row.credential_id);
      z.enum(["claude", "codex", "cursor"]).parse(row.provider);
      sequence.nullable().parse(row.cache_revision); sequence.nullable().parse(row.connection_revision); return;
    case "local_credential_start_fences":
      uid.parse(row.mutation_id); uid.parse(row.writer_epoch); sha.parse(row.identity_sha256);
      z.array(CloudAgentCredentialControlSelectorSchema).min(1).max(32).parse(JSON.parse(String(row.selectors)));
      sequence.min(1).parse(row.fence_epoch); sequence.nullable().parse(row.desired_revision); uid.nullable().parse(row.proof_id);
      z.enum(["fenced", "waiting-ready", "ready", "retiring", "retired", "released", "failed"]).parse(row.phase); return;
    default: return nativeRefuse();
  }
}
export function mapPeriodicNativeRow(database: PeriodicDatabase, table: string, row: Row): Row | null {
  const policy: Readonly<Record<string, string>> = PERIODIC_NATIVE_POLICY[database];
  const mode = policy[table];
  if (!mode || mode === "empty") nativeRefuse();
  if (mode === "authority") { checkManagedRecord(table, row); return null; }
  if (mode === "regenerate") return null;
  switch (mode) {
    case "data": return row;
    case "command": {
      const result = omit(row, rowOmissions.command!);
      result.actor = attribution(parsed(row.actor));
      if (row.payload !== null) result.payload = CloudBootCommandClaimSchema.shape.payload.parse(JSON.parse(String(row.payload)));
      return result;
    }
    case "action": {
      // This native version durably records only the request hash before an
      // action dispatch. Its pending user payload is not reconstructible yet.
      // Never label that unsupported prefix complete or replay the receipt.
      if (row.state !== "settled") nativeRefuse();
      return { ...omit(row, rowOmissions.action!), actor: attribution(parsed(row.actor)) };
    }
    case "reservation": {
      const reservation = reservationSchema.parse(parsed(row.reservation));
      return { ...omit(row, ["reservation", "receipt"]), reservation: {
        command: omit(reservation.command, ["executionId"]), actor: attribution(reservation.actor) },
      mutation: row.mutation === null ? null : CloudBootCommandMutationSchema.parse(JSON.parse(String(row.mutation))) };
    }
    case "metadata": {
      if (typeof row.key !== "string" || !metadataKeys.has(row.key)) nativeRefuse();
      if (["sealedWriter", "acceptanceFenced"].includes(row.key)) return null;
      if (row.key !== "writer") return row;
      const writer = CloudAgentBootScopeSchema.parse(parsed(row.value));
      return { key: row.key, value: omit(writer, ["fundingOwnerUserId", "fundingOwnerEpoch"]) };
    }
    case "resolver": return omit(row, rowOmissions.resolver!);
    case "control": return { ...row, document: control(parsed(row.document)) };
    case "event": return { ...row, frame: inertFrame(parsed(row.frame)) };
    case "change": return { ...row, document: change(parsed(row.document)) };
    case "outbox": return { ...row, document: omit(change({ sequence: 1, ...parsed(row.document) }), ["sequence"]) };
    case "batch": {
      const batch = CloudLocalCommandMirrorBatchSchema.parse(parsed(row.document));
      return { ...row, document: { ...batch, changes: batch.changes.map(change) } };
    }
    default: return nativeRefuse();
  }
}

const sqlCell = z.union([z.null(), z.string(), z.number().finite().refine(value => !Number.isInteger(value) || Number.isSafeInteger(value)),
  z.object({ sqliteBlob: z.string().refine(value => Buffer.from(value, "base64").toString("base64") === value) }).strict()]);
const inertWriter = CloudAgentBootScopeSchema.omit({ fundingOwnerUserId: true, fundingOwnerEpoch: true }).strict();
function checkInertFrame(value: unknown): Row {
  const frame = record(value);
  if (frame.type === "platform_credential_use_omitted") {
    z.object({ type: z.literal("platform_credential_use_omitted") }).strict().parse(frame); return frame;
  }
  if (typeof frame.type !== "string" || !Object.hasOwn(frameKeys, frame.type) || frame.type === "CLOUD_AGENT_CREDENTIAL_USED") nativeRefuse();
  const keys = ["id", "source", "timestamp", "type", ...frameKeys[frame.type]!]
    .filter(key => !["sessionId", "executionId", "cloudHistoryRestore"].includes(key));
  if (Object.keys(frame).some(key => !keys.includes(key))) nativeRefuse();
  z.string().min(1).parse(frame.id); z.literal("engine").parse(frame.source); z.number().finite().parse(frame.timestamp);
  if (frame.type === "AGENT_SESSION_UPDATE") {
    const notification = record(frame.notification), update = record(notification.update);
    if (Object.keys(notification).length !== 1 || typeof update.sessionUpdate !== "string" || !updateKinds.has(update.sessionUpdate)) nativeRefuse();
  }
  if (["AGENT_PERMISSION_REQUEST", "AGENT_QUESTION_REQUEST"].includes(frame.type)) {
    const request = record(frame.request);
    if (Object.hasOwn(request, "sessionId") || Object.hasOwn(request, "executionId")) nativeRefuse();
  }
  return frame;
}
const inertFrameSchema = z.custom<Row>(value => { try { checkInertFrame(value); return true; } catch { return false; } });
const inertControl = z.object({ ...CloudCompactControlEventSchema.shape, frame: inertFrameSchema }).omit({ executionId: true }).strict();
const inertChange = z.object({ ...CloudLocalCommandMirrorChangeSchema.shape,
  actor: CloudCommandActorSchema.optional(),
  entry: CloudBootCommandEntrySchema.omit({ executionId: true }).optional(),
  event: inertControl.optional(),
}).omit({ credentialRun: true }).strict();
const inertOutbox = inertChange.omit({ sequence: true }).strict();
const inertBatch = z.object({ ...CloudLocalCommandMirrorBatchSchema.shape, changes: z.array(inertChange) }).strict();

/** Reader and producer both enforce this exact inert representation. User JSON
 * stays in declared payload/history cells; no generic object can add a native
 * claim, session grant or an unknown SQLite column to a restored record. */
export function validatePeriodicNativeRow(database: PeriodicDatabase, table: string, value: unknown): void {
  const row = record(value), policy: Readonly<Record<string, string>> = PERIODIC_NATIVE_POLICY[database];
  if (!Object.hasOwn(policy, table)) nativeRefuse();
  const mode = policy[table]!;
  if (["authority", "regenerate", "empty"].includes(mode)) nativeRefuse();
  const columns = (layout[database].tables as Record<string, { columns: string[] }>)[table]!.columns;
  const keys = columns.filter(key => !(rowOmissions[mode] ?? []).includes(key));
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) nativeRefuse();
  const special: Record<string, z.ZodType> = {};
  if (mode === "command" || mode === "action") special.actor = CloudCommandActorSchema;
  if (mode === "command") special.payload = CloudBootCommandClaimSchema.shape.payload.nullable();
  if (mode === "action") z.literal("settled").parse(row.state);
  if (mode === "reservation") {
    special.reservation = z.object({ command: CloudAcceptedWorkCommandSchema.omit({ executionId: true }), actor: CloudCommandActorSchema }).strict();
    special.mutation = CloudBootCommandMutationSchema.nullable();
  }
  if (mode === "metadata") {
    if (typeof row.key !== "string" || !metadataKeys.has(row.key) || ["sealedWriter", "acceptanceFenced"].includes(row.key)) nativeRefuse();
    if (row.key === "writer") special.value = inertWriter;
  }
  if (mode === "event") special.frame = inertFrameSchema;
  if (mode === "control") special.document = inertControl;
  if (mode === "change") special.document = inertChange;
  if (mode === "outbox") special.document = inertOutbox;
  if (mode === "batch") special.document = inertBatch;
  for (const key of keys) (special[key] ?? sqlCell).parse(row[key]);
}
