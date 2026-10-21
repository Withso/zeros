import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureUser, type AuthedUser } from "../auth.js";
import { HttpError } from "../authz.js";
import { createDeletionLifecycleRoutes, DeletionLifecycleProcessor } from "../deletion-lifecycle.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { applyWorkOSIdentityEvent } from "../workos-events.js";
import { ingestWorkOSManagementEvent } from "../workos-sync-events.js";
import { CloudV2Store } from "./store.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("v2 account and organization deletion", () => {
  let pool: pg.Pool, actor: AuthedUser, org: string, app: Hono, store: CloudV2Store;
  const user = () => ensureUser(pool, { provider: "workos", providerSubject: `user_${randomUUID()}`,
    email: `user-${randomUUID()}@example.test`, displayName: "Owner",
    session: { id: `session_${randomUUID()}`, clientKind: "web", authTime: Math.floor(Date.now()/1000), tokenExpiresAt: Math.floor(Date.now()/1000)+3600 } });
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    actor = await user(); org = randomUUID(); store = new CloudV2Store(pool);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Test organization',$3,false,true)", [org,`org-${org}`,actor.id]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')",[org,actor.id]);
    app = new Hono(); app.use("*", async (c,next) => { c.set("user",actor); await next(); });
    app.onError((error,c) => error instanceof HttpError ? c.json({error:error.code},error.status) : c.json({error:"internal"},500));
    app.route("/",createDeletionLifecycleRoutes(pool));
  });
  async function workspace(creator = actor.id) {
    const row = await store.createWorkspace({id:randomUUID(),organizationId:org,creatorUserId:creator,name:"Test",repository:"o/r",branch:"topic",baseBranch:"main",computerBuildId:null});
    await store.transition(row.id,["creating"],"running",{boatSandboxId:`fixture-${row.id}`});
    return row.id;
  }
  const request = (path: string, method: string, confirmation: string) => app.request(path,{method,headers:{"content-type":"application/json"},body:JSON.stringify({confirmation})});
  const state = async (id: string) => (await pool.query("SELECT state FROM cloud_v2_workspaces WHERE id=$1",[id])).rows[0]?.state;

  it("schedules all organization VMs for deletion and revokes their credentials",async () => {
    const id=await workspace(), token=await store.rotateWorkerToken(id);
    const response=await request(`/v1/organizations/${org}`,"DELETE","Test organization");
    expect(response.status).toBe(202); expect(await state(id)).toBe("deleting");
    expect(await store.byWorkerToken(token)).toBeNull();
  });

  it("deletes only the departing account's VMs in a surviving shared organization",async () => {
    const other=await user();
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')",[org,other.id]);
    const mine=await workspace(), theirs=await workspace(other.id);
    const response=await request("/v1/account/deletion","POST","DELETE MY ACCOUNT");
    expect(response.status).toBe(202); expect(await state(mine)).toBe("deleting"); expect(await state(theirs)).toBe("running");
    expect((await pool.query("SELECT deleted_at FROM organizations WHERE id=$1",[org])).rows[0].deleted_at).toBeNull();
  });

  it("retires the account's VM when WorkOS deletes its identity", async () => {
    const id = await workspace(), token = await store.rotateWorkerToken(id);
    const response = await applyWorkOSIdentityEvent(pool, {
      eventId: `event_${randomUUID()}`, eventType: "user.deleted", createdAt: new Date().toISOString(),
      user: { id: actor.identity.subject, email: actor.email, emailVerified: true, name: "Owner", profilePictureUrl: null },
    });
    expect(response.status).toBe("applied");
    expect(await state(id)).toBe("deleting");
    expect(await store.byWorkerToken(token)).toBeNull();
  });

  it("retires the organization's VM when WorkOS deletes the organization", async () => {
    const id = await workspace(), token = await store.rotateWorkerToken(id), subject = `org_${randomUUID()}`;
    await pool.query("INSERT INTO workos_organization_links(organization_id,workos_organization_id,external_id,state) VALUES($1::uuid,$2,($1::uuid)::text,'active')", [org,subject]);
    const at = new Date().toISOString();
    const response = await ingestWorkOSManagementEvent(pool, {
      id: `event_${randomUUID()}`, event: "organization.deleted", createdAt: at,
      data: { id: subject, externalId: org, name: "Test organization", updatedAt: at },
    }, "webhook");
    expect(response.status).toBe("applied");
    expect(await state(id)).toBe("deleting");
    expect(await store.byWorkerToken(token)).toBeNull();
  });

  it("keeps the organization row until VM deletion completes, then permits final purge",async () => {
    const id=await workspace();
    await request(`/v1/organizations/${org}`,"DELETE","Test organization");
    await pool.query("UPDATE deletion_requests SET requested_at=now()-interval '31 days',purge_after=now()-interval '1 day' WHERE target_id=$1",[org]);
    const processor=new DeletionLifecycleProcessor(pool,{logger:{warn(){},error(){}}});
    await processor.tick(10);
    expect((await pool.query("SELECT 1 FROM organizations WHERE id=$1",[org])).rowCount).toBe(1);
    expect(await state(id)).toBe("deleting");
    await store.transition(id,["deleting"],"deleted");
    await pool.query("UPDATE deletion_requests SET next_attempt_at=now(),lease_expires_at=NULL,lease_owner=NULL WHERE target_id=$1",[org]);
    await processor.tick(10);
    await pool.query("UPDATE deletion_requests SET next_attempt_at=now() WHERE target_id=$1",[org]);
    await processor.tick(10);
    expect((await pool.query("SELECT 1 FROM organizations WHERE id=$1",[org])).rowCount).toBe(0);
    expect(await state(id)).toBeUndefined();
  });
});
