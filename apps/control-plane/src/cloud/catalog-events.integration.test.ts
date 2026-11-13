import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUser, type AuthedUser } from "../auth.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { listSecurityEvents, getSecuritySnapshot } from "../security-events.js";
import { CloudV2Store, type CloudV2Workspace } from "./store.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("committed cloud catalog changes", () => {
  let pool: pg.Pool, user: AuthedUser, org: string, workspace: CloudV2Workspace, store: CloudV2Store;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    const id = randomUUID();
    user = await ensureUser(pool, { provider: "workos", providerSubject: `user_catalog_${id}`, email: `catalog-${id}@example.test`, displayName: "Catalog fixture" });
    await grantTestPro(pool, user.id); org = randomUUID();
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Catalog',$3,false,true)", [org, `catalog-${org}`, user.id]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, user.id]);
    store = new CloudV2Store(pool);
    workspace = await store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: user.id, repository: "fixture/project",
      branch: "topic", baseBranch: "main", name: "Workspace", computerBuildId: null });
  });
  const hints = async (after = 0) => (await listSecurityEvents(pool, user, after)).filter(event => event.payload.resource === "cloud_workspace");

  it("replays creation from the account stream without a pre-existing workspace subscription", async () => {
    expect(await hints()).toEqual([expect.objectContaining({ kind: "organization.data_changed", organizationId: org, workspaceId: null,
      payload: { resource: "cloud_workspace", workspaceId: workspace.id, change: "created" } })]);
  });

  it.each([
    ["title", "UPDATE cloud_v2_workspaces SET title='New title' WHERE id=$1", "document"],
    ["name", "UPDATE cloud_v2_workspaces SET name='Renamed' WHERE id=$1", "document"],
    ["state", "UPDATE cloud_v2_workspaces SET state='stopped' WHERE id=$1", "lifecycle"],
    ["route condition", "UPDATE cloud_v2_workspaces SET error_code='live_connection_unavailable' WHERE id=$1", "lifecycle"],
    ["archive", "UPDATE cloud_v2_workspaces SET archived_at=clock_timestamp() WHERE id=$1", "document"],
    ["setup", "UPDATE cloud_v2_workspaces SET setup_status='{\"state\":\"succeeded\"}' WHERE id=$1", "document"],
    ["follower", "INSERT INTO cloud_v2_workspace_followers(workspace_id,org_id,user_id) SELECT id,org_id,creator_user_id FROM cloud_v2_workspaces WHERE id=$1", "document"],
    ["pin", "INSERT INTO cloud_v2_workspace_pins(workspace_id,org_id,user_id) SELECT id,org_id,creator_user_id FROM cloud_v2_workspaces WHERE id=$1", "document"],
  ])("covers an N-1 %s writer without application-side emission", async (_name, sql, change) => {
    const cursor = (await getSecuritySnapshot(pool, user)).cursor;
    await pool.query(sql!, [workspace.id]);
    expect(await hints(cursor)).toEqual([expect.objectContaining({ payload: { resource: "cloud_workspace", workspaceId: workspace.id, change } })]);
  });

  it("covers an N-1 ownership writer without application-side emission", async () => {
    const id = randomUUID();
    const successor = await ensureUser(pool, { provider: "workos", providerSubject: `user_successor_${id}`,
      email: `successor-${id}@example.test`, displayName: "Successor fixture" });
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [org, successor.id]);
    const cursor = (await getSecuritySnapshot(pool, user)).cursor;
    await pool.query("UPDATE cloud_v2_workspaces SET creator_user_id=$2 WHERE id=$1", [workspace.id, successor.id]);
    expect(await hints(cursor)).toEqual([expect.objectContaining({
      payload: { resource: "cloud_workspace", workspaceId: workspace.id, change: "document" },
    })]);
  });

  it("keeps a deleted workspace's invalidation replayable", async () => {
    const cursor = (await getSecuritySnapshot(pool, user)).cursor;
    await pool.query("DELETE FROM cloud_v2_workspaces WHERE id=$1", [workspace.id]);
    expect(await hints(cursor)).toEqual([expect.objectContaining({ workspaceId: null, payload: { resource: "cloud_workspace", workspaceId: workspace.id, change: "deleted" } })]);
  });

  it("emits pull-request and checkout changes but ignores provider check timestamps", async () => {
    await pool.query("INSERT INTO cloud_v2_github_workspaces(workspace_id,repository_id,canonical_repository) VALUES($1,42,'fixture/project')", [workspace.id]);
    let cursor = (await getSecuritySnapshot(pool, user)).cursor;
    await pool.query("UPDATE cloud_v2_github_workspaces SET pr_number=7,pr_state='ready',pr_url='https://github.com/fixture/project/pull/7' WHERE workspace_id=$1", [workspace.id]);
    expect(await hints(cursor)).toEqual([expect.objectContaining({ payload: { resource: "cloud_workspace", workspaceId: workspace.id, change: "pull_request" } })]);
    cursor = (await getSecuritySnapshot(pool, user)).cursor;
    await pool.query("UPDATE cloud_v2_github_workspaces SET updated_at=clock_timestamp(),repository_observed_at=clock_timestamp() WHERE workspace_id=$1", [workspace.id]);
    expect(await hints(cursor)).toEqual([]);
  });

  it("does not turn transcript delivery or internal bookkeeping into catalog refreshes", async () => {
    const cursor = (await getSecuritySnapshot(pool, user)).cursor;
    await pool.query("INSERT INTO cloud_v2_chats(workspace_id,chat_id,row) VALUES($1,'chat','{}')", [workspace.id]);
    await pool.query("INSERT INTO cloud_v2_messages(workspace_id,chat_id,msg_id,kind,payload,created_at_ms) VALUES($1,'chat','item','text','text',1)", [workspace.id]);
    await pool.query("UPDATE cloud_v2_workspaces SET updated_at=clock_timestamp(),attempts=attempts+1,boat_sandbox_id='bx_catalog' WHERE id=$1", [workspace.id]);
    expect(await hints(cursor)).toEqual([]);
  });

  it("does not turn 30-second activity updates into catalog refreshes", async () => {
    const cursor = (await getSecuritySnapshot(pool, user)).cursor;
    for (let beat = 0; beat < 3; beat++)
      await pool.query("UPDATE cloud_v2_workspaces SET active_at=clock_timestamp()+$2*interval '30 seconds' WHERE id=$1", [workspace.id, beat]);
    expect(await hints(cursor)).toEqual([]);
  });

  it("leaves cost-only changes to the next catalog read", async () => {
    const cursor = (await getSecuritySnapshot(pool, user)).cursor;
    await store.writeHistory(workspace.id, { messages: { chatId: "cost-chat", rows: [{ msgId: "cost", kind: "text", createdAt: 1,
      payload: JSON.stringify({ role: "user", turnSummary: { usage: { totalCostUsd: 2, costKind: "estimated" } } }) }] } });
    expect((await store.get(workspace.id, user.id)).agentCost).toEqual({ totalUsd: 2, estimated: true });
    expect(await hints(cursor)).toEqual([]);
  });

  it("emits no catalog hint when a history replacement preserves the final cost", async () => {
    const messages = { chatId: "cost-chat", rows: [{ msgId: "cost", kind: "text", createdAt: 1,
      payload: JSON.stringify({ role: "user", turnSummary: { usage: { totalCostUsd: 2, costKind: "reported" } } }) }] };
    await store.writeHistory(workspace.id, { messages });
    const cursor = (await getSecuritySnapshot(pool, user)).cursor;
    await store.writeHistory(workspace.id, { messages: { ...messages, replace: true } });
    expect((await store.get(workspace.id, user.id)).agentCost).toEqual({ totalUsd: 2, estimated: false });
    expect(await hints(cursor)).toEqual([]);
  });

  it.each(["checkout_boot_id", "pr_connection_generation"])("publishes a %s visibility change", async field => {
    await pool.query("INSERT INTO cloud_v2_github_workspaces(workspace_id,repository_id,canonical_repository) VALUES($1,42,'fixture/project')", [workspace.id]);
    const cursor = (await getSecuritySnapshot(pool, user)).cursor;
    await pool.query(`UPDATE cloud_v2_github_workspaces SET ${field}=$2 WHERE workspace_id=$1`, [workspace.id, randomUUID()]);
    expect(await hints(cursor)).toEqual([expect.objectContaining({
      payload: { resource: "cloud_workspace", workspaceId: workspace.id, change: "pull_request" },
    })]);
  });

  it("publishes only committed changes and preserves current membership filtering", async () => {
    const cursor = (await getSecuritySnapshot(pool, user)).cursor, writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("UPDATE cloud_v2_workspaces SET title='Uncommitted' WHERE id=$1", [workspace.id]);
      expect(await hints(cursor)).toEqual([]);
      await writer.query("ROLLBACK");
      expect(await hints(cursor)).toEqual([]);
      await pool.query("UPDATE cloud_v2_workspaces SET title='Committed' WHERE id=$1", [workspace.id]);
      expect(await hints(cursor)).toHaveLength(1);
      await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, user.id]);
      expect(await hints(cursor)).toEqual([]);
    } finally { await writer.query("ROLLBACK"); writer.release(); }
  });

  it("keeps catalog changes off the authority channel while retaining authority wakeups", async () => {
    const listener = await pool.connect(), channels: string[] = [];
    const received = (message: pg.Notification) => channels.push(message.channel);
    listener.on("notification", received);
    try {
      await listener.query("LISTEN zeros_cloud_v2_catalog;LISTEN zeros_security_event");
      await pool.query("UPDATE cloud_v2_workspaces SET title='Updated' WHERE id=$1", [workspace.id]);
      await vi.waitFor(() => expect(channels).toContain("zeros_cloud_v2_catalog"));
      expect(channels).not.toContain("zeros_security_event");
      await pool.query("INSERT INTO security_events(kind,org_id) VALUES('organization.authorization_changed',$1)", [org]);
      await vi.waitFor(() => expect(channels).toContain("zeros_security_event"));
    } finally { await listener.query("UNLISTEN *"); listener.off("notification", received); listener.release(); }
  });

  it("does not prevent an organization cascade when its catalog becomes inaccessible", async () => {
    await pool.query("DELETE FROM organizations WHERE id=$1", [org]);
    expect(await hints()).toEqual([]);
  });

  it("installs as a non-superuser owner and emits under the runtime role without custom function settings", async () => {
    const tx = await pool.connect(), owner = `catalog_owner_${randomUUID().replaceAll("-", "")}`;
    try {
      await tx.query("BEGIN");
      await tx.query(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await tx.query(`GRANT USAGE,CREATE ON SCHEMA public TO ${owner}`);
      await tx.query("DROP FUNCTION notify_cloud_v2_catalog_row() CASCADE");
      await tx.query("ALTER TABLE local_command_devices DROP COLUMN liveness_instance_id,DROP COLUMN liveness_stream_id");
      for (const table of ["local_command_devices", "cloud_v2_workspaces", "cloud_v2_github_workspaces",
        "cloud_v2_workspace_followers", "cloud_v2_workspace_pins"]) await tx.query(`ALTER TABLE ${table} OWNER TO ${owner}`);
      await tx.query(`ALTER FUNCTION notify_security_event() OWNER TO ${owner}`);
      await tx.query(`SET LOCAL ROLE ${owner}`);
      expect((await tx.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows)
        .toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await tx.query(readFileSync(new URL("../../migrations/0249_cloud_push_signals.sql", import.meta.url), "utf8"));
      expect((await tx.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid='notify_cloud_v2_catalog_row()'::regprocedure")).rows)
        .toEqual([{ prosecdef: false, proconfig: ["search_path=pg_catalog, public, pg_temp"] }]);
      await tx.query("SET LOCAL ROLE zeros_app");
      await tx.query("SELECT set_config('app.system','on',true)");
      expect((await tx.query("UPDATE cloud_v2_workspaces SET title='Runtime role' WHERE id=$1", [workspace.id])).rowCount).toBe(1);
      expect((await tx.query("SELECT count(*)::int AS count FROM security_events WHERE org_id=$1 AND payload->>'change'='document'", [org])).rows)
        .toEqual([{ count: 1 }]);
    } finally { await tx.query("ROLLBACK"); tx.release(); }
  });
});
