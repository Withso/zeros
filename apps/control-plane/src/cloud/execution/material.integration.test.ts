import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../../db.js";
import { McpStore } from "../../mcp/store.js";
import { pinCloudEnvironment } from "../environment-store.js";
import { CloudExecutionLogins } from "./logins.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("execution material ownership and pins", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10, statement_timeout: 5000 }); });
  beforeEach(async () => { f = await executionFixture(pool, { teamOwnership: true }); await f.login(); await f.login(f.viewer); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  const environments = () => f.cp.routes.environments!;
  const patch = (user = f.viewer, expectedRevision = 0, value = "member-value") => environments().patch(f.organizationId, user.id, "42", f.workspace.repository,
    { expectedRevision, variables: { APP_KEY: value }, files: [{ path: ".env.local", content: `FILE_KEY=${value}` }] });
  const ready = async () => { await f.activate(); expect((await f.hello()).status).toBe(200); };
  const turn = () => f.dispatch(f.prompt(), f.viewer);

  it.each(["legacy", "prepared"])("keeps the old global environment guard in %s mode", async mode => {
    await patch(f.creator);
    await withSystemTx(pool, tx => pinCloudEnvironment(tx, f.workspace, "42"));
    await pool.query("UPDATE cloud_v2_workspaces SET execution_mode=$2 WHERE id=$1", [f.workspace.id, mode]);
    const response = await f.hello(); expect(response.status).toBe(200);
    expect((await response.json()).config).toHaveProperty("environment");
    expect((await f.cp.store.get(f.workspace.id, f.creator.id)).state).toBe("starting");
    await expect(pool.query("UPDATE cloud_v2_workspaces SET state='running' WHERE id=$1", [f.workspace.id]))
      .rejects.toMatchObject({ code: "23514", constraint: "cloud_environment_ready", message: "cloud_environment_not_ready" });
  });

  it("keeps a legacy Creator environment pin without blocking an activated boot or sharing it with a member", async () => {
    await patch(f.creator, 0, "creator-value");
    await withSystemTx(pool, tx => pinCloudEnvironment(tx, f.workspace, "42", { variables: { APP_KEY: "creator-override" }, keys: f.keys }));
    await patch();
    await ready();
    expect((await (await f.worker("config", undefined, { method: "GET" })).json()).config).not.toHaveProperty("environment");
    expect((await f.cp.store.get(f.workspace.id, f.creator.id)).state).toBe("running");
    const member = await turn();
    const memberLease = await f.worker("turn-lease", member.lease);
    expect(memberLease.status).toBe(200);
    expect((await memberLease.json()).environment).toMatchObject({ variables: { APP_KEY: "member-value" } });
    const creator = await f.dispatch(f.prompt(randomUUID(), { chatId: "creator-chat" }));
    const creatorLease = await f.worker("turn-lease", creator.lease);
    expect(creatorLease.status).toBe(200);
    expect((await creatorLease.json()).environment).toMatchObject({ variables: { APP_KEY: "creator-override" } });
  });

  it("pins the sender's variables and files through edits, then erases them on retirement", async () => {
    const saved = await patch(); await ready();
    const active = await turn(), first = await f.worker("turn-lease", active.lease);
    expect(first.status).toBe(200);
    const material = await first.json();
    expect(material.environment).toMatchObject({ versionId: saved.versionId, variables: { APP_KEY: "member-value" },
      files: [{ path: ".env.local", content: "FILE_KEY=member-value" }] });
    await patch(f.viewer, 1, "later-value");
    expect(await (await f.worker("turn-lease", active.lease)).json()).toEqual(material);
    expect(JSON.stringify((await pool.query("SELECT material FROM cloud_v2_execution_contexts WHERE id=$1", [active.begun.contextId])).rows)).not.toContain("member-value");
    expect((await pool.query("SELECT 1 FROM cloud_environment_versions WHERE id=$1", [saved.versionId])).rowCount).toBe(1);
    expect((await f.worker("execution-leases/" + active.begun.contextId + "/retired", { retirementId: randomUUID(), reason: "outcome", processes: 0 })).status).toBe(200);
    await environments().prune();
    expect((await pool.query("SELECT material,environment_version_id FROM cloud_v2_execution_contexts WHERE id=$1", [active.begun.contextId])).rows[0])
      .toEqual({ material: null, environment_version_id: null });
    expect((await pool.query("SELECT 1 FROM cloud_environment_versions WHERE id=$1", [saved.versionId])).rowCount).toBe(0);
  });

  it("keeps each person's environment after Reassign, including the original Creator's private pin", async () => {
    await patch(f.creator, 0, "creator-head");
    await withSystemTx(pool, tx => pinCloudEnvironment(tx, f.workspace, "42", { variables: { APP_KEY: "creator-override" }, keys: f.keys }));
    await patch(); await ready();
    const before = await turn(), first = await f.worker("turn-lease", before.lease);
    expect(first.status).toBe(200);
    const original = await first.json();
    const reassigned = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/reassign`, "POST", {
      requestId: randomUUID(), toUserId: f.viewer.id, expectedCreatorUserId: f.creator.id, expectedCreatorRevision: "1",
    }, f.creator, { "X-Zeros-Team-Sharing": "1", "X-Zeros-Team-Ownership": "1" });
    expect(reassigned.status).toBe(200);
    const next = await f.dispatch(f.prompt(randomUUID(), { chatId: "new-creator" }), f.viewer);
    const nextLease = await f.worker("turn-lease", next.lease);
    expect(nextLease.status).toBe(200);
    expect((await nextLease.json()).environment).toMatchObject({ variables: { APP_KEY: "member-value" } });
    const former = await f.dispatch(f.prompt(randomUUID(), { chatId: "former-creator" }));
    const formerLease = await f.worker("turn-lease", former.lease);
    expect(formerLease.status).toBe(200);
    expect((await formerLease.json()).environment).toMatchObject({ variables: { APP_KEY: "creator-override" } });
    expect(await (await f.worker("turn-lease", before.lease)).json()).toEqual(original);
  });

  it("freezes an empty environment as well as a selected version", async () => {
    await ready(); const active = await turn();
    const resolve = () => withSystemTx(pool, tx => environments().resolveExecution(f.workspace, f.viewer.id, active.begun.contextId, tx));
    expect(await resolve()).toBeUndefined();
    await patch();
    expect(await resolve()).toBeUndefined();
  });

  it("selects and pins a complete version before a concurrent edit can prune it", async () => {
    const first = await patch(); await ready(); const active = await turn();
    let entered!: () => void, release!: () => void;
    const observed = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const original = environments().resolveExecution.bind(environments());
    let intercepted = false;
    vi.spyOn(environments(), "resolveExecution").mockImplementationOnce(async (workspace, userId, contextId, tx) => {
      const query = tx.query.bind(tx);
      const spy = vi.spyOn(tx, "query").mockImplementation((async (sql: unknown, ...args: unknown[]) => {
        const result = await (query as any)(sql, ...args);
        if (!intercepted && typeof sql === "string" && sql.includes("coalesce(c.environment_version_id,p.version_id,h.version_id) AS version_id")) {
          intercepted = true; entered(); await held;
        }
        return result;
      }) as typeof tx.query);
      try { return await original(workspace, userId, contextId, tx); } finally { spy.mockRestore(); }
    });
    const leasing = f.worker("turn-lease", active.lease);
    await observed;
    let editing: Promise<unknown> | undefined;
    try {
      editing = patch(f.viewer, 1, "next-value");
      // Observe either a committed edit (the bug) or its actual lock wait;
      // do not assume elapsed time means that a competing writer arrived.
      await expect.poll(async () => {
        const changed = (await pool.query("SELECT revision FROM cloud_environment_heads WHERE org_id=$1 AND owner_user_id=$2", [f.organizationId, f.viewer.id])).rows[0];
        const blocked = (await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rowCount;
        return Number(changed.revision) === 2 || Boolean(blocked);
      }).toBe(true);
    } finally { release(); }
    const result = await leasing; await editing;
    expect(result.status).toBe(200);
    const lease = await result.json();
    expect(lease.environment.versionId).toBe(first.versionId);
    expect((await pool.query("SELECT environment_version_id FROM cloud_v2_execution_contexts WHERE id=$1", [active.begun.contextId])).rows[0].environment_version_id)
      .toBe(lease.environment.versionId);
  });

  it("selects only this sender's MCP servers and revokes on their definition change", async () => {
    const mcp = new McpStore(pool, f.keys, async () => []);
    const put = (user = f.creator, owner: "organization" | "user" = "user") => mcp.put(f.organizationId, user.id, randomUUID(), {
      kind: "mcp", owner, repository: null, expectedRevision: null,
      config: { name: "private-tools", transport: "stdio", command: "fixture-server", env: { APP_KEY: `mcp-${user.id}` } },
    });
    await put(); const own = await put(f.viewer); await put(f.creator, "organization");
    await ready(); const active = await turn(), response = await f.worker("turn-lease", active.lease);
    expect(response.status).toBe(200);
    expect((await response.json()).mcpServers).toMatchObject([{ id: own.id, env: { APP_KEY: `mcp-${f.viewer.id}` } }]);
    await mcp.remove(f.organizationId, f.viewer.id, own.id, own.revision);
    expect((await f.worker("turn-lease", active.lease)).status).toBe(409);
    expect((await pool.query("SELECT state,material FROM cloud_v2_execution_contexts WHERE id=$1", [active.begun.contextId])).rows[0])
      .toEqual({ state: "revoked", material: null });
  });

  it("selects a configured shared key first and never falls back when that configured key is unreadable", async () => {
    const selected = { selection: { source: "shared" as const, credentialId: randomUUID(), credentialRevision: "1", connectionRevision: "1" },
      material: { kind: "claude-api-key" as const, apiKey: "synthetic-shared" } };
    const shared = vi.fn(async () => selected as typeof selected | null);
    const logins = new CloudExecutionLogins(pool, f.keys, shared);
    expect(await logins.select(f.organizationId, f.viewer.id, "claude")).toEqual(selected);
    shared.mockResolvedValueOnce(null);
    expect((await logins.select(f.organizationId, f.viewer.id, "claude")).selection.source).toBe("personal");
    shared.mockRejectedValueOnce(new Error("unreadable"));
    await expect(logins.select(f.organizationId, f.viewer.id, "claude")).rejects.toMatchObject({ status: 503, code: "agent_credentials_unavailable" });
    shared.mockResolvedValueOnce({ ...selected, material: { kind: "codex-api-key", apiKey: "synthetic-wrong-provider" } } as never);
    await expect(logins.select(f.organizationId, f.viewer.id, "claude")).rejects.toMatchObject({ status: 503 });
  });
});
