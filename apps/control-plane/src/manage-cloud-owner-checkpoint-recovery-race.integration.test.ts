import pg from "pg";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "./test-database.js";
import { manageCloudOwnerCheckpointRecovery, manageCloudOwnerCheckpointRecoveryWithEvidence,
  type OwnerRecoveryLossEvidence } from "./manage-cloud-owner-checkpoint-recovery.js";
import { ownerRecoveryConfig, seedOwnerCheckpointRecovery } from "./cloud-workspaces/owner-checkpoint-recovery-test-fixtures.js";
import { requestManagedComputeStop } from "./cloud-workspaces/compute-credit-stop.js";
import { CloudWorkspaceComputeLeaseCoordinator } from "./cloud-workspaces/compute-leases.js";
import type { CloudWorkspaceProvider } from "./cloud-workspaces/provider.js";
import type { CloudWorkspaceComputeProvider } from "./cloud-workspaces/provider-compute.js";
import { CloudWorkspaceCheckpointRequestWorker } from "./cloud-workspaces/checkpoint-requests.js";
import { runFinalSaveRecovery } from "./cloud-workspaces/final-save-service.js";
import { DatabaseCloudWorkspaceHealthService } from "./cloud-workspaces/health.js";
import { seedFinalSave, seedFinalSaveEngine } from "./cloud-workspaces/final-save-test-fixtures.js";
import { completeCloudWorkspaceGenerationTransition } from "./cloud-workspaces/generation-transitions.js";
import { withSystemTx } from "./db.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("owner recovery across provider-loss safety Stop", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => resetMigratedTestDatabase(pool));
  const options = () => ({ databaseUrl: process.env.TEST_DATABASE_URL!, config: ownerRecoveryConfig, workosEnabled: false });
  async function safetyStop(workspaceId: string) {
    const lease = (await pool.query("SELECT id FROM managed_compute_allocation_leases WHERE workspace_id=$1", [workspaceId])).rows[0];
    await requestManagedComputeStop(pool, { leaseId: lease.id, reason: "provider_not_found" });
    const stop = (await pool.query(`SELECT intent.id,request.id AS request_id
      FROM cloud_workspace_lifecycle_intents intent
      JOIN workspace_checkpoint_requests request ON request.lifecycle_intent_id=intent.id
      WHERE intent.workspace_id=$1 AND intent.idempotency_key LIKE 'system:compute-stop:%'`, [workspaceId])).rows[0];
    expect(stop).toBeDefined();
    return { intentId: stop.id as string, requestId: stop.request_id as string };
  }
  async function settleLostLease(workspaceId: string) {
    const noProviderMutation = vi.fn(async () => { throw new Error("Lost allocation must not dispatch provider work"); });
    const provider = { name: "boat", inspect: async () => null, verifyAbsence: async () => true,
      create:noProviderMutation,start:noProviderMutation,stop:noProviderMutation,delete:noProviderMutation,archive:noProviderMutation,
      find:async()=>[],computeWeight:()=>({numerator:1,denominator:1}),createWithComputeLease:noProviderMutation,
      startWithComputeLease:noProviderMutation,renewComputeLease:noProviderMutation,readComputeUsage:noProviderMutation } satisfies CloudWorkspaceProvider & CloudWorkspaceComputeProvider;
    const coordinator = new CloudWorkspaceComputeLeaseCoordinator({pool,provider,workosEnabled:false});
    await pool.query("UPDATE managed_compute_allocation_leases SET next_check_at=clock_timestamp() WHERE workspace_id=$1",[workspaceId]);
    expect(await coordinator.runOnce(workspaceId)).toBe(true);
    expect((await pool.query("SELECT state,lease_owner FROM managed_compute_allocation_leases WHERE workspace_id=$1",[workspaceId])).rows)
      .toEqual([{state:"settled",lease_owner:null}]);
    expect(noProviderMutation).not.toHaveBeenCalled();
  }
  async function fixture(historicalLoss=false) {
    const f=await seedOwnerCheckpointRecovery(pool,{historicalLoss});
    const safety=await safetyStop(f.scope.workspaceId);
    await settleLostLease(f.scope.workspaceId);
    return {...f,safety,requestInput:{...f.requestInput,safetyStop:safety}};
  }
  async function expire(requestId:string) {
    await pool.query(`UPDATE workspace_checkpoint_requests SET created_at=clock_timestamp()-interval '6 minutes',
      deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1`,[requestId]);
    expect(await new CloudWorkspaceCheckpointRequestWorker(pool).expireOnce()).toBe(1);
  }
  async function evidence(resourceId:string):Promise<OwnerRecoveryLossEvidence> {
    const now=(await pool.query("SELECT clock_timestamp() AS now")).rows[0].now;
    return {inventory:{observedAt:now,providerAccount:"fixture-account",accountProof:null,resources:[]},
      lookup:{resourceId,observedAt:now,notFound:true}};
  }
  const receipts=async()=>(await pool.query("SELECT count(*)::int AS count FROM cloud_workspace_owner_discard_receipts")).rows[0].count;

  it.each(["before attestation", "after attestation"] as const)("recovers the exact two Stops when the lease worker runs %s", async order => {
    let safety: Awaited<ReturnType<typeof safetyStop>> | undefined;
    const f = await seedOwnerCheckpointRecovery(pool, order === "before attestation" ? {
      beforeLoss: async original => { safety = await safetyStop(original.scope.workspaceId); },
    } : {});
    if (!safety) safety = await safetyStop(f.scope.workspaceId);
    await settleLostLease(f.scope.workspaceId);
    const intents = (await pool.query(`SELECT id,operation,state,attempt_count FROM cloud_workspace_lifecycle_intents
      WHERE id=ANY($1::uuid[]) ORDER BY id`, [[f.intentId,f.wakeId,safety.intentId]])).rows;
    expect(intents).toHaveLength(3);
    expect(intents.find(row => row.id === f.wakeId)).toMatchObject({ operation: "wake", state: "superseded", attempt_count: 0 });
    expect(intents.filter(row => row.operation === "stop").every(row => row.state === "queued" && row.attempt_count === 0)).toBe(true);
    const original = await f.row();
    const request = { ...f.requestInput, safetyStop: safety };
    await expect(manageCloudOwnerCheckpointRecovery(pool, request, options())).resolves.toMatchObject({ state: "planned" });
    const plan = await manageCloudOwnerCheckpointRecovery(pool, request, options());
    const result = await manageCloudOwnerCheckpointRecovery(pool, request, { ...options(), execute: true, approval: plan.approval });
    expect(result).toMatchObject({ state: "restoring", candidateGeneration: 2 });
    expect((await pool.query(`SELECT state FROM cloud_workspace_final_save_recoveries
      WHERE lifecycle_intent_id=ANY($1::uuid[])`, [[f.intentId,safety.intentId]])).rows)
      .toEqual([{ state: "discarded" }, { state: "discarded" }]);
    expect(await f.row()).toEqual({ ...original, state: "discarded", next_attempt_at: Infinity });
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=ANY($1::uuid[])",
      [[f.intentId,f.wakeId,safety.intentId]])).rows.every(row => row.state === "superseded")).toBe(true);
    expect((await pool.query("SELECT cloud_final_save_proven($1) OR cloud_final_save_proven($2) AS proven",
      [f.intentId,safety.intentId])).rows[0].proven).toBe(false);
  });

  it("retains the original two-intent operator path without a safety Stop", async () => {
    const f = await seedOwnerCheckpointRecovery(pool);
    const plan = await manageCloudOwnerCheckpointRecovery(pool, f.requestInput, options());
    expect(await manageCloudOwnerCheckpointRecovery(pool, f.requestInput, { ...options(), execute: true, approval: plan.approval }))
      .toMatchObject({ state: "restoring", candidateGeneration: 2 });
  });

  it("refuses to ignore the extra Stop when it is absent from the exact request", async () => {
    const f = await seedOwnerCheckpointRecovery(pool);
    await safetyStop(f.scope.workspaceId);
    await expect(manageCloudOwnerCheckpointRecovery(pool, f.requestInput, options()))
      .rejects.toMatchObject({ code: "owner_recovery_lifecycle_changed" });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_discard_receipts")).rows[0].n).toBe(0);
  });

  it("retains an expired undelivered safety capture and its failure while discarding both recoveries",async()=>{
    const f=await fixture();
    await expire(f.safety.requestId);
    await runFinalSaveRecovery(pool,f.scope.workspaceId,false);
    const before=(await pool.query("SELECT * FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1",[f.safety.intentId])).rows[0];
    const capture=(await pool.query("SELECT * FROM workspace_checkpoint_requests WHERE id=$1",[f.safety.requestId])).rows[0];
    expect(before).toMatchObject({state:"blocked",custody_id:null,attempt_ordinal:0});
    expect(capture).toMatchObject({state:"expired",delivery_count:0,final_save_capture_report:null,final_save_commit_report:null});
    const plan=await manageCloudOwnerCheckpointRecovery(pool,f.requestInput,options());
    await manageCloudOwnerCheckpointRecovery(pool,f.requestInput,{...options(),execute:true,approval:plan.approval});
    expect((await pool.query("SELECT * FROM workspace_checkpoint_requests WHERE id=$1",[f.safety.requestId])).rows[0]).toEqual(capture);
    expect((await pool.query("SELECT * FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1",[f.safety.intentId])).rows[0])
      .toEqual({...before,state:"discarded",next_attempt_at:Infinity});
  });

  it("allows ordinary expiry between plan and execute without renewing the capture",async()=>{
    const f=await fixture();
    const plan=await manageCloudOwnerCheckpointRecovery(pool,f.requestInput,options());
    await expire(f.safety.requestId);
    expect(await manageCloudOwnerCheckpointRecovery(pool,f.requestInput,{...options(),execute:true,approval:plan.approval}))
      .toMatchObject({state:"restoring"});
    expect((await pool.query("SELECT state,deadline_at<clock_timestamp() AS expired FROM workspace_checkpoint_requests WHERE id=$1",
      [f.safety.requestId])).rows[0]).toEqual({state:"expired",expired:true});
  });

  it.each(["delivery","custody","capture","commit","reconcile","lease-pointer","wake-reason"] as const)
    ("refuses changed safety %s after plan with no receipt or transition",async mutation=>{
      const f=await fixture();
      const plan=await manageCloudOwnerCheckpointRecovery(pool,f.requestInput,options());
      if(mutation==="delivery")await pool.query(`UPDATE workspace_checkpoint_requests SET state='delivered',delivery_count=1,
        last_delivered_at=clock_timestamp() WHERE id=$1`,[f.safety.requestId]);
      else if(mutation==="custody")await pool.query("UPDATE cloud_workspace_final_save_recoveries SET custody_id=$2 WHERE lifecycle_intent_id=$1",
        [f.safety.intentId,randomUUID()]);
      else if(mutation==="lease-pointer")await pool.query("UPDATE managed_compute_allocation_leases SET stop_intent_id=$2 WHERE workspace_id=$1",
        [f.scope.workspaceId,f.intentId]);
      else if(mutation==="wake-reason")await pool.query("UPDATE cloud_workspace_lifecycle_intents SET error_code='another_reason' WHERE id=$1",[f.wakeId]);
      else {
        const column={capture:"final_save_capture_report",commit:"final_save_commit_report",reconcile:"final_save_reconcile_report"}[mutation];
        await pool.query(`UPDATE workspace_checkpoint_requests SET ${column}='{}'::jsonb WHERE id=$1`,[f.safety.requestId]);
      }
      await expect(manageCloudOwnerCheckpointRecovery(pool,f.requestInput,{...options(),execute:true,approval:plan.approval}))
        .rejects.toMatchObject({code:"owner_recovery_safety_stop_changed"});
      expect(await receipts()).toBe(0);
      expect((await pool.query("SELECT count(*)::int AS count FROM cloud_workspace_generation_transitions")).rows[0].count).toBe(0);
    });

  it("requires the lease to settle and refuses a third recovery or a foreign safety identity",async()=>{
    const f=await seedOwnerCheckpointRecovery(pool);
    const safety=await safetyStop(f.scope.workspaceId);
    const request={...f.requestInput,safetyStop:safety};
    await expect(manageCloudOwnerCheckpointRecovery(pool,request,options())).rejects.toMatchObject({code:"owner_recovery_safety_stop_changed"});
    await settleLostLease(f.scope.workspaceId);
    await expect(manageCloudOwnerCheckpointRecovery(pool,{...request,safetyStop:{...safety,intentId:randomUUID()}},options())).rejects.toThrow();
    const third=randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256)
      VALUES($1::uuid,$2,$3,1,$4,'stop',$1::text,digest($1::text,'sha256'))`,[third,f.scope.workspaceId,f.scope.organizationId,f.fixture.userId]);
    await expect(manageCloudOwnerCheckpointRecovery(pool,request,options())).rejects.toMatchObject({code:"owner_recovery_lifecycle_changed"});
    expect(await receipts()).toBe(0);
  });

  it("clears both target health reasons, fences late workers and leaves another workspace unsaved",async()=>{
    const f=await fixture(),other=await seedFinalSave(pool);
    await expire(f.safety.requestId);
    await pool.query(`UPDATE cloud_workspace_lifecycle_intents SET next_attempt_at=clock_timestamp()-interval '16 minutes',
      updated_at=clock_timestamp()-interval '16 minutes' WHERE workspace_id=$1 AND state='queued'`,[f.scope.workspaceId]);
    await pool.query("UPDATE cloud_workspace_final_save_recoveries SET state='blocked' WHERE lifecycle_intent_id=ANY($1::uuid[])",[[f.intentId,f.safety.intentId]]);
    const health=new DatabaseCloudWorkspaceHealthService(pool,{setupExecutionEnabled:false,durabilityEnabled:true,outboxDeliveryEnabled:false});
    expect((await health.read()).reasons).toEqual(expect.arrayContaining(["lifecycle_stalled","final_save_blocked"]));
    const plan=await manageCloudOwnerCheckpointRecovery(pool,f.requestInput,options());
    await manageCloudOwnerCheckpointRecovery(pool,f.requestInput,{...options(),execute:true,approval:plan.approval});
    const original=(await pool.query("SELECT * FROM workspace_checkpoint_requests WHERE id=$1",[f.safety.requestId])).rows[0];
    await pool.query("UPDATE cloud_workspace_final_save_recoveries SET state='blocked',next_attempt_at=now(),retry_count=1000 WHERE lifecycle_intent_id=ANY($1::uuid[])",
      [[f.intentId,f.safety.intentId]]);
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='queued',completed_at=NULL WHERE id=ANY($1::uuid[])",[[f.intentId,f.wakeId,f.safety.intentId]]);
    await requestManagedComputeStop(pool,{leaseId:(await f.row()).allocation_lease_id,reason:"provider_not_found",force:true});
    expect(await runFinalSaveRecovery(pool,f.scope.workspaceId,false)).toBe(0);
    expect((await health.read()).reasons.filter(reason=>["lifecycle_stalled","final_save_blocked"].includes(reason))).toEqual([]);
    expect((await pool.query("SELECT * FROM workspace_checkpoint_requests WHERE id=$1",[f.safety.requestId])).rows[0]).toEqual(original);
    expect((await pool.query("SELECT count(*)::int AS count FROM cloud_workspace_final_save_recoveries WHERE workspace_id=$1",[f.scope.workspaceId])).rows[0].count).toBe(2);
    await expect(pool.query(`UPDATE cloud_workspace_lifecycle_intents SET state='dispatching',lease_owner='late-worker',
      lease_expires_at=now()+interval '1 minute' WHERE id=$1`,[f.safety.intentId])).rejects.toMatchObject({code:"40001"});
    expect((await pool.query("SELECT cloud_final_save_deletion_claimable($1,$2) AS erasable",[other.scope.workspaceId,other.scope.organizationId])).rows[0].erasable).toBe(false);
    // History coverage alone can pass before the candidate has an engine;
    // it cannot authorize physical erasure of a restoring workspace.
    expect((await withSystemTx(pool,tx=>tx.query("SELECT cloud_workspace_data_purge_authorized($1,$2) AS erasable",
      [f.scope.workspaceId,f.scope.organizationId]))).rows[0].erasable).toBe(false);
    await withSystemTx(pool,tx=>completeCloudWorkspaceGenerationTransition(tx,{...f.scope,generation:2}));
    await pool.query(`UPDATE cloud_workspace_provider_bindings SET provider_resource_id='bx_23456789',observed_state='running'
      WHERE workspace_id=$1 AND generation=2`,[f.scope.workspaceId]);
    await withSystemTx(pool,tx=>seedFinalSaveEngine(tx,{...f.fixture,generation:2}));
    // The discarded source cannot satisfy the replacement engine's save.
    expect((await pool.query("SELECT cloud_final_save_deletion_claimable($1,$2) AS erasable",[f.scope.workspaceId,f.scope.organizationId])).rows[0].erasable).toBe(false);
  });

  it("keeps the old loss immutable and stores fresh authenticated observations on the exact receipt",async()=>{
    const f=await fixture(true);
    const old=(await pool.query("SELECT * FROM cloud_workspace_provider_loss_attestations WHERE id=$1",[f.requestInput.providerLossAttestationId])).rows[0];
    await expect(manageCloudOwnerCheckpointRecovery(pool,f.requestInput,options())).rejects.toMatchObject({code:"owner_recovery_loss_unconfirmed"});
    const request={...f.requestInput,lossRecheck:{providerAccount:"fixture-account"}};
    const read=vi.fn(()=>evidence(request.providerResourceId));
    const plan=await manageCloudOwnerCheckpointRecoveryWithEvidence(pool,request,options(),read);
    const accepted=await manageCloudOwnerCheckpointRecoveryWithEvidence(pool,request,{...options(),execute:true,approval:plan.approval},read);
    expect(read).toHaveBeenCalledTimes(2);
    expect((await pool.query("SELECT * FROM cloud_workspace_provider_loss_attestations WHERE id=$1",[request.providerLossAttestationId])).rows[0]).toEqual(old);
    expect((await pool.query(`SELECT loss_inventory_observed_at>clock_timestamp()-interval '15 minutes' AS fresh_inventory,
      loss_lookup_observed_at>clock_timestamp()-interval '15 minutes' AS fresh_lookup,
      loss_provider_account,loss_inventory_resource_count,safety_stop_intent_id,safety_request_id
      FROM cloud_workspace_owner_discard_receipts WHERE id=$1`,[request.operationId])).rows[0])
      .toEqual({fresh_inventory:true,fresh_lookup:true,loss_provider_account:"fixture-account",loss_inventory_resource_count:0,
        safety_stop_intent_id:f.safety.intentId,safety_request_id:f.safety.requestId});
    const unavailable=vi.fn(async()=>{throw new Error("A committed replay must not contact the provider");});
    expect(await manageCloudOwnerCheckpointRecoveryWithEvidence(pool,request,{...options(),execute:true,approval:plan.approval},unavailable))
      .toEqual({...accepted,state:"unchanged"});
    expect(unavailable).not.toHaveBeenCalled();
  });

  it.each(["expired","future","account","present","lookup","resource"] as const)("refuses %s fresh-loss evidence",async kind=>{
    const f=await fixture(true),request={...f.requestInput,lossRecheck:{providerAccount:"fixture-account"}};
    const lossEvidence=await evidence(request.providerResourceId);
    if(kind==="expired")lossEvidence.inventory.observedAt=new Date(Date.now()-16*60_000);
    else if(kind==="future")lossEvidence.lookup.observedAt=new Date(Date.now()+60_000);
    else if(kind==="account")lossEvidence.inventory.providerAccount="different-account";
    else if(kind==="present")lossEvidence.inventory.resources.push({id:request.providerResourceId,state:"running"});
    else if(kind==="lookup")lossEvidence.lookup.notFound=false;
    else lossEvidence.lookup.resourceId="bx_thr9q3w7";
    await expect(manageCloudOwnerCheckpointRecovery(pool,request,{...options(),lossEvidence})).rejects.toThrow();
    expect(await receipts()).toBe(0);
  });

  it("releases parent locks during authenticated reads and refuses a late delivered capture",async()=>{
    const f=await fixture(true),request={...f.requestInput,lossRecheck:{providerAccount:"fixture-account"}};
    const plan=await manageCloudOwnerCheckpointRecoveryWithEvidence(pool,request,options(),()=>evidence(request.providerResourceId));
    const read=vi.fn(async()=>{
      await withSystemTx(pool,async tx=>{
        await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE NOWAIT",[f.scope.organizationId]);
        await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE NOWAIT",[f.scope.workspaceId]);
        await tx.query(`UPDATE workspace_checkpoint_requests SET state='delivered',delivery_count=1,
          last_delivered_at=clock_timestamp() WHERE id=$1`,[f.safety.requestId]);
      });
      return evidence(request.providerResourceId);
    });
    await expect(manageCloudOwnerCheckpointRecoveryWithEvidence(pool,request,{...options(),execute:true,approval:plan.approval},read))
      .rejects.toMatchObject({code:"owner_recovery_safety_stop_changed"});
    expect(read).toHaveBeenCalledOnce();
    expect(await receipts()).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS count FROM cloud_workspace_generation_transitions")).rows[0].count).toBe(0);
  });

  it("runs the authenticated fresh-loss CLI as a restricted login and replays without another provider read",async()=>{
    const f=await fixture(true);
    await expire(f.safety.requestId);
    const directory=await mkdtemp(path.join(tmpdir(),"owner-loss-race-cli-"));
    const suffix=randomUUID().replaceAll("-","");
    const ownerRole=`w3_owner_${suffix}`,loginRole=`w3_login_${suffix}`,loginPassword=randomUUID();
    const principal=(await pool.query("SELECT current_user AS name")).rows[0].name as string;
    await pool.query(`CREATE ROLE ${ownerRole} NOLOGIN;
      CREATE ROLE ${loginRole} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD ${pg.escapeLiteral(loginPassword)};
      GRANT ${ownerRole} TO ${loginRole}; GRANT USAGE ON SCHEMA public TO ${ownerRole};
      GRANT ALL ON ALL TABLES IN SCHEMA public TO ${ownerRole};
      GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${ownerRole};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${ownerRole};
      ALTER TABLE cloud_workspace_owner_discard_receipts OWNER TO ${ownerRole}`);
    try {
      const filename=path.join(directory,"request.json"),calls=path.join(directory,"calls.jsonl"),stub=path.join(directory,"provider.mjs");
      await writeFile(filename,JSON.stringify({...f.requestInput,channel:"development",lossRecheck:{providerAccount:"fixture-account"}}),{mode:0o600});
      // The child uses the actual Boat client, inventory reader and exact-404
      // decoder. A private test preload intercepts only these three GETs;
      // there is no product test flag or live provider access.
      await writeFile(stub,`import { appendFileSync } from 'node:fs';
        globalThis.fetch=async(input,init)=>{
          const url=new URL(String(input));
          if(url.origin!=='https://boat.dev'||(init?.method??'GET')!=='GET'||
            new Headers(init?.headers).get('authorization')!=='Bearer fixture-provider')throw new Error('Unexpected provider access');
          const route=url.pathname+url.search;
          appendFileSync(${JSON.stringify(calls)},JSON.stringify(route)+'\\n',{mode:0o600});
          if(route==='/api/v1/me')return Response.json({ok:true,user:{id:'fixture-account'}});
          if(route==='/api/v1/sandboxes?limit=100')return Response.json({ok:true,sandboxes:[],pageInfo:{hasMore:false}});
          if(route===${JSON.stringify(`/api/v1/sandboxes/${f.requestInput.providerResourceId}`)})return Response.json({},{status:404});
          throw new Error('Unexpected provider route');
        };`,{mode:0o600});
      const databaseUrl=new URL(process.env.TEST_DATABASE_URL!);
      databaseUrl.username=loginRole;databaseUrl.password=loginPassword;
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
      const invoke=(execute=false,approval?:string)=>JSON.parse(execFileSync(process.execPath,
        ["--import","tsx","--import",stub,fileURLToPath(new URL("./manage-cloud-owner-checkpoint-recovery.ts",import.meta.url)),...(execute?["--execute"]:[])],
        {env:{...env,...(approval?{CONTROL_PLANE_OWNER_RECOVERY_APPROVAL:approval}:{})},encoding:"utf8",timeout:15_000}));
      const observed=async()=>(await readFile(calls,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
      const routes=["/api/v1/me","/api/v1/sandboxes?limit=100",`/api/v1/sandboxes/${f.requestInput.providerResourceId}`];
      const plan=invoke();
      expect(plan.state).toBe("planned");
      expect(await receipts()).toBe(0);
      expect(await observed()).toEqual(routes);
      const accepted=invoke(true,plan.approval);
      expect(accepted.state).toBe("restoring");
      expect(await observed()).toEqual([...routes,...routes]);
      await writeFile(stub,"globalThis.fetch=()=>{throw new Error('Provider unavailable after commit')};",{mode:0o600});
      expect(invoke(true,plan.approval)).toEqual({...accepted,state:"unchanged"});
      expect(await observed()).toEqual([...routes,...routes]);
      expect((await pool.query("SELECT state FROM cloud_workspace_final_save_recoveries WHERE workspace_id=$1",[f.scope.workspaceId])).rows)
        .toEqual([{state:"discarded"},{state:"discarded"}]);
    } finally {
      await pool.query(`ALTER TABLE cloud_workspace_owner_discard_receipts OWNER TO "${principal.replaceAll('"','""')}";
        DROP OWNED BY ${ownerRole}; DROP ROLE ${loginRole}; DROP ROLE ${ownerRole}`);
      await rm(directory,{recursive:true,force:true});
    }
  });

  it.each(["custody","expired-observation","partial-transition"] as const)
    ("SQL independently rejects %s even after the operator's plan checks",async kind=>{
      const f=await fixture(true),request={...f.requestInput,lossRecheck:{providerAccount:"fixture-account"}};
      const opts={...options(),lossEvidence:await evidence(request.providerResourceId)};
      const plan=await manageCloudOwnerCheckpointRecovery(pool,request,opts);
      const before=(await pool.query("SELECT * FROM workspace_checkpoint_requests WHERE id=$1",[f.safety.requestId])).rows[0];
      if(kind==="partial-transition") {
        // Simulate an incomplete old operator: it writes the receipt and
        // candidate but forgets to retire the second recovery.
        await pool.query(`CREATE FUNCTION test_hold_safety_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.lifecycle_intent_id='${f.safety.intentId}'::uuid AND NEW.state='discarded' THEN RETURN NULL; END IF; RETURN NEW; END $$;
          CREATE TRIGGER aa_test_hold_safety_recovery BEFORE UPDATE ON cloud_workspace_final_save_recoveries
          FOR EACH ROW EXECUTE FUNCTION test_hold_safety_recovery()`);
      } else {
        const mutation=kind==="custody"
          ? "UPDATE cloud_workspace_final_save_recoveries SET custody_id=gen_random_uuid() WHERE lifecycle_intent_id=NEW.safety_stop_intent_id;"
          : "NEW.loss_lookup_observed_at=clock_timestamp()-interval '16 minutes';";
        await pool.query(`CREATE FUNCTION test_change_discard_before_guard() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN ${mutation} RETURN NEW; END $$;
          CREATE TRIGGER aa_test_change_discard_before_guard BEFORE INSERT ON cloud_workspace_owner_discard_receipts
          FOR EACH ROW EXECUTE FUNCTION test_change_discard_before_guard()`);
      }
      await expect(manageCloudOwnerCheckpointRecovery(pool,request,{...opts,execute:true,approval:plan.approval}))
        .rejects.toMatchObject({code:kind==="partial-transition"?"23514":"40001"});
      expect(await receipts()).toBe(0);
      expect((await pool.query("SELECT count(*)::int AS count FROM cloud_workspace_generation_transitions")).rows[0].count).toBe(0);
      expect((await pool.query("SELECT current_generation FROM cloud_workspaces WHERE id=$1",[f.scope.workspaceId])).rows[0].current_generation).toBe(1);
      expect((await pool.query("SELECT * FROM workspace_checkpoint_requests WHERE id=$1",[f.safety.requestId])).rows[0]).toEqual(before);
    });
});
