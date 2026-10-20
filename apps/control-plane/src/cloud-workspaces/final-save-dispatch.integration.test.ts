import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx, withUserTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedFinalSave, seedFinalSaveEngine } from "./final-save-test-fixtures.js";
import { seedSupportedCloudWorkspaceGeneration, withCloudFixtureOwnerTx } from "./test-fixtures.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("final-save dispatch custody and database privileges",()=>{
  let pool:pg.Pool,f:Awaited<ReturnType<typeof seedFinalSave>>;
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5});});
  afterAll(async()=>pool.end());
  beforeEach(async()=>{await resetMigratedTestDatabase(pool);f=await seedFinalSave(pool);});
  async function claim(){
    await (await f.prepareCommit()).run();
    await pool.query(`UPDATE cloud_workspace_lifecycle_intents SET state='dispatching',lease_owner='held-provider-call',
      lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1`,[f.intentId]);
  }
  it("retains the exact source through an ambiguous dispatch and an expired worker claim",async()=>{
    await withCloudFixtureOwnerTx(pool,tx=>seedSupportedCloudWorkspaceGeneration(tx,{...f.scope,ownerUserId:f.fixture.userId,generation:2}));
    await claim();
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.intentId]);
    const mutations=[
      ()=>withSystemTx(pool,tx=>seedFinalSaveEngine(tx,{...f.scope,userId:f.fixture.userId,setupAttempt:2})),
      ()=>pool.query("UPDATE cloud_workspace_engine_instances SET registered_at=clock_timestamp() WHERE id=$1",[f.scope.engineInstanceId]),
      ()=>pool.query("UPDATE cloud_workspace_provider_bindings SET provider_resource_id='replacement-allocation' WHERE workspace_id=$1",[f.scope.workspaceId]),
      ()=>pool.query("UPDATE managed_compute_allocation_leases SET provider_resource_id='replacement-allocation' WHERE id=$1",[f.allocationLeaseId]),
      ()=>pool.query("UPDATE cloud_workspaces SET current_generation=2 WHERE id=$1",[f.scope.workspaceId]),
    ];
    for(const mutate of mutations)await expect(mutate()).rejects.toMatchObject({code:"40001"});
    expect((await pool.query("SELECT settled_at FROM cloud_workspace_final_save_dispatches WHERE lifecycle_intent_id=$1",[f.intentId])).rows)
      .toEqual([{settled_at:null}]);
    // State alone is insufficient. The positive observation must postdate
    // admission and match this allocation, then its lifecycle result commits.
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=clock_timestamp() WHERE id=$1",[f.intentId]);
    await expect(mutations[0]!()).rejects.toMatchObject({code:"40001"});
    await pool.query("UPDATE cloud_workspace_provider_bindings SET observed_state='stopped',last_observed_at=clock_timestamp() WHERE workspace_id=$1",[f.scope.workspaceId]);
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded' WHERE id=$1",[f.intentId]);
    expect((await pool.query("SELECT settled_at IS NOT NULL AS settled FROM cloud_workspace_final_save_dispatches WHERE lifecycle_intent_id=$1",[f.intentId])).rows)
      .toEqual([{settled:true}]);
    await expect(mutations[0]!()).resolves.toMatchObject({workspaceId:f.scope.workspaceId});
  });

  it("uses NOWAIT when a lease owner reaches a contested workspace",async()=>{
    await claim();
    const owner=await pool.connect();
    try {
      await owner.query("BEGIN");
      await owner.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE",[f.scope.workspaceId]);
      await expect(withSystemTx(pool,async tx=>{
        await tx.query("SET LOCAL statement_timeout='1s'");
        await tx.query("SELECT id FROM managed_compute_allocation_leases WHERE id=$1 FOR UPDATE",[f.allocationLeaseId]);
        await tx.query("UPDATE managed_compute_allocation_leases SET provider_resource_id='replacement-allocation' WHERE id=$1",[f.allocationLeaseId]);
      })).rejects.toMatchObject({code:"55P03"});
    }finally{await owner.query("ROLLBACK");owner.release();}
  });

  it("hides recovery and dispatch custody from the workspace owner and PUBLIC",async()=>{
    await claim();
    await withUserTx(pool,f.fixture.userId,async tx=>{
      expect((await tx.query("SELECT * FROM cloud_workspace_final_save_recoveries")).rowCount).toBe(0);
      expect((await tx.query("SELECT * FROM cloud_workspace_final_save_dispatches")).rowCount).toBe(0);
      expect((await tx.query("UPDATE cloud_workspace_final_save_recoveries SET custody_id=$1 WHERE lifecycle_intent_id=$2",[randomUUID(),f.intentId])).rowCount).toBe(0);
      expect((await tx.query("SELECT cloud_final_save_proven($1) AS proven",[f.intentId])).rows).toEqual([{proven:false}]);
    });
    const functions=(await pool.query(`SELECT p.proname,p.prosecdef,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
        WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
        AND (p.proname LIKE 'cloud_final_save_%' OR p.proname='ensure_cloud_final_save_recovery'
          OR p.proname LIKE 'cloud_restart_%' OR p.proname LIKE 'cloud_accepted_lifecycle_%'
          OR p.proname='cloud_workspace_accepted_lifecycle')`)).rows;
    expect(functions).toHaveLength(28);
    expect(functions.some(fn => fn.proname === "cloud_final_save_owner_discarded")).toBe(true);
    for(const fn of functions)expect(fn).toMatchObject({prosecdef:false,public_execute:false});
    expect((await pool.query(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE oid IN ('cloud_workspace_final_save_recoveries'::regclass,'cloud_workspace_final_save_dispatches'::regclass)`)).rows)
      .toEqual([{relrowsecurity:true,relforcerowsecurity:true},{relrowsecurity:true,relforcerowsecurity:true}]);
  });
});
