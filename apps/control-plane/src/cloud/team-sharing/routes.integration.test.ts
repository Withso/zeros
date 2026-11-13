import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { teamSharingFixture, type TeamSharingFixture } from "./test-fixture.js";
import { CloudV2CapabilitiesSchema } from "../contract.js";
import { withSystemTx } from "../../db.js";
import { CloudV2Computers } from "../computer.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("opt-in cloud team sharing through the real router", () => {
  let pool: pg.Pool, f: TeamSharingFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL,max: 6 }); });
  beforeEach(async () => { f = await teamSharingFixture(pool); });
  afterAll(async () => { await pool.end(); });
  const path = () => `/v1/cloud-v2/workspaces/${f.workspace.id}`;

  it("includes both the viewer's OWN workspaces and teammates' workspaces", async () => {
    const response = await f.call(`/v1/cloud-v2/workspaces?organizationId=${f.organizationId}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ teamSharing: 1,nextCursor: null });
    expect(new Set(body.workspaces.map((row: { id: string }) => row.id))).toEqual(new Set([f.workspace.id,f.own.id]));
    expect(body.workspaces.find((row: { id: string }) => row.id === f.own.id)).toMatchObject({ viewerRole: "creator",readOnly: false,canManage: true });
    expect(body.workspaces.find((row: { id: string }) => row.id === f.workspace.id)).toMatchObject({ viewerRole: "member",readOnly: true,canManage: false });
  });

  it.each([50,200])("shares source admission and batches database reads for a warm %i-workspace page", async count => {
    for (let n=0;n<count-2;n++) await f.store.createWorkspace({ id: randomUUID(),organizationId: f.organizationId,
      creatorUserId: f.creator.id,name: `Workspace ${n}`,repository: "example/project",sourceRepositoryId: "42",
      branch: `page-${n}`,baseBranch: "main",computerBuildId: null });
    expect((await f.call(path())).status).toBe(200);
    f.fetcher.mockClear();
    const connects = vi.spyOn(pool,"connect");
    try {
      const response = await f.call(`/v1/cloud-v2/workspaces?organizationId=${f.organizationId}&limit=${count}`);
      expect(response.status).toBe(200);
      expect((await response.json()).workspaces).toHaveLength(count);
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(connects.mock.calls.length).toBeLessThanOrEqual(16);
      process.stdout.write(`[team-sharing] page-cost ${JSON.stringify({ workspaces: count,checkouts: connects.mock.calls.length,githubCalls: f.fetcher.mock.calls.length })}\n`);
    } finally { connects.mockRestore(); }
  },15_000);

  it("opens a teammate's shareable link while keeping non-opt-in reads creator-only", async () => {
    const response = await f.call(`/v1/cloud-v2/workspaces/by-number/org-${f.organizationId}/${f.workspace.number}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ teamSharing: 1,workspace: { id: f.workspace.id,createdByUserId: f.creator.id } });
    expect((await f.call(path(),"GET",undefined,f.viewer,false)).status).toBe(404);
    const legacy = await (await f.call(`/v1/cloud-v2/workspaces?organizationId=${f.organizationId}`,"GET",undefined,f.viewer,false)).json();
    expect(legacy.teamSharing).toBeUndefined();
    expect(legacy.workspaces.map((row: { id: string }) => row.id)).toEqual([f.own.id]);
  });

  it("reads a stopped workspace's transcript without waking or giving a bridge ticket", async () => {
    await pool.query("INSERT INTO cloud_v2_chats(workspace_id,chat_id,row) VALUES($1,'chat',$2)",[f.workspace.id,{ id: "chat",title: "Team chat" }]);
    const response = await f.call(`${path()}/history`,"POST",{ op: "chats.list",params: {} });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain("Team chat");
    const connect = await f.call(`${path()}/connect`,"POST",{});
    expect(connect.status).toBe(409);
    expect(await connect.json()).toMatchObject({ error: { code: "workspace_read_only" } });
    expect((await f.store.get(f.workspace.id,f.creator.id)).state).toBe("stopped");
    expect((await pool.query("SELECT 1 FROM cloud_v2_tokens WHERE workspace_id=$1",[f.workspace.id])).rowCount).toBe(0);
  });

  it("lets an admin stop another Creator's VM but never start or restart it", async () => {
    await f.store.transition(f.workspace.id,["stopped"],"running");
    const response = await f.call(`${path()}/stop`,"POST",undefined,f.admin);
    expect(response.status).toBe(202);
    expect((await response.json()).workspace.state).toBe("stopping");
    for (const action of ["start","restart","connect"]) {
      const denied = await f.call(`${path()}/${action}`,"POST",undefined,f.admin);
      expect(denied.status).toBe(409);
      expect(await denied.json()).toMatchObject({ error: { code: "workspace_read_only" } });
    }
  });

  it("keeps the released strict capabilities document valid and sharing fields top-level", async () => {
    const shared = await (await f.call(path())).json();
    expect(CloudV2CapabilitiesSchema.safeParse(shared.workspace.capabilities).success).toBe(true);
    expect(shared.workspace.capabilities.teamSharing).toBeUndefined();
    expect(shared.workspace).toMatchObject({ teamSharing: 1,following: false,pinned: false,followerIds: [],followerCount: 0 });
    const legacy = await (await f.call(path(),"GET",undefined,f.creator,false)).json();
    for (const key of ["teamSharing","createdByUserId","viewerRole","readOnly","canManage","following","pinned","followerIds","followerCount"])
      expect(legacy.workspace[key]).toBeUndefined();
  });

  it("preserves the Creator's existing GitHub body bound when sharing is opted in", async () => {
    const request = { op: "gh.prCreate",expected: { connectionGeneration: "fixture",repositoryId: "42",repository: "example/project",
      branch: "work",baseBranch: "main",contextRevision: "fixture" },params: { title: "Fixture",body: "x".repeat(32*1024) } };
    const legacy = await f.call(`${path()}/github`,"POST",request,f.creator,false);
    const shared = await f.call(`${path()}/github`,"POST",request,f.creator);
    expect(legacy.status).not.toBe(413);
    expect(shared.status).toBe(legacy.status);
    expect(await shared.json()).toEqual(await legacy.json());
  });

  it("hides foreign organizations but admits members without GitHub access to snapshot sources", async () => {
    const id = randomUUID();
    await withSystemTx(pool,async tx => {
      await tx.query(`INSERT INTO cloud_v2_workspaces(id,org_id,creator_user_id,name,repository,branch,base_branch,state,source_repositories)
        VALUES($1,$2,$3,'Snapshot','example/project','snapshot','main','running',ARRAY['example/project','example/snapshot'])`,[id,f.organizationId,f.creator.id]);
      await tx.query(`INSERT INTO cloud_v2_github_sources(workspace_id,source_repository,repository_id)
        VALUES($1,'example/project',42),($1,'example/snapshot',43)`,[id]);
    });
    f.denied.add(`${f.viewer.id}:43`);
    expect((await f.call(`/v1/cloud-v2/workspaces/${id}`)).status).toBe(200);
    const list = await (await f.call(`/v1/cloud-v2/workspaces?organizationId=${f.organizationId}`)).json();
    expect(list.workspaces.map((row: { id: string }) => row.id).sort()).toEqual([f.workspace.id,f.own.id,id].sort());
    expect((await f.call(path(),"GET",undefined,f.outsider)).status).toBe(404);
    expect((await f.call(`/v1/cloud-v2/workspaces?organizationId=${f.organizationId}`,"GET",undefined,f.outsider)).status).toBe(404);
    expect((await f.call(`/v1/cloud-v2/workspaces/${id}`,"GET",undefined,f.admin)).status).toBe(200);
    expect((await pool.query("SELECT state FROM cloud_v2_workspaces WHERE id=$1",[id])).rows[0].state).toBe("running");
  });

  it("returns the membership catalog without provider calls during a GitHub outage", async () => {
    f.unavailable.add(f.viewer.id);
    const response = await f.call(`/v1/cloud-v2/workspaces?organizationId=${f.organizationId}`);
    expect(response.status).toBe(200);
    expect((await response.json()).workspaces).toHaveLength(2);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect((await f.call(path(),"GET",undefined,f.admin)).status).toBe(200);
  });

  it("never treats an empty or pending source scope as another member's access", async () => {
    const computers = new CloudV2Computers(pool,pool,async (_org,_user,target) => ({ repository: target.repository,repositoryId: "42" }));
    const build = await computers.enqueue(f.organizationId,f.creator.id,{ repositories: [{ repository: "example/project",branch: "main" }] });
    await computers.claim(); await computers.activate(build.id,"synthetic-snapshot");
    const pending = await f.store.createWorkspace({ id: randomUUID(),organizationId: f.organizationId,creatorUserId: f.creator.id,
      name: "Pending",repository: "example/project",branch: "pending",baseBranch: "main",computerBuildId: build.id,pendingSource: true });
    expect((await f.call(`/v1/cloud-v2/workspaces/${pending.id}`)).status).toBe(404);
    expect((await f.call(`/v1/cloud-v2/workspaces/${pending.id}`,"GET",undefined,f.creator)).status).toBe(200);
    await pool.query("DELETE FROM cloud_v2_github_sources WHERE workspace_id=$1",[f.workspace.id]);
    expect((await f.call(path())).status).toBe(503);
  });

  it.each(["signout","membership","hold","account deletion","fingerprint","epoch"] as const)("fences a %s change after an awaited metadata read", async change => {
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const original = f.github.metadata.documents.bind(f.github.metadata);
    vi.spyOn(f.github.metadata,"documents").mockImplementationOnce(async (...args) => { const rows = await original(...args); entered(); await held; return rows; });
    const response = f.call(path()); await reached;
    try {
      if (change === "signout") await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE provider_session_id=$1",[f.viewer.authentication.sessionId]);
      if (change === "membership") await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2",[f.organizationId,f.viewer.id]);
      if (change === "account deletion") await pool.query("UPDATE users SET auth_status='deleted',deleted_at=now() WHERE id=$1",[f.viewer.id]);
      if (change === "fingerprint") await pool.query("UPDATE cloud_github_selections SET generation=gen_random_uuid() WHERE org_id=$1 AND owner_user_id=$2",[f.organizationId,f.viewer.id]);
      if (change === "epoch") await pool.query("UPDATE cloud_v2_workspaces SET access_epoch=access_epoch+1 WHERE id=$1",[f.workspace.id]);
      if (change === "hold") {
        for (let n=0;n<5;n++) {
          const id = randomUUID(); await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')",[id,`${id}@example.test`]);
          await pool.query("INSERT INTO organization_members(org_id,user_id,role,created_at) VALUES($1,$2,'member',now()-interval '1 day')",[f.organizationId,id]);
        }
        await pool.query("UPDATE account_entitlements SET status='cancelled',cloud_workspaces_allowed=false WHERE user_id=$1",[f.viewer.id]);
      }
    } finally { release(); }
    const result = await response;
    if (change === "fingerprint") {
      expect(result.status).toBe(200);
      expect((await result.json()).workspace.id).toBe(f.workspace.id);
    } else {
      expect([401,404]).toContain(result.status);
      expect((await result.json()).workspace).toBeUndefined();
    }
    expect((await f.store.get(f.workspace.id,f.creator.id)).state).toBe("stopped");
  });

  it("keeps ordinary reads lock-free while the lifecycle holds the workspace row", async () => {
    const lock = await pool.connect();
    await lock.query("BEGIN"); await lock.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE",[f.workspace.id]);
    try {
      expect((await f.call(path())).status).toBe(200);
      expect((await f.call(`${path()}/history`,"POST",{ op: "chats.list" })).status).toBe(200);
      expect((await f.call(`${path()}/prompts?chatId=chat`)).status).toBe(200);
    } finally { await lock.query("ROLLBACK"); lock.release(); }
  },5_000);

  it.each(["rename","stop","chats/chat/edit"])("rolls back admin %s if the session is revoked after its authority read", async action => {
    await f.store.transition(f.workspace.id,["stopped"],"running");
    await pool.query("INSERT INTO cloud_v2_chats(workspace_id,chat_id,row) VALUES($1,'chat',$2)",[f.workspace.id,{ id: "chat",title: "Before" }]);
    const boot = randomUUID();
    await pool.query("UPDATE cloud_v2_workspaces SET worker_boot_id=$2,chat_edit_boot_ids=ARRAY[$2::uuid] WHERE id=$1",[f.workspace.id,boot]);
    const original = f.sharing.manager.bind(f.sharing);
    vi.spyOn(f.sharing,"manager").mockImplementationOnce(async (...args) => {
      await original(...args);
      await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE provider_session_id=$1",[f.admin.authentication.sessionId]);
    });
    const response = await f.call(`${path()}/${action}`,"POST",action === "rename" ? { name: "After" } : action.includes("edit") ? { title: "After" } : undefined,f.admin);
    expect(response.status).toBe(401);
    expect((await f.store.get(f.workspace.id,f.creator.id)).state).toBe("running");
    expect((await pool.query("SELECT title FROM cloud_v2_workspaces WHERE id=$1",[f.workspace.id])).rows[0].title).not.toBe("After");
    expect((await pool.query("SELECT row->>'title' AS title FROM cloud_v2_chats WHERE workspace_id=$1",[f.workspace.id])).rows[0].title).toBe("Before");
    expect((await pool.query("SELECT 1 FROM cloud_v2_chat_edits WHERE workspace_id=$1",[f.workspace.id])).rowCount).toBe(0);
  });

  it("retains the focused-activity rate limit for shared readers", async () => {
    for (let n=0;n<12;n++) expect((await f.call(`${path()}/activity`,"POST")).status).toBe(200);
    const limited = await f.call(`${path()}/activity`,"POST");
    expect(limited.status).toBe(429); expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await f.store.get(f.workspace.id,f.creator.id)).state).toBe("stopped");
  });

  it("permits admin metadata management but keeps every execution entrance Creator-only", async () => {
    await pool.query("INSERT INTO cloud_v2_chats(workspace_id,chat_id,row) VALUES($1,'chat',$2)",[f.workspace.id,{ id: "chat",title: "Before" }]);
    for (const user of [f.viewer,f.admin]) {
      for (const action of ["connect","start","restart","prompts","prompts/stop","github"]) {
        const response = await f.call(`${path()}/${action}`,"POST",{ canManage: true,creatorUserId: user.id },user);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: "workspace_read_only" } });
      }
      for (const suffix of ["/macs","/sync/grant"]) expect((await f.call(`${path()}${suffix}`,suffix.includes("grant") ? "POST" : "GET",undefined,user)).status).toBe(404);
      await expect(f.store.get(f.workspace.id,user.id)).rejects.toMatchObject({ status: 404 });
      await expect(f.store.issueToken({ workspaceId: f.workspace.id,userId: user.id,kind: "connect",ttlMs: 60_000,authority: user })).rejects.toMatchObject({ status: 404 });
    }
    const renamed = await f.call(`${path()}/rename`,"POST",{ name: "  New name  " },f.admin);
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).workspace).toMatchObject({ title: "New name",readOnly: true,canManage: true });
    const edited = await f.call(`${path()}/chats/chat/edit`,"POST",{ title: "Admin title" },f.admin);
    expect(edited.status).toBe(200);
    for (const action of ["stop","archive","rename","chats/chat/edit"]) expect((await f.call(`${path()}/${action}`,"POST",
      action === "rename" ? { name: "Refused" } : action.includes("edit") ? { title: "Refused" } : undefined)).status).toBe(403);
    expect((await f.call(`${path()}/archive`,"POST",undefined,f.admin)).status).toBe(200);
    expect((await f.store.get(f.workspace.id,f.creator.id)).state).toBe("stopped");
    expect((await f.call(path(),"DELETE",undefined,f.admin)).status).toBe(202);
    expect((await f.store.get(f.workspace.id,f.creator.id)).state).toBe("deleting");
  });

  it("keeps existing chat-edit conflicts for authorized admins and never wakes", async () => {
    await pool.query("INSERT INTO cloud_v2_chats(workspace_id,chat_id,row) VALUES($1,'chat',$2)",[f.workspace.id,{ id: "chat",title: "Before" }]);
    await f.store.transition(f.workspace.id,["stopped"],"running");
    const legacy = await f.call(`${path()}/chats/chat/edit`,"POST",{ title: "Unavailable" },f.admin);
    expect(legacy.status).toBe(409); expect(await legacy.json()).toMatchObject({ error: { code: "worker_update_required" } });
    const boot = randomUUID();
    await pool.query("UPDATE cloud_v2_workspaces SET worker_boot_id=$2,chat_edit_boot_ids=ARRAY[$2::uuid] WHERE id=$1",[f.workspace.id,boot]);
    await f.store.prompts.enqueue(f.workspace.id,f.creator.id,{ chatId: "chat",userMessageId: "message",agentId: "codex",startedAt: 1,prompt: [{ type: "text",text: "Fixture" }] },f.creator);
    const busy = await f.call(`${path()}/chats/chat/edit`,"POST",{ archived: true },f.admin);
    expect(busy.status).toBe(409); expect(await busy.json()).toMatchObject({ error: { code: "session_busy" } });
  });
});
