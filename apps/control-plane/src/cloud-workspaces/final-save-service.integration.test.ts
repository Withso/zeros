import { createHash,randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { withSystemTx } from "../db.js";
import { seedFinalSave, seedFinalSaveEngine, sealFinalSaveFixture, commitFinalSaveFixture } from "./final-save-test-fixtures.js";
import { finalSaveProven } from "./final-save-recovery.js";
import { CloudFinalSaveRejected,DatabaseCloudFinalSaveService,runFinalSaveRecovery } from "./final-save-service.js";
import { DatabaseCloudWorkspaceContentService } from "./content-record.js";
import { ensureCloudPilotUser } from "./test-fixtures.js";
import { deliverWorkspaceCheckpointRequest, enqueueWorkspaceCheckpointRequest, loadCommittedFinalCheckpoint } from "./checkpoint-requests.js";
import * as runtimeSelection from "./runtime-selection.js";
import { createCloudWorkspaceInternalRoutes,CLOUD_WORKSPACE_CHECKPOINT_COMMIT_PATH } from "./internal-routes.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("finite final-save attempts with durable recovery",()=>{
  let pool:pg.Pool, f:Awaited<ReturnType<typeof seedFinalSave>>;
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:6});});
  afterAll(async()=>{await pool.end();});
  afterEach(()=>vi.restoreAllMocks());
  beforeEach(async()=>{await resetMigratedTestDatabase(pool);f=await seedFinalSave(pool);});
  it("saves a fresh enrollment in the same generation while retaining its earlier sealed writer", async () => {
    await (await f.prepareCommit()).run();
    expect(await withSystemTx(pool, tx => finalSaveProven(tx, f.intentId))).toBe(true);
    const source = await withSystemTx(pool, async tx => {
      await tx.query("UPDATE cloud_workspace_local_command_writers SET state='retired',retired_at=clock_timestamp() WHERE writer_epoch=$1", [f.writerEpoch]);
      await tx.query("UPDATE cloud_agent_boot_bindings SET retired_at=clock_timestamp() WHERE id=$1", [f.bindingId]);
      await tx.query("UPDATE cloud_workspace_engine_instances SET revoked_at=clock_timestamp(),state='revoked' WHERE id=$1", [f.scope.engineInstanceId]);
      return seedFinalSaveEngine(tx, { ...f.scope, userId: f.fixture.userId, setupAttempt: 2 });
    });
    const writerEpoch=randomUUID(), bindingId=randomUUID();
    await withSystemTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_workspace_local_command_writers(workspace_id,org_id,generation,engine_instance_id,
        boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch)
        SELECT workspace_id,org_id,generation,id,runtime_boot_id,$2,account_user_id,1 FROM cloud_workspace_engine_instances WHERE id=$1`,
      [source.engineInstanceId,writerEpoch]);
      await tx.query(`INSERT INTO cloud_agent_boot_bindings(id,workspace_id,org_id,generation,engine_instance_id,boot_id,
        writer_epoch,funding_owner_user_id,funding_owner_epoch,credentials_initialized,initial_adoptions)
        SELECT $1,workspace_id,org_id,generation,id,runtime_boot_id,$3,account_user_id,1,true,
          '[{"provider":"claude","status":"missing"},{"provider":"codex","status":"missing"},{"provider":"cursor","status":"missing"}]'
        FROM cloud_workspace_engine_instances WHERE id=$2`, [bindingId,source.engineInstanceId,writerEpoch]);
      await tx.query("UPDATE cloud_workspace_local_command_writers SET state='active',activated_at=clock_timestamp() WHERE writer_epoch=$1", [writerEpoch]);
      await tx.query("UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=1,final_save_version=1 WHERE id=$1", [source.engineInstanceId]);
      await tx.query("UPDATE cloud_workspaces SET agent_boot_id=$2 WHERE id=$1", [f.scope.workspaceId,bindingId]);
    });
    await new DatabaseCloudWorkspaceContentService({pool,workosEnabled:false}).append({
      ...source, expectedRevision:1,idempotencyKey:randomUUID(),gitBaseCommit:"a".repeat(40),gitHeadRef:null,
      mutations:[{operation:"delete",path:"file.txt"}],
    });
    await sealFinalSaveFixture(pool, source);
    const intentId=randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256)
      VALUES($1::uuid,$2,$3,1,$4,'stop',$1::text,digest($1::text,'sha256'))`, [intentId,f.scope.workspaceId,f.scope.organizationId,f.fixture.userId]);
    const { receipt } = await commitFinalSaveFixture(pool, source, { intentId, userId:f.fixture.userId, reason:"before_stop" });
    expect(await withSystemTx(pool, tx => finalSaveProven(tx, intentId))).toBe(true);
    expect((await pool.query("SELECT state,checkpoint_id FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1", [intentId])).rows)
      .toEqual([{ state:"proven",checkpoint_id:receipt.checkpointId }]);
    expect((await pool.query("SELECT state,seal_ack IS NOT NULL AS sealed FROM cloud_workspace_local_command_writers WHERE writer_epoch=$1", [f.writerEpoch])).rows)
      .toEqual([{state:"retired",sealed:true}]);
    expect(await withSystemTx(pool, tx => finalSaveProven(tx, f.intentId))).toBe(false);
  });
  it("refuses the older final proof when enrollment timestamps tie", async () => {
    await (await f.prepareCommit()).run();
    const replacement=await withSystemTx(pool, tx => seedFinalSaveEngine(tx, { ...f.scope,userId:f.fixture.userId,setupAttempt:2 }));
    await pool.query(`UPDATE cloud_workspace_engine_instances SET created_at=(SELECT created_at FROM cloud_workspace_engine_instances WHERE id=$2)
      WHERE id=$1`, [replacement.engineInstanceId,f.scope.engineInstanceId]);
    expect(await withSystemTx(pool, tx => finalSaveProven(tx, f.intentId))).toBe(false);
  });
  it("pins post-join reports and retry floors without renewing the original deadline or lease",async()=>{
    const engineBefore=(await pool.query("SELECT lease_expires_at FROM cloud_workspace_engine_instances WHERE id=$1",[f.scope.engineInstanceId])).rows;
    const first=await f.send();
    expect(first.state).toBe("waiting");
    const stored=await f.row(); expect(stored.retry_count).toBe(1);
    expect((await f.send()).state).toBe("waiting"); expect((await f.row()).next_attempt_at).toEqual(stored.next_attempt_at);
    expect(await f.delivery()).toBeNull();
    await f.due(); expect(await runFinalSaveRecovery(pool,f.scope.workspaceId,false)).toBe(1);
    expect((await f.delivery())?.deadlineAtMs).toBe(f.directive.deadlineAtMs);
    expect((await f.send()).state).toBe("waiting"); expect((await f.row()).retry_count).toBe(2);
    expect((await pool.query("SELECT lease_expires_at FROM cloud_workspace_engine_instances WHERE id=$1",[f.scope.engineInstanceId])).rows).toEqual(engineBefore);
  });
  it("requires an after-expiry report before a single successor, preserving the original UNIQUE lifecycle link",async()=>{
    await f.send(f.report("reconcile")); await f.expire();await f.due();
    await runFinalSaveRecovery(pool,f.scope.workspaceId,false);
    expect((await f.row()).attempt_ordinal).toBe(0);
    const retired=await f.send(f.report("reconcile"));expect(retired.state).toBe("retired");
    await f.due();await Promise.all([runFinalSaveRecovery(pool,f.scope.workspaceId,false),runFinalSaveRecovery(pool,f.scope.workspaceId,false)]);
    const current=await f.row();expect(current.attempt_ordinal).toBe(1);
    const child=(await f.delivery())!;expect(child.finalSave).toMatchObject({attemptOrdinal:1,predecessorRequestId:f.request.id,
      custodyId:f.report().custodyId,retirementId:retired.state==="retired"?retired.retirementId:null});
    expect(child.id).not.toBe(f.request.id);expect(child.deadlineAtMs).toBeGreaterThan(Date.now());
    expect((await pool.query("SELECT id FROM workspace_checkpoint_requests WHERE lifecycle_intent_id=$1",[f.intentId])).rows).toEqual([{id:f.request.id}]);
    expect(await withSystemTx(pool,tx=>deliverWorkspaceCheckpointRequest(tx,f.scope))).toBeNull();
    // N-1 delivery and expiry SQL cannot see successor states.
    expect((await pool.query("SELECT id FROM workspace_checkpoint_requests WHERE workspace_id=$1 AND state IN ('queued','delivered')",[f.scope.workspaceId])).rowCount).toBe(0);
  });
  it("attributes a successor's real final commit to the original accepted action", async () => {
    await f.expire(); await f.send(f.report("reconcile")); await f.due();
    await runFinalSaveRecovery(pool,f.scope.workspaceId,false);
    const successor=(await f.delivery())!;
    const commit=await f.prepareCommit(successor.id), receipt=await commit.run();
    expect((await f.row()).state).toBe("proven");
    expect(await withSystemTx(pool,tx=>loadCommittedFinalCheckpoint(tx,f.scope.workspaceId,1)))
      .toMatchObject({checkpoint_id:receipt.checkpointId,lifecycle_intent_id:f.intentId});
    expect((await pool.query("SELECT state,lifecycle_intent_id FROM workspace_checkpoint_requests WHERE id=$1",[f.request.id])).rows)
      .toEqual([{state:"expired",lifecycle_intent_id:f.intentId}]);
  });
  for(const invalid of ["engine lease","funding","registration","token","old engine","boot","custody"] as const){
    it(`refuses ${invalid} changes across an expired attempt`,async()=>{
      await f.expire();const original=f.report("reconcile");await f.send(original);
      if(invalid==="engine lease")await pool.query("UPDATE cloud_workspace_engine_instances SET last_heartbeat_at=now()-interval '5 minutes',lease_expires_at=now()-interval '1 second' WHERE id=$1",[f.scope.engineInstanceId]);
      if(invalid==="funding") {
        const next=await ensureCloudPilotUser(pool,{provider:"workos",providerSubject:`user_${randomUUID()}`,email:`new-${randomUUID()}@example.test`,displayName:"New owner"});
        await withSystemTx(pool,tx=>tx.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')",[f.scope.organizationId,next.id]));
        await pool.query("UPDATE cloud_workspaces SET owner_user_id=$2 WHERE id=$1",[f.scope.workspaceId,next.id]);
        await pool.query("UPDATE cloud_workspaces SET owner_user_id=$2 WHERE id=$1",[f.scope.workspaceId,f.fixture.userId]);
      }
      if(invalid==="registration")await pool.query("UPDATE cloud_workspace_engine_instances SET registered_at=registered_at+interval '1 millisecond' WHERE id=$1",[f.scope.engineInstanceId]);
      if(invalid==="token")await pool.query("UPDATE cloud_workspace_engine_instances SET heartbeat_token_hash=digest('rotated-test-token','sha256') WHERE id=$1",[f.scope.engineInstanceId]);
      if(invalid==="old engine")await pool.query("UPDATE cloud_workspace_engine_instances SET final_save_version=NULL WHERE id=$1",[f.scope.engineInstanceId]);
      if(invalid==="boot")await pool.query("UPDATE cloud_agent_boot_bindings SET retired_at=now() WHERE id=$1",[f.bindingId]);
      if(invalid==="custody")await expect(f.send({...original,custodyId:randomUUID()})).rejects.toBeInstanceOf(CloudFinalSaveRejected);
      else {await f.due();await runFinalSaveRecovery(pool,f.scope.workspaceId,false);expect((await f.row()).state).toBe("blocked");expect((await f.row()).attempt_ordinal).toBe(0);}
      if(["registration","token","old engine"].includes(invalid))await expect(f.send(original)).rejects.toThrow();
    });
  }
  it("reconciles a committed exact body after ACK loss without mutation authority",async()=>{
    const commit=await f.prepareCommit();const receipt=await commit.run();
    await pool.query("UPDATE cloud_workspace_engine_instances SET last_heartbeat_at=now()-interval '5 minutes',lease_expires_at=now()-interval '1 second' WHERE id=$1",[f.scope.engineInstanceId]);
    const report={...f.report("reconcile"),commit:commit.commit};
    expect(await f.send(report)).toMatchObject({state:"committed",checkpoint:{checkpointId:receipt.checkpointId,contentRevision:1,
      requestSha256:commit.commit.requestSha256}});
    await expect(f.send({...report,commit:{...commit.commit,bodySha256:"c".repeat(64)}})).rejects.toBeInstanceOf(CloudFinalSaveRejected);
    await expect(commit.content.commitCheckpoint({...commit.body,heartbeatToken:f.scope.heartbeatToken,serializedBodySha256:"d".repeat(64)})).rejects.toThrow();
  });
  it("retains raw HTTP bytes through a real commit and refuses a normalized replay",async()=>{
    const commit=await f.prepareCommit();
    const raw=JSON.stringify(Object.fromEntries(Object.entries(commit.body).reverse()),null,2);
    const app=createCloudWorkspaceInternalRoutes({redeem:vi.fn(),registerEngine:vi.fn(),heartbeat:vi.fn(),
      commitCheckpoint:input=>commit.content.commitCheckpoint(input)});
    const post=(serialized:string)=>app.request(CLOUD_WORKSPACE_CHECKPOINT_COMMIT_PATH,{method:"POST",headers:{
      authorization:`Bearer ${f.scope.heartbeatToken}`,"content-type":"application/json"},body:serialized});
    const response=await post(raw);expect(response.status).toBe(200);const receipt=await response.json();
    const retained={...commit.commit,bodySha256:createHash("sha256").update(raw).digest("hex")};
    expect((await pool.query("SELECT encode(final_save_body_sha256,'hex') AS digest FROM workspace_checkpoints WHERE id=$1",[receipt.checkpointId])).rows)
      .toEqual([{digest:retained.bodySha256}]);
    expect(await f.send({...f.report("reconcile"),commit:retained})).toMatchObject({state:"committed",checkpoint:{checkpointId:receipt.checkpointId}});
    expect((await post(raw)).status).toBe(200);
    expect((await post(commit.serialized)).status).toBe(409);
  });
  it("refuses a successor when authority expires while qualification I/O settles",async()=>{
    await f.expire(); await f.send(f.report("reconcile")); await f.due();
    const original=runtimeSelection.loadPinnedCloudRuntime;
    vi.spyOn(runtimeSelection,"loadPinnedCloudRuntime").mockImplementationOnce(async(tx,...args)=>{
      const runtime=await original(tx,...args);
      await tx.query("UPDATE cloud_workspace_engine_instances SET last_heartbeat_at=clock_timestamp()-interval '2 minutes',lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.scope.engineInstanceId]);
      return runtime;
    });
    await runFinalSaveRecovery(pool,f.scope.workspaceId,false);
    expect((await f.row()).attempt_ordinal).toBe(0);
    expect((await f.row()).state).toBe("blocked");
  });
  it("retirement wins under the completion lock and refuses the original late commit",async()=>{
    const commit=await f.prepareCommit();await f.expire();
    const retired=await f.send({...f.report("reconcile"),commit:commit.commit});expect(retired.state).toBe("retired");
    await expect(commit.run()).rejects.toThrow();
    expect(await f.send({...f.report("reconcile"),commit:commit.commit})).toEqual(retired);
    expect((await pool.query("SELECT id FROM workspace_checkpoints WHERE workspace_id=$1",[f.scope.workspaceId])).rowCount).toBe(0);
  });
  it.each(["commit","retirement"] as const)("serializes the real commit/retirement race when %s owns the parent lock first",async winner=>{
    const commit=await f.prepareCommit();
    if(winner==="retirement")await f.expire();
    const gate=await pool.connect(), key=487112;
    const commitPool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:1,application_name:"final-save-commit-race"});
    const reportPool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:1,application_name:"final-save-report-race"});
    const content=new DatabaseCloudWorkspaceContentService({pool:commitPool,workosEnabled:false});
    const recovery=new DatabaseCloudFinalSaveService(reportPool,false);
    const report={...f.report("reconcile"),commit:commit.commit,token:f.scope.heartbeatToken};
    const waiting=(name:string)=>pool.query<{waiting:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
      WHERE application_name=$1 AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0) AS waiting`,[name])
      .then(result=>result.rows[0]!.waiting);
    let first:Promise<unknown>|undefined,second:Promise<unknown>|undefined;
    const startCommit=()=>content.commitCheckpoint({...commit.body,heartbeatToken:f.scope.heartbeatToken,serializedBodySha256:commit.commit.bodySha256})
      .then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
    const startReport=()=>recovery.report(report).then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
    try{
      await gate.query("SELECT pg_advisory_lock($1)",[key]);
      await pool.query(`CREATE FUNCTION hold_final_save_race() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock(487112); RETURN NEW; END $$`);
      await pool.query(winner==="commit"
        ? "CREATE TRIGGER hold_final_save_race BEFORE INSERT ON workspace_checkpoints FOR EACH ROW EXECUTE FUNCTION hold_final_save_race()"
        : "CREATE TRIGGER hold_final_save_race BEFORE UPDATE OF state ON workspace_checkpoint_requests FOR EACH ROW WHEN (NEW.state='expired') EXECUTE FUNCTION hold_final_save_race()");
      const commitResult=winner==="commit"?startCommit():undefined;
      const reportResult=winner==="retirement"?startReport():undefined;
      first=commitResult??reportResult;
      await expect.poll(()=>waiting(winner==="commit"?"final-save-commit-race":"final-save-report-race"),{timeout:3000}).toBe(true);
      const lateCommit=commitResult??startCommit(), lateReport=reportResult??startReport();
      second=winner==="commit"?lateReport:lateCommit;
      await expect.poll(()=>waiting(winner==="commit"?"final-save-report-race":"final-save-commit-race"),{timeout:3000}).toBe(true);
      await gate.query("SELECT pg_advisory_unlock($1)",[key]);
      const [committed,reconciled]=await Promise.all([lateCommit,lateReport]);
      expect(reconciled.ok).toBe(true);
      if(!reconciled.ok)throw reconciled.error;
      if(winner==="commit"){
        expect(committed.ok).toBe(true);
        if(!committed.ok)throw committed.error;
        expect(reconciled.value).toMatchObject({state:"committed",checkpoint:{checkpointId:committed.value.checkpointId,
          requestSha256:commit.commit.requestSha256}});
        expect((await f.row()).state).toBe("proven");
      }else{
        expect(reconciled.value.state).toBe("retired");expect(committed.ok).toBe(false);
        expect((await pool.query("SELECT id FROM workspace_checkpoints WHERE workspace_id=$1",[f.scope.workspaceId])).rowCount).toBe(0);
      }
    }finally{
      await gate.query("SELECT pg_advisory_unlock($1)",[key]);
      await Promise.allSettled([first,second]);gate.release();await Promise.all([commitPool.end(),reportPool.end()]);
    }
  });
  it("uses one final proof for a later accepted action on the unchanged frozen source",async()=>{
    const commit=await f.prepareCommit(), later=randomUUID();
    const request=await withSystemTx(pool,async tx=>{
      await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
        (id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256)
        VALUES($1::uuid,$2,$3,1,$4,'archive',$1::text,digest($1::text,'sha256'))`,[later,f.scope.workspaceId,f.scope.organizationId,f.fixture.userId]);
      return enqueueWorkspaceCheckpointRequest(tx,{...f.scope,requestedBy:f.fixture.userId,lifecycleIntentId:later,
        reason:"before_archive",idempotencyKey:`later.${later}`});
    });
    const receipt=await commit.run();
    expect((await pool.query("SELECT state,checkpoint_id,proven_request_id FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1",[later])).rows[0])
      .toEqual({state:"proven",checkpoint_id:receipt.checkpointId,proven_request_id:f.request.id});
    expect((await pool.query("SELECT state,final_save_retirement_id FROM workspace_checkpoint_requests WHERE id=$1",[request.id])).rows[0])
      .toEqual({state:"cancelled",final_save_retirement_id:expect.any(String)});
  });
});
