import { randomBytes,randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll,beforeAll,beforeEach,describe,expect,it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { withSystemTx } from "../db.js";
import { seedReadyCloudWorkspace,type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";
import { copyGenerationPins } from "./generation-pins.js";

(process.env.TEST_DATABASE_URL?describe:describe.skip)("runtime transfer schema preserves old shapes",()=>{
  let pool:pg.Pool,fixture:ReadyCloudWorkspaceFixture;
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});});
  afterAll(async()=>{await pool.end();});
  beforeEach(async()=>{await resetMigratedTestDatabase(pool);fixture=await seedReadyCloudWorkspace(pool,{runtimeV4:true});});

  it.each(['setup_run_id','setup_execution_fence','registration_grant_id'])("keeps the legacy requirement for %s",async column=>{
    // The fixture INSERT and unchanged-column UPDATE are old-code shapes.
    await pool.query(`UPDATE cloud_workspace_engine_instances SET ${column}=${column},state='revoked',revoked_at=now() WHERE id=$1`,[fixture.engineInstanceId]);
    await expect(pool.query(`UPDATE cloud_workspace_engine_instances SET ${column}=NULL WHERE id=$1`,[fixture.engineInstanceId])).rejects.toMatchObject({constraint:"cloud_engine_enrollment_kind"});
  });

  it.each([
    {old:"check3",state:"rolling_back",valid:"drain",invalid:"none"},
    {old:"check4",state:"draining",valid:"drain",invalid:"provision"},
    {old:"check5",state:"setting_up",valid:"provision",invalid:"drain"},
  ])("retains the original executor rule from $old",async test=>{
    const scope={workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,generation:1};
    await withSystemTx(pool,async tx=>{
      const connection=(await tx.query<{provider_connection_id:string}>("SELECT provider_connection_id FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1",[fixture.workspaceId])).rows[0]!;
      await copyGenerationPins(tx,{...scope,sourceGeneration:1,targetGeneration:2,actorUserId:fixture.userId,
        providerConnectionId:connection.provider_connection_id,qualificationMode:"full"});
    });
    const drain=randomUUID(),provision=randomUUID();
    for(const [id,generation,operation] of [[drain,1,'stop'],[provision,2,'create']] as const)
      await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,org_id,generation,operation,idempotency_key,request_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,fixture.workspaceId,fixture.organizationId,generation,operation,randomUUID(),randomBytes(32)]);
    const insert=(mode:string)=>pool.query(`INSERT INTO cloud_workspace_generation_transitions
      (id,workspace_id,org_id,operation,source_generation,template_generation,candidate_generation,state,drain_intent_id,provision_intent_id)
      VALUES($1,$2,$3,'upgrade',1,1,2,$4,$5,$6)`,[randomUUID(),fixture.workspaceId,fixture.organizationId,test.state,mode==='drain'?drain:null,mode==='provision'?provision:null]);
    await insert(test.valid);
    await pool.query("DELETE FROM cloud_workspace_generation_transitions WHERE workspace_id=$1",[fixture.workspaceId]);
    await expect(insert(test.invalid)).rejects.toMatchObject({constraint:"cloud_generation_transition_executor"});
  });

  it("continues enforcing the original setup fence and immutable runtime pin",async()=>{
    await pool.query("UPDATE cloud_workspace_engine_instances SET last_heartbeat_at=now() WHERE id=$1",[fixture.engineInstanceId]);
    await expect(pool.query("UPDATE cloud_workspace_engine_instances SET setup_execution_fence=setup_execution_fence+1 WHERE id=$1",[fixture.engineInstanceId])).rejects.toMatchObject({code:"23514"});
    await expect(pool.query("UPDATE cloud_workspace_engine_instances SET runtime_supervisor_session_id=gen_random_uuid() WHERE id=$1",[fixture.engineInstanceId])).rejects.toMatchObject({code:"55000"});
  });
});
