import { createHash } from "node:crypto";
import type { Tx } from "../db.js";
import { HttpError } from "../authz.js";
import type { CloudAgentBootScope, CloudAgentHistoryRecoveryResponse } from "./agent-boot-contract.js";
import { CloudCheckpointHistorySnapshotSchema, CLOUD_CHECKPOINT_HISTORY_MAX_BYTES, type CloudCheckpointHistorySnapshot } from "./checkpoint-history-contract.js";
import { canonicalCloudHistoryJson as canonical, CloudLocalHistoryManifestSchema } from "./history-local-contract.js";

function reject(): never { throw new HttpError(403, "cloud_validation_access_denied", "cloud_validation_access_denied"); }
function limit(): never { throw new HttpError(409, "cloud_history_recovery_limit", "cloud_history_recovery_limit"); }
export type CheckpointHistoryOwner = { id: string; checkpoint_id: string; source_generation: number; engine_instance_id: string };
export async function checkpointHistoryOwner(tx: Tx, engineInstanceId: string): Promise<CheckpointHistoryOwner> {
  const row = (await tx.query<CheckpointHistoryOwner>(`SELECT receipt.id,receipt.checkpoint_id,receipt.source_generation,recovery.engine_instance_id
    FROM cloud_workspace_owner_discard_receipts receipt
    JOIN cloud_workspace_final_save_recoveries recovery ON recovery.lifecycle_intent_id=receipt.stop_intent_id
    WHERE receipt.id=cloud_owner_discard_history_receipt($1)`, [engineInstanceId])).rows[0];
  return row ?? reject();
}

type History = NonNullable<CloudCheckpointHistorySnapshot["commands"][number]["history"]>;
type HeadRow = { conversation_id: string; origin_writer_epoch: string; source: unknown; deleted: boolean;
  restore_revision: string; record_sequence: string | null; event_sequence: string | null;
  manifest_sha256: Buffer | null; incomplete_reason: string | null };
function history(row: Pick<HeadRow, "restore_revision" | "record_sequence" | "event_sequence" | "manifest_sha256" | "incomplete_reason">): History {
  const counters = { restoreRevision: Number(row.restore_revision), recordSequence: row.record_sequence === null ? null : Number(row.record_sequence),
    eventSequence: row.event_sequence === null ? null : Number(row.event_sequence) };
  return (row.manifest_sha256 ? { ...counters, manifestSha256: row.manifest_sha256.toString("hex") }
    : { ...counters, incompleteReason: row.incomplete_reason }) as History;
}

async function mirrorSnapshot(tx: Tx, scope: CloudAgentBootScope): Promise<CloudCheckpointHistorySnapshot> {
  const args = [scope.workspaceId, scope.organizationId];
  // Bound database egress before materializing any large canonical body. The
  // source is retired under the workspace lock, so no mirror may race this cut.
  const size = (await tx.query<{ bytes: string; n: string }>(`SELECT count(*) AS n,
      coalesce(sum(octet_length(coalesce(result::text,''))+octet_length(coalesce(actor_provenance::text,''))+
        octet_length(coalesce(credential_run_info::text,''))+2048),0) AS bytes
    FROM cloud_workspace_local_commands WHERE workspace_id=$1 AND org_id=$2`, args)).rows[0]!;
  if (Number(size.n)>100_000 || Number(size.bytes)>CLOUD_CHECKPOINT_HISTORY_MAX_BYTES) limit();
  const originRows = (await tx.query<{ scope: CloudAgentBootScope; record_sequence: string; event_sequence: string; sealed:boolean }>(`SELECT
      jsonb_build_object('organizationId',writer.org_id,'workspaceId',writer.workspace_id,'generation',writer.generation,
        'engineInstanceId',writer.engine_instance_id,'bootId',writer.boot_id,'writerEpoch',writer.writer_epoch,
        'fundingOwnerUserId',writer.funding_owner_user_id,'fundingOwnerEpoch',writer.funding_owner_epoch) AS scope,
      coalesce(writer.seal_record_sequence,0) AS record_sequence,coalesce(writer.seal_event_sequence,0) AS event_sequence,
      writer.seal IS NOT NULL AND writer.seal_ack IS NOT NULL AS sealed
    FROM cloud_workspace_local_command_writers writer JOIN cloud_workspace_engine_instances engine ON engine.id=writer.engine_instance_id
    JOIN cloud_workspace_engine_instances source ON source.id=$3
    WHERE writer.workspace_id=$1 AND writer.org_id=$2 AND writer.state='retired' AND engine.enrollment_order<=source.enrollment_order
    ORDER BY engine.enrollment_order,writer.writer_epoch LIMIT 4097`, [...args, scope.engineInstanceId])).rows;
  const origins=originRows.map(row => ({ scope: row.scope, recordSequence: Number(row.record_sequence), eventSequence: Number(row.event_sequence) }));
  if (origins.length>4096) limit();
  const originByWriter=new Map(origins.map((origin,index)=>[origin.scope.writerEpoch,{origin,sealed:originRows[index]!.sealed}]));
  const controls = (await tx.query<{ conversation_id: string; revision: string; paused: boolean }>(`SELECT DISTINCT ON (conversation_id)
      conversation_id,revision,paused FROM cloud_workspace_local_command_controls
    WHERE workspace_id=$1 AND org_id=$2 ORDER BY conversation_id,revision DESC,updated_at DESC LIMIT 10001`, args)).rows
    .map(row => ({ conversationId: row.conversation_id, revision: Number(row.revision), paused: row.paused }));
  const heads = (await tx.query<HeadRow>(`SELECT DISTINCT ON (conversation_id) * FROM cloud_workspace_local_command_history_heads
    WHERE workspace_id=$1 AND org_id=$2 ORDER BY conversation_id,restore_revision DESC,updated_at DESC LIMIT 10001`, args)).rows
    .map(row => ({ conversationId: row.conversation_id, head: { originWriterEpoch: row.origin_writer_epoch, source: row.source,
      deleted: row.deleted, history: history(row) } })) as CloudCheckpointHistorySnapshot["heads"];
  if (controls.length>10_000 || heads.length>10_000) limit();
  const commands = (await tx.query<{ conversation_id: string; writer_epoch: string; entry: unknown; user_message_id: string; agent_id: string;
    actor_provenance: unknown; credential_run_info: unknown; restore_revision: string | null; record_sequence: string | null;
    event_sequence: string | null; manifest_sha256: Buffer | null; incomplete_reason: string | null }>(`SELECT conversation_id,writer_epoch,
      jsonb_build_object('commandId',id,'position',position,'state',state,'executionId',execution_id,'generation',generation,
        'resultCode',result_code,'createdAt',created_at,'updatedAt',updated_at,'result',result) AS entry,
      user_message_id,agent_id,actor_provenance,credential_run_info,history_restore_revision AS restore_revision,
      history_record_sequence AS record_sequence,history_event_sequence AS event_sequence,
      history_manifest_sha256 AS manifest_sha256,history_incomplete_reason AS incomplete_reason
    FROM cloud_workspace_local_commands WHERE workspace_id=$1 AND org_id=$2 ORDER BY conversation_id,position,id`, args)).rows
    .map(row => ({ conversationId: row.conversation_id, originWriterEpoch: row.writer_epoch,
      entry: { ...row.entry as object, createdAt: new Date((row.entry as { createdAt: string }).createdAt).toISOString(),
        updatedAt: new Date((row.entry as { updatedAt: string }).updatedAt).toISOString() },
      intent: { userMessageId: row.user_message_id, agentId: row.agent_id }, actor: row.actor_provenance,
      credentialRun: row.credential_run_info, history: row.restore_revision === null ? null : history({ ...row, restore_revision: row.restore_revision }) })) as CloudCheckpointHistorySnapshot["commands"];
  for (const item of [...heads.map(item => ({ epoch: item.head.originWriterEpoch, history: item.head.history })),
    ...commands.map(item => ({ epoch: item.originWriterEpoch, history: item.history }))]) {
    const bound = originByWriter.get(item.epoch);
    if (!bound) reject();
    const {origin,sealed}=bound;
    if(sealed && ((item.history?.recordSequence??0)>origin.recordSequence || (item.history?.eventSequence??0)>origin.eventSequence))reject();
    origin.recordSequence=Math.max(origin.recordSequence,item.history?.recordSequence??0);
    origin.eventSequence=Math.max(origin.eventSequence,item.history?.eventSequence??0);
  }
  const documents: CloudCheckpointHistorySnapshot["documents"] = [];
  const loaded=new Set<string>();
  let bytes=Number(size.bytes);
  async function load(hashes: string[], kind: "manifest" | "record") {
    if (!hashes.length) return;
    const unique=[...new Set(hashes)].filter(hash=>!loaded.has(hash));
    if (unique.length+documents.length>65_536) limit();
    const params=[...args,unique.map(hash=>Buffer.from(hash,"hex")),kind];
    const metadata=(await tx.query<{ bytes:string;n:string }>(`SELECT count(*) AS n,coalesce(sum(octet_length(canonical_document)),0) AS bytes
      FROM cloud_workspace_local_command_history_blobs WHERE workspace_id=$1 AND org_id=$2 AND document_sha256=ANY($3::bytea[]) AND kind=$4`,params)).rows[0]!;
    if (Number(metadata.n)!==unique.length) reject();
    bytes+=Number(metadata.bytes); if (bytes>CLOUD_CHECKPOINT_HISTORY_MAX_BYTES) limit();
    const rows=(await tx.query<{ document_sha256:Buffer;canonical_document:string }>(`SELECT document_sha256,canonical_document
      FROM cloud_workspace_local_command_history_blobs WHERE workspace_id=$1 AND org_id=$2 AND document_sha256=ANY($3::bytea[]) AND kind=$4
      ORDER BY document_sha256`,params)).rows;
    for(const row of rows) {
      const sha256=row.document_sha256.toString("hex");loaded.add(sha256);
      documents.push({sha256,kind,document:row.canonical_document});
    }
  }
  await load([...heads.map(item=>item.head.history),...commands.flatMap(item=>item.history?[item.history]:[])]
    .flatMap(history=>"manifestSha256" in history?[history.manifestSha256]:[]),"manifest");
  const refs=documents.flatMap(item=>CloudLocalHistoryManifestSchema.parse(JSON.parse(item.document)).records.map(ref=>ref.sha256));
  await load(refs,"record");
  return CloudCheckpointHistorySnapshotSchema.parse({version:1,scope,origins,controls,commands,heads,documents});
}

export async function checkpointHistorySnapshot(tx: Tx, recoveryId: string, scope: CloudAgentBootScope,
  owner: CheckpointHistoryOwner): Promise<NonNullable<CloudAgentHistoryRecoveryResponse["checkpointOnly"]>> {
  let row=(await tx.query<{owner_discard_receipt_id:string;checkpoint_id:string;document:string;sha256:string}>(
    "SELECT * FROM cloud_agent_checkpoint_history_snapshots WHERE recovery_id=$1",[recoveryId])).rows[0];
  if(!row) {
    const document=canonical(await mirrorSnapshot(tx,scope));
    if(Buffer.byteLength(document)>CLOUD_CHECKPOINT_HISTORY_MAX_BYTES) limit();
    const sha256=createHash("sha256").update(document).digest("hex");
    row=(await tx.query(`INSERT INTO cloud_agent_checkpoint_history_snapshots(recovery_id,owner_discard_receipt_id,checkpoint_id,document,sha256)
      VALUES($1,$2,$3,$4,$5) RETURNING *`,[recoveryId,owner.id,owner.checkpoint_id,document,sha256])).rows[0];
  }
  if(!row || row.owner_discard_receipt_id!==owner.id || row.checkpoint_id!==owner.checkpoint_id) reject();
  return {ownerDiscardReceiptId:row.owner_discard_receipt_id,checkpointId:row.checkpoint_id,document:row.document,sha256:row.sha256};
}

export async function checkCheckpointHistoryActivation(tx:Tx, recoveryId:string, engineInstanceId:string):Promise<void> {
  const snapshot=(await tx.query<{owner_discard_receipt_id:string;checkpoint_id:string}>(
    "SELECT owner_discard_receipt_id,checkpoint_id FROM cloud_agent_checkpoint_history_snapshots WHERE recovery_id=$1",[recoveryId])).rows[0];
  if(!snapshot)return;
  const owner=await checkpointHistoryOwner(tx,engineInstanceId);
  if(snapshot.owner_discard_receipt_id!==owner.id || snapshot.checkpoint_id!==owner.checkpoint_id) reject();
}
