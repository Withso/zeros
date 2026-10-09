import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { authorizeCloudWorkspaceActor } from "./actors.js";
import { lockCloudWorkspaceScope } from "./authorization.js";
import { CloudActorProvenanceSchema, CloudAgentBootScopeSchema, type CloudAgentBootScope } from "./agent-boot-contract.js";
import { readCurrentCloudAgentBootBinding, type CurrentCloudAgentBootBinding } from "./agent-boot-credentials.js";
import { CloudBootCommandEntrySchema, CloudBootCommandSnapshotSchema } from "./commands.js";
import { CloudCompactControlEventSchema } from "./event-streams.js";
import { recordDatabasePersistenceCost } from "../request-timing.js";
import {
  assembleCloudHistoryDocument, canonicalCloudHistoryJson, CloudLocalHistoryManifestSchema,
  CloudLocalHistoryPartSchema, CloudLocalHistoryRecordSchema, CloudMirroredHistoryHeadSchema,
  CloudLocalHistoryHeadSchema, CloudStoppedHistoryMetadataSchema,
  HISTORY_BUNDLE_BYTES, HISTORY_PART_BYTES, HISTORY_WORKSPACE_BYTES, type CloudLocalHistoryManifest,
  type CloudLocalHistoryRecord, type CloudMirroredHistoryHead, type CloudLocalHistoryHead,
} from "./history-local-contract.js";

type Scope = {
  workspaceId: string;
  organizationId: string;
  accountUserId: string;
};
type Entity = {
  entity_id: string;
  schema_version: number;
  document: unknown;
  tombstoned_at: Date | null;
};
const id = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const chatDocument = z.object({
  version: z.literal(1),
  chat: z.object({ id, folder: z.string() }).passthrough(),
});
const messageDocument = z.object({
  version: z.literal(1),
  chatId: id,
  msgId: id,
  ord: z.number().int().safe().nonnegative(),
  kind: z.string(),
  payload: z.string(),
  createdAt: z.number().int().safe().nonnegative(),
});
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_MESSAGES = 1000;
const invalid = () =>
  new HttpError(422, "invalid_input", "Invalid cloud history request");
const corrupt = () =>
  new HttpError(
    503,
    "cloud_history_unavailable",
    "Cloud history is temporarily unavailable",
  );

const mirrorScope = z.object({ organizationId: z.string().uuid(), workspaceId: z.string().uuid(),
  writerEpoch: z.string().uuid(), outboxSequence: z.number().int().safe().positive() }).strict();
const mirrorHistory = z.object({ conversationId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  historyPart: CloudLocalHistoryPartSchema.optional(), historyHead: CloudMirroredHistoryHeadSchema.optional(),
}).strict().refine(value => value.historyPart !== undefined || value.historyHead !== undefined);
type MirrorScope = z.infer<typeof mirrorScope>;
const historyConflict = () => new HttpError(409, "cloud_history_conflict", "Cloud history projection identity changed");
type HistoryBlob = { document_sha256: Buffer; kind: "record" | "manifest"; canonical_document: string; origin_writer_epoch: string };
type HistoryWriter = { generation: number; engine_instance_id: string; boot_id: string; writer_epoch: string;
  funding_owner_user_id: string; funding_owner_epoch: string; state: string };

async function historyOrigin(tx: Tx, scope: MirrorScope, writerEpoch: string): Promise<CloudAgentBootScope> {
  const row = (await tx.query<HistoryWriter>(`SELECT generation,engine_instance_id,boot_id,writer_epoch,
      funding_owner_user_id,funding_owner_epoch,state FROM cloud_workspace_local_command_writers
    WHERE workspace_id=$1 AND org_id=$2 AND writer_epoch=$3 FOR SHARE`,
  [scope.workspaceId, scope.organizationId, writerEpoch])).rows[0];
  if (!row || (writerEpoch === scope.writerEpoch ? !["active", "retired"].includes(row.state) : row.state !== "retired")) throw historyConflict();
  const parsed = CloudAgentBootScopeSchema.safeParse({ organizationId: scope.organizationId, workspaceId: scope.workspaceId,
    generation: row.generation, engineInstanceId: row.engine_instance_id, bootId: row.boot_id, writerEpoch: row.writer_epoch,
    fundingOwnerUserId: row.funding_owner_user_id, fundingOwnerEpoch: Number(row.funding_owner_epoch) });
  if (!parsed.success) throw historyConflict();
  return parsed.data;
}
function parsedHistoryBlob(row: HistoryBlob): CloudLocalHistoryManifest | CloudLocalHistoryRecord {
  try {
    const value: unknown = JSON.parse(row.canonical_document);
    if (canonicalCloudHistoryJson(value) !== row.canonical_document ||
        createHash("sha256").update(row.canonical_document).digest("hex") !== row.document_sha256.toString("hex")) throw historyConflict();
    return row.kind === "record" ? CloudLocalHistoryRecordSchema.parse(value) : CloudLocalHistoryManifestSchema.parse(value);
  } catch { throw historyConflict(); }
}
async function historyStorageBytes(tx: Tx, scope: MirrorScope): Promise<number> {
  const row = (await tx.query<{ bytes: string }>(`SELECT
    coalesce((SELECT sum(octet_length(data)) FROM cloud_workspace_local_command_history_parts WHERE workspace_id=$1 AND org_id=$2),0)
    +coalesce((SELECT sum(octet_length(canonical_document)) FROM cloud_workspace_local_command_history_blobs WHERE workspace_id=$1 AND org_id=$2),0) AS bytes`,
  [scope.workspaceId, scope.organizationId])).rows[0];
  const bytes = Number(row?.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw historyConflict();
  return bytes;
}
async function validateManifestOrigin(tx: Tx, scope: MirrorScope, conversationId: string, manifest: CloudLocalHistoryManifest): Promise<void> {
  if (manifest.conversationId !== conversationId) throw historyConflict();
  const origin = await historyOrigin(tx, scope, manifest.scope.writerEpoch);
  if (canonicalCloudHistoryJson(origin) !== canonicalCloudHistoryJson(manifest.scope)) throw historyConflict();
}
async function stageHistoryPart(tx: Tx, scope: MirrorScope, conversationId: string,
  part: z.infer<typeof CloudLocalHistoryPartSchema>): Promise<boolean> {
  const hash = Buffer.from(part.sha256, "hex");
  const stored = (await tx.query<HistoryBlob>(`SELECT document_sha256,kind,canonical_document,origin_writer_epoch
    FROM cloud_workspace_local_command_history_blobs WHERE workspace_id=$1 AND org_id=$2 AND document_sha256=$3 FOR SHARE`,
  [scope.workspaceId, scope.organizationId, hash])).rows[0];
  if (stored) {
    const document = parsedHistoryBlob(stored), bytes = Buffer.from(stored.canonical_document);
    if (stored.kind !== part.kind || document.conversationId !== conversationId || bytes.length !== part.bytes ||
        !bytes.subarray(part.index * HISTORY_PART_BYTES, (part.index + 1) * HISTORY_PART_BYTES).equals(Buffer.from(part.data, "base64"))) throw historyConflict();
    if (stored.kind === "manifest") await validateManifestOrigin(tx, scope, conversationId, document as CloudLocalHistoryManifest);
    return false;
  }
  type PartRow = { kind: "record" | "manifest"; part_index: number; part_count: number; document_bytes: number; data: Buffer };
  const rows = (await tx.query<PartRow>(`SELECT kind,part_index,part_count,document_bytes,data
    FROM cloud_workspace_local_command_history_parts WHERE workspace_id=$1 AND org_id=$2 AND projection_epoch=$3
      AND document_sha256=$4 ORDER BY part_index LIMIT 33 FOR SHARE`,
  [scope.workspaceId, scope.organizationId, scope.writerEpoch, hash])).rows;
  if (rows.length > 32 || rows.some(row => row.kind !== part.kind || row.part_count !== part.count || row.document_bytes !== part.bytes)) throw historyConflict();
  const same = rows.find(row => row.part_index === part.index), data = Buffer.from(part.data, "base64");
  if (same && !same.data.equals(data)) throw historyConflict();
  if (!same) {
    if (await historyStorageBytes(tx, scope) + data.length > HISTORY_WORKSPACE_BYTES) return true;
    const result = await tx.query(`INSERT INTO cloud_workspace_local_command_history_parts(workspace_id,org_id,projection_epoch,
      document_sha256,kind,part_index,part_count,document_bytes,data,outbox_sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [scope.workspaceId, scope.organizationId, scope.writerEpoch, hash, part.kind, part.index, part.count, part.bytes, data, scope.outboxSequence]);
    recordDatabasePersistenceCost(result, { writeStatements: 1, affectedRows: result.rowCount ?? 0,
      encodedPersistedBytes: result.rowCount ? data.length : 0 });
    rows.push({ kind: part.kind, part_index: part.index, part_count: part.count, document_bytes: part.bytes, data });
  }
  if (rows.length !== part.count) return false;
  let assembled: ReturnType<typeof assembleCloudHistoryDocument>;
  try { assembled = assembleCloudHistoryDocument(rows.map(row => ({ version: 1, kind: row.kind, sha256: part.sha256,
    index: row.part_index, count: row.part_count, bytes: row.document_bytes, data: row.data.toString("base64") }))); }
  catch { throw historyConflict(); }
  if (assembled.document.conversationId !== conversationId) throw historyConflict();
  if (assembled.kind === "manifest") await validateManifestOrigin(tx, scope, conversationId, assembled.document as CloudLocalHistoryManifest);
  if (await historyStorageBytes(tx, scope) + Buffer.byteLength(assembled.canonicalDocument) > HISTORY_WORKSPACE_BYTES) return true;
  const result = await tx.query(`INSERT INTO cloud_workspace_local_command_history_blobs(workspace_id,org_id,document_sha256,
      kind,canonical_document,origin_writer_epoch,verified_sequence) VALUES($1,$2,$3,$4,$5,$6,$7)`,
  [scope.workspaceId, scope.organizationId, hash, assembled.kind, assembled.canonicalDocument,
    assembled.kind === "manifest" ? (assembled.document as CloudLocalHistoryManifest).scope.writerEpoch : scope.writerEpoch, scope.outboxSequence]);
  recordDatabasePersistenceCost(result, { writeStatements: 1, affectedRows: result.rowCount ?? 0,
    encodedPersistedBytes: result.rowCount ? Buffer.byteLength(assembled.canonicalDocument) : 0 });
  return false;
}

async function validateHistoryCommandSource(tx: Tx, scope: MirrorScope, conversationId: string,
  head: CloudMirroredHistoryHead, origin: CloudAgentBootScope): Promise<void> {
  if (head.source.kind !== "command") return;
  const source = head.source;
  const command = (await tx.query<{ user_message_id: string; agent_id: string; execution_id: string | null;
    result: unknown; generation: number; actor_provenance: unknown }>(`SELECT user_message_id,agent_id,execution_id,result,generation,actor_provenance
    FROM cloud_workspace_local_commands WHERE workspace_id=$1 AND org_id=$2 AND id=$3 AND conversation_id=$4
      AND writer_epoch=$5 AND projection_epoch=$6 FOR SHARE`,
  [scope.workspaceId, scope.organizationId, source.commandId, conversationId, head.originWriterEpoch, scope.writerEpoch])).rows[0];
  if (!command || command.user_message_id !== source.intent.userMessageId || command.agent_id !== source.intent.agentId ||
      command.execution_id !== source.executionId || command.generation !== origin.generation ||
      (command.result === null ? source.nativeResultSha256 !== null :
        createHash("sha256").update(canonicalCloudHistoryJson(command.result)).digest("hex") !== source.nativeResultSha256)) throw historyConflict();
  if (source.executionId !== null) {
    const actor = CloudActorProvenanceSchema.safeParse(command.actor_provenance);
    if (!actor.success || actor.data.actor.role === "viewer" || !actor.data.fundingGrant || actor.data.fundingConsentVersion !== 1 ||
        canonicalCloudHistoryJson(actor.data.scope) !== canonicalCloudHistoryJson(origin)) throw historyConflict();
  }
}
async function validatedManifestRecords(tx: Tx, scope: MirrorScope, conversationId: string,
  manifest: CloudLocalHistoryManifest, manifestBytes: number): Promise<void> {
  const hashes = [...new Set(manifest.records.map(record => record.sha256))].map(hash => Buffer.from(hash, "hex"));
  const metadata = (await tx.query<{ document_sha256: Buffer; kind: string; bytes: number }>(`SELECT document_sha256,kind,
    octet_length(canonical_document) AS bytes FROM cloud_workspace_local_command_history_blobs
    WHERE workspace_id=$1 AND org_id=$2 AND document_sha256=ANY($3::bytea[])`, [scope.workspaceId, scope.organizationId, hashes])).rows;
  const byHash = new Map(metadata.map(row => [row.document_sha256.toString("hex"), row]));
  if (metadata.length !== hashes.length || manifest.records.some(ref => byHash.get(ref.sha256)?.kind !== "record") ||
      manifestBytes + manifest.records.reduce((bytes, ref) => bytes + (byHash.get(ref.sha256)?.bytes ?? HISTORY_BUNDLE_BYTES), 0) > HISTORY_BUNDLE_BYTES ||
      manifest.records.some(ref => ref.sourceRevision > manifest.recordSequence) || manifest.tombstones.some(ref => ref.sourceRevision > manifest.recordSequence)) throw historyConflict();
  const rows = (await tx.query<HistoryBlob>(`SELECT document_sha256,kind,canonical_document,origin_writer_epoch
    FROM cloud_workspace_local_command_history_blobs WHERE workspace_id=$1 AND org_id=$2 AND document_sha256=ANY($3::bytea[])`,
  [scope.workspaceId, scope.organizationId, hashes])).rows;
  if (rows.length !== hashes.length) throw historyConflict();
  const records = new Map(rows.map(row => [row.document_sha256.toString("hex"), parsedHistoryBlob(row) as CloudLocalHistoryRecord]));
  const controls: Array<z.infer<typeof CloudCompactControlEventSchema>> = [];
  for (const ref of manifest.records) {
    const record = records.get(ref.sha256);
    if (!record || record.conversationId !== conversationId || record.entityKind !== ref.entityKind || record.entityId !== ref.entityId ||
        record.schemaVersion !== ref.schemaVersion || record.sourceRevision !== ref.sourceRevision) throw historyConflict();
    if (record.entityKind === "control") controls.push(CloudCompactControlEventSchema.parse(record.document));
  }
  if (!controls.length) return;
  const saved = (await tx.query<{ command_id: string; execution_id: string; user_message_id: string; agent_id: string;
    local_stream_id: string; local_sequence: string; frame: unknown }>(`SELECT command_id,execution_id,user_message_id,agent_id,
      local_stream_id,local_sequence,frame FROM cloud_workspace_local_agent_controls WHERE workspace_id=$1 AND org_id=$2
      AND conversation_id=$3 AND local_sequence=ANY($4::bigint[]) AND outbox_sequence<=$5 LIMIT $6`,
  [scope.workspaceId, scope.organizationId, conversationId, controls.map(event => event.eventSequence), scope.outboxSequence, controls.length + 1])).rows;
  for (const event of controls) {
    const matching = saved.filter(row => Number(row.local_sequence) === event.eventSequence && row.execution_id === event.executionId &&
      row.agent_id === event.frame.agentId && (event.commandId === undefined || row.command_id === event.commandId) &&
      (event.turnId === undefined || row.user_message_id === event.turnId) &&
      (!event.frame.cloudStream || row.local_stream_id === event.frame.cloudStream.streamId) &&
      canonicalCloudHistoryJson(row.frame) === canonicalCloudHistoryJson(event.frame));
    if (event.eventSequence > manifest.eventSequence || matching.length !== 1) throw historyConflict();
  }
}

/** Private mirror transaction helper. Caller locks the exact current binding,
 * validates the contiguous batch and original actor provenance, stages immutable
 * command/result prerequisites, and publishes the terminal AFTER this returns
 * in this SAME transaction. This does not authenticate or wake an engine.
 * historyLimit is durable ACK feedback, never a successful skipped-part ACK. */
export async function applyMirroredCloudAgentHistory(tx: Tx, suppliedScope: unknown, suppliedChange: unknown):
Promise<{ historyLimit: boolean; historyHead?: CloudMirroredHistoryHead }> {
  const validScope = mirrorScope.safeParse(suppliedScope), validChange = mirrorHistory.safeParse(suppliedChange);
  if (!validScope.success || !validChange.success) throw invalid();
  const scope = validScope.data, change = validChange.data;
  const binding = await readCurrentCloudAgentBootBinding(tx, { organizationId: scope.organizationId, workspaceId: scope.workspaceId });
  if (binding.mode !== "boot-owner-v1" || binding.binding.writerEpoch !== scope.writerEpoch) throw historyConflict();
  const historyLimit = change.historyPart ? await stageHistoryPart(tx, scope, change.conversationId, change.historyPart) : false;
  if (!change.historyHead) return { historyLimit };
  let head = change.historyHead;
  const origin = await historyOrigin(tx, scope, head.originWriterEpoch);
  await validateHistoryCommandSource(tx, scope, change.conversationId, head, origin);
  type HeadRow = { origin_writer_epoch: string; source: unknown; deleted: boolean; restore_revision: string; complete: boolean;
    manifest_sha256: Buffer | null; record_sequence: string | null; event_sequence: string | null; incomplete_reason: string | null };
  const previous = (await tx.query<HeadRow>(`SELECT origin_writer_epoch,source,deleted,restore_revision,complete,
    manifest_sha256,record_sequence,event_sequence,incomplete_reason FROM cloud_workspace_local_command_history_heads
    WHERE workspace_id=$1 AND org_id=$2 AND projection_epoch=$3 AND conversation_id=$4 FOR UPDATE`,
  [scope.workspaceId, scope.organizationId, scope.writerEpoch, change.conversationId])).rows[0];
  if (previous && Number(previous.restore_revision) > head.history.restoreRevision) return { historyLimit };
  if (historyLimit && "manifestSha256" in head.history) head = { ...head, history: { restoreRevision: head.history.restoreRevision,
    recordSequence: head.history.recordSequence, eventSequence: head.history.eventSequence, incompleteReason: "history_limit" } };
  if (previous && Number(previous.restore_revision) === head.history.restoreRevision) {
    const old = { originWriterEpoch: previous.origin_writer_epoch, source: previous.source, deleted: previous.deleted,
      history: previous.complete ? { restoreRevision: Number(previous.restore_revision), recordSequence: Number(previous.record_sequence),
        eventSequence: Number(previous.event_sequence), manifestSha256: previous.manifest_sha256?.toString("hex") }
        : { restoreRevision: Number(previous.restore_revision), recordSequence: previous.record_sequence === null ? null : Number(previous.record_sequence),
          eventSequence: previous.event_sequence === null ? null : Number(previous.event_sequence), incompleteReason: previous.incomplete_reason } };
    if (canonicalCloudHistoryJson(head) !== canonicalCloudHistoryJson(old)) throw historyConflict();
    return { historyLimit, historyHead: head };
  }
  if ("manifestSha256" in head.history) {
    const blob = (await tx.query<HistoryBlob>(`SELECT document_sha256,kind,canonical_document,origin_writer_epoch
      FROM cloud_workspace_local_command_history_blobs WHERE workspace_id=$1 AND org_id=$2 AND document_sha256=$3 FOR SHARE`,
    [scope.workspaceId, scope.organizationId, Buffer.from(head.history.manifestSha256, "hex")])).rows[0];
    if (!blob || blob.kind !== "manifest") throw historyConflict();
    const manifest = parsedHistoryBlob(blob) as CloudLocalHistoryManifest;
    if (manifest.conversationId !== change.conversationId || manifest.scope.writerEpoch !== head.originWriterEpoch ||
        canonicalCloudHistoryJson(manifest.scope) !== canonicalCloudHistoryJson(origin) || manifest.restoreRevision !== head.history.restoreRevision ||
        manifest.deleted !== head.deleted || manifest.recordSequence !== head.history.recordSequence || manifest.eventSequence !== head.history.eventSequence ||
        canonicalCloudHistoryJson(manifest.source) !== canonicalCloudHistoryJson(head.source)) throw historyConflict();
    await validatedManifestRecords(tx, scope, change.conversationId, manifest, Buffer.byteLength(blob.canonical_document));
  }
  const complete = "manifestSha256" in head.history;
  const sourceId = head.source.kind === "command" ? head.source.commandId : head.source.mutationId;
  const result = await tx.query(`INSERT INTO cloud_workspace_local_command_history_heads(workspace_id,org_id,projection_epoch,
    origin_writer_epoch,conversation_id,restore_revision,complete,deleted,manifest_sha256,record_sequence,event_sequence,
    incomplete_reason,source_kind,source_id,source,outbox_sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT(workspace_id,projection_epoch,conversation_id) DO UPDATE SET origin_writer_epoch=EXCLUDED.origin_writer_epoch,
      restore_revision=EXCLUDED.restore_revision,complete=EXCLUDED.complete,deleted=EXCLUDED.deleted,manifest_sha256=EXCLUDED.manifest_sha256,
      record_sequence=EXCLUDED.record_sequence,event_sequence=EXCLUDED.event_sequence,incomplete_reason=EXCLUDED.incomplete_reason,
      source_kind=EXCLUDED.source_kind,source_id=EXCLUDED.source_id,source=EXCLUDED.source,outbox_sequence=EXCLUDED.outbox_sequence,updated_at=now()`,
  [scope.workspaceId, scope.organizationId, scope.writerEpoch, head.originWriterEpoch, change.conversationId, head.history.restoreRevision,
    complete, head.deleted, "manifestSha256" in head.history ? Buffer.from(head.history.manifestSha256, "hex") : null,
    head.history.recordSequence, head.history.eventSequence, "incompleteReason" in head.history ? head.history.incompleteReason : null,
    head.source.kind, sourceId, JSON.stringify(head.source), scope.outboxSequence]);
  recordDatabasePersistenceCost(result, { writeStatements: 1, affectedRows: result.rowCount ?? 0,
    encodedPersistedBytes: result.rowCount ? Buffer.byteLength(canonicalCloudHistoryJson(head)) : 0 });
  return { historyLimit, historyHead: head };
}

function validateLimit(limit: number, max: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) throw invalid();
}
function validFolder(folder: string): boolean {
  return (
    folder === "." ||
    (folder.length > 0 &&
      !folder.includes("\\") &&
      !/[\u0000-\u001f\u007f]/u.test(folder) &&
      folder
        .split("/")
        .every((part) => !!part && part !== "." && part !== ".."))
  );
}

type LocalReadContext = {
  binding: CurrentCloudAgentBootBinding; mirroredSequence: number; sealedSequence: number | null;
  sealRecordSequence: number | null; sealEventSequence: number | null;
};
type LocalCandidate = { conversationId: string; head: CloudLocalHistoryHead | null; outboxSequence: number | null; manifestBytes: number | null };
type HistoryRef = CloudLocalHistoryManifest["records"][number];
type RecordRef = { conversationId: string; ref: HistoryRef };
const READ_MANIFEST_BYTES = 8 * 1024 * 1024;
function historySequence(value: unknown): number {
  if ((typeof value !== "number" && (typeof value !== "string" || !/^[0-9]{1,16}$/.test(value))) ||
      !Number.isSafeInteger(Number(value)) || Number(value) < 0) throw corrupt();
  return Number(value);
}
async function localReadContext(tx: Tx, scope: Scope): Promise<LocalReadContext | null> {
  const mode = await readCurrentCloudAgentBootBinding(tx, { organizationId: scope.organizationId, workspaceId: scope.workspaceId });
  if (mode.mode === "legacy") return null;
  const writer = (await tx.query<{ mirrored_sequence: string; sealed_sequence: string | null;
    seal_record_sequence: string | null; seal_event_sequence: string | null }>(`SELECT mirrored_sequence,sealed_sequence,
      seal_record_sequence,seal_event_sequence FROM cloud_workspace_local_command_writers
    WHERE workspace_id=$1 AND org_id=$2 AND writer_epoch=$3 FOR SHARE`,
  [scope.workspaceId, scope.organizationId, mode.binding.writerEpoch])).rows[0];
  if (!writer) throw corrupt();
  const nullable = (value: unknown) => value === null ? null : historySequence(value);
  const context = { binding: mode.binding, mirroredSequence: historySequence(writer.mirrored_sequence),
    sealedSequence: nullable(writer.sealed_sequence), sealRecordSequence: nullable(writer.seal_record_sequence),
    sealEventSequence: nullable(writer.seal_event_sequence) };
  if ([context.sealedSequence, context.sealRecordSequence, context.sealEventSequence].filter(value => value !== null).length % 3 !== 0 ||
      (context.sealedSequence !== null && context.sealedSequence > context.mirroredSequence)) throw corrupt();
  return context;
}
function localMetadata(local: LocalReadContext, candidates: readonly LocalCandidate[]) {
  const bound = local.binding;
  const complete = bound.writerState === "retired" && local.sealedSequence !== null && local.sealRecordSequence !== null && local.sealEventSequence !== null &&
    candidates.every(candidate => candidate.head?.manifestSha256 !== null && candidate.head !== null &&
      candidate.outboxSequence !== null && candidate.outboxSequence <= local.sealedSequence! &&
      candidate.head.recordSequence !== null && candidate.head.recordSequence <= local.sealRecordSequence! &&
      candidate.head.eventSequence !== null && candidate.head.eventSequence <= local.sealEventSequence!);
  const result = CloudStoppedHistoryMetadataSchema.safeParse({ projection: {
    version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", organizationId: bound.organizationId,
    workspaceId: bound.workspaceId, generation: bound.generation, engineInstanceId: bound.engineInstanceId,
    bootId: bound.bootId, writerEpoch: bound.writerEpoch, fundingOwnerUserId: bound.fundingOwnerUserId,
    fundingOwnerEpoch: bound.fundingOwnerEpoch, mirroredSequence: local.mirroredSequence, sealedSequence: local.sealedSequence, complete,
  }, historyHeads: candidates.flatMap(candidate => candidate.head ? [candidate.head] : []) });
  if (!result.success) throw corrupt();
  return result.data;
}
async function localCandidates(tx: Tx, scope: Scope, local: LocalReadContext, options: {
  conversationId?: string | undefined; afterId?: string | undefined; inclusive?: boolean; limit: number;
}): Promise<LocalCandidate[]> {
  type Row = { conversation_id: string; origin_writer_epoch: string | null; source: unknown; restore_revision: string | null;
    deleted: boolean | null; complete: boolean | null; record_sequence: string | null; event_sequence: string | null;
    manifest_sha256: Buffer | null; incomplete_reason: string | null; outbox_sequence: string | null; manifest_bytes: number | null; blob_kind: string | null };
  const rows = (await tx.query<Row>(`WITH candidates AS MATERIALIZED (
      SELECT conversation_id FROM cloud_workspace_local_command_history_heads WHERE workspace_id=$1 AND org_id=$2 AND projection_epoch=$3
      UNION SELECT conversation_id FROM cloud_workspace_local_command_controls WHERE workspace_id=$1 AND org_id=$2 AND writer_epoch=$3
    ), selected AS (SELECT conversation_id FROM candidates WHERE ($4::text IS NULL OR conversation_id=$4)
      AND ($5::text IS NULL OR conversation_id>$5 OR ($7 AND conversation_id=$5)) ORDER BY conversation_id LIMIT $6)
    SELECT selected.conversation_id,head.origin_writer_epoch,head.source,head.restore_revision,head.deleted,head.complete,
      head.record_sequence,head.event_sequence,head.manifest_sha256,head.incomplete_reason,head.outbox_sequence,
      octet_length(blob.canonical_document) AS manifest_bytes,blob.kind AS blob_kind FROM selected
    LEFT JOIN cloud_workspace_local_command_history_heads head ON head.workspace_id=$1 AND head.org_id=$2
      AND head.projection_epoch=$3 AND head.conversation_id=selected.conversation_id
    LEFT JOIN cloud_workspace_local_command_history_blobs blob ON blob.workspace_id=$1 AND blob.org_id=$2 AND blob.document_sha256=head.manifest_sha256
    ORDER BY selected.conversation_id`, [scope.workspaceId, scope.organizationId, local.binding.writerEpoch,
    options.conversationId ?? null, options.afterId ?? null, options.limit, options.inclusive ?? false])).rows;
  return rows.map(row => {
    if (row.origin_writer_epoch === null) return { conversationId: row.conversation_id, head: null, outboxSequence: null, manifestBytes: null };
    const result = CloudLocalHistoryHeadSchema.safeParse({ conversationId: row.conversation_id, originWriterEpoch: row.origin_writer_epoch,
      source: row.source, restoreRevision: historySequence(row.restore_revision), deleted: row.deleted,
      recordSequence: row.record_sequence === null ? null : historySequence(row.record_sequence),
      eventSequence: row.event_sequence === null ? null : historySequence(row.event_sequence),
      manifestSha256: row.manifest_sha256?.toString("hex") ?? null, incompleteReason: row.incomplete_reason });
    const outboxSequence = historySequence(row.outbox_sequence);
    if (!result.success || outboxSequence > local.mirroredSequence || row.complete !== (result.data.manifestSha256 !== null) ||
        (row.complete && (row.blob_kind !== "manifest" || row.manifest_bytes === null))) throw corrupt();
    return { conversationId: row.conversation_id, head: result.data, outboxSequence, manifestBytes: row.manifest_bytes };
  });
}
function boundedCandidates(rows: LocalCandidate[], limit: number): LocalCandidate[] {
  let bytes = 0, count = 0;
  for (const row of rows.slice(0, limit)) {
    if (row.manifestBytes !== null && (!Number.isSafeInteger(row.manifestBytes) || row.manifestBytes < 1)) throw corrupt();
    bytes += row.manifestBytes ?? 0;
    if (bytes > READ_MANIFEST_BYTES) break;
    count++;
  }
  if (rows.length && count === 0) throw corrupt();
  return rows.slice(0, count);
}
async function localManifests(tx: Tx, scope: Scope, local: LocalReadContext, candidates: LocalCandidate[]): Promise<Map<string, CloudLocalHistoryManifest>> {
  const complete = candidates.filter(candidate => candidate.head?.manifestSha256);
  if (!complete.length) return new Map();
  const rows = (await tx.query<HistoryBlob>(`SELECT document_sha256,kind,canonical_document,origin_writer_epoch
    FROM cloud_workspace_local_command_history_blobs WHERE workspace_id=$1 AND org_id=$2 AND document_sha256=ANY($3::bytea[])`,
  [scope.workspaceId, scope.organizationId, complete.map(candidate => Buffer.from(candidate.head!.manifestSha256!, "hex"))])).rows;
  const byHash = new Map(rows.map(row => [row.document_sha256.toString("hex"), row]));
  const result = new Map<string, CloudLocalHistoryManifest>();
  const origins = new Map<string, CloudAgentBootScope>();
  for (const candidate of complete) {
    const head = candidate.head!, blob = byHash.get(head.manifestSha256!);
    if (!blob || blob.kind !== "manifest" || Buffer.byteLength(blob.canonical_document) !== candidate.manifestBytes) throw corrupt();
    const manifest = parsedHistoryBlob(blob) as CloudLocalHistoryManifest;
    let origin = origins.get(head.originWriterEpoch);
    if (!origin) { origin = await historyOrigin(tx, { organizationId: scope.organizationId, workspaceId: scope.workspaceId,
      writerEpoch: local.binding.writerEpoch, outboxSequence: local.mirroredSequence || 1 }, head.originWriterEpoch); origins.set(head.originWriterEpoch, origin); }
    if (manifest.conversationId !== candidate.conversationId || manifest.restoreRevision !== head.restoreRevision || manifest.deleted !== head.deleted ||
        manifest.recordSequence !== head.recordSequence || manifest.eventSequence !== head.eventSequence ||
        canonicalCloudHistoryJson(manifest.scope) !== canonicalCloudHistoryJson(origin) || canonicalCloudHistoryJson(manifest.source) !== canonicalCloudHistoryJson(head.source)) throw corrupt();
    result.set(candidate.conversationId, manifest);
  }
  return result;
}
async function localRecords(tx: Tx, scope: Scope, items: RecordRef[], query?: string): Promise<{ records: CloudLocalHistoryRecord[]; consumed: number; matches: Set<string> }> {
  if (!items.length) return { records: [], consumed: 0, matches: new Set() };
  const hashes = [...new Set(items.map(item => item.ref.sha256))];
  const sizes = (await tx.query<{ document_sha256: Buffer; kind: string; bytes: number }>(`SELECT document_sha256,kind,
    octet_length(canonical_document) AS bytes FROM cloud_workspace_local_command_history_blobs
    WHERE workspace_id=$1 AND org_id=$2 AND document_sha256=ANY($3::bytea[])`, [scope.workspaceId, scope.organizationId, hashes.map(hash => Buffer.from(hash, "hex"))])).rows;
  const byHash = new Map(sizes.map(row => [row.document_sha256.toString("hex"), row]));
  let bytes = 0, consumed = 0;
  for (const item of items) {
    const size = byHash.get(item.ref.sha256);
    if (!size || size.kind !== "record" || !Number.isSafeInteger(size.bytes) || size.bytes < 1) throw corrupt();
    bytes += size.bytes;
    if (bytes > MAX_BYTES) break;
    consumed++;
  }
  if (!consumed) throw corrupt();
  const selected = items.slice(0, consumed);
  const rows = (await tx.query<HistoryBlob & { matches: boolean }>(`SELECT document_sha256,kind,canonical_document,origin_writer_epoch,
    CASE WHEN $4::text IS NULL THEN false ELSE to_tsvector('simple',canonical_document::jsonb->'document'->>'payload')
      @@ plainto_tsquery('simple',$4) END AS matches FROM cloud_workspace_local_command_history_blobs
    WHERE workspace_id=$1 AND org_id=$2 AND document_sha256=ANY($3::bytea[])`,
  [scope.workspaceId, scope.organizationId, [...new Set(selected.map(item => item.ref.sha256))].map(hash => Buffer.from(hash, "hex")), query ?? null])).rows;
  const documents = new Map(rows.map(row => [row.document_sha256.toString("hex"), row]));
  const matches = new Set<string>();
  const records = selected.map(item => {
    const blob = documents.get(item.ref.sha256);
    if (!blob || blob.kind !== "record") throw corrupt();
    const record = parsedHistoryBlob(blob) as CloudLocalHistoryRecord;
    if (record.conversationId !== item.conversationId || record.entityKind !== item.ref.entityKind || record.entityId !== item.ref.entityId ||
        record.schemaVersion !== item.ref.schemaVersion || record.sourceRevision !== item.ref.sourceRevision) throw corrupt();
    if (blob.matches) matches.add(item.ref.sha256);
    return record;
  });
  return { records, consumed, matches };
}
function localChatRef(manifest: CloudLocalHistoryManifest): RecordRef {
  const refs = manifest.records.filter(ref => ref.entityKind === "chat" && ref.entityId === manifest.conversationId);
  if (refs.length !== 1) throw corrupt();
  return { conversationId: manifest.conversationId, ref: refs[0]! };
}
function localChat(record: CloudLocalHistoryRecord): Record<string, unknown> & { id: string; folder: string } {
  const result = chatDocument.safeParse(record.document);
  if (!result.success || result.data.chat.id !== record.conversationId || !validFolder(result.data.chat.folder)) throw corrupt();
  // Validation must not rebuild arbitrary saved JSON and lose inert own keys.
  return record.document.chat as Record<string, unknown> & { id: string; folder: string };
}
function localMessage(record: CloudLocalHistoryRecord) {
  const result = messageDocument.safeParse(record.document);
  if (!result.success || result.data.chatId !== record.conversationId) throw corrupt();
  return result.data;
}

/** Read the cloud-owned transcript projection without engine admission, a
 * compute lease or a provider call. Every page rechecks the acting account. */
export class DatabaseCloudWorkspaceHistoryService {
  constructor(private readonly pool: pg.Pool) {}

  private read<T>(
    scope: Scope,
    body: (tx: Tx, revision: number, local: LocalReadContext | null) => Promise<T>,
  ): Promise<T> {
    return withSystemTx(this.pool, async (tx) => {
      if (
        !(await lockCloudWorkspaceScope(tx, {
          ...scope,
          organizationLock: "share",
          workspaceLock: "share",
        }))
      )
        throw new HttpError(404, "not_found", "Workspace not found");
      await authorizeCloudWorkspaceActor(tx, {
        ...scope,
        actorUserId: scope.accountUserId,
        capability: "read",
        allowOwnerDataRecovery: true,
      });
      const local = await localReadContext(tx, scope);
      if (local) return body(tx, local.mirroredSequence, local);
      // Append holds this same row FOR UPDATE. A page's metadata, tombstones
      // and messages therefore belong to one confirmed projection revision.
      const head = (
        await tx.query<{ current_revision: string }>(
          "SELECT current_revision FROM workspace_record_heads WHERE workspace_id=$1 AND org_id=$2 FOR SHARE",
          [scope.workspaceId, scope.organizationId],
        )
      ).rows[0];
      return body(tx, Number(head?.current_revision ?? 0), null);
    });
  }

  /** Search a bounded slice of the saved projection. A continuation may have
   * no hits: the cursor advances over scanned rows, so sparse matches never
   * require an unbounded database scan or a worker wake. */
  async search(input: Scope & {
    query: string;
    limit: number;
    chatId?: string | undefined;
    folder?: string | undefined;
    cursor?: string | undefined;
    revision?: number | undefined;
  }) {
    validateLimit(input.limit, 200);
    if (typeof input.query !== "string" || input.query.length > 1000 || /[\u0000-\u001f\u007f]/u.test(input.query) ||
        (input.chatId !== undefined && !id.safeParse(input.chatId).success) ||
        (input.folder !== undefined && (!validFolder(input.folder) || input.folder.length > 4096)) ||
        (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision < 0)) ||
        (input.cursor !== undefined && (input.cursor.length > 1024 || input.revision === undefined))) throw invalid();
    return this.read(input, async (tx, revision, local) => {
      if (input.revision !== undefined && input.revision !== revision)
        throw new HttpError(409, "cloud_history_changed", "Cloud history changed while loading; retry the snapshot");
      if (local) return this.localSearch(tx, input, local);
      const binding = createHash("sha256").update(JSON.stringify([
        input.workspaceId, input.organizationId, input.accountUserId, revision,
        input.query, input.chatId ?? null, input.folder ?? null,
      ])).digest("hex");
      let after: string | null = null;
      if (input.cursor !== undefined) {
        try {
          const cursor = z.object({ after: z.string().regex(/^m:[a-f0-9]{64}$/), binding: z.literal(binding) }).strict()
            .parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
          after = cursor.after;
        } catch { throw invalid(); }
      }
      const hits: Array<{ chatId: string; msgId: string; payload: string; createdAt: number }> = [];
      const result = (nextCursor: string | null) => ({ workspaceId: input.workspaceId, organizationId: input.organizationId, revision, hits, nextCursor });
      if (!input.query.trim() || revision === 0) return result(null);
      // Tenant predicates apply before paging, and only live chats participate.
      // Materialization bounds full-text tokenization as well as returned bytes.
      const scanLimit = 512;
      const rows = (await tx.query<Entity & { matches: boolean; overflow: boolean }>(`
        WITH candidates AS MATERIALIZED (
          SELECT m.entity_id,m.schema_version,m.document,m.tombstoned_at
          FROM workspace_record_entities m
          JOIN workspace_record_entities c ON c.workspace_id=m.workspace_id AND c.org_id=m.org_id
            AND c.entity_kind='chat' AND c.entity_id=m.document->>'chatId' AND c.tombstoned_at IS NULL
          WHERE m.workspace_id=$1 AND m.org_id=$2 AND m.entity_kind='message' AND m.tombstoned_at IS NULL
            AND ($3::text IS NULL OR m.document->>'chatId'=$3)
            AND ($4::text IS NULL OR c.document->'chat'->>'folder'=$4)
            AND ($5::text IS NULL OR m.entity_id>$5)
          ORDER BY m.entity_id LIMIT $6
        ), bounded AS MATERIALIZED (
          SELECT *,sum(octet_length(document::text)+512) OVER (ORDER BY entity_id) AS bytes FROM candidates
        )
        SELECT entity_id,schema_version,document,tombstoned_at,bytes>$7 AS overflow,
          CASE WHEN bytes<=$7 THEN to_tsvector('simple',document->>'payload') @@ plainto_tsquery('simple',$8) ELSE false END AS matches
        FROM bounded WHERE bytes<=$7 OR entity_id=(SELECT entity_id FROM bounded WHERE bytes>$7 ORDER BY entity_id LIMIT 1)
        ORDER BY entity_id`, [input.workspaceId, input.organizationId, input.chatId ?? null,
        input.folder ?? null, after, scanLimit + 1, MAX_BYTES, input.query])).rows;
      let consumed = 0;
      for (const row of rows.slice(0, scanLimit)) {
        if (row.overflow || hits.length >= input.limit) break;
        const parsed = messageDocument.safeParse(row.document);
        if (row.schema_version !== 1 || !parsed.success ||
            row.entity_id !== `m:${createHash("sha256").update(`${parsed.data.chatId}\0${parsed.data.msgId}`).digest("hex")}`) throw corrupt();
        if (row.matches) {
          const { chatId, msgId, payload, createdAt } = parsed.data;
          hits.push({ chatId, msgId, payload, createdAt });
        }
        consumed++;
      }
      if (rows.length > 0 && consumed === 0) throw corrupt();
      return result(rows.length > consumed
        ? Buffer.from(JSON.stringify({ after: rows[consumed - 1]!.entity_id, binding })).toString("base64url") : null);
    });
  }

  async chats(
    input: Scope & {
      limit: number;
      afterId?: string | undefined;
      revision?: number | undefined;
    },
  ) {
    validateLimit(input.limit, 200);
    if (
      (input.afterId !== undefined && !id.safeParse(input.afterId).success) ||
      (input.revision !== undefined &&
        (!Number.isSafeInteger(input.revision) || input.revision < 0))
    )
      throw invalid();
    return this.read(input, async (tx, revision, local) => {
      if (input.revision !== undefined && input.revision !== revision)
        throw new HttpError(
          409,
          "cloud_history_changed",
          "Cloud history changed while loading; retry the snapshot",
        );
      if (local) return this.localChats(tx, input, local);
      const rows =
        revision === 0
          ? []
          : (
              await tx.query<Entity & { overflow: boolean }>(
                `WITH candidates AS MATERIALIZED (SELECT entity_id,schema_version,document,tombstoned_at
        FROM workspace_record_entities WHERE workspace_id=$1 AND org_id=$2 AND entity_kind='chat'
          AND ($3::text IS NULL OR entity_id>$3) ORDER BY entity_id LIMIT $4), bounded AS (
          SELECT *,sum(coalesce(octet_length(document::text),0)+512) OVER (ORDER BY entity_id) AS bytes FROM candidates)
        SELECT entity_id,schema_version,document,tombstoned_at,bytes>$5 AS overflow FROM bounded
        WHERE bytes<=$5 OR entity_id=(SELECT entity_id FROM bounded WHERE bytes>$5 ORDER BY entity_id LIMIT 1) ORDER BY entity_id`,
                [
                  input.workspaceId,
                  input.organizationId,
                  input.afterId ?? null,
                  input.limit + 1,
                  MAX_BYTES,
                ],
              )
            ).rows;
      const chats: Array<
        Record<string, unknown> & { id: string; folder: string }
      > = [];
      const chatDeletions: string[] = [];
      let consumed = 0;
      for (const row of rows.slice(0, input.limit)) {
        // The extra row proves more data exists without a second query. Use
        // SQL's byte accounting for consumption as well as the page boundary.
        if (row.overflow) break;
        if (row.tombstoned_at) chatDeletions.push(row.entity_id);
        else {
          const parsed = chatDocument.safeParse(row.document);
          if (
            row.schema_version !== 1 ||
            !parsed.success ||
            parsed.data.chat.id !== row.entity_id ||
            !validFolder(parsed.data.chat.folder)
          )
            throw corrupt();
          chats.push(parsed.data.chat);
        }
        consumed++;
      }
      if (rows.length > 0 && consumed === 0) throw corrupt();
      return {
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        revision,
        chats,
        chatDeletions,
        nextCursor:
          rows.length > consumed ? rows[consumed - 1]!.entity_id : null,
      };
    });
  }

  async messages(
    input: Scope & {
      chatId: string;
      limit: number;
      beforeMsgId?: string | undefined;
      before?: number | undefined;
    },
  ) {
    validateLimit(input.limit, MAX_MESSAGES);
    if (
      !id.safeParse(input.chatId).success ||
      (input.beforeMsgId !== undefined &&
        !id.safeParse(input.beforeMsgId).success) ||
      (input.before !== undefined &&
        (!Number.isSafeInteger(input.before) || input.before < 0)) ||
      (input.before !== undefined && input.beforeMsgId !== undefined)
    )
      throw invalid();
    return this.read(input, async (tx, revision, local) => {
      if (local) return this.localMessages(tx, input, local);
      const chat =
        revision === 0
          ? null
          : (
              await tx.query(
                "SELECT 1 FROM workspace_record_entities WHERE workspace_id=$1 AND org_id=$2 AND entity_kind='chat' AND entity_id=$3 AND tombstoned_at IS NULL",
                [input.workspaceId, input.organizationId, input.chatId],
              )
            ).rows[0];
      if (!chat)
        throw new HttpError(404, "not_found", "Conversation not found");
      const result = (
        messages: Array<{
          msgId: string;
          kind: string;
          payload: string;
          createdAt: number;
        }>,
      ) => ({
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        revision,
        messages,
      });
      let before = input.before;
      if (input.beforeMsgId !== undefined) {
        const entity = `m:${createHash("sha256").update(`${input.chatId}\0${input.beforeMsgId}`).digest("hex")}`;
        const cursor = (
          await tx.query<{ document: unknown }>(
            "SELECT document FROM workspace_record_entities WHERE workspace_id=$1 AND org_id=$2 AND entity_kind='message' AND entity_id=$3 AND tombstoned_at IS NULL",
            [input.workspaceId, input.organizationId, entity],
          )
        ).rows[0];
        if (!cursor) return result([]);
        const parsed = messageDocument.safeParse(cursor.document);
        if (
          !parsed.success ||
          parsed.data.chatId !== input.chatId ||
          parsed.data.msgId !== input.beforeMsgId
        )
          throw corrupt();
        before = parsed.data.ord;
      }
      // SQL bounds both rows and bytes before materializing tool payloads in
      // the API process. JSON numeric ordering uses the matching partial index.
      const raw = (
        await tx.query<Entity>(
          `WITH candidates AS MATERIALIZED (
        SELECT entity_id,schema_version,document,tombstoned_at FROM workspace_record_entities
        WHERE workspace_id=$1 AND org_id=$2 AND entity_kind='message' AND tombstoned_at IS NULL
          AND document->>'chatId'=$3 AND ($4::bigint IS NULL OR document->'ord'<to_jsonb($4::bigint))
        ORDER BY document->'ord' DESC,entity_id LIMIT $5
      ), bounded AS (SELECT *,sum(octet_length(document::text)) OVER (ORDER BY document->'ord' DESC,entity_id) AS bytes FROM candidates)
      SELECT entity_id,schema_version,document,tombstoned_at FROM bounded WHERE bytes<=$6 ORDER BY document->'ord' DESC,entity_id`,
          [
            input.workspaceId,
            input.organizationId,
            input.chatId,
            before ?? null,
            before === undefined ? MAX_MESSAGES : input.limit,
            MAX_BYTES,
          ],
        )
      ).rows;
      const rows = raw.map((row) => {
        const parsed = messageDocument.safeParse(row.document);
        if (
          row.schema_version !== 1 ||
          !parsed.success ||
          parsed.data.chatId !== input.chatId ||
          row.entity_id !==
            `m:${createHash("sha256").update(`${input.chatId}\0${parsed.data.msgId}`).digest("hex")}`
        )
          throw corrupt();
        return parsed.data;
      });
      let count = Math.min(input.limit, rows.length);
      const user = (index: number, opening: boolean) => {
        const row = rows[index];
        if (!row || row.kind !== "text") return false;
        try {
          const payload = JSON.parse(row.payload);
          return (
            payload.role === "user" && (!opening || !payload.steeredTurnId)
          );
        } catch {
          return false;
        }
      };
      // Match the existing transcript window: keep its opening prompt when a
      // tool-heavy turn crosses the requested tail, with a 1000-row ceiling.
      if (before === undefined && count > 0 && !user(count - 1, false)) {
        let start = rows.findIndex(
          (_, index) => index >= count && user(index, true),
        );
        if (start < 0)
          start = rows.findIndex(
            (_, index) => index >= count && user(index, false),
          );
        if (start >= 0) count = start + 1;
      }
      return result(
        rows
          .slice(0, count)
          .reverse()
          .map(({ msgId, kind, payload, createdAt }) => ({
            msgId,
            kind,
            payload,
            createdAt,
          })),
      );
    });
  }

  private async localChats(tx: Tx, input: Scope & { limit: number; afterId?: string | undefined }, local: LocalReadContext) {
    const rows = await localCandidates(tx, input, local, { afterId: input.afterId, limit: input.limit + 1 });
    let candidates = boundedCandidates(rows, input.limit);
    const manifests = await localManifests(tx, input, local, candidates);
    const headers = candidates.flatMap(candidate => {
      const manifest = manifests.get(candidate.conversationId);
      return manifest && !manifest.deleted ? [localChatRef(manifest)] : [];
    });
    const records = await localRecords(tx, input, headers);
    if (records.consumed < headers.length) candidates = candidates.slice(0,
      candidates.findIndex(candidate => candidate.conversationId === headers[records.consumed]!.conversationId));
    const chats = records.records.map(localChat);
    return { workspaceId: input.workspaceId, organizationId: input.organizationId, revision: local.mirroredSequence,
      chats, chatDeletions: candidates.filter(candidate => candidate.head?.deleted).map(candidate => candidate.conversationId),
      nextCursor: rows.length > candidates.length ? candidates.at(-1)!.conversationId : null, ...localMetadata(local, candidates) };
  }

  private async localMessages(tx: Tx, input: Scope & {
    chatId: string; limit: number; beforeMsgId?: string | undefined; before?: number | undefined;
  }, local: LocalReadContext) {
    const candidates = await localCandidates(tx, input, local, { conversationId: input.chatId, limit: 1 });
    if (!candidates.length) throw new HttpError(404, "not_found", "Conversation not found");
    const manifests = await localManifests(tx, input, local, candidates), manifest = manifests.get(input.chatId);
    const result = (messages: Array<{ msgId: string; kind: string; payload: string; createdAt: number }>) => ({
      workspaceId: input.workspaceId, organizationId: input.organizationId, revision: local.mirroredSequence,
      messages, ...localMetadata(local, candidates),
    });
    if (!manifest || manifest.deleted) return result([]);
    localChat((await localRecords(tx, input, [localChatRef(manifest)])).records[0]!);
    const refs = manifest.records.filter(ref => ref.entityKind === "message");
    if (!refs.length) return result([]);
    // Metadata is bounded by the verified FULL16MiB conversation. Only the
    // requested3MiB window is materialized in the API process below.
    const metadata = (await tx.query<{ document_sha256: Buffer; bytes: number; ord: unknown; msg_id: unknown }>(`SELECT document_sha256,
      octet_length(canonical_document) AS bytes,canonical_document::jsonb->'document'->'ord' AS ord,
      canonical_document::jsonb->'document'->>'msgId' AS msg_id FROM cloud_workspace_local_command_history_blobs
      WHERE workspace_id=$1 AND org_id=$2 AND kind='record' AND document_sha256=ANY($3::bytea[])`,
    [input.workspaceId, input.organizationId, refs.map(ref => Buffer.from(ref.sha256, "hex"))])).rows;
    const byHash = new Map(metadata.map(row => [row.document_sha256.toString("hex"), row]));
    if (byHash.size !== refs.length || new Set(metadata.map(row => row.msg_id)).size !== refs.length ||
        metadata.some(row => !id.safeParse(row.msg_id).success || !Number.isSafeInteger(row.ord) || Number(row.ord) < 0 ||
          !Number.isSafeInteger(row.bytes) || row.bytes < 1) ||
        metadata.reduce((bytes, row) => bytes + row.bytes, candidates[0]!.manifestBytes ?? HISTORY_BUNDLE_BYTES) > HISTORY_BUNDLE_BYTES) throw corrupt();
    let before = input.before;
    if (input.beforeMsgId !== undefined) {
      const row = metadata.find(row => row.msg_id === input.beforeMsgId);
      if (!row) return result([]);
      before = Number(row.ord);
    }
    const ordered = refs.filter(ref => before === undefined || Number(byHash.get(ref.sha256)!.ord) < before).sort((left, right) =>
      Number(byHash.get(right.sha256)!.ord) - Number(byHash.get(left.sha256)!.ord) ||
      (left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0));
    const rows = (await localRecords(tx, input, ordered.slice(0, before === undefined ? MAX_MESSAGES : input.limit)
      .map(ref => ({ conversationId: input.chatId, ref })))).records.map(localMessage);
    let count = Math.min(input.limit, rows.length);
    const user = (index: number, opening: boolean) => {
      const row = rows[index]; if (!row || row.kind !== "text") return false;
      try { const payload = JSON.parse(row.payload); return payload.role === "user" && (!opening || !payload.steeredTurnId); }
      catch { return false; }
    };
    if (before === undefined && count > 0 && !user(count - 1, false)) {
      let start = rows.findIndex((_, index) => index >= count && user(index, true));
      if (start < 0) start = rows.findIndex((_, index) => index >= count && user(index, false));
      if (start >= 0) count = start + 1;
    }
    return result(rows.slice(0, count).reverse().map(({ msgId, kind, payload, createdAt }) => ({ msgId, kind, payload, createdAt })));
  }

  private async localSearch(tx: Tx, input: Scope & {
    query: string; limit: number; chatId?: string | undefined; folder?: string | undefined; cursor?: string | undefined;
  }, local: LocalReadContext) {
    const bound = local.binding;
    const binding = createHash("sha256").update(canonicalCloudHistoryJson([input.workspaceId, input.organizationId, input.accountUserId,
      bound.generation, bound.engineInstanceId, bound.bootId, bound.writerEpoch, bound.fundingOwnerEpoch, local.mirroredSequence,
      input.query, input.chatId ?? null, input.folder ?? null])).digest("hex");
    let afterConversation: string | undefined, afterEntity: string | null = null;
    if (input.cursor !== undefined) {
      try {
        const cursor = z.object({ conversationId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/), entityId: id.nullable(), binding: z.literal(binding) }).strict()
          .parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
        afterConversation = cursor.conversationId; afterEntity = cursor.entityId;
      } catch { throw invalid(); }
    }
    const rows = await localCandidates(tx, input, local, { conversationId: input.chatId, afterId: afterConversation,
      inclusive: afterEntity !== null, limit: 513 });
    let candidates = boundedCandidates(rows, 512);
    const manifests = await localManifests(tx, input, local, candidates);
    const headers = candidates.flatMap(candidate => {
      const manifest = manifests.get(candidate.conversationId); return manifest && !manifest.deleted ? [localChatRef(manifest)] : [];
    });
    const readHeaders = await localRecords(tx, input, headers);
    if (readHeaders.consumed < headers.length) candidates = candidates.slice(0,
      candidates.findIndex(candidate => candidate.conversationId === headers[readHeaders.consumed]!.conversationId));
    const folders = new Map(readHeaders.records.map(record => [record.conversationId, localChat(record).folder]));
    const items = candidates.flatMap(candidate => {
      const manifest = manifests.get(candidate.conversationId);
      if (!manifest || manifest.deleted || (input.folder !== undefined && folders.get(candidate.conversationId) !== input.folder)) return [];
      return manifest.records.filter(ref => ref.entityKind === "message" &&
        (candidate.conversationId !== afterConversation || afterEntity === null || ref.entityId > afterEntity))
        .sort((left, right) => left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0)
        .map(ref => ({ conversationId: candidate.conversationId, ref }));
    }).slice(0, 513);
    const read = input.query.trim() ? await localRecords(tx, input, items.slice(0, 512), input.query) : { records: [], consumed: 0, matches: new Set<string>() };
    const hits: Array<{ chatId: string; msgId: string; payload: string; createdAt: number }> = [];
    let consumed = 0;
    for (const record of read.records) {
      const message = localMessage(record);
      if (hits.length >= input.limit) break;
      if (read.matches.has(items[consumed]!.ref.sha256)) {
        const { chatId, msgId, payload, createdAt } = message; hits.push({ chatId, msgId, payload, createdAt });
      }
      consumed++;
    }
    const lastItem = consumed > 0 ? items[consumed - 1]! : null;
    let nextCursor: string | null = null;
    if (input.query.trim() && (items.length > consumed || rows.length > candidates.length)) {
      const last = lastItem && items.length > consumed ? { conversationId: lastItem.conversationId, entityId: lastItem.ref.entityId }
        : { conversationId: candidates.at(-1)!.conversationId, entityId: null };
      nextCursor = Buffer.from(JSON.stringify({ ...last, binding })).toString("base64url");
    }
    return { workspaceId: input.workspaceId, organizationId: input.organizationId, revision: local.mirroredSequence,
      hits, nextCursor, ...localMetadata(local, candidates) };
  }

  async commands(input: Scope & { conversationId: string }) {
    if (!z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).safeParse(input.conversationId).success) throw invalid();
    return this.read(input, async (tx, _revision, local) => {
      if (!local) throw new HttpError(409, "cloud_runtime_upgrade_required", "Local cloud commands are unavailable for this workspace");
      const control = (await tx.query<{ revision: string; paused: boolean; native_goal: unknown }>(`SELECT revision,paused,native_goal
        FROM cloud_workspace_local_command_controls WHERE workspace_id=$1 AND org_id=$2 AND writer_epoch=$3 AND conversation_id=$4`,
      [input.workspaceId, input.organizationId, local.binding.writerEpoch, input.conversationId])).rows[0];
      if (!control) throw new HttpError(404, "not_found", "Conversation not found");
      const pending = await this.localCommandRows(tx, input, local, input.conversationId, true, 33);
      if (pending.length > 32) throw corrupt();
      const receipts = await this.localCommandRows(tx, input, local, input.conversationId, false, 50);
      const queue = CloudBootCommandSnapshotSchema.safeParse({ version: 1, conversationId: input.conversationId,
        revision: historySequence(control.revision), paused: control.paused, pending, receipts,
        ...(control.native_goal !== null ? { nativeGoal: control.native_goal } : {}) });
      if (!queue.success) throw corrupt();
      const candidates = await localCandidates(tx, input, local, { conversationId: input.conversationId, limit: 1 });
      await localManifests(tx, input, local, candidates);
      return { queue: queue.data, ...localMetadata(local, candidates) };
    });
  }

  async receipt(input: Scope & { commandId: string }) {
    if (!z.string().uuid().safeParse(input.commandId).success) throw invalid();
    return this.read(input, async (tx, _revision, local) => {
      if (!local) throw new HttpError(409, "cloud_runtime_upgrade_required", "Local cloud commands are unavailable for this workspace");
      const row = (await tx.query<LocalCommandRow>(`SELECT id,conversation_id,user_message_id,agent_id,position,state,payload,execution_id,
        generation,result_code,result,created_at,updated_at FROM cloud_workspace_local_commands WHERE workspace_id=$1 AND org_id=$2
        AND projection_epoch=$3 AND id=$4 AND mirror_sequence<=$5`, [input.workspaceId, input.organizationId, local.binding.writerEpoch,
      input.commandId, local.mirroredSequence])).rows[0];
      if (!row) throw new HttpError(404, "not_found", "Command not found");
      const entry = localCommandEntry(row);
      const candidates = await localCandidates(tx, input, local, { conversationId: row.conversation_id, limit: 1 });
      await localManifests(tx, input, local, candidates);
      return { receipt: { conversationId: row.conversation_id, entry }, ...localMetadata(local, candidates) };
    });
  }

  private async localCommandRows(tx: Tx, input: Scope, local: LocalReadContext, conversationId: string, pending: boolean, limit: number) {
    const rows = (await tx.query<LocalCommandRow>(`SELECT id,conversation_id,user_message_id,agent_id,position,state,payload,execution_id,
      generation,result_code,result,created_at,updated_at FROM cloud_workspace_local_commands WHERE workspace_id=$1 AND org_id=$2
      AND projection_epoch=$3 AND conversation_id=$4 AND mirror_sequence<=$5
      AND (state IN ('queued','dispatching'))=$6 ORDER BY ${pending ? "position ASC,id" : "created_at DESC,id DESC"} LIMIT $7`,
    [input.workspaceId, input.organizationId, local.binding.writerEpoch, conversationId, local.mirroredSequence, pending, limit])).rows;
    return rows.map(localCommandEntry);
  }
}

type LocalCommandRow = { id: string; conversation_id: string; user_message_id: string; agent_id: string; position: string; state: string; payload: unknown;
  execution_id: string | null; generation: number; result_code: string | null; result: unknown; created_at: Date; updated_at: Date };
function localCommandEntry(row: LocalCommandRow) {
  const result = CloudBootCommandEntrySchema.safeParse({ commandId: row.id, position: historySequence(row.position), state: row.state,
    payload: row.payload, executionId: row.execution_id, generation: row.generation, resultCode: row.result_code,
    result: row.result, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
  if (!result.success) throw corrupt();
  const terminal = result.data.result?.terminal;
  if (terminal && (terminal.commandId !== row.id || terminal.conversationId !== row.conversation_id ||
      terminal.executionId !== row.execution_id || terminal.turnId !== row.user_message_id || terminal.agentId !== row.agent_id ||
      terminal.status !== ({ succeeded: "completed", failed: "failed", cancelled: "cancelled" } as Record<string, string>)[row.state])) throw corrupt();
  return result.data;
}
