import { randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
import type { AuthedUser } from "../auth.js";
import { HttpError } from "../authz.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedFinalSave, seedFinalSaveEngine } from "./final-save-test-fixtures.js";
import { seedReadyCloudWorkspace, seedSupportedCloudWorkspaceGeneration, withCloudFixtureOwnerTx } from "./test-fixtures.js";
import { withSystemTx } from "../db.js";
import { createCloudWorkspaceRoutes } from "./routes.js";
import { CloudWorkspaceCheckpointRequestWorker } from "./checkpoint-requests.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import type { CloudProviderResource,CloudWorkspaceProvider } from "./provider.js";
import { DEFAULT_CLOUD_RUNTIME_RELAY_LIMITS } from "./runtime-bridge-limits.js";

const config:CloudWorkspaceBackendConfig={provider:"boat",apiKey:"fixture-only",apiUrl:"https://api.example.test",target:"fixture",
  snapshotId:"fixture",imageRef:"fixture",architecture:"linux/amd64",cpuMillicores:2000,memoryMiB:4096,storageMiB:20480,
  sourceCommit:"a".repeat(40),operationTimeoutSeconds:30,autoArchiveMinutes:10080,reconcileIntervalMs:1000,
  settingsSecretEncryptionKeys:{},currentSettingsSecretEncryptionKeyVersion:null,settingsSecretKeyV1:null,
  access:{allowedSshHosts:[],allowedPreviewHostSuffixes:[],previewBaseDomain:null},durability:null,outbox:null,setupExecution:null,
  bridge:DEFAULT_CLOUD_RUNTIME_RELAY_LIMITS,runtime:{qualificationMode:"full"}};
const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("server-owned accepted final-save lifecycle",()=>{
  let pool:pg.Pool, f:Awaited<ReturnType<typeof seedFinalSave>>, app:Hono, actor:AuthedUser;
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:6});});
  afterAll(async()=>pool.end());
  beforeEach(async()=>{
    await resetMigratedTestDatabase(pool); f=await seedFinalSave(pool);
    await quota(f.scope.organizationId);
    actor={id:f.fixture.userId} as AuthedUser;
    app=new Hono();app.use("*",async(c,next)=>{c.set("user",actor);await next();});
    app.route("/",createCloudWorkspaceRoutes(pool,config));
    app.onError((error,c)=>{if(error instanceof HttpError)return c.json({error:{code:error.code}},error.status);throw error;});
  });
  const quota = (organizationId: string) => pool.query(`INSERT INTO cloud_workspace_quotas
    (org_id,max_workspaces,max_running_workspaces,max_cpu_millicores,max_memory_mib,max_storage_mib)
    VALUES($1,5,5,10000,20480,102400)`, [organizationId]);
  const url=()=>`/v1/organizations/${f.scope.organizationId}/cloud-workspaces/${f.scope.workspaceId}`;
  const restart=(key=randomUUID(),expectedGeneration=1)=>app.request(`${url()}/restart`,{method:"POST",
    headers:{"idempotency-key":key,"content-type":"application/json"},body:JSON.stringify({version:1,expectedGeneration})});
  const document=async()=> (await (await app.request(`/v1/cloud-workspaces/${f.scope.workspaceId}`)).json()).workspace;
  function provider(){
    let current:CloudProviderResource={resourceId:`sandbox-${f.scope.workspaceId}`,state:"running",workspaceId:f.scope.workspaceId,
      generation:1,target:"fixture",metadata:{}};
    return {name:"boat",find:vi.fn(async()=>[current]),inspect:vi.fn(async()=>current),create:vi.fn(),
      start:vi.fn(async()=>current={...current,state:"running"}),stop:vi.fn(async()=>current={...current,state:"stopped"}),
      archive:vi.fn(),delete:vi.fn(),async *listManaged(){yield current;},verifyManagedResourceOwnership:vi.fn(async()=>true)} satisfies CloudWorkspaceProvider;
  }
  it("projects accepted saving without retiring ready engine authority or exposing failure details",async()=>{
    const before=(await pool.query("SELECT authority_epoch,desired_state,status FROM cloud_workspaces WHERE id=$1",[f.scope.workspaceId])).rows[0];
    await f.send();
    const doc=await document();
    expect(doc).toMatchObject({lifecycleVersion:1,acceptedOperation:{version:1,id:f.intentId,kind:"stop",sourceGeneration:1,phase:"saving",state:"pending"},error:null});
    expect(Object.keys(doc.acceptedOperation).sort()).toEqual(["version","id","kind","sourceGeneration","phase","state"].sort());
    expect((await pool.query("SELECT authority_epoch,desired_state,status FROM cloud_workspaces WHERE id=$1",[f.scope.workspaceId])).rows[0]).toEqual(before);
  });
  it("accepts one replayable Restart pair with an exact stop prerequisite and no early source revocation",async()=>{
    const key=randomUUID(),before=await document();
    const response=await restart(key);expect(response.status).toBe(202);
    const body=await response.json();const operation=body.workspace.acceptedOperation;
    expect(operation).toMatchObject({version:1,kind:"restart",sourceGeneration:1,phase:"saving",state:"pending"});
    expect(body.workspace.version).toBeGreaterThan(before.version);
    expect((await pool.query("SELECT resume_after_intent_id,state FROM cloud_workspace_lifecycle_intents WHERE id=$1",[operation.id])).rows[0])
      .toEqual({resume_after_intent_id:f.intentId,state:"queued"});
    expect((await pool.query("SELECT final_checkpoint_at,revoked_at FROM cloud_workspace_engine_instances WHERE id=$1",[f.scope.engineInstanceId])).rows[0])
      .toEqual({final_checkpoint_at:null,revoked_at:null});
    const replay=await restart(key);expect(replay.status).toBe(200);expect((await replay.json()).workspace.acceptedOperation).toEqual(operation);
    expect((await pool.query("SELECT count(*)::int AS count FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='wake'",[f.scope.workspaceId])).rows[0].count).toBe(1);
  });
  it("keeps Restart pending through attempt expiry and worker restart with no provider start or stop",async()=>{
    expect((await restart()).status).toBe(202);await f.expire();
    await new CloudWorkspaceCheckpointRequestWorker(pool).expireOnce();
    const p=provider();await new CloudWorkspaceReconciler({pool,provider:p,workosEnabled:false}).runOnce(f.scope.workspaceId);
    expect(p.stop).not.toHaveBeenCalled();expect(p.start).not.toHaveBeenCalled();
    expect(await document()).toMatchObject({acceptedOperation:{kind:"restart",phase:"saving",state:"pending"},error:null});
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='wake'",[f.scope.workspaceId])).rows)
      .toEqual([{state:"queued"}]);
  });
  it("allows only saved retirement to release the one dependent wake and keeps readiness distinct from a start receipt",async()=>{
    const response=await restart();expect(response.status).toBe(202);const {workspace}=await response.json();
    const p=provider(), worker=new CloudWorkspaceReconciler({pool,provider:p,workosEnabled:false});
    await worker.runOnce(f.scope.workspaceId);expect(p.stop).not.toHaveBeenCalled();
    const commit=await f.prepareCommit();await commit.run();await worker.runOnce(f.scope.workspaceId);
    expect(p.stop).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1",[f.intentId])).rows[0].state).toBe("succeeded");
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=clock_timestamp() WHERE id=$1",[workspace.acceptedOperation.id]);
    expect(await document()).toMatchObject({acceptedOperation:{id:workspace.acceptedOperation.id,phase:"starting",state:"pending"}});
  });
  it("does not complete Restart from the old source's same-generation ready status", async () => {
    const response=await restart(); const {operation}=await response.json();
    const commit=await f.prepareCommit(); await commit.run();
    await new CloudWorkspaceReconciler({pool,provider:provider(),workosEnabled:false}).runOnce(f.scope.workspaceId);
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=clock_timestamp() WHERE id=$1",[operation.id]);
    await pool.query("UPDATE cloud_workspaces SET status='ready',desired_state='running' WHERE id=$1",[f.scope.workspaceId]);
    expect(await document()).toMatchObject({acceptedOperation:{id:operation.id,phase:"starting",state:"pending"}});
  });
  it("keeps an ordinary wake behind an accepted final Stop while its source still reports ready", async () => {
    const response=await app.request(`${url()}/wake`,{method:"POST",headers:{"idempotency-key":randomUUID()}});
    expect(response.status).toBe(202);const body=await response.json();
    expect((await pool.query("SELECT state,resume_after_intent_id FROM cloud_workspace_lifecycle_intents WHERE id=$1",[body.intent.id])).rows)
      .toEqual([{state:"queued",resume_after_intent_id:f.intentId}]);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1",[f.intentId])).rows[0].state).toBe("queued");
  });
  it("returns the original receipt on replay after a later accepted action replaces the projection", async () => {
    const key=randomUUID(), response=await restart(key), original=await response.json();
    expect(original.operation).toMatchObject({id:original.intent.id,kind:"restart",sourceGeneration:1});
    const archive=await app.request(`${url()}/archive`,{method:"POST",headers:{"idempotency-key":randomUUID()}});
    expect(archive.status).toBe(202);
    const later=await archive.json(), replay=await restart(key);
    expect(replay.status).toBe(200);const body=await replay.json();
    expect(body.operation).toEqual(original.operation);
    expect(body.workspace.acceptedOperation.id).toBe(later.operation.id);
    expect((await restart(key,2)).status).toBe(409);
  });
  it("retains old DELETE serialization while refusing its unsaved discard shortcut",async()=>{
    const response=await app.request(url(),{method:"DELETE",headers:{"idempotency-key":randomUUID(),"content-type":"application/json"},
      body:JSON.stringify({discardUncheckpointed:true})});expect(response.status).toBe(202);
    const body=await response.json();
    expect((await pool.query("SELECT reason,state FROM workspace_checkpoint_requests WHERE lifecycle_intent_id=$1",[body.intent.id])).rows)
      .toEqual([{reason:"before_delete",state:"queued"}]);
    expect((await pool.query("SELECT revoked_at FROM cloud_workspace_engine_instances WHERE id=$1",[f.scope.engineInstanceId])).rows[0].revoked_at).toBeNull();
  });
  it("refuses a stale Restart generation without accepting either action",async()=>{
    expect((await restart(randomUUID(),2)).status).toBe(409);
    expect((await pool.query("SELECT id FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='wake'",[f.scope.workspaceId])).rowCount).toBe(0);
  });
  it("refuses an unrelated second Restart while the accepted pair is pending",async()=>{
    expect((await restart()).status).toBe(202);expect((await restart()).status).toBe(409);
    expect((await pool.query("SELECT id FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='wake'",[f.scope.workspaceId])).rowCount).toBe(1);
  });

  it("completes only after a fresh post-stop enrollment is interactively ready", async () => {
    const { operation } = await (await restart()).json();
    await (await f.prepareCommit()).run();
    await new CloudWorkspaceReconciler({ pool, provider: provider(), workosEnabled: false }).runOnce(f.scope.workspaceId);
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=clock_timestamp() WHERE id=$1", [operation.id]);
    await pool.query("UPDATE cloud_workspaces SET status='ready',desired_state='running' WHERE id=$1", [f.scope.workspaceId]);
    const source = await withSystemTx(pool, tx => seedFinalSaveEngine(tx, { ...f.scope, userId: f.fixture.userId, setupAttempt: 2 }));
    await pool.query(`UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=1,
      accepted_work_version=1,coordinator_version=1 WHERE id=$1`, [source.engineInstanceId]);
    expect(await document()).toMatchObject({ acceptedOperation: { id: operation.id, state: "pending", phase: "starting" } });
    await pool.query(`UPDATE cloud_workspace_engine_instances SET interactive_frontend_id=$2,
      interactive_ready_until=clock_timestamp()+interval '30 seconds' WHERE id=$1`, [source.engineInstanceId, randomUUID()]);
    expect(await document()).toMatchObject({ acceptedOperation: { id: operation.id, state: "completed", phase: "completed" } });
    await pool.query("UPDATE cloud_workspace_engine_instances SET interactive_ready_until=clock_timestamp()-interval '1 second' WHERE id=$1", [source.engineInstanceId]);
    expect(await document()).toMatchObject({ acceptedOperation: { id: operation.id, state: "pending", phase: "starting" } });
  });

  it.each([true, false])("rolls back both sides of Restart when wake insertion fails (existing Stop=%s)", async existingStop => {
    const target = existingStop ? f.fixture : await seedReadyCloudWorkspace(pool, { ownerUserId: f.fixture.userId });
    if (!existingStop) await quota(target.organizationId);
    const before = (await pool.query("SELECT id,affects_workspace FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 ORDER BY id", [target.workspaceId])).rows;
    const documentBefore = (await pool.query("SELECT accepted_lifecycle_intent_id,version,authority_epoch FROM cloud_workspaces WHERE id=$1", [target.workspaceId])).rows;
    await pool.query(`CREATE FUNCTION fixture_restart_insert_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic_restart_insert'; END $$;
      CREATE TRIGGER fixture_restart_insert_failure BEFORE INSERT ON cloud_workspace_lifecycle_intents
        FOR EACH ROW WHEN (NEW.restart_version=1) EXECUTE FUNCTION fixture_restart_insert_failure()`);
    await expect(app.request(`/v1/organizations/${target.organizationId}/cloud-workspaces/${target.workspaceId}/restart`, {
      method: "POST", headers: { "idempotency-key": randomUUID(), "content-type": "application/json" },
      body: JSON.stringify({ version: 1, expectedGeneration: 1 }),
    })).rejects.toThrow("synthetic_restart_insert");
    expect((await pool.query("SELECT id,affects_workspace FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 ORDER BY id", [target.workspaceId])).rows).toEqual(before);
    expect((await pool.query("SELECT accepted_lifecycle_intent_id,version,authority_epoch FROM cloud_workspaces WHERE id=$1", [target.workspaceId])).rows).toEqual(documentBefore);
  });

  it.each(["rights", "funding", "quota", "policy", "quarantine"] as const)("rechecks current %s before first Restart admission", async restriction => {
    if (restriction === "rights") {
      const actorId = randomUUID();
      await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Guest')", [actorId, `${actorId}@example.test`]);
      await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [f.scope.organizationId,actorId]);
      await pool.query("INSERT INTO cloud_workspace_members(workspace_id,org_id,user_id,role) VALUES($1,$2,$3,'prompter')", [f.scope.workspaceId,f.scope.organizationId,actorId]);
      actor = { id: actorId } as AuthedUser;
    } else if (restriction === "funding") {
      await pool.query("UPDATE users SET staff_role=NULL WHERE id=$1", [f.fixture.userId]);
      await pool.query("UPDATE account_entitlements SET status='expired',revision=revision+1 WHERE user_id=$1", [f.fixture.userId]);
      await pool.query("UPDATE organization_entitlements SET status='expired',revision=revision+1 WHERE org_id=$1", [f.scope.organizationId]);
    } else if (restriction === "quota") {
      await pool.query("DELETE FROM cloud_workspace_quotas WHERE org_id=$1", [f.scope.organizationId]);
    } else if (restriction === "policy") {
      await pool.query("INSERT INTO organization_cloud_policy_versions(org_id,version,document,created_by) VALUES($1,1,'{}',$2)", [f.scope.organizationId,f.fixture.userId]);
      await pool.query("INSERT INTO organization_cloud_policy_heads(org_id,current_version) VALUES($1,1)", [f.scope.organizationId]);
    } else {
      await pool.query(`UPDATE cloud_computer_templates SET state='quarantined' WHERE build_id IN
        (SELECT build_id FROM cloud_workspace_computer_sources WHERE workspace_id=$1)`, [f.scope.workspaceId]);
    }
    expect((await restart()).status).toBeGreaterThanOrEqual(400);
    expect((await pool.query("SELECT id FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND restart_version=1", [f.scope.workspaceId])).rowCount).toBe(0);
  });

  it("keeps the exact replay receipt across generation change and checks current membership before replay", async () => {
    const key = randomUUID(), { operation } = await (await restart(key)).json();
    await (await f.prepareCommit()).run();
    await new CloudWorkspaceReconciler({ pool, provider: provider(), workosEnabled: false }).runOnce(f.scope.workspaceId);
    await withCloudFixtureOwnerTx(pool, async tx => {
      await seedSupportedCloudWorkspaceGeneration(tx, { workspaceId: f.scope.workspaceId, organizationId: f.scope.organizationId, ownerUserId: f.fixture.userId, generation: 2 });
      await tx.query(`INSERT INTO cloud_workspace_provider_bindings(workspace_id,org_id,generation,provider,provider_resource_id,observed_state)
        VALUES($1,$2,2,'boat','replacement-fixture','running')`, [f.scope.workspaceId,f.scope.organizationId]);
      await tx.query("UPDATE cloud_workspaces SET current_generation=2 WHERE id=$1", [f.scope.workspaceId]);
    });
    const replay = await restart(key); expect(replay.status).toBe(200);
    const body = await replay.json(); expect(body.operation).toEqual(operation);
    expect(body.workspace.generation.number).toBe(2); expect(body.workspace.acceptedOperation).toBeUndefined();
    expect((await restart(key,2)).status).toBe(409);
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.scope.organizationId,f.fixture.userId]);
    expect((await restart(key)).status).toBeGreaterThanOrEqual(400);
  });
});
