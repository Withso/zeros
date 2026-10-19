import {readFile,readdir} from "node:fs/promises";
import {randomBytes,randomUUID} from "node:crypto";
import pg from "pg";
import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {withSystemTx} from "../db.js";
import {seedReadyCloudWorkspace,seedSupportedCloudWorkspaceGeneration,withCloudFixtureOwnerTx} from "./test-fixtures.js";
import {DatabaseCloudWorkspaceBlobService,MemoryCloudWorkspaceObjectStore} from "./object-store.js";
import {DatabaseCloudWorkspaceContentService} from "./content-record.js";
import {ensureFinalSaveRecovery,finalSaveProven} from "./final-save-recovery.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
const directory=new URL("../../migrations/",import.meta.url),migration="0171_cloud_final_save_recovery.sql";
suite("final-save expansion adopts only exact historical evidence",()=>{
  let pool:pg.Pool;
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5});});
  afterAll(async()=>pool.end());
  beforeEach(async()=>{
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);
    const tx=await pool.connect();
    try {for(const name of (await readdir(directory)).filter(name=>/^\d{4}_.*\.sql$/.test(name)&&name<migration).sort()){
      await tx.query("BEGIN");await tx.query(await readFile(new URL(name,directory),"utf8"));await tx.query("COMMIT");
    }} finally {await tx.query("ROLLBACK");tx.release();}
  });
  const migrate=async()=>{
    const tx=await pool.connect();
    try {await tx.query("BEGIN");await tx.query(await readFile(new URL(migration,directory),"utf8"));await tx.query("COMMIT");}
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
