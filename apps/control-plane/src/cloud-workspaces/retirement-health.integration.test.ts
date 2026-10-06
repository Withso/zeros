import { randomUUID, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { DatabaseCloudWorkspaceHealthService } from "./health.js";
import { withSystemTx } from "../db.js";
import { readPendingDeletionCapacity } from "./pending-deletion.js";
import { DatabaseCloudProviderOperationStore } from "./provider-operation-store.js";
import { DatabaseCloudWorkspaceManagementService } from "./management.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("retirement progress health",()=>{
  let pool:pg.Pool,f:Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:4});});
  afterAll(async()=>{await pool.end();});
  beforeEach(async()=>{await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");await runMigrations(pool);f=await seedReadyCloudWorkspace(pool);});
  it("alerts on old non-workspace-affecting deletion despite frequent retries",async()=>{
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256,affects_workspace,state,created_at,updated_at,next_attempt_at)
      VALUES($1,$2,1,$3,'delete','synthetic-retirement',$4,false,'observing',now()-interval '2 hours',now(),now()+interval '1 minute')`,[randomUUID(),f.workspaceId,f.organizationId,randomBytes(32)]);
    const health=new DatabaseCloudWorkspaceHealthService(pool,{setupExecutionEnabled:false,durabilityEnabled:false,outboxDeliveryEnabled:false});
    expect((await health.read()).reasons).toContain("deletion_intent_stalled");
    expect((await pool.query("SELECT status FROM cloud_workspaces WHERE id=$1",[f.workspaceId])).rows[0].status).toBe("ready");
  });
  it("retains capacity and receipt progress independently of retries and logical deletion",async()=>{
    const resource=(await pool.query("SELECT provider_resource_id FROM cloud_workspace_provider_bindings WHERE workspace_id=$1",[f.workspaceId])).rows[0].provider_resource_id;
    await pool.query(`INSERT INTO cloud_workspace_provider_operations(provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256,resource_id,deletion_requested_at,deletion_operation_id)
      VALUES('daytona','synthetic',$1,1,$2,'synthetic',repeat('a',64),$3,now()-interval '2 hours','receipt')`,[f.workspaceId,f.organizationId,resource]);
    const store=new DatabaseCloudProviderOperationStore(pool,"daytona","synthetic");
    await store.recordDeletionProgress(resource,"receipt","processing");
    const progress=async()=>(await pool.query("SELECT deletion_progress_at FROM cloud_workspace_provider_operations WHERE workspace_id=$1",[f.workspaceId])).rows[0].deletion_progress_at;
    const first=await progress();
    await store.recordDeletionProgress(resource,"receipt","processing");
    await store.recordDeletionProgress(resource,"receipt","blocked");
    expect(await progress()).toEqual(first);
    const health=new DatabaseCloudWorkspaceHealthService(pool,{setupExecutionEnabled:false,durabilityEnabled:false,outboxDeliveryEnabled:false});
    expect((await health.read()).reasons).toContain("deletion_intent_stalled");
    await store.recordDeletionProgress(resource,"receipt","waiting_for_uploads");
    expect((await progress()).getTime()).toBeGreaterThan(first.getTime());
    expect((await health.read()).reasons).not.toContain("deletion_intent_stalled");
    await pool.query("UPDATE cloud_workspaces SET deleted_at=now(),status='deleted',desired_state='deleted' WHERE id=$1",[f.workspaceId]);
    const result=await withSystemTx(pool,tx=>readPendingDeletionCapacity(tx,f.organizationId));
    expect(result.pendingDeletion).toMatchObject([{workspaceId:f.workspaceId,generation:1,stage:"waiting_for_uploads",reserved:{storageMiB:expect.any(Number)}}]);
    expect(result.pendingDeletion[0]!.ageSeconds).toBeGreaterThanOrEqual(7200);
    expect((await withSystemTx(pool,tx=>readPendingDeletionCapacity(tx,randomUUID()))).pendingDeletion).toEqual([]);
    await pool.query("UPDATE cloud_workspace_provider_bindings SET deletion_verified_at=now(),observed_state='deleted' WHERE workspace_id=$1",[f.workspaceId]);
    expect((await withSystemTx(pool,tx=>readPendingDeletionCapacity(tx,f.organizationId))).pendingDeletion).toEqual([]);
  });
  const waitingDeletion=async(stage:string,requestedHoursAgo:number)=>{
    // Boat retains a deleted sandbox while it finishes snapshot uploads or
    // serves newer restores; those receipts can complete many hours later.
    const resource=(await pool.query("SELECT provider_resource_id FROM cloud_workspace_provider_bindings WHERE workspace_id=$1",[f.workspaceId])).rows[0].provider_resource_id;
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256,affects_workspace,state,created_at,updated_at,next_attempt_at)
      VALUES($1,$2,1,$3,'delete','synthetic-waiting-retirement',$4,false,'observing',now()-make_interval(hours=>$5),now(),now()+interval '1 minute')`,
    [randomUUID(),f.workspaceId,f.organizationId,randomBytes(32),requestedHoursAgo]);
    await pool.query(`INSERT INTO cloud_workspace_provider_operations(provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256,resource_id,deletion_requested_at,deletion_operation_id)
      VALUES('boat','synthetic',$1,1,$2,'synthetic-waiting',repeat('b',64),$3,now()-make_interval(hours=>$4),'receipt')`,[f.workspaceId,f.organizationId,resource,requestedHoursAgo]);
    await new DatabaseCloudProviderOperationStore(pool,"boat","synthetic").recordDeletionProgress(resource,"receipt",stage);
    await pool.query("UPDATE cloud_workspace_provider_operations SET deletion_progress_at=now()-interval '2 hours' WHERE workspace_id=$1",[f.workspaceId]);
    return new DatabaseCloudWorkspaceHealthService(pool,{setupExecutionEnabled:false,durabilityEnabled:false,outboxDeliveryEnabled:false});
  };
  it.each(["waiting_for_uploads","kept_for_newer_snapshots","waiting_for_restore"])("keeps a provider-reported %s deletion healthy after an hour without stage progress",async stage=>{
    const health=await waitingDeletion(stage,2);
    expect((await health.read()).reasons).not.toContain("deletion_intent_stalled");
  });
  it.each(["waiting_for_uploads","kept_for_newer_snapshots","waiting_for_restore"])("still reports a %s deletion stalled at the 24-hour limit",async stage=>{
    const health=await waitingDeletion(stage,25);
    expect((await health.read()).reasons).toContain("deletion_intent_stalled");
  });
  it("still reports a generic blocked receipt after an hour without progress",async()=>{
    const health=await waitingDeletion("blocked",2);
    expect((await health.read()).reasons).toContain("deletion_intent_stalled");
  });
  it("restricts the cleanup read model to an organization administrator",async()=>{
    const service=new DatabaseCloudWorkspaceManagementService(pool,{} as CloudWorkspaceBackendConfig,{workosEnabled:false});
    expect((await service.pendingDeletionCapacity({organizationId:f.organizationId,actorUserId:f.userId})).pendingDeletion).toEqual([]);
    const other=await seedReadyCloudWorkspace(pool);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')",[f.organizationId,other.userId]);
    await expect(service.pendingDeletionCapacity({organizationId:f.organizationId,actorUserId:other.userId})).rejects.toBeDefined();
  });
});
