import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "./test-database.js";
import { withSystemTx } from "./db.js";
import { seedOwnerDiscardDelete } from "./cloud-workspaces/owner-discard-delete-test-fixtures.js";
import { requestCloudWorkspaceDeletion } from "./cloud-workspaces/routes.js";
import { prepareCloudWorkspaceStopSeal } from "./cloud-workspaces/stop-seal.js";
const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("owner-approved discard and normal Delete baseline",()=>{
 let pool:pg.Pool;
 beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5});});
 afterAll(async()=>pool.end());
 beforeEach(async()=>resetMigratedTestDatabase(pool));
 it("raw supersession plus normal Delete cannot release the blocked source",async()=>{
  const f=await seedOwnerDiscardDelete(pool);
  const deletion=await withSystemTx(pool,async tx=>{
   await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE",[f.organizationId]);
   await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE",[f.workspaceId]);
   await tx.query("UPDATE cloud_workspace_lifecycle_intents SET state='superseded',completed_at=clock_timestamp() WHERE id=$1",[f.stopId]);
   return requestCloudWorkspaceDeletion(tx,{organizationId:f.organizationId,workspaceId:f.workspaceId,actorUserId:f.userId,idempotencyKey:randomUUID(),discardUncheckpointed:true});
  });
  const ready=await withSystemTx(pool,tx=>prepareCloudWorkspaceStopSeal(tx,{workspaceId:f.workspaceId,organizationId:f.organizationId,generation:1,intentId:deletion.intent.id,operation:"delete"}));
  expect(ready).toBe(false);
 });
 it("retains truthful missing proof and blocked recovery",async()=>{
  const f=await seedOwnerDiscardDelete(pool);
  expect((await pool.query("SELECT state,custody_id,checkpoint_id,cloud_final_save_proven(lifecycle_intent_id) AS proven FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=$1",[f.stopId])).rows)
   .toEqual([{state:"blocked",custody_id:null,checkpoint_id:null,proven:false}]);
 });
 it("refuses raw dispatch and keeps provider custody",async()=>{
  const f=await seedOwnerDiscardDelete(pool);
  await expect(pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='dispatching' WHERE id=$1",[f.stopId])).rejects.toMatchObject({code:"40001"});
  expect((await pool.query("SELECT deletion_verified_at FROM cloud_workspace_provider_bindings WHERE workspace_id=$1",[f.workspaceId])).rows).toEqual([{deletion_verified_at:null}]);
 });
});
