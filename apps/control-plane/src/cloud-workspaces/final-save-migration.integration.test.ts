import {readFile,readdir} from "node:fs/promises";
import {randomBytes,randomUUID} from "node:crypto";
import pg from "pg";
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {withSystemTx} from "../db.js";
import {seedReadyCloudWorkspace,seedSupportedCloudWorkspaceGeneration,withCloudFixtureOwnerTx} from "./test-fixtures.js";
import {DatabaseCloudWorkspaceBlobService,MemoryCloudWorkspaceObjectStore} from "./object-store.js";
import {DatabaseCloudWorkspaceContentService} from "./content-record.js";
import {ensureFinalSaveRecovery,finalSaveProven} from "./final-save-recovery.js";
import {commitFinalSaveFixture,seedFinalSaveEngine} from "./final-save-test-fixtures.js";
import { CloudWorkspaceOperationsWorker } from "./operations.js";
import { readCloudWorkerNextDelay } from "./worker-deadlines.js";
import { confirmWorkspaceDeletion } from "./deletion-test-fixtures.js";
import { runFinalSaveRecovery } from "./final-save-service.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
const directory=new URL("../../migrations/",import.meta.url),migration="0171_cloud_final_save_recovery.sql";
suite("final-save expansion adopts only exact historical evidence",()=>{
  let pool:pg.Pool;
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5});});
  afterAll(async()=>pool.end());
  beforeEach(async()=>{
    // A complete schema replay invalidates thousands of catalog entries.
    // Give each legacy fixture fresh backends instead of retaining that cache.
    await pool.end();
    pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5});
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);
    const tx=await pool.connect();
    try {for(const name of (await readdir(directory)).filter(name=>/^\d{4}_.*\.sql$/.test(name)&&name<migration).sort()){
      await tx.query("BEGIN");await tx.query(await readFile(new URL(name,directory),"utf8"));await tx.query("COMMIT");
    }} finally {await tx.query("ROLLBACK");tx.release();}
  // Replays the complete pre-expansion ladder for real legacy-row fixtures.
  },30_000);
  const migrate=async(currentSchema=false)=>{
    const tx=await pool.connect();
    const files=currentSchema
      ? (await readdir(directory)).filter(name=>/^\d{4}_.*\.sql$/.test(name)&&name>=migration).sort()
      : [migration];
    try {for(const name of files){
      await tx.query("BEGIN");await tx.query(await readFile(new URL(name,directory),"utf8"));await tx.query("COMMIT");
    }}
    finally {await tx.query("ROLLBACK");tx.release();}
  };
  async function legacy(committed:boolean){
    const fixture=await seedReadyCloudWorkspace(pool),intentId=randomUUID(),requestId=randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256)
      VALUES($1::uuid,$2,$3,1,$4,'stop',$1::text,digest($1::text,'sha256'))`,[intentId,fixture.workspaceId,fixture.organizationId,fixture.userId]);
    await pool.query(`INSERT INTO workspace_checkpoint_requests(id,workspace_id,org_id,generation,requested_by,lifecycle_intent_id,
      reason,idempotency_key,deadline_at) VALUES($1::uuid,$2,$3,1,$4,$5,'before_stop',$1::text,now()+interval '5 minutes')`,
    [requestId,fixture.workspaceId,fixture.organizationId,fixture.userId,intentId]);
    if(committed){
      const source={...fixture,generation:1};
      const blobs=new DatabaseCloudWorkspaceBlobService({pool,workosEnabled:false,objectStore:new MemoryCloudWorkspaceObjectStore(),
        encryptionKeyV1:randomBytes(32).toString("base64url")});
      const blob=await blobs.put({...source,bytes:Buffer.from("legacy saved content")});
      const content=new DatabaseCloudWorkspaceContentService({pool,workosEnabled:false});
      await content.append({...source,expectedRevision:0,idempotencyKey:randomUUID(),gitBaseCommit:"a".repeat(40),gitHeadRef:null,
        mutations:[{path:"saved.txt",operation:"upsert",entryType:"file",mode:33188,blobId:blob.id,contentSha256:blob.plaintextSha256,sizeBytes:20}]});
      // This is the deployed pre-0171 commit writer's relational receipt.
      // Real upload/content exist; no future column, trigger toggle or fake
      // recovery flag is used to make the old source appear saved.
      const checkpointId=randomUUID();
      await withSystemTx(pool,async tx=>{
        await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE",[fixture.organizationId]);
        await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE",[fixture.workspaceId]);
        await tx.query(`INSERT INTO workspace_checkpoints(id,workspace_id,org_id,idempotency_key,request_sha256,content_revision,
          record_revision,authority_epoch,generation,reason,manifest_blob_id,inclusion_policy,file_count,total_bytes,state,integrity_sha256,durable_at)
          VALUES($1::uuid,$2,$3,$1::text,digest($1::text,'sha256'),1,0,1,1,'before_stop',$4,'{}',1,20,'durable',$5,now())`,
        [checkpointId,fixture.workspaceId,fixture.organizationId,blob.id,Buffer.from(blob.plaintextSha256,"hex")]);
        await tx.query(`INSERT INTO workspace_checkpoint_entries(checkpoint_id,workspace_id,org_id,normalized_path,operation,entry_type,mode,blob_id,content_sha256,size_bytes)
          SELECT $1,workspace_id,org_id,normalized_path,'upsert',entry_type,mode,blob_id,content_sha256,size_bytes
          FROM workspace_file_entries WHERE workspace_id=$2`,[checkpointId,fixture.workspaceId]);
        await tx.query(`INSERT INTO workspace_blob_references(blob_id,org_id,workspace_id,reference_kind,reference_id)
          VALUES($1,$2,$3,'checkpoint_file',$4),($1,$2,$3,'checkpoint_manifest',$4)`,[blob.id,fixture.organizationId,fixture.workspaceId,checkpointId]);
        await tx.query("UPDATE workspace_blobs SET reference_count=reference_count+2 WHERE id=$1",[blob.id]);
        await tx.query("UPDATE workspace_content_heads SET current_checkpoint_id=$2,durable_revision=1 WHERE workspace_id=$1",[fixture.workspaceId,checkpointId]);
        await tx.query("UPDATE workspace_checkpoint_requests SET state='succeeded',checkpoint_id=$2,completed_at=now() WHERE id=$1",[requestId,checkpointId]);
      });
      expect((await pool.query("SELECT final_checkpoint_at FROM cloud_workspace_engine_instances WHERE id=$1",[fixture.engineInstanceId])).rows[0].final_checkpoint_at).toBeInstanceOf(Date);
      await pool.query("UPDATE cloud_workspaces SET authority_epoch=authority_epoch+1,desired_state='stopped',status='stopped' WHERE id=$1",[fixture.workspaceId]);
    }
    return {...fixture,intentId,requestId};
  }
  it("adopts an old final checkpoint's original epoch after lifecycle advanced the workspace",async()=>{
    const f=await legacy(true);await migrate();
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_final_save_recoveries")).rows[0].n).toBe(0);
    await withSystemTx(pool,tx=>ensureFinalSaveRecovery(tx,f.intentId));
    expect(await withSystemTx(pool,tx=>finalSaveProven(tx,f.intentId))).toBe(true);
    expect((await pool.query("SELECT authority_epoch::text,state,proven_request_id FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1",[f.intentId])).rows)
      .toEqual([{authority_epoch:"1",state:"proven",proven_request_id:f.requestId}]);
  });
  it("does not adopt a historical final checkpoint after its registration incarnation changes",async()=>{
    const f=await legacy(true);
    await pool.query("UPDATE cloud_workspace_engine_instances SET registered_at=clock_timestamp() WHERE id=$1",[f.engineInstanceId]);
    await migrate();await withSystemTx(pool,tx=>ensureFinalSaveRecovery(tx,f.intentId));
    expect(await withSystemTx(pool,tx=>finalSaveProven(tx,f.intentId))).toBe(false);
  });
  async function savedDelete(f:Awaited<ReturnType<typeof legacy>>, source = { ...f,generation:1 }) {
    const intentId=randomUUID();
    await withSystemTx(pool,tx=>tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256)
      VALUES($1::uuid,$2,$3,1,$4,'delete',$1::text,digest($1::text,'sha256'))`,[intentId,f.workspaceId,f.organizationId,f.userId]));
    await commitFinalSaveFixture(pool,source,{intentId,userId:f.userId,reason:"before_delete"});
    expect(await withSystemTx(pool,tx=>finalSaveProven(tx,intentId))).toBe(true);
    return intentId;
  }
  const deletionClaimable=async(f:Awaited<ReturnType<typeof legacy>>)=>
    (await withSystemTx(pool,tx=>tx.query("SELECT cloud_final_save_deletion_claimable($1,$2) AS allowed",[f.workspaceId,f.organizationId]))).rows[0].allowed as boolean;

  async function deletionWithLegacyHistory(historyCount = 1, currentSchema = false) {
    const f = await legacy(true);
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE id=$1", [f.intentId]);
    for (let index = 1; index < historyCount; index++) {
      const intentId = randomUUID(), requestId = randomUUID();
      await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
        (id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256,state,completed_at)
        SELECT $1::uuid,workspace_id,org_id,generation,requested_by,operation,$1::text,digest($1::text,'sha256'),'succeeded',now()
        FROM cloud_workspace_lifecycle_intents WHERE id=$2`, [intentId,f.intentId]);
      await pool.query(`INSERT INTO workspace_checkpoint_requests
        (id,workspace_id,org_id,generation,requested_by,lifecycle_intent_id,reason,idempotency_key,deadline_at,state,checkpoint_id,completed_at)
        SELECT $1::uuid,workspace_id,org_id,generation,requested_by,$2,reason,$1::text,deadline_at,state,checkpoint_id,completed_at
        FROM workspace_checkpoint_requests WHERE id=$3`, [requestId,intentId,f.requestId]);
    }
    // A real wake in the same generation enrolls a different source. The old
    // Stop must never acquire the new source's live dispatch authority.
    await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1", [f.engineInstanceId]);
    await pool.query("UPDATE cloud_workspaces SET status='ready',desired_state='running' WHERE id=$1", [f.workspaceId]);
    const successor = await withSystemTx(pool, tx => seedFinalSaveEngine(tx, { ...f,setupAttempt:2 }));
    // This durable job predates 0171. The post-upgrade delete has exact proof,
    // but its earlier explicit Stop has never encountered an adoption writer.
    const jobId = randomUUID();
    await pool.query(`INSERT INTO workspace_deletion_jobs(id,workspace_id,org_id,requested_by,idempotency_key,next_attempt_at)
      VALUES($1,$2,$3,$4,'pre-expansion-delete',now()-interval '1 hour')`, [jobId,f.workspaceId,f.organizationId,f.userId]);
    await migrate(currentSchema);
    const deleteId = await savedDelete(f, { ...f,...successor });
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='dispatching',dispatched_at=now() WHERE id=$1", [deleteId]);
    await confirmWorkspaceDeletion(pool, f);
    await pool.query("UPDATE cloud_workspace_provider_bindings SET last_observed_at=clock_timestamp() WHERE workspace_id=$1", [f.workspaceId]);
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE id=$1", [deleteId]);
    await pool.query(`INSERT INTO workspace_retention_policies(workspace_id,org_id,last_applied_at)
      VALUES($1,$2,now()) ON CONFLICT(workspace_id,org_id) DO UPDATE SET last_applied_at=excluded.last_applied_at`,
    [f.workspaceId,f.organizationId]);
    expect((await pool.query(`SELECT recovery.state,dispatch.settled_at IS NOT NULL AS settled
      FROM cloud_workspace_final_save_recoveries recovery JOIN cloud_workspace_final_save_dispatches dispatch USING(lifecycle_intent_id)
      WHERE recovery.lifecycle_intent_id=$1`, [deleteId])).rows).toEqual([{ state: "proven", settled: true }]);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [f.intentId])).rowCount).toBe(0);
    expect(await deletionClaimable(f)).toBe(false);
    return { ...f,jobId,deleteId };
  }

  it("schedules adoption of legacy Stop history before the erasure claim filter", async () => {
    const f = await deletionWithLegacyHistory();
    // All unrelated maintenance is in the future. A missing history row must
    // itself wake reconciliation; a scheduler read is still strictly read-only.
    expect(await readCloudWorkerNextDelay(pool, "operations")).toBeLessThanOrEqual(0);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [f.intentId])).rowCount).toBe(0);
  });

  it("recovers an existing waiting_for_provider job with saved legacy Stop history through real erasure", async () => {
    const f = await deletionWithLegacyHistory(), logger = { error: vi.fn() };
    const objects = { deleteUnreferencedSystem: vi.fn(async () => "already_deleted" as const) };
    const worker = new CloudWorkspaceOperationsWorker(pool, objects, { workerId: "legacy-history-erasure", logger });
    await worker.runOnce();
    expect((await pool.query(`SELECT job.id,job.state,job.attempt_count,job.idempotency_key,job.error_code,
      workspace.data_deleted_at IS NOT NULL AS erased FROM workspace_deletion_jobs job
      JOIN cloud_workspaces workspace ON workspace.id=job.workspace_id AND workspace.org_id=job.org_id WHERE job.id=$1`, [f.jobId])).rows)
      .toEqual([{ id: f.jobId,state: "succeeded",attempt_count: 0,idempotency_key: "pre-expansion-delete",error_code: null,erased: true }]);
    expect((await pool.query("SELECT 1 FROM workspace_checkpoint_requests WHERE workspace_id=$1", [f.workspaceId])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM workspace_checkpoints WHERE workspace_id=$1", [f.workspaceId])).rowCount).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("retains original historical custody without granting it current dispatch authority", async () => {
    const f = await deletionWithLegacyHistory();
    const objects = { deleteUnreferencedSystem: vi.fn(async () => "already_deleted" as const) };
    const worker = new CloudWorkspaceOperationsWorker(pool, objects, { workerId: "historical-custody" });
    expect(await worker.processDeletionOnce()).toBe(true);
    expect((await pool.query(`SELECT state,original_request_id,proven_request_id,engine_instance_id,authority_epoch::text
      FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1`, [f.intentId])).rows)
      .toEqual([{ state: "resolved",original_request_id:f.requestId,proven_request_id:f.requestId,engine_instance_id:f.engineInstanceId,authority_epoch:"1" }]);
    expect(await withSystemTx(pool, tx => finalSaveProven(tx,f.intentId))).toBe(false);
    await expect(withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_lifecycle_intents SET state='dispatching' WHERE id=$1", [f.intentId])))
      .rejects.toMatchObject({ code: "40001" });
    expect(objects.deleteUnreferencedSystem).not.toHaveBeenCalled();
  });

  it.each(["invalidated receipt", "changed registration", "missing negotiated seal", "unsettled dispatch", "invalidated current Delete"])(
    "does not erase or hot-poll after adopting history with %s", async fault => {
      const f = await deletionWithLegacyHistory();
      if (fault === "changed registration") await pool.query("UPDATE cloud_workspace_engine_instances SET registered_at=clock_timestamp() WHERE id=$1", [f.engineInstanceId]);
      else if (fault === "missing negotiated seal") await pool.query("UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=1 WHERE id=$1", [f.engineInstanceId]);
      else if (fault === "unsettled dispatch") await pool.query("UPDATE cloud_workspace_final_save_dispatches SET settled_at=NULL WHERE lifecycle_intent_id=$1", [f.deleteId]);
      else await pool.query(`UPDATE workspace_checkpoints SET state='invalid',invalidated_at=clock_timestamp()
        WHERE id=(SELECT checkpoint_id FROM workspace_checkpoint_requests WHERE lifecycle_intent_id=$1)`,
      [fault === "invalidated receipt" ? f.intentId : f.deleteId]);
      const objects = { deleteUnreferencedSystem: vi.fn(async () => "already_deleted" as const) }, logger = { error: vi.fn() };
      const worker = new CloudWorkspaceOperationsWorker(pool, objects, { workerId: "historical-refusal", logger });
      expect(await worker.processDeletionOnce()).toBe(false);
      expect((await pool.query("SELECT state,attempt_count,last_started_at FROM workspace_deletion_jobs WHERE id=$1", [f.jobId])).rows)
        .toEqual([{ state:"waiting_for_provider",attempt_count:0,last_started_at:null }]);
      expect(await deletionClaimable(f)).toBe(false);
      expect(await readCloudWorkerNextDelay(pool,"operations")).toBeGreaterThan(0);
      expect((await pool.query(`SELECT 1 FROM control_plane_jobs WHERE workspace_id=$1 AND org_id=$2
        AND kind='cloud_final_save_recovery' AND state IN ('queued','running')`, [f.workspaceId,f.organizationId])).rowCount).toBe(1);
      expect(objects.deleteUnreferencedSystem).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

  it.each(["organization", "workspace", "job"])("skips a held %s lock and resumes the original job after release", async held => {
    const f = await deletionWithLegacyHistory();
    const objects = { deleteUnreferencedSystem: vi.fn(async () => "already_deleted" as const) };
    const worker = new CloudWorkspaceOperationsWorker(pool, objects, { workerId: "historical-lock" });
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      if (held === "organization") await holder.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [f.organizationId]);
      else if (held === "workspace") await holder.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId]);
      else await holder.query("SELECT id FROM workspace_deletion_jobs WHERE id=$1 FOR UPDATE", [f.jobId]);
      expect(await worker.processDeletionOnce()).toBe(false);
      expect((await pool.query("SELECT 1 FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [f.intentId])).rowCount).toBe(0);
    } finally { await holder.query("ROLLBACK"); holder.release(); }
    expect(await worker.processDeletionOnce()).toBe(true);
    expect((await pool.query("SELECT state,attempt_count FROM workspace_deletion_jobs WHERE id=$1", [f.jobId])).rows)
      .toEqual([{ state:"deleting_objects",attempt_count:0 }]);
    expect(objects.deleteUnreferencedSystem).not.toHaveBeenCalled();
  });

  it("adopts at most eight historical intents per transaction and keeps the remaining backlog due", async () => {
    const f = await deletionWithLegacyHistory(9);
    const objects = { deleteUnreferencedSystem: vi.fn(async () => "already_deleted" as const) };
    const worker = new CloudWorkspaceOperationsWorker(pool, objects, { workerId: "historical-batch" });
    expect(await worker.processDeletionOnce()).toBe(false);
    const historicalCount = async () => (await pool.query(`SELECT count(*)::int AS n FROM cloud_workspace_final_save_recoveries
      WHERE workspace_id=$1 AND operation='stop'`, [f.workspaceId])).rows[0].n;
    expect(await historicalCount()).toBe(8);
    expect(await deletionClaimable(f)).toBe(false);
    expect(await readCloudWorkerNextDelay(pool,"operations")).toBeLessThanOrEqual(0);
    expect(await worker.processDeletionOnce()).toBe(true);
    expect(await historicalCount()).toBe(9);
    expect(await deletionClaimable(f)).toBe(true);
    expect((await pool.query("SELECT state,attempt_count FROM workspace_deletion_jobs WHERE id=$1", [f.jobId])).rows)
      .toEqual([{ state:"deleting_objects",attempt_count:0 }]);
    expect(objects.deleteUnreferencedSystem).not.toHaveBeenCalled();
  });

  it("uses the existing recovery job to finish already-adopted historical custody after retirement settles", async () => {
    // Keep the old receipt producer, then apply every shipped expansion before
    // starting today's worker, which owns the new cleanup adoption function.
    const f = await deletionWithLegacyHistory(1, true);
    await pool.query("UPDATE cloud_workspace_final_save_dispatches SET settled_at=NULL WHERE lifecycle_intent_id=$1", [f.deleteId]);
    const objects = { deleteUnreferencedSystem: vi.fn(async () => "already_deleted" as const) };
    const worker = new CloudWorkspaceOperationsWorker(pool, objects, { workerId: "historical-recovery" });
    expect(await worker.processDeletionOnce()).toBe(false);
    expect(await deletionClaimable(f)).toBe(false);
    await pool.query("UPDATE cloud_workspace_final_save_dispatches SET settled_at=clock_timestamp() WHERE lifecycle_intent_id=$1", [f.deleteId]);
    await pool.query("UPDATE cloud_workspace_final_save_recoveries SET next_attempt_at=clock_timestamp() WHERE lifecycle_intent_id=$1", [f.intentId]);
    expect(await runFinalSaveRecovery(pool,f.workspaceId,false)).toBe(1);
    expect((await pool.query("SELECT state FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [f.intentId])).rows)
      .toEqual([{ state:"resolved" }]);
    expect(await deletionClaimable(f)).toBe(true);
    expect(await withSystemTx(pool,tx=>finalSaveProven(tx,f.intentId))).toBe(false);
  });

  it.each(["provider", "legal hold"])("does not claim a legacy-history job before %s permits erasure", async withheld => {
    const f = await deletionWithLegacyHistory(), logger = { error: vi.fn() };
    if (withheld === "provider") await pool.query("UPDATE cloud_workspace_provider_bindings SET deletion_verified_at=NULL WHERE workspace_id=$1", [f.workspaceId]);
    else await pool.query("UPDATE workspace_retention_policies SET legal_hold=true WHERE workspace_id=$1", [f.workspaceId]);
    const objects = { deleteUnreferencedSystem: vi.fn(async () => "already_deleted" as const) };
    const worker = new CloudWorkspaceOperationsWorker(pool, objects, { workerId: "legacy-history-erasure", logger });
    expect(await readCloudWorkerNextDelay(pool, "operations")).toBeGreaterThan(0);
    expect(await worker.processDeletionOnce()).toBe(false);
    expect((await pool.query("SELECT state,attempt_count,last_started_at FROM workspace_deletion_jobs WHERE id=$1", [f.jobId])).rows)
      .toEqual([{ state: "waiting_for_provider",attempt_count: 0,last_started_at: null }]);
    expect(objects.deleteUnreferencedSystem).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each(["failed","superseded"].flatMap(intentState=>["cancelled","expired","failed"].map(requestState=>({intentState,requestState}))))(
    "preserves pre-0171 reversible idle $intentState/$requestState history without demanding recovery",async({intentState,requestState})=>{
      const f=await legacy(false);
      await pool.query(`UPDATE workspace_checkpoint_requests SET idle_engine_instance_id=$2,state=$3,completed_at=clock_timestamp()
        WHERE id=$1`,[f.requestId,f.engineInstanceId,requestState]);
      await pool.query(`UPDATE cloud_workspace_lifecycle_intents SET requested_by=NULL,idempotency_key=$2,state=$3,completed_at=clock_timestamp()
        WHERE id=$1`,[f.intentId,`system:idle:${f.engineInstanceId}:${randomUUID()}`,intentState]);
      await migrate();
      await savedDelete(f);
      await withSystemTx(pool,tx=>ensureFinalSaveRecovery(tx,f.intentId));
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1",[f.intentId])).rows[0].n).toBe(0);
      expect(await deletionClaimable(f)).toBe(true);
    });

  it.each(["stop","archive","delete"].flatMap(operation=>["failed","superseded","succeeded"].map(state=>({operation,state}))))(
    "requires exact proof adoption for a pre-0171 explicit $operation/$state instead of ignoring history",async({operation,state})=>{
      const f=await legacy(false);
      await pool.query("UPDATE workspace_checkpoint_requests SET reason=$2,state='cancelled',completed_at=clock_timestamp() WHERE id=$1",[f.requestId,`before_${operation}`]);
      await pool.query("UPDATE cloud_workspace_lifecycle_intents SET operation=$2,state=$3,completed_at=clock_timestamp() WHERE id=$1",[f.intentId,operation,state]);
      await migrate();
      await savedDelete(f);
      // Historical explicit failures are not replayed as new accepted actions.
      // Their separately reviewed adoption must find this exact saved source.
      expect(await deletionClaimable(f)).toBe(false);
      await withSystemTx(pool,tx=>ensureFinalSaveRecovery(tx,f.intentId));
      expect(await withSystemTx(pool,tx=>finalSaveProven(tx,f.intentId))).toBe(true);
      expect(await deletionClaimable(f)).toBe(true);
      expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1",[f.intentId])).rows[0].state).toBe(state);
    });

  it("requires recovery for a committed pre-0171 idle stop",async()=>{
    const f=await legacy(true);
    await pool.query("UPDATE workspace_checkpoint_requests SET idle_engine_instance_id=$2 WHERE id=$1",[f.requestId,f.engineInstanceId]);
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET requested_by=NULL,idempotency_key=$2 WHERE id=$1",[f.intentId,`system:idle:${f.engineInstanceId}:${randomUUID()}`]);
    await migrate();
    expect(await deletionClaimable(f)).toBe(false);
    await withSystemTx(pool,tx=>ensureFinalSaveRecovery(tx,f.intentId));
    expect(await withSystemTx(pool,tx=>finalSaveProven(tx,f.intentId))).toBe(true);
    expect(await deletionClaimable(f)).toBe(true);
  });
  it("adopts a legacy drain before an old expiry writer tries to retire its candidate first",async()=>{
    const f=await legacy(false),transitionId=randomUUID();
    await withCloudFixtureOwnerTx(pool,async tx=>{
      await seedSupportedCloudWorkspaceGeneration(tx,{workspaceId:f.workspaceId,organizationId:f.organizationId,ownerUserId:f.userId,generation:2});
      await tx.query(`INSERT INTO cloud_workspace_generation_transitions(id,workspace_id,org_id,requested_by,operation,
        source_generation,template_generation,candidate_generation,state,drain_intent_id)
        VALUES($1,$2,$3,$4,'upgrade',1,1,2,'draining',$5)`,[transitionId,f.workspaceId,f.organizationId,f.userId,f.intentId]);
    });
    await migrate();
    await pool.query("UPDATE cloud_workspace_generations SET retired_at=clock_timestamp() WHERE workspace_id=$1 AND generation=2",[f.workspaceId]);
    expect((await pool.query("SELECT retired_at FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=2",[f.workspaceId])).rows[0].retired_at).toBeNull();
    expect((await pool.query("SELECT state FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1",[f.intentId])).rows)
      .toEqual([{state:"capturing"}]);
  });
});
