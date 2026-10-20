import { createHash } from "node:crypto";
import type Sqlite from "better-sqlite3";
import { CloudAgentHistoryRecoveryResponseSchema, type CloudAgentHistoryRecoveryResponse } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudCheckpointHistorySnapshotSchema, CLOUD_CHECKPOINT_HISTORY_MAX_BYTES, CLOUD_CHECKPOINT_HISTORY_ENVELOPE_MAX_BYTES,
  type CloudCheckpointHistorySnapshot } from "@zeros/protocol/cloud-checkpoint-history";
import { canonicalCloudLocalCommandHistoryJson as canonical, CloudLocalCommandHistoryManifestSchema,
  CloudLocalCommandHistoryRecordSchema, CloudLocalCommandHistoryHeadSchema, cloudLocalCommandHistoryHeadMatchesManifest,
  CLOUD_LOCAL_COMMAND_HISTORY_BUNDLE_MAX_BYTES } from "@zeros/protocol/cloud-local-mirror";
import { CloudCommandRuntimeError } from "./cloud-command-client";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function refuse(): never { throw new CloudCommandRuntimeError("checkpoint_inventory_hash"); }
type Check = () => void;
export function parseCheckpointHistory(authorization: CloudAgentHistoryRecoveryResponse, check: Check): CloudCheckpointHistorySnapshot {
  check();
  const proof=authorization.checkpointOnly;
  if(!proof || Buffer.byteLength(proof.document)>CLOUD_CHECKPOINT_HISTORY_MAX_BYTES || hash(proof.document)!==proof.sha256) refuse();
  const snapshot=CloudCheckpointHistorySnapshotSchema.parse(JSON.parse(proof.document));
  check();
  if(canonical(snapshot)!==proof.document || canonical(snapshot.scope)!==canonical(authorization.predecessor)) refuse();
  const origins=new Map(snapshot.origins.map(item=>[item.scope.writerEpoch,item]));
  const documents=new Map(snapshot.documents.map(item=>[item.sha256,item]));
  const commands=new Map(snapshot.commands.map(item=>[item.entry.commandId,item]));
  for(const item of snapshot.documents) {
    check();
    if(hash(item.document)!==item.sha256) refuse();
    const parsed=item.kind==="manifest"?CloudLocalCommandHistoryManifestSchema.parse(JSON.parse(item.document)):
      CloudLocalCommandHistoryRecordSchema.parse(JSON.parse(item.document));
    if(canonical(parsed)!==item.document) refuse();
  }
  const heads=[...snapshot.heads,...snapshot.commands.flatMap(item=>item.history?[{conversationId:item.conversationId,head:{
    originWriterEpoch:item.originWriterEpoch,source:{kind:"command" as const,commandId:item.entry.commandId,intent:item.intent,
      executionId:item.entry.executionId,nativeResultSha256:item.entry.result?hash(canonical(item.entry.result)):null},deleted:false,history:item.history}}]:[])];
  for(const item of heads) {
    check();
    const head=item.head,origin=origins.get(head.originWriterEpoch);
    if(!origin || head.history.recordSequence!==null && head.history.recordSequence>origin.recordSequence ||
      head.history.eventSequence!==null && head.history.eventSequence>origin.eventSequence) refuse();
    if(head.source.kind==="command") {
      const command=commands.get(head.source.commandId);
      if(!command || command.conversationId!==item.conversationId || command.originWriterEpoch!==head.originWriterEpoch ||
        command.entry.executionId!==head.source.executionId || canonical(command.intent)!==canonical(head.source.intent) ||
        (command.entry.result?hash(canonical(command.entry.result)):null)!==head.source.nativeResultSha256 ||
        ["queued","dispatching"].includes(command.entry.state)) refuse();
    }
    if(!("manifestSha256" in head.history))continue;
    const saved=documents.get(head.history.manifestSha256); if(!saved || saved.kind!=="manifest")refuse();
    const manifest=CloudLocalCommandHistoryManifestSchema.parse(JSON.parse(saved.document));
    if(manifest.conversationId!==item.conversationId || canonical(manifest.scope)!==canonical(origin.scope) ||
      !cloudLocalCommandHistoryHeadMatchesManifest(head,manifest,saved.sha256))refuse();
    let bytes=Buffer.byteLength(saved.document);
    for(const ref of manifest.records) {
      check();
      const stored=documents.get(ref.sha256);if(!stored || stored.kind!=="record")refuse();
      const record=CloudLocalCommandHistoryRecordSchema.parse(JSON.parse(stored.document));
      bytes+=Buffer.byteLength(stored.document);
      if(bytes>CLOUD_LOCAL_COMMAND_HISTORY_BUNDLE_MAX_BYTES || record.conversationId!==item.conversationId ||
        record.entityId!==ref.entityId || record.entityKind!==ref.entityKind || record.sourceRevision!==ref.sourceRevision ||
        record.schemaVersion!==ref.schemaVersion || record.sourceRevision>manifest.recordSequence)refuse();
    }
    if(manifest.tombstones.some(row=>row.sourceRevision>manifest.recordSequence))refuse();
  }
  check();
  return snapshot;
}

/** A retained local marker may request fresh CP authorization after a crash.
 * It never authorizes recovery by itself, even if its hash is well formed. */
export function checkpointHistoryMarker(db:Sqlite.Database, predecessorWriter:string, check: Check):CloudAgentHistoryRecoveryResponse|null {
  check();
  const present=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_command_checkpoint_history'").get();
  check(); if(!present)return null;
  const rows=db.prepare("SELECT recovery_id,length(CAST(document AS BLOB)) AS bytes FROM local_command_checkpoint_history ORDER BY recovery_id LIMIT 4097")
    .all() as {recovery_id:string;bytes:number}[];
  check();
  if(rows.length>4096) refuse();
  let selected:CloudAgentHistoryRecoveryResponse|null=null;
  for(const metadata of rows) {
    check();
    if(metadata.bytes<1 || metadata.bytes>CLOUD_CHECKPOINT_HISTORY_ENVELOPE_MAX_BYTES)refuse();
    const row=db.prepare("SELECT document FROM local_command_checkpoint_history WHERE recovery_id=?").get(metadata.recovery_id) as {document:string};
    check();
    if(Buffer.byteLength(row.document)>CLOUD_CHECKPOINT_HISTORY_ENVELOPE_MAX_BYTES) refuse();
    const proof=CloudAgentHistoryRecoveryResponseSchema.parse(JSON.parse(row.document));
    if(canonical(proof)!==row.document) refuse();
    parseCheckpointHistory(proof,check);
    if(proof.predecessor.writerEpoch===predecessorWriter) {
      if(selected) refuse(); selected=proof;
    }
  }
  check();
  return selected;
}

/** Copy only CP-committed identities and current history. The caller owns a
 * private staged copy of a verified acknowledged ancestor; NORMAL is never
 * imported from that ancestor for this gap. No claim or credential is created. */
export function importCheckpointHistory(db:Sqlite.Database, authorization:CloudAgentHistoryRecoveryResponse, check: Check):void {
  const snapshot=parseCheckpointHistory(authorization,check);
  const controls=new Map(snapshot.controls.map(item=>[item.conversationId,item]));
  for(const item of [...snapshot.commands,...snapshot.heads]) if(!controls.has(item.conversationId)) refuse();
  const commands=new Map(snapshot.commands.map(item=>[item.entry.commandId,item]));
  const existing=db.prepare("SELECT id,conversation_id,position,writer_epoch,generation,user_message_id,agent_id,created_at FROM local_commands").iterate() as
    Iterable<{id:string;conversation_id:string;position:number;writer_epoch:string;generation:number;user_message_id:string;agent_id:string;created_at:string}>;
  for(const row of existing) {
    check();
    const item=commands.get(row.id);
    if(!item || item.conversationId!==row.conversation_id || item.entry.position!==row.position || item.originWriterEpoch!==row.writer_epoch ||
      item.entry.generation!==row.generation || item.intent.userMessageId!==row.user_message_id || item.intent.agentId!==row.agent_id ||
      item.entry.createdAt!==row.created_at) refuse();
  }
  const heads=new Map(snapshot.heads.map(item=>[item.conversationId,item.head]));
  for(const row of db.prepare("SELECT conversation_id,document FROM local_command_history_heads").iterate() as Iterable<{conversation_id:string;document:string}>) {
    check();
    const previous=CloudLocalCommandHistoryHeadSchema.parse(JSON.parse(row.document)), current=heads.get(row.conversation_id);
    if(!current || current.history.restoreRevision<previous.history.restoreRevision ||
      current.history.restoreRevision===previous.history.restoreRevision && canonical(current)!==canonical(previous) &&
      // CP may have retained the exact current fence as incomplete after its
      // own canonical-storage limit. That cannot promote the old full bytes.
      !("incompleteReason" in current.history && current.history.incompleteReason==="history_limit" &&
        current.originWriterEpoch===previous.originWriterEpoch && current.deleted===previous.deleted &&
        canonical(current.source)===canonical(previous.source) && current.history.recordSequence===previous.history.recordSequence &&
        current.history.eventSequence===previous.history.eventSequence)) refuse();
  }
  db.transaction(()=>{
    check();
    const positions=new Map<string,number>();
    for(const item of snapshot.commands) positions.set(item.conversationId,Math.max(positions.get(item.conversationId)??0,item.entry.position));
    for(const control of snapshot.controls) {
      check();
      const next=(positions.get(control.conversationId)??0)+1;
      if(!Number.isSafeInteger(next)) refuse();
      db.prepare(`INSERT INTO local_command_controls(conversation_id,revision,paused,next_position,mirror_dirty) VALUES(?,?,?,?,0)
        ON CONFLICT(conversation_id) DO UPDATE SET revision=excluded.revision,paused=excluded.paused,next_position=excluded.next_position,mirror_dirty=0`)
        .run(control.conversationId,control.revision,Number(control.paused),next);
    }
    for(const item of snapshot.commands) {
      check();
      const entry=item.entry, head=item.history ? {originWriterEpoch:item.originWriterEpoch,source:{kind:"command",commandId:entry.commandId,
        intent:item.intent,executionId:entry.executionId,nativeResultSha256:entry.result?hash(canonical(entry.result)):null},deleted:false,history:item.history}:null;
      db.prepare(`INSERT INTO local_commands(id,conversation_id,position,state,payload,actor,user_message_id,agent_id,writer_epoch,generation,
        execution_id,claim_id,result,result_code,goal_revision,goal_sequence,created_at,updated_at,history,mirror_history_head,credential_run_info,mirror_dirty)
        VALUES(?,?,?,?,NULL,?,?,?,?,?,?,NULL,?,?,NULL,0,?,?,?,?,?,0)
        ON CONFLICT(id) DO UPDATE SET state=excluded.state,payload=NULL,actor=excluded.actor,execution_id=excluded.execution_id,claim_id=NULL,
          result=excluded.result,result_code=excluded.result_code,goal_revision=NULL,goal_sequence=0,updated_at=excluded.updated_at,
          history=excluded.history,mirror_history_head=excluded.mirror_history_head,credential_run_info=excluded.credential_run_info,mirror_dirty=0`)
        .run(entry.commandId,item.conversationId,entry.position,entry.state,canonical(item.actor),item.intent.userMessageId,item.intent.agentId,
          item.originWriterEpoch,entry.generation,entry.executionId,entry.result?canonical(entry.result):null,entry.resultCode,entry.createdAt,entry.updatedAt,
          item.history?canonical(item.history):null,head?canonical(head):null,item.credentialRun?canonical(item.credentialRun):null);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS local_command_recovered_history_mutations(
      mutation_id TEXT PRIMARY KEY,writer_epoch TEXT NOT NULL,conversation_id TEXT NOT NULL)`);
    for(const item of snapshot.heads) {
      check();
      db.prepare(`INSERT INTO local_command_history_heads(conversation_id,restore_revision,document) VALUES(?,?,?)
        ON CONFLICT(conversation_id) DO UPDATE SET restore_revision=excluded.restore_revision,document=excluded.document`)
        .run(item.conversationId,item.head.history.restoreRevision,canonical(item.head));
      if(item.head.source.kind==="mutation") {
        // CP retained the operation identity, not the original native request
        // hash. Fence reuse without inventing a replayable request body.
        db.prepare("INSERT OR IGNORE INTO local_command_recovered_history_mutations VALUES(?,?,?)")
          .run(item.head.source.mutationId,item.head.originWriterEpoch,item.conversationId);
        const saved=db.prepare("SELECT writer_epoch,conversation_id FROM local_command_recovered_history_mutations WHERE mutation_id=?")
          .get(item.head.source.mutationId) as {writer_epoch:string;conversation_id:string};
        if(saved.writer_epoch!==item.head.originWriterEpoch || saved.conversation_id!==item.conversationId) refuse();
      }
    }
    for(const item of snapshot.documents) {
      check();
      db.prepare("INSERT OR IGNORE INTO local_command_history_documents(sha256,kind,document,bytes) VALUES(?,?,?,?)")
        .run(item.sha256,item.kind,item.document,Buffer.byteLength(item.document));
      const row=db.prepare("SELECT kind,document,bytes FROM local_command_history_documents WHERE sha256=?").get(item.sha256) as
        {kind:string;document:string;bytes:number};
      if(row.kind!==item.kind || row.document!==item.document || row.bytes!==Buffer.byteLength(item.document)) refuse();
    }
    db.exec("CREATE TABLE IF NOT EXISTS local_command_checkpoint_history(recovery_id TEXT PRIMARY KEY,document TEXT NOT NULL)");
    db.prepare("INSERT INTO local_command_checkpoint_history(recovery_id,document) VALUES(?,?)")
      .run(authorization.recoveryId,canonical(authorization));
    check();
  })();
  check();
}

/** Restaging may not overwrite an existing native store. Verify the retained
 * exact CP cut and permit only constructor quarantine of its pending IDs. */
export function verifyCheckpointHistoryImport(db:Sqlite.Database, authorization:CloudAgentHistoryRecoveryResponse, check: Check):CloudCheckpointHistorySnapshot {
  const marker=checkpointHistoryMarker(db,authorization.predecessor.writerEpoch,check);
  if(!marker || canonical(marker)!==canonical(authorization)) refuse();
  const snapshot=parseCheckpointHistory(authorization,check);
  const commands=new Map(snapshot.commands.map(item=>[item.entry.commandId,item]));
  const rows=db.prepare("SELECT * FROM local_commands").iterate() as Iterable<Record<string,unknown>>;
  let count=0;
  for(const row of rows) {
    check(); if(++count>commands.size)refuse();
    const item=commands.get(String(row.id));
    if(!item || row.conversation_id!==item.conversationId || row.writer_epoch!==item.originWriterEpoch || row.generation!==item.entry.generation ||
      row.position!==item.entry.position || row.user_message_id!==item.intent.userMessageId || row.agent_id!==item.intent.agentId ||
      row.created_at!==item.entry.createdAt || row.execution_id!==item.entry.executionId || row.actor!==canonical(item.actor) || row.payload!==null ||
      row.result!==(item.entry.result==null?null:canonical(item.entry.result))) refuse();
    const pending=["queued","dispatching"].includes(item.entry.state);
    if(!pending && (row.state!==item.entry.state || row.history!==(item.history?canonical(item.history):null) || row.result_code!==item.entry.resultCode) ||
      pending && row.state!==item.entry.state && !(row.state==="uncertain" &&
        row.result_code===(item.entry.state==="queued"?"queue_recovery_required":"engine_interrupted"))) refuse();
  }
  check(); if(count!==commands.size)refuse();
  for(const item of snapshot.documents) {
    check();
    const row=db.prepare("SELECT kind,document,bytes FROM local_command_history_documents WHERE sha256=?").get(item.sha256) as
      {kind:string;document:string;bytes:number}|undefined;
    if(!row || row.kind!==item.kind || row.document!==item.document || row.bytes!==Buffer.byteLength(item.document)) refuse();
  }
  for(const item of snapshot.heads) {
    check();
    if(item.head.source.kind==="mutation") {
      const fence=db.prepare("SELECT writer_epoch,conversation_id FROM local_command_recovered_history_mutations WHERE mutation_id=?")
        .get(item.head.source.mutationId) as {writer_epoch:string;conversation_id:string}|undefined;
      if(!fence || fence.writer_epoch!==item.head.originWriterEpoch || fence.conversation_id!==item.conversationId) refuse();
    }
    const row=db.prepare("SELECT document FROM local_command_history_heads WHERE conversation_id=?").get(item.conversationId) as {document:string}|undefined;
    if(!row) refuse();
    const head=CloudLocalCommandHistoryHeadSchema.parse(JSON.parse(row.document));
    if(canonical(head)===canonical(item.head))continue;
    const command=head.source.kind==="command"?commands.get(head.source.commandId):undefined;
    if(!command || command.conversationId!==item.conversationId || !["queued","dispatching"].includes(command.entry.state) ||
      head.history.restoreRevision<=item.head.history.restoreRevision || !("incompleteReason" in head.history) ||
      head.history.incompleteReason!=="recovery_uncertain") refuse();
  }
  check();
  return snapshot;
}
