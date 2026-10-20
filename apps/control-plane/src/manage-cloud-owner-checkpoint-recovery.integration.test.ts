import pg from "pg";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "./test-database.js";
import { withSystemTx } from "./db.js";
import { manageCloudOwnerCheckpointRecovery } from "./manage-cloud-owner-checkpoint-recovery.js";
import { seedOwnerCheckpointRecovery, ownerRecoveryConfig } from "./cloud-workspaces/owner-checkpoint-recovery-test-fixtures.js";
import { requireCloudRecoveryAdmission } from "./cloud-workspaces/automatic-recovery.js";
import { completeCloudWorkspaceGenerationTransition, rollbackCloudWorkspaceGenerationTransition,
  cancelCloudWorkspaceGenerationTransition } from "./cloud-workspaces/generation-transitions.js";
import { runFinalSaveRecovery } from "./cloud-workspaces/final-save-service.js";
import { readLifecycleDueInMs } from "./cloud-workspaces/lifecycle-jobs.js";
import { DatabaseCloudWorkspaceHealthService } from "./cloud-workspaces/health.js";
import { seedFinalSave, seedFinalSaveEngine, commitFinalSaveFixture } from "./cloud-workspaces/final-save-test-fixtures.js";
import type { CloudOwnerCheckpointRecoveryRequest } from "./cloud-owner-checkpoint-recovery-contract.js";
import { loadConfig } from "./config.js";
import { DatabaseCloudWorkspaceContentService } from "./cloud-workspaces/content-record.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("owner-attested checkpoint recovery", () => {
  let pool: pg.Pool, f: Awaited<ReturnType<typeof seedOwnerCheckpointRecovery>>;
  beforeAll(() => { pool = new pg.Pool({ connectionString:process.env.TEST_DATABASE_URL,max:5 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => { await resetMigratedTestDatabase(pool); f = await seedOwnerCheckpointRecovery(pool); });
  const options = () => ({ databaseUrl:process.env.TEST_DATABASE_URL!,config:ownerRecoveryConfig,workosEnabled:false });
  async function execute() {
    const plan=await manageCloudOwnerCheckpointRecovery(pool,f.requestInput,options());
    return manageCloudOwnerCheckpointRecovery(pool,f.requestInput,{...options(),execute:true,approval:plan.approval});
  }
  const recoveryCount=async () => (await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_discard_receipts")).rows[0].n;

  it("keeps ordinary recovery blocked after provider loss without an owner discard", async () => {
    await expect(withSystemTx(pool,tx => requireCloudRecoveryAdmission(tx, { workspaceId:f.scope.workspaceId,
      organizationId:f.scope.organizationId,sourceGeneration:1,checkpointId:f.checkpointId,actorUserId:f.fixture.userId,
      workosEnabled:false,allowDataLoss:true }))).rejects.toMatchObject({code:"cloud_workspace_lifecycle_active"});
  });

  it("defaults to a mutation-free exact plan while retaining failed-save custody", async () => {
    const recovery = await f.row();
    const workspace = (await pool.query("SELECT * FROM cloud_workspaces WHERE id=$1", [f.scope.workspaceId])).rows[0];
    const plan = await manageCloudOwnerCheckpointRecovery(pool,f.requestInput,options());
    expect(plan).toMatchObject({ state:"planned",receiptId:f.requestInput.operationId,transitionId:null,candidateGeneration:2 });
    expect(plan.approval).toMatch(/^owner-checkpoint-recovery:v1:[a-f0-9]{64}$/);
    expect(await f.row()).toEqual(recovery);
    expect((await pool.query("SELECT * FROM cloud_workspaces WHERE id=$1", [f.scope.workspaceId])).rows[0]).toEqual(workspace);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_generation_transitions")).rows[0].n).toBe(0);
  });

  it("discards only the exact failed Stop and Wake and pins the chosen checkpoint to the current Computer once", async () => {
    const recovery = await f.row();
    const original = (await pool.query("SELECT * FROM workspace_checkpoint_requests WHERE id=$1", [f.request.id])).rows[0];
    const plan = await manageCloudOwnerCheckpointRecovery(pool,f.requestInput,options());
    const result = await manageCloudOwnerCheckpointRecovery(pool,f.requestInput,{...options(),execute:true,approval:plan.approval});
    expect(result).toMatchObject({state:"restoring",receiptId:f.requestInput.operationId,candidateGeneration:2,transitionId:expect.any(String)});
    expect((await pool.query("SELECT operation,state FROM cloud_workspace_lifecycle_intents WHERE id=ANY($1::uuid[]) ORDER BY operation", [[f.intentId,f.wakeId]])).rows)
      .toEqual([{operation:"stop",state:"superseded"},{operation:"wake",state:"superseded"}]);
    expect(await f.row()).toEqual({...recovery,state:"discarded",next_attempt_at:Infinity});
    expect((await pool.query("SELECT * FROM workspace_checkpoint_requests WHERE id=$1", [f.request.id])).rows[0]).toEqual(original);
    expect((await pool.query("SELECT cloud_final_save_proven($1) AS proven", [f.intentId])).rows[0].proven).toBe(false);
    expect((await pool.query("SELECT runtime_id,recovery_checkpoint_id FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=2", [f.scope.workspaceId])).rows)
      .toEqual([{runtime_id:f.computer.runtimeId,recovery_checkpoint_id:f.checkpointId}]);
    expect((await pool.query("SELECT build_id,config_id FROM cloud_workspace_computer_sources WHERE workspace_id=$1 AND generation=2", [f.scope.workspaceId])).rows)
      .toEqual([{build_id:f.computer.buildId,config_id:f.computer.configId}]);
    expect((await pool.query("SELECT current_generation,accepted_lifecycle_intent_id FROM cloud_workspaces WHERE id=$1", [f.scope.workspaceId])).rows[0])
      .toEqual({current_generation:2,accepted_lifecycle_intent_id:null});
    expect(await manageCloudOwnerCheckpointRecovery(pool,f.requestInput,{...options(),execute:true,approval:plan.approval}))
      .toEqual({...result,state:"unchanged"});
  });

  it.each(["organizationId","workspaceId","ownerUserId","stopIntentId","wakeIntentId","recoveryId","requestId","retirementId",
    "custodyId","providerLossAttestationId","checkpointId","computerBuildId","computerConfigId"] as const)("refuses a foreign %s without mutation", async key => {
    await expect(manageCloudOwnerCheckpointRecovery(pool,{...f.requestInput,[key]:randomUUID()},options())).rejects.toThrow();
    expect(await recoveryCount()).toBe(0);
    expect((await pool.query("SELECT current_generation FROM cloud_workspaces WHERE id=$1", [f.scope.workspaceId])).rows[0].current_generation).toBe(1);
  });

  it.each([
    {sourceGeneration:2},{providerResourceId:"bx_thr9q3w7"},{providerAccountScope:"foreign-account"},
    {checkpointContentRevision:2},{checkpointRecordRevision:99},{checkpointSha256:"0".repeat(64)},
    {checkpointAt:"2020-01-01T00:00:00.000Z"},{runtimeId:`r1-${"0".repeat(64)}`},
  ] as const)("refuses changed exact pins %j", async change => {
    await expect(manageCloudOwnerCheckpointRecovery(pool,{...f.requestInput,...change},options())).rejects.toThrow();
    expect(await recoveryCount()).toBe(0);
  });

  it.each(["reason","ownerApprovalReference","operationId","target"])("refuses execution after the approved %s changes", async key => {
    const plan=await manageCloudOwnerCheckpointRecovery(pool,f.requestInput,options());
    const changed:CloudOwnerCheckpointRecoveryRequest={...f.requestInput,...(key==="reason" ? {reason:"A changed reason cannot borrow the previous approval"} :
      key==="ownerApprovalReference" ? {ownerApprovalReference:"A different owner acknowledgement is not approved"} : key==="operationId" ? {operationId:randomUUID()} : {})};
    const config={...options(),execute:true,approval:plan.approval,...(key==="target" ? {databaseUrl:options().databaseUrl.replace("127.0.0.1","localhost")} : {})};
    await expect(manageCloudOwnerCheckpointRecovery(pool,changed,config)).rejects.toMatchObject({code:"owner_recovery_approval_mismatch"});
    expect(await recoveryCount()).toBe(0);
  });

  it("refuses an execution without an exact approval even for a platform owner", async () => {
    await expect(manageCloudOwnerCheckpointRecovery(pool,f.requestInput,{...options(),execute:true})).rejects.toMatchObject({code:"owner_recovery_approval_mismatch"});
    expect(await recoveryCount()).toBe(0);
  });

  it("does not admit an application-role operator or an inactive platform owner", async () => {
    const appPool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:"-c role=zeros_app",max:1});
    try { await expect(manageCloudOwnerCheckpointRecovery(appPool,f.requestInput,options())).rejects.toMatchObject({code:"owner_recovery_database_owner_required"}); }
    finally { await appPool.end(); }
    await pool.query("UPDATE users SET staff_role='developer' WHERE id=$1",[f.fixture.userId]);
    await expect(manageCloudOwnerCheckpointRecovery(pool,f.requestInput,options())).rejects.toMatchObject({code:"owner_recovery_operator_required"});
    expect(await recoveryCount()).toBe(0);
  });

  it("refuses a reappearing live source after planning without revoking it", async () => {
    const plan=await manageCloudOwnerCheckpointRecovery(pool,f.requestInput,options());
    await pool.query("UPDATE cloud_workspace_engine_instances SET lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1",[f.scope.engineInstanceId]);
    await expect(manageCloudOwnerCheckpointRecovery(pool,f.requestInput,{...options(),execute:true,approval:plan.approval}))
      .rejects.toMatchObject({code:"owner_recovery_source_changed_or_live"});
    expect((await pool.query("SELECT revoked_at FROM cloud_workspace_engine_instances WHERE id=$1",[f.scope.engineInstanceId])).rows[0].revoked_at).toBeNull();
    expect(await recoveryCount()).toBe(0);
  });

  it("refuses a candidate with new in-flight work after planning", async () => {
    const plan=await manageCloudOwnerCheckpointRecovery(pool,f.requestInput,options());
    await pool.query(`UPDATE cloud_workspace_setup_runs SET state='running',completed_at=NULL,lease_owner='new-work',
      lease_expires_at=clock_timestamp()+interval '1 minute' WHERE workspace_id=$1`,[f.scope.workspaceId]);
    await expect(manageCloudOwnerCheckpointRecovery(pool,f.requestInput,{...options(),execute:true,approval:plan.approval}))
      .rejects.toMatchObject({code:"owner_recovery_work_in_flight"});
    expect(await recoveryCount()).toBe(0);
  });

  it("serializes concurrent execution and never replays a changed operation body", async () => {
    const plan=await manageCloudOwnerCheckpointRecovery(pool,f.requestInput,options());
    const results=await Promise.all([1,2].map(()=>manageCloudOwnerCheckpointRecovery(pool,f.requestInput,{...options(),execute:true,approval:plan.approval})));
    expect(results.map(result=>result.state).sort()).toEqual(["restoring","unchanged"]);
    expect(new Set(results.map(result=>result.transitionId)).size).toBe(1);
    await expect(manageCloudOwnerCheckpointRecovery(pool,{...f.requestInput,reason:"Changed input must not replay an existing receipt"},
      {...options(),execute:true,approval:plan.approval})).rejects.toMatchObject({code:"owner_recovery_replay_mismatch"});
    expect(await recoveryCount()).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_generation_transitions")).rows[0].n).toBe(1);
  });

  it("removes only the discarded failure from retry and operator alerts and retains immutable custody", async () => {
    await f.due();
    const recovery=await f.row();
    await execute();
    expect(await runFinalSaveRecovery(pool,f.scope.workspaceId,false)).toBe(0);
    expect(await readLifecycleDueInMs(pool,"finalSave",f.scope.workspaceId,{provider:"boat",driftIntervalMs:1000})).toBeNull();
    expect((await new DatabaseCloudWorkspaceHealthService(pool,{setupExecutionEnabled:false,durabilityEnabled:true,outboxDeliveryEnabled:false}).read()).reasons
      .filter(reason=>reason.startsWith("final_save_"))).toEqual([]);
    await pool.query("UPDATE cloud_workspace_final_save_recoveries SET last_failure='authority',retry_count=1000 WHERE lifecycle_intent_id=$1",[f.intentId]);
    expect(await f.row()).toEqual({...recovery,state:"discarded",next_attempt_at:Infinity});
    await expect(withSystemTx(pool,async tx=>{await tx.query("SET LOCAL ROLE zeros_app");
      return tx.query("UPDATE cloud_workspace_owner_discard_receipts SET reason='Application cannot alter owner disposition'");}))
      .rejects.toMatchObject({code:"42501"});
    await expect(pool.query("UPDATE cloud_workspace_owner_discard_receipts SET reason='Owner cannot rewrite an immutable receipt'"))
      .rejects.toMatchObject({code:"55000"});
    await expect(pool.query("DELETE FROM cloud_workspace_owner_discard_receipts")).rejects.toMatchObject({code:"55000"});
  });

  it.each(["blocked","retrying"])("retires the discarded %s failure for deployed health and due readers without inventing proof", async state => {
    await f.due();
    await pool.query("UPDATE cloud_workspace_final_save_recoveries SET state=$2 WHERE lifecycle_intent_id=$1",[f.intentId,state]);
    const legacySignals = async () => (await pool.query(`SELECT
      EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries WHERE state='blocked') AS blocked,
      EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries WHERE failure_started_at IS NOT NULL
        AND state IN ('capturing','retrying','reconciling')) AS retrying,
      EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries WHERE state NOT IN ('proven','resolved')
        AND next_attempt_at<clock_timestamp()-interval '5 minutes') AS stalled,
      EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries WHERE state NOT IN ('proven','resolved')
        AND next_attempt_at<=clock_timestamp()) AS due,
      EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents WHERE state IN ('queued','observing','dispatching')
        AND generation=1 AND workspace_id=$1) AS active`, [f.scope.workspaceId])).rows[0];
    expect(await legacySignals()).toMatchObject({ blocked:state==="blocked",retrying:state==="retrying",due:true,active:true });
    await execute();
    expect(await legacySignals()).toEqual({ blocked:false,retrying:false,stalled:false,due:false,active:false });
    expect((await pool.query(`SELECT state,next_attempt_at='infinity'::timestamptz AS no_retry,
      checkpoint_id,proven_request_id FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1`,[f.intentId])).rows[0])
      .toEqual({state:"discarded",no_retry:true,checkpoint_id:null,proven_request_id:null});
  });

  it("refuses discarded state without an exact owner-only receipt", async () => {
    await expect(pool.query("UPDATE cloud_workspace_final_save_recoveries SET state='discarded' WHERE lifecycle_intent_id=$1",[f.intentId]))
      .rejects.toMatchObject({code:"23514"});
    expect((await f.row()).state).toBe("retrying");
  });

  it("clears both release health reasons only for the exact discarded restart", async () => {
    const health = new DatabaseCloudWorkspaceHealthService(pool,{setupExecutionEnabled:false,durabilityEnabled:true,outboxDeliveryEnabled:false});
    await pool.query(`UPDATE cloud_workspace_lifecycle_intents SET updated_at=clock_timestamp()-interval '16 minutes',
      next_attempt_at=clock_timestamp()-interval '16 minutes' WHERE id=ANY($1::uuid[])`,[[f.intentId,f.wakeId]]);
    await pool.query("UPDATE cloud_workspace_final_save_recoveries SET state='blocked' WHERE lifecycle_intent_id=$1",[f.intentId]);
    const reasons = async () => (await health.read()).reasons.filter(reason => ["lifecycle_stalled","final_save_blocked"].includes(reason)).sort();
    expect(await reasons()).toEqual(["final_save_blocked","lifecycle_stalled"]);
    await execute();
    expect(await reasons()).toEqual([]);
    const other=await seedFinalSave(pool);
    await pool.query(`UPDATE cloud_workspace_lifecycle_intents SET updated_at=clock_timestamp()-interval '16 minutes',
      next_attempt_at=clock_timestamp()-interval '16 minutes' WHERE id=$1`,[other.intentId]);
    await pool.query("UPDATE cloud_workspace_final_save_recoveries SET state='blocked' WHERE lifecycle_intent_id=$1",[other.intentId]);
    expect(await reasons()).toEqual(["final_save_blocked","lifecycle_stalled"]);
  });

  it("runs the real manage CLI as the stable migration owner with one private request and exact replay", async () => {
    const directory=await mkdtemp(path.join(tmpdir(),"owner-recovery-cli-"));
    const suffix=randomUUID().replaceAll("-","");
    const ownerRole=`w3_owner_${suffix}`,loginRole=`w3_login_${suffix}`;
    const principal=(await pool.query("SELECT current_user AS name")).rows[0].name as string;
    await pool.query(`CREATE ROLE ${ownerRole} NOLOGIN; CREATE ROLE ${loginRole} LOGIN NOINHERIT;
      GRANT ${ownerRole} TO ${loginRole}; GRANT USAGE ON SCHEMA public TO ${ownerRole};
      GRANT ALL ON ALL TABLES IN SCHEMA public TO ${ownerRole};
      GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${ownerRole};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${ownerRole};
      ALTER TABLE cloud_workspace_owner_discard_receipts OWNER TO ${ownerRole}`);
    try {
      const filename=path.join(directory,"request.json");
      await writeFile(filename,JSON.stringify({...f.requestInput,channel:"development"}),{mode:0o600});
      const databaseUrl=new URL(process.env.TEST_DATABASE_URL!);databaseUrl.username=loginRole;
      const env:NodeJS.ProcessEnv={PATH:process.env.PATH,NODE_ENV:"test",DATABASE_URL:databaseUrl.toString(),
        DATABASE_MIGRATION_ROLE:ownerRole,AUTH0_DOMAIN:"tenant.example.test",AUTH_AUDIENCE:"https://api.example.test",
        GITHUB_APP_ID:"123",GITHUB_APP_CLIENT_ID:"fixture-client",GITHUB_APP_CLIENT_SECRET:"fixture-secret",
        GITHUB_OAUTH_CALLBACK_URL:"https://api.example.test/v1/github/oauth/callback",
        GITHUB_APP_WEBHOOK_SECRET:"fixture-webhook",GITHUB_APP_SLUG:"fixture-app",
        GITHUB_APP_PRIVATE_KEY:generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({type:"pkcs8",format:"pem"}).toString(),
        CLOUD_WORKSPACES_ENABLED:"true",CLOUD_WORKSPACE_PROVIDER:"boat",BOAT_API_KEY:"fixture-provider",
        BOAT_ACCOUNT_SCOPE:ownerRecoveryConfig.boat!.accountScope,BOAT_BILLING_ORG:ownerRecoveryConfig.boat!.billingOrg,
        BOAT_SNAPSHOT_ID:"fixture-immutable-v1",BOAT_IMAGE_BUILD_SHA256:"c".repeat(64),BOAT_TTL_SECONDS:"3600",
        BOAT_COMPUTE_POLICY_ID:"fixture-v1",BOAT_SECONDS_PER_DOLLAR:"100000",CLOUD_WORKSPACE_STORAGE_MIB:"40960",
        ZEROS_CLOUD_SOURCE_COMMIT:"a".repeat(40),CONTROL_PLANE_OWNER_RECOVERY_REQUEST_FILE:filename};
      expect(loadConfig(env).cloudWorkspaces?.provider).toBe("boat");
      const invoke=(execute=false,approval?:string)=>JSON.parse(execFileSync(process.execPath,
        ["--import","tsx",fileURLToPath(new URL("./manage-cloud-owner-checkpoint-recovery.ts",import.meta.url)),...(execute?["--execute"]:[])],
        {env:{...env,...(approval?{CONTROL_PLANE_OWNER_RECOVERY_APPROVAL:approval}:{})},encoding:"utf8",timeout:15_000}));
      const plan=invoke();
      expect(plan.state).toBe("planned");
      expect(await recoveryCount()).toBe(0);
      const accepted=invoke(true,plan.approval);
      expect(accepted.state).toBe("restoring");
      expect(invoke(true,plan.approval)).toEqual({...accepted,state:"unchanged"});
    } finally {
      await pool.query(`ALTER TABLE cloud_workspace_owner_discard_receipts OWNER TO "${principal.replaceAll('"','""')}";
        DROP OWNED BY ${ownerRole}; DROP ROLE ${loginRole}; DROP ROLE ${ownerRole}`);
      await rm(directory,{recursive:true,force:true});
    }
  });

  it("keeps both exact intents retired under stale-worker writes without authorizing dispatch", async () => {
    await execute();
    for (const state of ["queued","succeeded","failed"] as const) {
      await pool.query(`UPDATE cloud_workspace_lifecycle_intents SET state=$2::cloud_workspace_intent_state,completed_at=CASE WHEN $2::text='queued' THEN NULL ELSE now() END
        WHERE id=ANY($1::uuid[])`,[[f.intentId,f.wakeId],state]);
      expect((await pool.query("SELECT DISTINCT state FROM cloud_workspace_lifecycle_intents WHERE id=ANY($1::uuid[])",[[f.intentId,f.wakeId]])).rows)
        .toEqual([{state:"superseded"}]);
    }
    await expect(pool.query(`UPDATE cloud_workspace_lifecycle_intents SET state='dispatching',completed_at=NULL,
      lease_owner='stale-worker',lease_expires_at=now()+interval '1 minute' WHERE id=$1`,[f.intentId])).rejects.toMatchObject({code:"40001"});
    await expect(pool.query(`INSERT INTO workspace_checkpoint_requests(id,workspace_id,org_id,generation,reason,state,idempotency_key,
      final_save_recovery_id,final_save_attempt_ordinal,deadline_at) VALUES($1,$2,$3,1,'before_stop','recovery_queued',$4,$5,1,now()+interval '5 minutes')`,
    [randomUUID(),f.scope.workspaceId,f.scope.organizationId,randomUUID(),f.intentId])).rejects.toMatchObject({code:"40001"});
    expect((await pool.query("SELECT cloud_final_save_proven($1) AS proven",[f.intentId])).rows[0].proven).toBe(false);
  });

  it("does not queue another unsavable source Delete after candidate readiness", async () => {
    const accepted=await execute();
    expect(await withSystemTx(pool,tx=>completeCloudWorkspaceGenerationTransition(tx,{...f.scope,generation:2}))).toBe("candidate_succeeded");
    expect((await pool.query("SELECT state FROM cloud_workspace_generation_transitions WHERE id=$1",[accepted.transitionId])).rows[0].state).toBe("succeeded");
    expect((await pool.query("SELECT 1 FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND generation=1 AND operation='delete'",[f.scope.workspaceId])).rows).toEqual([]);
    // An N-1 completion writer still cannot create its redundant cleanup.
    expect((await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,operation,idempotency_key,request_sha256,affects_workspace,generation_transition_id)
      VALUES($1::uuid,$2,$3,1,'delete',$1::text,digest($1::text,'sha256'),false,$4) RETURNING id`,
    [randomUUID(),f.scope.workspaceId,f.scope.organizationId,accepted.transitionId])).rows).toEqual([]);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_final_save_recoveries WHERE workspace_id=$1",[f.scope.workspaceId])).rows[0].n).toBe(1);
  });

  it("allows later saved Delete history only after the replacement generation has its own final proof", async () => {
    await execute();
    await withSystemTx(pool,tx=>completeCloudWorkspaceGenerationTransition(tx,{...f.scope,generation:2}));
    await pool.query(`UPDATE cloud_workspace_provider_bindings SET provider_resource_id='bx_23456789',observed_state='running'
      WHERE workspace_id=$1 AND generation=2`,[f.scope.workspaceId]);
    const source=await withSystemTx(pool,tx=>seedFinalSaveEngine(tx,{...f.fixture,generation:2}));
    await pool.query("UPDATE cloud_workspaces SET status='ready',desired_state='running' WHERE id=$1",[f.scope.workspaceId]);
    const saved=(await pool.query("SELECT manifest_blob_id FROM workspace_checkpoints WHERE id=$1",[f.checkpointId])).rows[0];
    await new DatabaseCloudWorkspaceContentService({pool,workosEnabled:false}).append({...source,expectedRevision:1,
      idempotencyKey:randomUUID(),gitBaseCommit:"a".repeat(40),gitHeadRef:null,
      mutations:[{path:"after-recovery.txt",operation:"upsert",entryType:"file",mode:33188,blobId:saved.manifest_blob_id,
        contentSha256:f.requestInput.checkpointSha256,sizeBytes:5}]});
    const intentId=randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256)
      VALUES($1::uuid,$2,$3,2,$4,'delete',$1::text,digest($1::text,'sha256'))`,
    [intentId,f.scope.workspaceId,f.scope.organizationId,f.fixture.userId]);
    const claimable=async()=>(await pool.query("SELECT cloud_final_save_deletion_claimable($1,$2) AS allowed",[f.scope.workspaceId,f.scope.organizationId])).rows[0].allowed;
    expect(await claimable()).toBe(false);
    await commitFinalSaveFixture(pool,source,{intentId,userId:f.fixture.userId,reason:"before_delete"});
    expect(await claimable()).toBe(true);
    expect((await pool.query("SELECT cloud_final_save_proven($1) AS proven",[f.intentId])).rows[0].proven).toBe(false);
  });

  it.each(["rollback","cancel"] as const)("quarantines the lost source on candidate %s without granting a source wake", async mode => {
    const accepted=await execute();
    await withSystemTx(pool,tx=>mode==="rollback"
      ? rollbackCloudWorkspaceGenerationTransition(tx,{...f.scope,candidateGeneration:2,errorCode:"setup_failed",errorMessage:"Synthetic candidate failure"})
      : cancelCloudWorkspaceGenerationTransition(tx,{...f.scope,reason:"workspace_stop_requested"}));
    expect((await pool.query("SELECT state FROM cloud_workspace_generation_transitions WHERE id=$1",[accepted.transitionId])).rows[0].state)
      .toBe(mode==="rollback" ? "rollback_failed" : "cancelled");
    expect((await pool.query(`SELECT 1 FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND generation=1
      AND state IN ('queued','observing','dispatching')`,[f.scope.workspaceId])).rows).toEqual([]);
    expect((await pool.query(`SELECT cloud_workspace_generation_quarantined($1,1,$2) AS quarantined,
      cloud_final_save_proven($3) AS proven,cloud_final_save_deletion_claimable($1,$2) AS erasable`,
    [f.scope.workspaceId,f.scope.organizationId,f.intentId])).rows[0]).toEqual({quarantined:true,proven:false,erasable:false});
  });

  it("keeps every other workspace's unsaved Stop and erasure gates intact", async () => {
    const other=await seedFinalSave(pool);
    await execute();
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='superseded',completed_at=now() WHERE id=$1",[other.intentId]);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1",[other.intentId])).rows[0].state).toBe("queued");
    await expect(pool.query(`UPDATE cloud_workspace_lifecycle_intents SET state='dispatching',lease_owner='other',
      lease_expires_at=now()+interval '1 minute' WHERE id=$1`,[other.intentId])).rejects.toMatchObject({code:"40001"});
    expect((await pool.query("SELECT cloud_final_save_deletion_claimable($1,$2) AS erasable",[other.scope.workspaceId,other.scope.organizationId])).rows[0].erasable).toBe(false);
  });
});
