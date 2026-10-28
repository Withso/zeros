import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUser, type AuthedUser } from "../auth.js";
import { HttpError } from "../authz.js";
import { createDeletionLifecycleRoutes, DeletionLifecycleProcessor } from "../deletion-lifecycle.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { applyWorkOSIdentityEvent } from "../workos-events.js";
import { ingestWorkOSManagementEvent } from "../workos-sync-events.js";
import { CloudV2Store } from "./store.js";
import { CloudV2Computers, CloudV2ComputerBuilder, cloudV2SnapshotName } from "./computer.js";
import type { CloudV2Compute } from "./boat.js";

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
  function computer() {
    const computers = new CloudV2Computers(pool, pool, async (_org, _user, target) => ({ repository: target.repository, repositoryId: "42" }));
    const compute: CloudV2Compute = {
      create: vi.fn(async () => ({ sandboxId: "bx_builder1" })),
      resume: vi.fn(), extendLease: vi.fn(async () => {}), stop: vi.fn(), delete: vi.fn(async () => {}), deleteSnapshot: vi.fn(async () => {}),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: "", timedOut: false })),
      execLong: vi.fn(async () => ({ exitCode: 0, stdout: `zeros-build-branch=main\n${"a".repeat(40)}\n`, timedOut: false })),
      saveSnapshot: vi.fn(async () => {}),
    };
    const builder = new CloudV2ComputerBuilder({ computers, compute, channel: "dev",
      runtime: { sha256: "b".repeat(64), url: async () => "https://example.test/runtime" }, cloneToken: async () => "fixture" });
    return { computers, compute, builder, recipe: { repositories: [{ repository: "o/r" }] } };
  }
  async function tryPurge() {
    const processor = new DeletionLifecycleProcessor(pool, { logger: { warn() {}, error() {} } });
    for (let i = 0; i < 3; i++) {
      await pool.query(`UPDATE deletion_requests SET requested_at=now()-interval '31 days',purge_after=now()-interval '1 day',
        next_attempt_at=now(),lease_expires_at=NULL,lease_owner=NULL WHERE target_id=$1`, [org]);
      await processor.tick(10);
    }
    return (await pool.query("SELECT 1 FROM organizations WHERE id=$1", [org])).rowCount;
  }

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

  it("retains an organization with no workspaces until every Computer resource deletion is confirmed", async () => {
    const { computers, compute, builder, recipe } = computer();
    const build = await computers.enqueue(org, actor.id, recipe);
    vi.mocked(compute.delete).mockRejectedValue(new Error("provider unavailable"));
    await builder.tick();
    await request(`/v1/organizations/${org}`, "DELETE", "Test organization");
    expect(await tryPurge()).toBe(1);
    vi.mocked(compute.delete).mockResolvedValue(undefined);
    vi.mocked(compute.deleteSnapshot).mockRejectedValue(new Error("provider unavailable"));
    await builder.cleanup();
    expect(await tryPurge()).toBe(1);
    const retained = (await pool.query("SELECT builder_deleted_at, snapshot_id, snapshot_deleted_at FROM cloud_v2_computer_builds WHERE id=$1", [build.id])).rows[0];
    expect(retained.builder_deleted_at).not.toBeNull();
    expect(retained.snapshot_deleted_at).toBeNull();
    expect(retained.snapshot_id).toBe(cloudV2SnapshotName("dev", org, 1));
    vi.mocked(compute.deleteSnapshot).mockResolvedValue(undefined);
    await builder.cleanup();
    expect(compute.deleteSnapshot).toHaveBeenCalledWith(cloudV2SnapshotName("dev", org, 1));
    expect(await tryPurge()).toBe(0);
  });

  it.each(["create", "snapshot"])("fences an in-flight %s and retains its identity until cleanup", async stage => {
    const { computers, compute, builder, recipe } = computer();
    const job = await computers.enqueue(org, actor.id, recipe);
    let release!: () => void;
    if (stage === "create") vi.mocked(compute.create).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ sandboxId: "bx_late1" }); }));
    else vi.mocked(compute.saveSnapshot).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const running = builder.tick();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    try {
      expect((await request(`/v1/organizations/${org}`, "DELETE", "Test organization")).status).toBe(202);
      expect(await tryPurge()).toBe(1);
      await builder.cleanup(); // Must not wait on or race the live provider call.
      expect(await tryPurge()).toBe(1);
    } finally { release(); await running; }
    await builder.cleanup();
    expect((await computers.overview(org)).activeBuildId).toBeNull();
    expect((await computers.overview(org)).builds[0]).toMatchObject({ id: job.id, state: "cancelled" });
    expect(compute.delete).toHaveBeenCalledWith(stage === "create" ? "bx_late1" : "bx_builder1");
    if (stage === "create") expect(compute.exec).not.toHaveBeenCalled();
    expect(await tryPurge()).toBe(0);
  });

  it("keeps a surviving organization's Computer when one account leaves", async () => {
    const other = await user();
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, other.id]);
    const { computers, builder, compute, recipe } = computer();
    await computers.enqueue(org, actor.id, recipe); await builder.tick();
    await request("/v1/account/deletion", "POST", "DELETE MY ACCOUNT");
    await builder.cleanup();
    expect((await computers.overview(org)).snapshotName).toBe(cloudV2SnapshotName("dev", org, 1));
    expect(compute.deleteSnapshot).not.toHaveBeenCalled();
  });

  it.each(["create", "snapshot"])("recovers a lost %s reply after its request deadline before allowing erasure", async stage => {
    const { computers, compute, builder, recipe } = computer();
    const job = await computers.enqueue(org, actor.id, recipe);
    if (stage === "create") vi.mocked(compute.create).mockRejectedValueOnce(new Error("reply lost after provider committed"));
    else vi.mocked(compute.saveSnapshot).mockRejectedValueOnce(new Error("save reply lost"));
    await builder.tick();
    await request(`/v1/organizations/${org}`, "DELETE", "Test organization");
    await builder.cleanup();
    expect(await tryPurge()).toBe(1);
    expect(compute.deleteSnapshot).not.toHaveBeenCalled();
    await pool.query("UPDATE cloud_v2_computer_builds SET operation_until=now()-interval '1 second' WHERE id=$1", [job.id]);
    await builder.cleanup();
    if (stage === "create") {
      expect(compute.create).toHaveBeenCalledTimes(2);
      expect(vi.mocked(compute.create).mock.calls[0]).toEqual(vi.mocked(compute.create).mock.calls[1]);
      expect(compute.exec).not.toHaveBeenCalled();
    }
    expect(compute.delete).toHaveBeenCalledWith("bx_builder1");
    expect(compute.deleteSnapshot).toHaveBeenCalledWith(cloudV2SnapshotName("dev", org, 1));
    expect(await tryPurge()).toBe(0);
  });

  it("fences queued builds and also verifies old snapshot names whose identity was cleared early", async () => {
    const { computers, compute, builder, recipe } = computer();
    const first = await computers.enqueue(org, actor.id, recipe); await builder.tick();
    await pool.query("UPDATE cloud_v2_computer_builds SET snapshot_id=NULL,snapshot_deleted_at=NULL WHERE id=$1", [first.id]);
    await computers.enqueue(org, actor.id, recipe);
    await request(`/v1/organizations/${org}`, "DELETE", "Test organization");
    await expect(computers.enqueue(org, actor.id, recipe)).rejects.toMatchObject({ status: 404 });
    await builder.tick();
    expect(compute.create).toHaveBeenCalledTimes(1);
    expect(compute.deleteSnapshot).toHaveBeenCalledWith(cloudV2SnapshotName("dev", org, 1));
    expect(await tryPurge()).toBe(0);
  });
});
