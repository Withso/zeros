import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudAgentBootScope, CloudAgentCredentialRunInfo, CloudAgentHistoryRecoveryResponse } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudActorAuthorityRegistry } from "../agents/cloud-actor-authority";
import { CloudLocalCommandQueue } from "../cloud-local-command-queue";
import { CloudLocalCommandEventStore } from "../cloud-local-command-queue-events";
import { CloudLocalCommandWriterLifecycle } from "../cloud-local-command-queue-lifecycle";
import { restoreCloudLocalCommandCheckpointLedger, verifiedCloudLocalCommandPredecessor, verifyAndPrepareCloudLocalCommandPredecessor,
  cloudLocalCommandHistoryRecoveryCustody, type CloudLocalCommandPredecessor } from "../cloud-local-command-queue-checkpoint";
import { CloudCredentialStartFences, type CloudAgentCredentialControlRequest } from "../cloud-local-command-queue-start-fences";
import { openSqlite } from "../db/sqlite";
import { checkpointReadClock } from "./cloud-checkpoint-inventory-clock";
import { canonicalCloudLocalCommandHistoryJson as canonical } from "@zeros/protocol/cloud-local-mirror";
import type { CloudCheckpointHistorySnapshot } from "@zeros/protocol/cloud-checkpoint-history";
import { captureCloudLocalCommandHistory } from "../cloud-local-command-queue-history";
import { rebuildCloudLocalCommandHistory } from "../cloud-local-command-queue-history-rebuild";
import { runMigrations } from "../db/migrations";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const successor = (scope: CloudAgentBootScope): CloudAgentBootScope => ({ ...scope,
  engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID() });
function controls(file: string, scope: CloudAgentBootScope, predecessor?: CloudLocalCommandPredecessor | null,
  synchronize = async () => {}, limits: { maxOperations?: number; maxMutations?: number } = {},
  verifyPredecessor: typeof verifiedCloudLocalCommandPredecessor | null = verifiedCloudLocalCommandPredecessor) {
  const value = new CloudCredentialStartFences({ file, scope, predecessor, ...limits, engineLive: () => true,
    ...(verifyPredecessor ? { verifyPredecessor } : {}),
    activity: () => ({ complete: true, foreground: 0, reservedLaunches: 0, background: 0, idleHosts: 0, scopes: [] }),
    retire: async () => {}, markDesired: () => {}, readyRevision: () => 2, synchronize,
    associationFloor: () => ({ cacheRevision: 2, connectionRevision: 1 }) });
  cleanup.push(() => value.close()); return value;
}
function inventory(file: string) {
  const db = openSqlite(file, { readonly: true });
  try { return {
    fences: db.prepare("SELECT mutation_id,identity_sha256,selectors,fence_epoch,phase,desired_revision,proof_id FROM local_credential_start_fences ORDER BY mutation_id").all(),
    operations: db.prepare("SELECT request_id,request_sha256,acknowledgement,ack_bytes,ack_delivered FROM local_credential_control_operations ORDER BY request_id").all(),
    floors: db.prepare("SELECT mutation_id,provider,credential_id,cache_revision,connection_revision FROM local_credential_retirement_floors ORDER BY mutation_id,provider,credential_id").all(),
  }; } finally { db.close(); }
}
async function seal(file: string, scope: CloudAgentBootScope, root: string) {
  const registry = new CloudActorAuthorityRegistry({ scope, engineLive: () => true }); cleanup.push(() => registry.dispose());
  const normal = openSqlite(path.join(path.dirname(file), "normal.sqlite"));
  cleanup.push(() => { if (normal.open) normal.close(); });
  normal.pragma("journal_mode = WAL"); normal.pragma("synchronous = NORMAL");
  normal.exec("CREATE TABLE IF NOT EXISTS sync_meta(id INTEGER PRIMARY KEY,next_rev INTEGER NOT NULL); INSERT OR IGNORE INTO sync_meta VALUES(0,8)");
  const queue = new CloudLocalCommandQueue({ file, scope, actors: registry, engineLive: () => true,
    ready: () => true, history: () => ({ recordSequence: 7, eventSequence: 0 }) });
  cleanup.push(() => queue.close());
  const events = new CloudLocalCommandEventStore({ file, queue, engineLive: () => true }); cleanup.push(() => events.close());
  const lifecycle = new CloudLocalCommandWriterLifecycle({ file, queue, normalDb: () => normal, assertQuiescent: () => {},
    heads: (source = normal) => ({ recordSequence: (source.prepare("SELECT next_rev-1 AS rev FROM sync_meta WHERE id=0").get() as { rev: number }).rev,
      eventSequence: events.head }) });
  cleanup.push(() => lifecycle.close());
  await lifecycle.drainAndSeal({ mirror: { flush: async () => {} }, retireNative: async () => {}, waitForWork: async () => {},
    freezeNormal: () => normal.close(), request: async value => { const { scope: _scope, ...body } = value; return { ...body, writerEpoch: scope.writerEpoch }; } });
  await lifecycle.captureCheckpoint(root);
  lifecycle.close(); events.close(); queue.close();
}
async function fixture(legacy = false) {
  const directory = mkdtempSync(path.join(tmpdir(), "zeros-resume-fences-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 2,
    engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  const file = path.join(directory, "queue.sqlite"), root = path.join(directory, "checkpoint");
  const run: CloudAgentCredentialRunInfo = { version: 1, bootId: scope.bootId, writerEpoch: scope.writerEpoch, cacheRevision: 2,
    provider: "claude", fundingOwnerUserId: scope.fundingOwnerUserId, fundingOwnerEpoch: 1, credentialId: randomUUID(),
    credentialRevision: 1, connectionRevision: 1, adoptionId: randomUUID(), materialVersion: 1, displayName: "Synthetic account" };
  const request: CloudAgentCredentialControlRequest = { ...scope, version: 1, mutationId: randomUUID(), controlRequestId: randomUUID(),
    fenceEpoch: 1, selectors: [{ provider: run.provider, credentialId: run.credentialId }], operation: "pause-starts", desiredCacheRevision: null };
  const old = controls(file, scope);
  await old.handle(request);
  const retired = await old.handle({ ...request, controlRequestId: randomUUID(), operation: "retire" });
  const pending = await old.handle({ ...request, controlRequestId: randomUUID(), mutationId: randomUUID() });
  old.close();
  if (legacy) {
    const db = openSqlite(file);
    try {
      for (const table of ["local_credential_start_fences", "local_credential_control_operations", "local_credential_retirement_floors"]) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (columns.some(column => column.name === "writer_epoch")) {
          db.exec(`DROP INDEX IF EXISTS ${table}_writer; ALTER TABLE ${table} DROP COLUMN writer_epoch`);
        }
      }
      db.exec("DROP TABLE IF EXISTS local_credential_control_scopes");
    } finally { db.close(); }
  }
  await seal(file, scope, root);
  const before = inventory(file);
  const restored = await restoreCloudLocalCommandCheckpointLedger({ root, file, scope, expectedWriterEpoch: scope.writerEpoch });
  cleanup.push(restored.cleanup);
  return { directory, file, root, scope, run, request, retired, pending, before, predecessor: restored.predecessor };
}

describe("credential-control custody across verified writer replacement", () => {
  async function lostWriter() {
    const f=await fixture(), unsealed={...successor(f.scope),generation:f.scope.generation+1},
      target={...successor(f.scope),generation:f.scope.generation+2};
    const normal=openSqlite(":memory:"); runMigrations(normal); cleanup.push(()=>{normal.close();});
    normal.prepare("INSERT INTO chats(id,folder,agent_id,title,created_at,updated_at,rev) VALUES('mirror',?,'claude','Mirrored history',1,2,8)")
      .run(f.directory);
    normal.prepare("INSERT INTO chat_messages(chat_id,msg_id,ord,kind,payload,created_at,rev) VALUES('mirror','known',0,'text','{\"role\":\"user\",\"text\":\"CP copy\"}',1,8)").run();
    normal.prepare("UPDATE sync_meta SET next_rev=9 WHERE id=0").run();
    const captured=captureCloudLocalCommandHistory({db:normal,repositoryRoot:f.directory,scope:unsealed,conversationId:"mirror",
      source:{kind:"mutation",mutationId:randomUUID(),operation:"repair"},nativeResult:null,restoreRevision:1,eventSequence:5,
      controls:[],redactDocument:value=>value});
    expect(captured.manifest).toBeDefined();
    const pendingId=randomUUID(), cancelledId=randomUUID();
    const actor={scope:unsealed,actorSessionId:randomUUID(),authorityEpoch:1,confirmedUntilMs:Date.now()+9_000,
      actor:{userId:unsealed.fundingOwnerUserId,deviceId:randomUUID(),deviceKeyVersion:1,role:"owner" as const,fingerprint:"a".repeat(64)},
      fundingConsentVersion:1 as const,fundingGrant:{kind:"owner" as const}};
    const incomplete={restoreRevision:1,recordSequence:8,eventSequence:5,incompleteReason:"capture_unavailable" as const};
    const commands:CloudCheckpointHistorySnapshot["commands"]=[{conversationId:"pending",originWriterEpoch:unsealed.writerEpoch,
      entry:{commandId:pendingId,position:1,state:"queued",generation:unsealed.generation,executionId:null,resultCode:null,
        result:null,createdAt:new Date(1).toISOString(),updatedAt:new Date(2).toISOString()},
      intent:{userMessageId:"pending-message",agentId:"claude"},actor,credentialRun:null,history:null},
      {conversationId:"cancelled",originWriterEpoch:unsealed.writerEpoch,
        entry:{commandId:cancelledId,position:1,state:"cancelled",generation:unsealed.generation,executionId:null,resultCode:null,
          result:null,createdAt:new Date(1).toISOString(),updatedAt:new Date(2).toISOString()},
        intent:{userMessageId:"cancelled-message",agentId:"claude"},actor:null,credentialRun:null,history:incomplete}];
    const snapshot:CloudCheckpointHistorySnapshot={version:1,scope:unsealed,
      origins:[{scope:f.scope,recordSequence:7,eventSequence:0},{scope:unsealed,recordSequence:8,eventSequence:5}],
      controls:["mirror","deleted","edited","pending","cancelled"].map(conversationId=>({conversationId,revision:1,paused:false})),commands,
      heads:[{conversationId:"mirror",head:captured.historyHead},
        ...["deleted","edited"].map(conversationId=>({conversationId,head:{originWriterEpoch:unsealed.writerEpoch,
          source:{kind:"mutation" as const,mutationId:randomUUID(),operation:conversationId==="deleted"?"delete" as const:"edit" as const},
          deleted:conversationId==="deleted",history:incomplete}})),
        {conversationId:"cancelled",head:{originWriterEpoch:unsealed.writerEpoch,source:{kind:"command",commandId:cancelledId,
          intent:commands[1]!.intent,executionId:null,nativeResultSha256:null},deleted:false,history:incomplete}}],
      documents:captured.documents.map(item=>({sha256:item.sha256,kind:item.kind,document:item.canonicalDocument}))};
    const {writerEpoch:_writer,...scope}=target, document=canonical(snapshot);
    const manifest=JSON.parse(readFileSync(path.join(f.root,"manifest.json"),"utf8"));
    const authorization:CloudAgentHistoryRecoveryResponse={...scope,version:1,mode:"boot-owner-v1",recoveryId:randomUUID(),
      code:"history_recovered_with_gap",coverage:"unknown",predecessor:unsealed,predecessorRetiredAt:new Date().toISOString(),
      checkpoint:{writerEpoch:f.scope.writerEpoch,sha256:manifest.seal.sha256},mirroredSequence:9,preparedCustody:[],
      checkpointOnly:{ownerDiscardReceiptId:randomUUID(),checkpointId:randomUUID(),document,sha256:createHash("sha256").update(document).digest("hex")}};
    const file=path.join(f.directory,"fresh.sqlite"), targetNormal=openSqlite(":memory:"); runMigrations(targetNormal); cleanup.push(()=>{targetNormal.close();});
    for(const id of ["deleted","edited","local"]) {
      targetNormal.prepare("INSERT INTO chats(id,folder,title,created_at,updated_at,rev) VALUES(?,?,?,1,1,1)")
        .run(id,id==="local"?"/unrelated-local":f.directory,id);
      targetNormal.prepare("INSERT INTO chat_messages(chat_id,msg_id,ord,kind,payload,created_at,rev) VALUES(?,'stale',0,'text','{\"text\":\"stale\"}',1,1)").run(id);
    }
    const recover=async(assertCurrent=()=>{})=>{
      const {recoverCloudLocalCommandCheckpointLedger}=await import("../cloud-local-command-queue-checkpoint");
      const recovered=await recoverCloudLocalCommandCheckpointLedger({root:f.root,file,scope:target,
        expectedWriterEpoch:unsealed.writerEpoch,authorization,assertCurrent}); cleanup.push(recovered.cleanup); return recovered;
    };
    return {...f,file,target,unsealed,authorization,snapshot,pendingId,cancelledId,targetNormal,recover};
  }

  it("restores only CP history after owner discard, retaining deletes, gaps, null-actor receipts and accepted IDs",async()=>{
    const f=await lostWriter(), recovered=await f.recover(), db=openSqlite(f.file,{readonly:true});
    try {
      expect(inventory(f.file)).toEqual(f.before);
      expect(db.prepare("SELECT writer_epoch FROM local_command_writer_seals").all()).toEqual([{writer_epoch:f.scope.writerEpoch}]);
      for(const item of f.snapshot.heads) rebuildCloudLocalCommandHistory({db:f.targetNormal,ledger:db,repositoryRoot:f.directory,
        scope:f.unsealed,sourceRecovery:recovered.predecessor,conversationId:item.conversationId});
      expect(f.targetNormal.prepare("SELECT id FROM chats WHERE id='deleted'").get()).toBeUndefined();
      expect(f.targetNormal.prepare("SELECT msg_id FROM chat_messages WHERE chat_id='edited'").all()).toEqual([]);
      expect(f.targetNormal.prepare("SELECT payload FROM chat_messages WHERE chat_id='mirror'").all()).toEqual([{payload:'{"role":"user","text":"CP copy"}'}]);
      expect(f.targetNormal.prepare("SELECT msg_id FROM chat_messages WHERE chat_id='local'").all()).toEqual([{msg_id:"stale"}]);
    } finally {db.close();}
    controls(f.file,f.target,recovered.predecessor,undefined,{},(receipt,file,db)=>verifyAndPrepareCloudLocalCommandPredecessor(receipt,file,db,f.target)).close();
    const actors=new CloudActorAuthorityRegistry({scope:f.target,engineLive:()=>true}); cleanup.push(()=>actors.dispose());
    const queue=new CloudLocalCommandQueue({file:f.file,scope:f.target,actors,engineLive:()=>true,ready:()=>true,history:()=>({recordSequence:8,eventSequence:0})});
    cleanup.push(()=>queue.close());
    const deleted=f.snapshot.heads.find(item=>item.conversationId==="deleted")!.head;
    expect(deleted.source.kind).toBe("mutation");
    expect(()=>queue.publishHistoryMutation({conversationId:"deleted",mutationId:deleted.source.kind==="mutation"?deleted.source.mutationId:"",
      operation:"delete",deleted:true,recordSequence:8,eventSequence:0})).toThrowError(expect.objectContaining({code:"command_conflict"}));
    expect(queue.handle({kind:"claim",conversationId:"pending",executionId:"new-execution"},{writerEpoch:f.target.writerEpoch})).toBeNull();
    const stored=openSqlite(f.file,{readonly:true});
    try {
      expect(stored.prepare("SELECT state,payload,result_code FROM local_commands WHERE id=?").get(f.pendingId))
        .toEqual({state:"uncertain",payload:null,result_code:"queue_recovery_required"});
      expect(stored.prepare("SELECT state FROM local_commands WHERE id=?").get(f.cancelledId)).toEqual({state:"cancelled"});
    } finally {stored.close();}
    expect(queue.peekMirrorBatch()!.changes.some(item=>item.entry?.commandId===f.cancelledId && item.actor===undefined)).toBe(true);
    const actorSessionId=randomUUID();
    actors.confirm({...f.snapshot.commands[0]!.actor!,scope:f.target,actorSessionId});
    const observed=queue.handle({kind:"snapshot",conversationId:"pending"},{writerEpoch:f.target.writerEpoch,actorSessionId}) as {revision:number};
    expect(()=>queue.handle({kind:"mutate",mutation:{conversationId:"pending",operationId:randomUUID(),expectedRevision:observed.revision,
      action:{kind:"enqueue",commandId:f.pendingId,payload:{agentId:"claude",userMessageId:"pending-message",modeRevision:0,
        model:"claude-sonnet-4-6",prompt:[{type:"text",text:"Do not replay"}]}}},admissionError:null},
      {writerEpoch:f.target.writerEpoch,actorSessionId})).toThrow();
  });

  it("reauthorizes an exact installed snapshot across a pre-activation crash without recopying FULL",async()=>{
    const f=await lostWriter(), first=await f.recover(), before=readFileSync(f.file);
    const again=await f.recover(); expect(readFileSync(f.file)).toEqual(before);
    const {cloudLocalCommandHistoryRecoveryCustodySha256,cloudLocalCommandHistoryRecoveryCustody}=await import("../cloud-local-command-queue-checkpoint");
    const originalHash=cloudLocalCommandHistoryRecoveryCustodySha256(first.predecessor,f.target);
    expect(cloudLocalCommandHistoryRecoveryCustodySha256(again.predecessor,f.target)).toBe(originalHash);
    controls(f.file,f.target,again.predecessor,undefined,{},(receipt,file,db)=>verifyAndPrepareCloudLocalCommandPredecessor(receipt,file,db,f.target)).close();
    expect(await cloudLocalCommandHistoryRecoveryCustody(f.file,f.unsealed.writerEpoch)).toBeNull();
    const afterPrepare=await f.recover();
    expect(cloudLocalCommandHistoryRecoveryCustodySha256(afterPrepare.predecessor,f.target)).toBe(originalHash);
  });

  it("refuses a missing terminal result on exact installed-snapshot replay",async()=>{
    const f=await lostWriter(), cancelled=f.snapshot.commands.find(item=>item.entry.commandId===f.cancelledId)!;
    cancelled.entry.result={version:1,model:"fixture"};
    const head=f.snapshot.heads.find(item=>item.conversationId==="cancelled")!.head;
    if(head.source.kind!=="command")throw new Error("fixture command head");
    head.source.nativeResultSha256=createHash("sha256").update(canonical(cancelled.entry.result)).digest("hex");
    f.authorization.checkpointOnly!.document=canonical(f.snapshot);
    f.authorization.checkpointOnly!.sha256=createHash("sha256").update(f.authorization.checkpointOnly!.document).digest("hex");
    await f.recover();
    const db=openSqlite(f.file);try{db.prepare("UPDATE local_commands SET result=NULL WHERE id=?").run(f.cancelledId);}finally{db.close();}
    await expect(f.recover()).rejects.toMatchObject({name:"CloudCommandRuntimeError"});
  });

  it.each(["hash","scope","checkpoint","sidecar","existing"])("refuses %s drift without publishing a checkpoint-only ledger",async kind=>{
    const f=await lostWriter();
    if(kind==="hash")f.authorization.checkpointOnly!.sha256="f".repeat(64);
    if(kind==="scope")f.authorization.predecessor.workspaceId=randomUUID();
    if(kind==="checkpoint")f.authorization.checkpoint.sha256="f".repeat(64);
    if(kind==="sidecar")writeFileSync(f.file+"-wal","unrelated WAL");
    if(kind==="existing")writeFileSync(f.file,"corrupt existing FULL");
    const before=existsSync(f.file)?readFileSync(f.file):null;
    await expect(f.recover()).rejects.toMatchObject({name:"CloudCommandRuntimeError"});
    expect(existsSync(f.file)?readFileSync(f.file):null).toEqual(before);
  });

  it("checks original authority after file I/O and leaves no publishable predecessor on revocation",async()=>{
    const f=await lostWriter(); let calls=0;
    await expect(f.recover(()=>{if(++calls===8)throw new Error("retired during copy");})).rejects.toMatchObject({name:"CloudCommandRuntimeError"});
    expect(calls).toBe(8); expect(existsSync(f.file)).toBe(false);
    await expect(f.recover()).resolves.toHaveProperty("predecessor");
  });

  it.each(["origin-bound","missing-document","foreign-actor"] as const)("refuses authenticated %s snapshot inconsistency before publication",async kind=>{
    const f=await lostWriter();
    if(kind==="origin-bound")f.snapshot.origins.find(item=>item.scope.writerEpoch===f.unsealed.writerEpoch)!.eventSequence=4;
    if(kind==="missing-document")f.snapshot.documents=f.snapshot.documents.filter(item=>item.kind!=="record");
    if(kind==="foreign-actor")f.snapshot.commands[0]!.actor!.scope.organizationId=randomUUID();
    const document=canonical(f.snapshot); f.authorization.checkpointOnly!.document=document;
    f.authorization.checkpointOnly!.sha256=createHash("sha256").update(document).digest("hex");
    await expect(f.recover()).rejects.toMatchObject({name:"CloudCommandRuntimeError"});
    expect(existsSync(f.file)).toBe(false);
  });

  it.each([false,true])("verifies the actual staged SQLite custody before CP import (changed credential rows=%s)",async changed=>{
    const f=await lostWriter(), sqlite=await import("../db/sqlite"), open=sqlite.openSqlite;
    let reached=0;
    const spy=vi.spyOn(sqlite,"openSqlite").mockImplementation((file,options)=>{
      const db=open(file,options);
      if(path.basename(file).startsWith(".checkpoint-history-") && !options?.readonly) {
        reached++;
        if(changed)expect(db.prepare("DELETE FROM local_credential_control_operations").run().changes).toBeGreaterThan(0);
      }
      return db;
    });
    try {
      if(changed)await expect(f.recover()).rejects.toMatchObject({code:"checkpoint_inventory_hash"});
      else await expect(f.recover()).resolves.toHaveProperty("predecessor");
      expect(reached).toBe(1); expect(existsSync(f.file)).toBe(!changed);
    } finally {spy.mockRestore();}
  });

  it.each(["single", "nested"] as const)("bounds %s retained checkpoint snapshot reads by one original inventory deadline",async kind=>{
    const f=await lostWriter(); await f.recover();
    const bytes=readFileSync(f.file), stages:string[]=[];
    const clock=checkpointReadClock(sql=>{
      const stage=sql.startsWith("SELECT recovery_id,length(CAST(document AS BLOB))")?"metadata":
        sql.startsWith("SELECT document FROM local_command_checkpoint_history WHERE")?"body":null;
      if(!stage || stages.includes(stage) || kind==="single" && stage==="metadata")return 0;
      stages.push(stage); return kind==="single"?5_001:3_000;
    });
    try {
      await expect(cloudLocalCommandHistoryRecoveryCustody(f.file,f.unsealed.writerEpoch))
        .rejects.toMatchObject({code:"checkpoint_inventory_timeout"});
      expect(stages).toEqual(kind==="single"?["body"]:["metadata","body"]);
      expect(clock.elapsed()).toBe(kind==="single"?5_001:6_000);
      expect(readFileSync(f.file)).toEqual(bytes);
    } finally {clock.restore();}
    expect(await cloudLocalCommandHistoryRecoveryCustody(f.file,f.unsealed.writerEpoch)).toBeNull();
  });

  it.each([false,true])("retains CP origin custody through the next acknowledged checkpoint with a smaller new event stream (lost mutation fence=%s)",async lostFence=>{
    const f=await lostWriter(), recovered=await f.recover();
    const db=openSqlite(f.file,{readonly:true});
    try {for(const item of f.snapshot.heads) rebuildCloudLocalCommandHistory({db:f.targetNormal,ledger:db,repositoryRoot:f.directory,
      scope:f.unsealed,sourceRecovery:recovered.predecessor,conversationId:item.conversationId});} finally {db.close();}
    controls(f.file,f.target,recovered.predecessor,undefined,{},(receipt,file,db)=>verifyAndPrepareCloudLocalCommandPredecessor(receipt,file,db,f.target)).close();
    const actors=new CloudActorAuthorityRegistry({scope:f.target,engineLive:()=>true}); cleanup.push(()=>actors.dispose());
    const queue=new CloudLocalCommandQueue({file:f.file,scope:f.target,actors,engineLive:()=>true,ready:()=>true,
      history:()=>({recordSequence:8,eventSequence:0})}); cleanup.push(()=>queue.close());
    const flush=async()=>{let batch;while((batch=queue.peekMirrorBatch()))queue.acknowledgeMirror({version:1,writerEpoch:f.target.writerEpoch,batchId:batch.batchId,through:batch.through});};
    await flush();
    const events=new CloudLocalCommandEventStore({file:f.file,queue,engineLive:()=>true}); cleanup.push(()=>events.close());
    const normalFile=path.join(f.directory,"after-normal.sqlite"); f.targetNormal.prepare("VACUUM INTO ?").run(normalFile);
    const normal=openSqlite(normalFile); normal.pragma("journal_mode=WAL"); normal.pragma("synchronous=NORMAL");
    const lifecycle=new CloudLocalCommandWriterLifecycle({file:f.file,queue,normalDb:()=>normal,assertQuiescent:()=>{},
      heads:()=>({recordSequence:8,eventSequence:events.head})}); cleanup.push(()=>lifecycle.close());
    await lifecycle.drainAndSeal({mirror:{flush},retireNative:async()=>{},waitForWork:async()=>{},freezeNormal:()=>normal.close(),
      request:async seal=>{expect(seal.eventSequence).toBe(0);const {scope:_scope,...body}=seal;return {...body,writerEpoch:seal.scope.writerEpoch};}});
    const checkpoint=path.join(f.directory,"next-checkpoint"); await lifecycle.captureCheckpoint(checkpoint);
    lifecycle.close(); events.close(); queue.close();
    const nextFile=path.join(f.directory,"next.sqlite");
    const restored=await restoreCloudLocalCommandCheckpointLedger({root:checkpoint,file:nextFile,scope:f.target,expectedWriterEpoch:f.target.writerEpoch});
    cleanup.push(restored.cleanup);
    const next=openSqlite(restored.ledgerFile,{readonly:true}), target=openSqlite(":memory:"); runMigrations(target);
    try {
      expect(rebuildCloudLocalCommandHistory({db:target,ledger:next,repositoryRoot:f.directory,scope:f.target,
        sourceSeal:restored.manifest.seal,sealedCheckpoint:restored,conversationId:"mirror"}).restored).toBe(true);
      expect(target.prepare("SELECT msg_id FROM chat_messages WHERE chat_id='mirror'").all()).toEqual([{msg_id:"known"}]);
    } finally {next.close();target.close();}
    const unsealed=successor(f.target), successorScope=successor(unsealed);
    controls(nextFile,unsealed,restored.predecessor).close();
    const nextActors=new CloudActorAuthorityRegistry({scope:unsealed,engineLive:()=>true});cleanup.push(()=>nextActors.dispose());
    const pending=new CloudLocalCommandQueue({file:nextFile,scope:unsealed,actors:nextActors,engineLive:()=>true,ready:()=>true,
      history:()=>({recordSequence:8,eventSequence:0})});
    let batch;while((batch=pending.peekMirrorBatch()))pending.acknowledgeMirror({version:1,writerEpoch:unsealed.writerEpoch,batchId:batch.batchId,through:batch.through});
    pending.close();
    const ledger=openSqlite(nextFile);let mirroredSequence:number;
    try {
      mirroredSequence=Number((ledger.prepare("SELECT value FROM local_command_metadata WHERE key='mirrorHead'").get() as {value:string}).value);
      if(lostFence)expect(ledger.prepare("DELETE FROM local_command_recovered_history_mutations WHERE conversation_id='deleted'").run().changes).toBe(1);
    } finally {ledger.close();}
    const {writerEpoch:_next,...scope}=successorScope;
    const authorization:CloudAgentHistoryRecoveryResponse={...scope,version:1,mode:"boot-owner-v1",recoveryId:randomUUID(),
      code:"history_recovered_with_gap",coverage:"unknown",predecessor:unsealed,predecessorRetiredAt:new Date().toISOString(),mirroredSequence,
      checkpoint:{writerEpoch:f.target.writerEpoch,sha256:restored.manifest.seal.sha256}};
    const {recoverCloudLocalCommandCheckpointLedger}=await import("../cloud-local-command-queue-checkpoint");
    const recovery=recoverCloudLocalCommandCheckpointLedger({root:checkpoint,file:nextFile,scope:successorScope,
      expectedWriterEpoch:unsealed.writerEpoch,authorization});
    if(lostFence)await expect(recovery).rejects.toMatchObject({code:"checkpoint_inventory_hash"});
    else cleanup.push((await recovery).cleanup);
  });

  async function interruptedWriter() {
    const f = await fixture();
    let prior: CloudAgentBootScope = f.scope;
    let predecessor = f.predecessor;
    for (let cycle = 0; cycle < 4; cycle++) {
      const next = successor(prior); controls(f.file, next, predecessor).close();
      await seal(f.file, next, f.root);
      const restored = await restoreCloudLocalCommandCheckpointLedger({ root: f.root, file: f.file, scope: next, expectedWriterEpoch: next.writerEpoch });
      cleanup.push(restored.cleanup); predecessor = restored.predecessor; prior = next;
    }
    const unsealed = successor(prior), target = successor(unsealed), current = controls(f.file, unsealed, predecessor);
    const ack = await current.handle({ ...f.request, ...unsealed, mutationId: randomUUID(), controlRequestId: randomUUID() });
    current.confirmAcknowledgement(ack); current.close();
    const actors = new CloudActorAuthorityRegistry({ scope: unsealed, engineLive: () => true });
    const actorSessionId = randomUUID();
    actors.confirm({ scope: unsealed, actorSessionId, authorityEpoch: 1, confirmedUntilMs: Date.now() + 9_000,
      actor: { userId: unsealed.fundingOwnerUserId, deviceId: randomUUID(), deviceKeyVersion: 1, role: "owner", fingerprint: "a".repeat(64) },
      fundingConsentVersion: 1, fundingGrant: { kind: "owner" } });
    const queue = new CloudLocalCommandQueue({ file: f.file, scope: unsealed, actors, engineLive: () => true,
      ready: () => true, history: () => ({ recordSequence: 7, eventSequence: 0 }) });
    const commandId = randomUUID(), userMessageId = randomUUID();
    queue.handle({ kind: "mutate", mutation: { conversationId: "pending", operationId: randomUUID(), expectedRevision: 0,
      action: { kind: "enqueue", commandId, payload: { agentId: "claude", userMessageId, modeRevision: 0,
        model: "claude-sonnet-4-6", prompt: [{ type: "text", text: "Synthetic uncertain request" }] } } }, admissionError: null },
    { writerEpoch: unsealed.writerEpoch, actorSessionId });
    const batch = queue.peekMirrorBatch()!;
    expect(batch.through).toBeGreaterThan(0);
    queue.acknowledgeMirror({ version: 1, writerEpoch: unsealed.writerEpoch, batchId: batch.batchId, through: batch.through });
    queue.close(); actors.dispose();
    const manifest = JSON.parse(readFileSync(path.join(f.root, "manifest.json"), "utf8")) as { seal: { sha256: string } };
    const { writerEpoch: _targetWriter, ...targetScope } = target;
    const authorization: CloudAgentHistoryRecoveryResponse = { ...targetScope, version: 1, mode: "boot-owner-v1",
      recoveryId: randomUUID(), code: "history_recovered_with_gap", coverage: "unknown", predecessor: unsealed,
      predecessorRetiredAt: new Date().toISOString(), checkpoint: { writerEpoch: prior.writerEpoch, sha256: manifest.seal.sha256 }, mirroredSequence: batch.through };
    return { ...f, unsealed, target, authorization, commandId, userMessageId, retained: inventory(f.file) };
  }

  it("recovers an authorized unsealed writer after a valid slow inventory read, retaining FULL bytes and ACKs", async () => {
    const f = await interruptedWriter(), bytes = readFileSync(f.file);
    const { recoverCloudLocalCommandCheckpointLedger } = await import("../cloud-local-command-queue-checkpoint");
    let delayed = false;
    const clock = checkpointReadClock(sql => {
      if (delayed || !/SELECT id,conversation_id,writer_epoch.*FROM local_commands/.test(sql)) return 0;
      delayed = true; return 250;
    });
    try {
      const recovered = await recoverCloudLocalCommandCheckpointLedger({ root: f.root, file: f.file,
        scope: f.target, expectedWriterEpoch: f.unsealed.writerEpoch, authorization: f.authorization });
      cleanup.push(recovered.cleanup);
      expect(delayed).toBe(true); expect(clock.elapsed()).toBe(250);
      expect(readFileSync(f.file)).toEqual(bytes); expect(inventory(f.file)).toEqual(f.retained);
      const db = openSqlite(f.file, { readonly: true });
      try { expect(verifiedCloudLocalCommandPredecessor(recovered.predecessor, f.file, db, f.target)).toEqual(f.unsealed); }
      finally { db.close(); }
    } finally { clock.restore(); }
  });

  it("shares the proof deadline across nested recovery inventories without changing the original ledger", async () => {
    const f = await interruptedWriter(), bytes = readFileSync(f.file);
    const { recoverCloudLocalCommandCheckpointLedger } = await import("../cloud-local-command-queue-checkpoint");
    const stages: string[] = [];
    const clock = checkpointReadClock((sql, _rows, read) => {
      if (read.method !== "all") return 0;
      const stage = read.file === f.file && sql.startsWith("SELECT id,conversation_id,writer_epoch,generation,user_message_id,agent_id,created_at,mirror_history_head FROM local_commands ORDER BY")
        ? "retained fingerprint"
        : read.file !== f.file && sql.startsWith("SELECT id,conversation_id,writer_epoch,generation,user_message_id,agent_id,created_at FROM local_commands ORDER BY")
          ? "sealed baseline" : null;
      if (!stage || stages.includes(stage)) return 0;
      stages.push(stage); return 3_000;
    });
    try {
      await expect(recoverCloudLocalCommandCheckpointLedger({ root: f.root, file: f.file,
        scope: f.target, expectedWriterEpoch: f.unsealed.writerEpoch, authorization: f.authorization }))
        .rejects.toMatchObject({ code: "checkpoint_inventory_timeout" });
      expect(stages).toEqual(["retained fingerprint", "sealed baseline"]);
      expect(clock.elapsed()).toBe(6_000);
      expect(readFileSync(f.file)).toEqual(bytes); expect(inventory(f.file)).toEqual(f.retained);
    } finally { clock.restore(); }
  });

  it("recovers an authorized unsealed fifth writer without replacing FULL bytes, ACKs, floors or accepted request IDs", async () => {
    const f = await interruptedWriter(), bytes = readFileSync(f.file);
    const { recoverCloudLocalCommandCheckpointLedger } = await import("../cloud-local-command-queue-checkpoint");
    const recovered = await recoverCloudLocalCommandCheckpointLedger({ root: f.root, file: f.file,
      scope: f.target, expectedWriterEpoch: f.unsealed.writerEpoch, authorization: f.authorization });
    cleanup.push(recovered.cleanup);
    expect(readFileSync(f.file)).toEqual(bytes);
    expect(inventory(f.file)).toEqual(f.retained);
    const verify = (receipt: CloudLocalCommandPredecessor | null | undefined, file: string, db: ReturnType<typeof openSqlite>) =>
      verifiedCloudLocalCommandPredecessor(receipt, file, db, f.target);
    controls(f.file, f.target, recovered.predecessor, undefined, {}, verify).close();
    const actors = new CloudActorAuthorityRegistry({ scope: f.target, engineLive: () => true });
    const queue = new CloudLocalCommandQueue({ file: f.file, scope: f.target, actors, engineLive: () => true,
      ready: () => true, history: () => ({ recordSequence: 7, eventSequence: 0 }) });
    queue.close(); actors.dispose();
    const db = openSqlite(f.file, { readonly: true });
    try {
      expect(db.prepare("SELECT id,user_message_id,state,payload FROM local_commands WHERE id=?").get(f.commandId))
        .toEqual({ id: f.commandId, user_message_id: f.userMessageId, state: "uncertain", payload: null });
    } finally { db.close(); }
    expect(inventory(f.file)).toEqual(f.retained);
  });

  it.each(["controls", "queue", "mixed"] as const)("recovers repeated crashes after the %s commit with the original nonzero mirror floor", async point => {
    const f = await interruptedWriter();
    const { recoverCloudLocalCommandCheckpointLedger, cloudLocalCommandHistoryRecoveryCustody } = await import("../cloud-local-command-queue-checkpoint");
    let target = f.target, authorization = f.authorization;
    const prepared: NonNullable<CloudAgentHistoryRecoveryResponse["preparedCustody"]> = [];
    for (let crash = 0; crash < 3; crash++) {
      const recovered = await recoverCloudLocalCommandCheckpointLedger({ root: f.root, file: f.file,
        scope: target, expectedWriterEpoch: f.unsealed.writerEpoch, authorization });
      cleanup.push(recovered.cleanup);
      controls(f.file, target, recovered.predecessor, undefined, {},
        (receipt, file, db) => verifyAndPrepareCloudLocalCommandPredecessor(receipt, file, db, target)).close();
      if (point === "queue" || point === "mixed" && crash !== 1) {
        const actors = new CloudActorAuthorityRegistry({ scope: target, engineLive: () => true });
        const queue = new CloudLocalCommandQueue({ file: f.file, scope: target, actors, engineLive: () => true,
          ready: () => true, history: () => ({ recordSequence: 7, eventSequence: 0 }) });
        expect(queue.handle({ kind: "claim", conversationId: "pending", executionId: randomUUID(), claimId: randomUUID() },
          { writerEpoch: target.writerEpoch })).toBeNull();
        queue.close(); actors.dispose();
        const db = openSqlite(f.file, { readonly: true });
        try {
          expect(db.prepare("SELECT value FROM local_command_metadata WHERE key='mirrorHead'").get()).toEqual({ value: "0" });
          expect(db.prepare("SELECT state,payload FROM local_commands WHERE id=?").get(f.commandId))
            .toEqual({ state: "uncertain", payload: null });
        } finally { db.close(); }
      }
      expect(inventory(f.file)).toEqual(f.retained);
      prepared.push({ scope: target, recoveryId: authorization.recoveryId, retiredAt: new Date().toISOString() });
      const hints = await cloudLocalCommandHistoryRecoveryCustody(f.file, f.unsealed.writerEpoch);
      expect(hints).toHaveLength(point === "mixed" && crash === 1 ? 2 : 1);
      expect(hints).toContainEqual({ writerEpoch: target.writerEpoch, recoveryId: authorization.recoveryId });
      target = successor(target);
      const { writerEpoch: _writer, ...identity } = target;
      authorization = { ...f.authorization, ...identity, recoveryId: randomUUID(),
        preparedCustody: hints!.map(hint => prepared.find(item => item.scope.writerEpoch === hint.writerEpoch)!) };
    }
  });

  it.each(["valid", "missing-anchor", "wrong-hash", "foreign-receipt", "changed-record", "missing-record"] as const)(
    "authenticates an activated unsealed recovery's %s lineage before preserving ACKs and floors", async kind => {
      const f = await interruptedWriter();
      const { recoverCloudLocalCommandCheckpointLedger, cloudLocalCommandHistoryRecoveryCustodySha256 } =
        await import("../cloud-local-command-queue-checkpoint");
      const recovered = await recoverCloudLocalCommandCheckpointLedger({ root: f.root, file: f.file,
        scope: f.target, expectedWriterEpoch: f.unsealed.writerEpoch, authorization: f.authorization });
      cleanup.push(recovered.cleanup);
      controls(f.file, f.target, recovered.predecessor, undefined, {},
        (receipt, file, db) => verifyAndPrepareCloudLocalCommandPredecessor(receipt, file, db, f.target)).close();
      const actors = new CloudActorAuthorityRegistry({ scope: f.target, engineLive: () => true });
      const queue = new CloudLocalCommandQueue({ file: f.file, scope: f.target, actors, engineLive: () => true,
        ready: () => true, history: () => ({ recordSequence: 7, eventSequence: 0 }) });
      expect(queue.handle({ kind: "claim", conversationId: "pending", executionId: randomUUID(), claimId: randomUUID() },
        { writerEpoch: f.target.writerEpoch })).toBeNull();
      queue.close(); actors.dispose();
      const custodySha256 = cloudLocalCommandHistoryRecoveryCustodySha256(recovered.predecessor, f.target)!;
      expect(custodySha256).toMatch(/^[a-f0-9]{64}$/);
      const db = openSqlite(f.file);
      try {
        if (kind === "changed-record") db.exec("UPDATE local_command_history_recovery_prepares SET document=replace(document,'retainedSha256','forgedSha256')");
        if (kind === "missing-record") db.exec("DELETE FROM local_command_history_recovery_prepares");
      } finally { db.close(); }
      const target = successor(f.target), { writerEpoch: _writer, ...identity } = target;
      const authorization: CloudAgentHistoryRecoveryResponse = { ...f.authorization, ...identity, recoveryId: randomUUID(),
        predecessor: f.target, mirroredSequence: 0,
        ...(kind === "missing-anchor" ? {} : { predecessorRecovery: {
          recoveryId: kind === "foreign-receipt" ? randomUUID() : f.authorization.recoveryId,
          custodySha256: kind === "wrong-hash" ? "f".repeat(64) : custodySha256 } }) };
      const bytes = readFileSync(f.file), before = inventory(f.file);
      const next = recoverCloudLocalCommandCheckpointLedger({ root: f.root, file: f.file,
        scope: target, expectedWriterEpoch: f.target.writerEpoch, authorization });
      if (kind === "valid") {
        const result = await next; cleanup.push(result.cleanup);
        expect(inventory(f.file)).toEqual(f.retained);
      } else await expect(next).rejects.toMatchObject({ name: "CloudCommandRuntimeError" });
      expect(inventory(f.file)).toEqual(before); expect(readFileSync(f.file)).toEqual(bytes);
    });

  it.each(["missing-prepare", "foreign-receipt", "floor", "accepted-id", "credential-ack"] as const)(
    "refuses %s in prepared custody without rewriting the surviving ledger", async kind => {
      const f = await interruptedWriter();
      const { recoverCloudLocalCommandCheckpointLedger } = await import("../cloud-local-command-queue-checkpoint");
      const first = await recoverCloudLocalCommandCheckpointLedger({ root: f.root, file: f.file,
        scope: f.target, expectedWriterEpoch: f.unsealed.writerEpoch, authorization: f.authorization });
      cleanup.push(first.cleanup);
      controls(f.file, f.target, first.predecessor, undefined, {},
        (receipt, file, db) => verifyAndPrepareCloudLocalCommandPredecessor(receipt, file, db, f.target)).close();
      const db = openSqlite(f.file);
      try {
        if (kind === "missing-prepare") db.exec("DELETE FROM local_command_history_recovery_prepares");
        if (kind === "floor") db.exec("UPDATE local_command_history_recovery_prepares SET document=json_set(document,'$.mirrorHead',0,'$.journalHead',0)");
        if (kind === "accepted-id") db.prepare("DELETE FROM local_commands WHERE id=?").run(f.commandId);
        if (kind === "credential-ack") db.exec("DELETE FROM local_credential_control_operations");
      } finally { db.close(); }
      const next = successor(f.target), { writerEpoch: _writer, ...identity } = next;
      const authorization = { ...f.authorization, ...identity, recoveryId: randomUUID(), preparedCustody: [{ scope: f.target,
        recoveryId: kind === "foreign-receipt" ? randomUUID() : f.authorization.recoveryId, retiredAt: new Date().toISOString() }] };
      const before = readFileSync(f.file), retained = inventory(f.file);
      await expect(recoverCloudLocalCommandCheckpointLedger({ root: f.root, file: f.file,
        scope: next, expectedWriterEpoch: f.unsealed.writerEpoch, authorization })).rejects.toMatchObject({ name: "CloudCommandRuntimeError" });
      expect(readFileSync(f.file)).toEqual(before); expect(inventory(f.file)).toEqual(retained);
    });

  it.each(["source", "target", "ancestor", "floor"] as const)("refuses conflicting recovery %s without installing an older checkpoint", async kind => {
    const f = await interruptedWriter(), bytes = readFileSync(f.file);
    const authorization = structuredClone(f.authorization);
    if (kind === "source") authorization.predecessor.writerEpoch = randomUUID();
    if (kind === "target") authorization.engineInstanceId = randomUUID();
    if (kind === "ancestor") authorization.checkpoint.sha256 = "f".repeat(64);
    if (kind === "floor") authorization.mirroredSequence = 1_000_000;
    const { recoverCloudLocalCommandCheckpointLedger } = await import("../cloud-local-command-queue-checkpoint");
    await expect(recoverCloudLocalCommandCheckpointLedger({ root: f.root, file: f.file,
      scope: f.target, expectedWriterEpoch: f.unsealed.writerEpoch, authorization })).rejects.toMatchObject({ name: "CloudCommandRuntimeError" });
    expect(readFileSync(f.file)).toEqual(bytes); expect(inventory(f.file)).toEqual(f.retained);
  });

  it("rechecks the authorized recovery inventory inside the credential-scope transaction", async () => {
    const f = await interruptedWriter();
    const { recoverCloudLocalCommandCheckpointLedger } = await import("../cloud-local-command-queue-checkpoint");
    const recovered = await recoverCloudLocalCommandCheckpointLedger({ root: f.root, file: f.file,
      scope: f.target, expectedWriterEpoch: f.unsealed.writerEpoch, authorization: f.authorization });
    cleanup.push(recovered.cleanup);
    const db = openSqlite(f.file);
    try { db.prepare("DELETE FROM local_credential_retirement_floors WHERE mutation_id=?").run(f.request.mutationId); }
    finally { db.close(); }
    expect(() => controls(f.file, f.target, recovered.predecessor, undefined, {},
      (receipt, file, db) => verifiedCloudLocalCommandPredecessor(receipt, file, db, f.target)))
      .toThrow("credential_control_authority_rejected");
  });

  it.each([false, true])("preserves eight sealed handoffs and identifies an unsealed successor (interrupted=%s)", async interrupted => {
    const f = await fixture();
    let scope: CloudAgentBootScope = f.scope;
    let predecessor = f.predecessor;
    for (let cycle = 1; cycle <= 8; cycle++) {
      const next = successor(scope), current = controls(f.file, next, predecessor);
      const request = { ...f.request, ...next, mutationId: randomUUID(), controlRequestId: randomUUID() };
      const ack = await current.handle(request);
      current.confirmAcknowledgement(ack);
      current.close();
      await seal(f.file, next, f.root);
      const restored = await restoreCloudLocalCommandCheckpointLedger({
        root: f.root, file: f.file, scope: next, expectedWriterEpoch: next.writerEpoch,
      });
      cleanup.push(restored.cleanup);
      expect(restored.predecessor?.scope).toEqual(next);
      const retained = inventory(f.file);
      expect(retained.fences).toEqual(expect.arrayContaining(f.before.fences));
      expect(retained.operations).toEqual(expect.arrayContaining(f.before.operations));
      expect(retained.floors).toEqual(f.before.floors);
      scope = next; predecessor = restored.predecessor;
    }
    const db = openSqlite(f.file, { readonly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM local_command_writer_seals WHERE ack IS NOT NULL").get()).toEqual({ n: 9 });
      expect(db.prepare("SELECT count(*) AS n FROM local_credential_control_scopes WHERE retired=1").get()).toEqual({ n: 8 });
    } finally { db.close(); }
    if (interrupted) {
      const unsealed = successor(scope), current = controls(f.file, unsealed, predecessor);
      const ack = await current.handle({ ...f.request, ...unsealed, mutationId: randomUUID(), controlRequestId: randomUUID() });
      current.confirmAcknowledgement(ack); current.close();
      const actors = new CloudActorAuthorityRegistry({ scope: unsealed, engineLive: () => true });
      const queue = new CloudLocalCommandQueue({ file: f.file, scope: unsealed, actors,
        engineLive: () => true, ready: () => true, history: () => ({ recordSequence: 7, eventSequence: 0 }) });
      // A provider stop retired this writer before drain/seal/capture. Its FULL
      // ledger must remain available for an explicitly authorized recovery.
      queue.close(); actors.dispose();
      const before = readFileSync(f.file), manifest = readFileSync(path.join(f.root, "manifest.json"));
      const retained = inventory(f.file);
      await expect(restoreCloudLocalCommandCheckpointLedger({
        root: f.root, file: f.file, scope: unsealed, expectedWriterEpoch: unsealed.writerEpoch,
      })).rejects.toMatchObject({ code: "checkpoint_expected_writer_mismatch" });
      expect(readFileSync(f.file)).toEqual(before);
      expect(readFileSync(path.join(f.root, "manifest.json"))).toEqual(manifest);
      expect(inventory(f.file)).toEqual(retained);
    }
  });

  it.each(["missing", "rejected"] as const)("refuses real predecessor custody when the injected verifier is %s", async mode => {
    const f = await fixture();
    const verifyPredecessor = mode === "missing" ? null : vi.fn<typeof verifiedCloudLocalCommandPredecessor>((receipt, file, db) => {
      expect(receipt).toBe(f.predecessor);
      expect(file).toBe(f.file);
      expect(db.inTransaction).toBe(true);
      return null;
    });
    expect(() => controls(f.file, successor(f.scope), f.predecessor, undefined, {}, verifyPredecessor))
      .toThrow("credential_control_authority_rejected");
    if (verifyPredecessor) expect(verifyPredecessor).toHaveBeenCalledOnce();
    expect(inventory(f.file)).toEqual(f.before);
    const db = openSqlite(f.file, { readonly: true });
    try {
      const stored = db.prepare("SELECT value FROM local_credential_control_metadata WHERE key='scope'").get() as { value: string };
      expect(JSON.parse(stored.value)).toEqual(f.scope);
    } finally { db.close(); }
  });

  it.each([false, true])("retains every original ACK/fence/floor while activating a fresh namespace (legacy=%s)", async legacy => {
    const f = await fixture(legacy), next = successor(f.scope), value = controls(f.file, next, f.predecessor);
    expect(inventory(f.file)).toEqual(f.before);
    expect(value.pendingAcknowledgement()).toBeNull();
    expect(value.canStart(f.run)).toBe(false);
    const admitted = { ...f.run, bootId: next.bootId, writerEpoch: next.writerEpoch };
    expect(value.canStart(admitted)).toBe(true);
    expect(() => value.confirmAcknowledgement(f.retired)).toThrow("credential_control_conflict");
    await expect(value.handle({ ...f.request, ...next })).rejects.toThrow("credential_control_conflict");
    await expect(value.handle({ ...f.request, ...next, controlRequestId: randomUUID() })).rejects.toThrow("credential_control_conflict");
    expect(inventory(f.file)).toEqual(f.before);
    const current = { ...f.request, ...next, mutationId: randomUUID(), controlRequestId: randomUUID() };
    const ack = await value.handle(current);
    expect(ack).toMatchObject({ writerEpoch: next.writerEpoch, controlRevision: 1, startsFenced: true });
    expect(value.canStart(admitted)).toBe(false);
    value.close();
    const reopened = controls(f.file, next);
    expect(reopened.pendingAcknowledgement()).toEqual(ack);
    expect(await reopened.handle(current)).toEqual(ack);
    expect(reopened.canStart(admitted)).toBe(false);
  });

  it.each(["missing", "structural-copy", "foreign-file", "source-not-authenticated", "replaced-inode"])(
    "rejects %s custody without changing old controls", async kind => {
      const f = await fixture(), next = successor(f.scope);
      let proof = f.predecessor, file = f.file;
      if (kind === "missing") proof = null;
      if (kind === "structural-copy") proof = structuredClone(f.predecessor);
      if (kind === "foreign-file") { file = path.join(f.directory, "copy.sqlite"); copyFileSync(f.file, file); }
      if (kind === "source-not-authenticated" || kind === "replaced-inode") {
        const restored = await restoreCloudLocalCommandCheckpointLedger({ root: f.root, file, scope: f.scope,
          ...(kind === "replaced-inode" ? { expectedWriterEpoch: f.scope.writerEpoch } : {}) });
        cleanup.push(restored.cleanup);
        if (kind === "source-not-authenticated") proof = restored.predecessor;
      }
      expect(() => controls(file, next, proof)).toThrow("credential_control_authority_rejected");
      expect(inventory(file)).toEqual(f.before);
    });

  it.each(["organization", "workspace", "generation", "engine", "writer"])(
    "refuses an invalid successor %s even with real predecessor custody", async kind => {
      const f = await fixture(), next = successor(f.scope);
      if (kind === "organization") next.organizationId = randomUUID();
      if (kind === "workspace") next.workspaceId = randomUUID();
      if (kind === "generation") next.generation--;
      if (kind === "engine") next.engineInstanceId = f.scope.engineInstanceId;
      if (kind === "writer") next.writerEpoch = f.scope.writerEpoch;
      expect(() => controls(f.file, next, f.predecessor)).toThrow("credential_control_authority_rejected");
      expect(inventory(f.file)).toEqual(f.before);
    });

  it("fences old handles and late ACK completion after the same-file publication", async () => {
    const f = await fixture();
    let resolve!: () => void;
    const wait = new Promise<void>(done => { resolve = done; }), entered = vi.fn();
    const old = controls(f.file, f.scope, null, async () => { entered(); await wait; });
    const late = old.handle({ ...f.request, mutationId: f.pending.mutationId, controlRequestId: randomUUID(),
      operation: "publish-desired", desiredCacheRevision: 2 });
    const failure = expect(late).rejects.toThrow("credential_control_authority_rejected");
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    const next = controls(f.file, successor(f.scope), f.predecessor);
    const published = inventory(f.file);
    expect(() => old.pendingAcknowledgement()).toThrow("credential_control_authority_rejected");
    expect(() => old.confirmAcknowledgement(f.pending)).toThrow("credential_control_authority_rejected");
    resolve(); await failure;
    expect(inventory(f.file)).toEqual(published);
    expect(next.pendingAcknowledgement()).toBeNull();
  });

  it("refuses A to B to A even with a freshly verified B checkpoint", async () => {
    const f = await fixture(), scopeB = successor(f.scope), b = controls(f.file, scopeB, f.predecessor);
    b.close();
    const rootB = path.join(f.directory, "checkpoint-b");
    await seal(f.file, scopeB, rootB);
    const restored = await restoreCloudLocalCommandCheckpointLedger({ root: rootB, file: f.file, scope: scopeB, expectedWriterEpoch: scopeB.writerEpoch });
    cleanup.push(restored.cleanup);
    expect(() => controls(f.file, f.scope, restored.predecessor)).toThrow("credential_control_authority_rejected");
    expect(inventory(f.file)).toEqual(f.before);
  });

  it.each(["retired", "foreign"])("refuses a contradictory %s current-scope record", async kind => {
    const f = await fixture(), db = openSqlite(f.file);
    try {
      if (kind === "retired") db.prepare("UPDATE local_credential_control_scopes SET retired=1 WHERE writer_epoch=?").run(f.scope.writerEpoch);
      else db.prepare("UPDATE local_credential_control_scopes SET scope=? WHERE writer_epoch=?")
        .run(JSON.stringify({ ...f.scope, workspaceId: randomUUID() }), f.scope.writerEpoch);
    } finally { db.close(); }
    expect(() => controls(f.file, successor(f.scope), f.predecessor)).toThrow("credential_control_authority_rejected");
    expect(inventory(f.file)).toEqual(f.before);
  });

  it.each(["mixed-columns", "missing-history", "missing-current"])("refuses a partial %s migration", async kind => {
    const f = await fixture(), db = openSqlite(f.file);
    try {
      if (kind === "mixed-columns") db.exec(`DROP INDEX local_credential_start_fences_writer;
        ALTER TABLE local_credential_start_fences DROP COLUMN writer_epoch`);
      else if (kind === "missing-history") db.exec("DROP TABLE local_credential_control_scopes");
      else db.prepare("DELETE FROM local_credential_control_scopes WHERE writer_epoch=?").run(f.scope.writerEpoch);
    } finally { db.close(); }
    expect(() => controls(f.file, successor(f.scope), f.predecessor)).toThrow("credential_control_authority_rejected");
    expect(inventory(f.file)).toEqual(f.before);
  });

  it("rolls back a partial legacy handoff without losing rows or publishing the successor", async () => {
    const f = await fixture(true), db = openSqlite(f.file);
    try { db.exec(`CREATE TRIGGER reject_scope_publication AFTER UPDATE ON local_credential_control_metadata
      WHEN NEW.key='scope' BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END`); }
    finally { db.close(); }
    expect(() => controls(f.file, successor(f.scope), f.predecessor)).toThrow("credential_control_storage_unavailable");
    expect(inventory(f.file)).toEqual(f.before);
    const check = openSqlite(f.file, { readonly: true });
    try {
      expect(check.prepare("SELECT name FROM pragma_table_info('local_credential_control_operations') WHERE name='writer_epoch'").get()).toBeUndefined();
      expect(check.prepare("SELECT value FROM local_credential_control_metadata WHERE key='scope'").get())
        .toEqual({ value: expect.any(String) });
      expect(JSON.parse((check.prepare("SELECT value FROM local_credential_control_metadata WHERE key='scope'").get() as { value: string }).value)).toEqual(f.scope);
    } finally { check.close(); }
    expect(controls(f.file, f.scope).pendingAcknowledgement()).not.toBeNull();
  });

  it("bounds the total retained epochs without pruning tombstones to admit another one", async () => {
    const f = await fixture(), db = openSqlite(f.file);
    try {
      db.transaction(() => {
        const insert = db.prepare("INSERT INTO local_credential_control_scopes(writer_epoch,scope,revision,retired) VALUES(?,?,?,1)");
        for (let index = 1; index < 4096; index++) {
          const old = successor(f.scope); insert.run(old.writerEpoch, JSON.stringify(old), "0");
        }
      })();
    } finally { db.close(); }
    expect(() => controls(f.file, successor(f.scope), f.predecessor)).toThrow("credential_control_limit");
    expect(inventory(f.file)).toEqual(f.before);
  });

  it.each(["operations", "mutations", "ack-bytes"])("counts retained predecessors against the total %s budget", async budget => {
    const f = await fixture(), next = successor(f.scope);
    if (budget === "ack-bytes") {
      const db = openSqlite(f.file);
      try { db.prepare("UPDATE local_credential_control_operations SET ack_bytes=? WHERE request_id=?")
        .run(32 * 1024 * 1024, f.request.controlRequestId); } finally { db.close(); }
    }
    const before = inventory(f.file);
    const current = controls(f.file, next, f.predecessor, undefined,
      budget === "operations" ? { maxOperations: 3 } : budget === "mutations" ? { maxMutations: 2 } : {});
    await expect(current.handle({ ...f.request, ...next, controlRequestId: randomUUID(), mutationId: randomUUID() }))
      .rejects.toThrow("credential_control_limit");
    expect(inventory(f.file)).toEqual(before);
  });
});
