import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoutes } from "../../routes.js";
import { withSystemTx } from "../../db.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("active workspace per-person access loss", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => {
    f = await executionFixture(pool);
    f.app.route("/", createRoutes(pool));
    await f.activate();
    expect((await f.hello()).status).toBe(200);
    await f.login(f.creator); await f.login(f.viewer);
  });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  const workspace = async () => (await pool.query(`SELECT state,access_epoch,stop_generation,worker_boot_id,
    encode(worker_token_hash,'hex') AS worker_token_hash FROM cloud_v2_workspaces WHERE id=$1`, [f.workspace.id])).rows[0];
  const context = async (id: string) => (await pool.query(
    "SELECT state,reason,material IS NOT NULL AS has_material FROM cloud_v2_execution_contexts WHERE id=$1", [id])).rows[0];
  const begin = async (user = f.creator, chatId = randomUUID()) => {
    const turn = await f.dispatch(f.prompt(randomUUID(), { chatId }), user);
    expect((await f.worker("turn-lease", turn.lease)).status).toBe(200);
    return turn;
  };
  const mac = async (user = f.viewer) => {
    const deviceId = randomUUID();
    const registered = await f.call(`/v1/cloud-v2/devices/${deviceId}`, "PUT", {
      requestId: randomUUID(), name: "Fixture Mac", capabilities: ["local-commands-v1"],
    }, user);
    expect(registered.status).toBe(200);
    const { device } = await registered.json();
    const headers = { "x-zeros-device-id": deviceId, "x-zeros-device-registration": device.registrationId,
      "x-zeros-device-instance": device.instanceId, "X-Zeros-Team-Sharing": "1" };
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/macs/${deviceId}/connect`, "POST", {}, user, headers)).status).toBe(200);
    const input = f.prompt(randomUUID(), { chatId: randomUUID() });
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/prompts`, "POST", input, user, headers)).status).toBe(201);
    await f.cp.execution.clients.ticket(f.workspace.id, user, false);
    return { device, input };
  };

  const legacyAuthority = async (contextId: string) => {
    const row = (await pool.query(`SELECT c.*,w.repository,w.creator_user_id,u.auth_revision::text AS account_revision,
      m.authorization_revision::text AS member_revision,m.created_at::text AS member_created_at,
      o.authorization_revision::text AS organization_revision,
      m.role,(SELECT jsonb_agg(jsonb_build_object('repository',s.source_repository,'repositoryId',s.repository_id::text)
        ORDER BY s.source_repository) FROM cloud_v2_github_sources s WHERE s.workspace_id=w.id) AS sources,
      jsonb_build_array((SELECT jsonb_build_array(s.selected_method,s.generation) FROM cloud_github_selections s
        WHERE s.org_id=w.org_id AND s.owner_user_id=c.user_id),
        (SELECT jsonb_agg(jsonb_build_array(g.id,g.method,g.generation,g.github_user_id) ORDER BY g.method)
          FROM cloud_github_credentials g WHERE g.org_id=w.org_id AND g.owner_user_id=c.user_id)) AS connection_revision
      FROM cloud_v2_execution_contexts c JOIN cloud_v2_workspaces w ON w.id=c.workspace_id
      JOIN organization_members m ON m.org_id=w.org_id AND m.user_id=c.user_id
      JOIN users u ON u.id=c.user_id JOIN organizations o ON o.id=w.org_id WHERE c.id=$1`, [contextId])).rows[0]!;
    const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const permission = hash([row.workspace_id,row.org_id,row.user_id,row.creator_user_id,row.account_revision,
      row.member_revision,row.member_created_at,row.organization_revision,row.role,row.repository,
      row.sources.map((s: { repository: string; repositoryId: string }) => ({ repository: s.repository, repositoryId: s.repositoryId })),row.connection_revision]);
    const person = hash([permission,row.access_epoch,row.stop_generation]);
    return { signature: hash([person,row.worker_boot_id,row.worker_token_hash.toString("hex")]) };
  };

  it("renews the surviving person's turn after the real member-removal route", async () => {
    const removed = await begin(f.viewer), survivor = await begin(), before = await workspace();
    const response = await f.call(`/v1/organizations/${f.organizationId}/members/${f.viewer.id}`, "DELETE", undefined, f.creator);
    expect(response.status).toBe(200);
    expect(await context(removed.begun.contextId)).toMatchObject({ state: "revoked", has_material: false });
    expect(await workspace()).toEqual(before);
    const renewed = await f.worker("execution-leases/renew", { contextIds: [survivor.begun.contextId] });
    expect(renewed.status).toBe(200);
    expect(await renewed.json()).toEqual({ leases: [{ contextId: survivor.begun.contextId, expiresAt: expect.any(Number) }] });
    expect((await f.worker("turn-lease", survivor.lease)).status).toBe(200);
    expect(await context(survivor.begun.contextId)).toMatchObject({ state: "active", has_material: true });
  });

  it("keeps an admitted member's GitHub reads usable after the Creator leaves", async () => {
    await pool.query("UPDATE organization_members SET role='owner' WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.admin.id]);
    expect((await f.call(`/v1/organizations/${f.organizationId}/members/${f.creator.id}`, "DELETE", undefined, f.creator)).status).toBe(200);
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/github`, "POST", { op: "gh.repoAccess", params: {} }, f.viewer,
      { "X-Zeros-Team-Sharing": "1" });
    expect(response.status).toBe(200);
  });

  it("keeps a member's running turn and VM when the current Creator leaves", async () => {
    await pool.query("UPDATE organization_members SET role='owner' WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.admin.id]);
    const removed = await begin(), survivor = await begin(f.viewer), before = await workspace();
    const response = await f.call(`/v1/organizations/${f.organizationId}/members/${f.creator.id}`, "DELETE", undefined, f.creator);
    expect(response.status).toBe(200);
    expect(await context(removed.begun.contextId)).toMatchObject({ state: "revoked", has_material: false });
    expect(await workspace()).toEqual(before);
    const renewed = await f.worker("execution-leases/renew", { contextIds: [survivor.begun.contextId] });
    expect(renewed.status).toBe(200);
    expect(await renewed.json()).toEqual({ leases: [{ contextId: survivor.begun.contextId, expiresAt: expect.any(Number) }] });
    expect((await f.worker("turn-lease", survivor.lease)).status).toBe(200);
    expect(await context(survivor.begun.contextId)).toMatchObject({ state: "active", has_material: true });
  });

  it("re-signs a phase-2 context after a roster edit without changing its material or generation", async () => {
    const survivor = await begin(f.viewer);
    const authority = await legacyAuthority(survivor.begun.contextId);
    await pool.query("UPDATE cloud_v2_execution_contexts SET authority=$2 WHERE id=$1", [survivor.begun.contextId, authority]);
    const before = (await pool.query("SELECT material,generation FROM cloud_v2_execution_contexts WHERE id=$1", [survivor.begun.contextId])).rows[0];
    await withSystemTx(pool, tx => tx.query("UPDATE organizations SET authorization_revision=authorization_revision+1 WHERE id=$1", [f.organizationId]));
    expect((await f.worker("turn-lease", survivor.lease)).status).toBe(200);
    const response = await f.worker("execution-leases/renew", { contextIds: [survivor.begun.contextId] });
    expect(await response.json()).toEqual({ leases: [{ contextId: survivor.begun.contextId, expiresAt: expect.any(Number) }] });
    const after = (await pool.query("SELECT material,generation,authority FROM cloud_v2_execution_contexts WHERE id=$1", [survivor.begun.contextId])).rows[0];
    expect(after).toMatchObject({ ...before, authority: { signatureVersion: 2 } });
  });

  it("re-signs a short phase-2 context when material delivery renews its lease", async () => {
    const turn = await begin(f.viewer), authority = await legacyAuthority(turn.begun.contextId);
    await pool.query("UPDATE cloud_v2_execution_contexts SET authority=$2,expires_at=clock_timestamp()+interval '9 seconds' WHERE id=$1",
      [turn.begun.contextId, authority]);
    const before = (await pool.query("SELECT material,generation FROM cloud_v2_execution_contexts WHERE id=$1", [turn.begun.contextId])).rows[0];
    await withSystemTx(pool, tx => tx.query("UPDATE organizations SET authorization_revision=authorization_revision+1 WHERE id=$1", [f.organizationId]));
    const response = await f.worker("turn-lease", turn.lease);
    expect(response.status).toBe(200);
    expect((await response.json()).expiresAt - Date.now()).toBeGreaterThanOrEqual(25_000);
    const after = (await pool.query("SELECT material,generation,authority FROM cloud_v2_execution_contexts WHERE id=$1", [turn.begun.contextId])).rows[0];
    expect(after).toMatchObject({ ...before, authority: { signatureVersion: 2 } });
    expect(after.authority).not.toHaveProperty("legacyBasis");
  });

  it.each([false, true])("replaces only an authentic expired undelivered phase-2 bootstrap after a roster edit (tampered: %s)", async tampered => {
    const first = await f.cp.execution.bootstrap(f.workspace.id);
    expect(first).toEqual(expect.any(String));
    const authority = await legacyAuthority(first!);
    await pool.query("UPDATE cloud_v2_execution_contexts SET authority=$2,expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [first, tampered ? { signature: "f".repeat(64) } : authority]);
    await withSystemTx(pool, tx => tx.query("UPDATE organizations SET authorization_revision=authorization_revision+1 WHERE id=$1", [f.organizationId]));
    const response = await f.worker("config", undefined, { method: "GET" });
    expect(response.status).toBe(tampered ? 409 : 200);
    if (!tampered) {
      const next = (await response.json()).config.bootstrapContextId;
      expect(next).toEqual(expect.any(String)); expect(next).not.toBe(first);
      expect((await f.worker("bootstrap-lease", { contextId: next })).status).toBe(200);
    }
    expect((await f.worker("bootstrap-lease", { contextId: first })).status).toBe(409);
  });

  it("does not upgrade an invalid phase-2 signature into access", async () => {
    const turn = await begin(f.viewer);
    await pool.query("UPDATE cloud_v2_execution_contexts SET authority=$2 WHERE id=$1", [turn.begun.contextId, { signature: "f".repeat(64) }]);
    const response = await f.worker("execution-leases/renew", { contextIds: [turn.begun.contextId] });
    expect(await response.json()).toEqual({ leases: [{ contextId: turn.begun.contextId, refused: "actor_changed" }] });
    expect(await context(turn.begun.contextId)).toMatchObject({ state: "revoked", has_material: false });
  });

  it("cuts only the departed person's tickets, Mac connection and sender binding in the membership transaction", async () => {
    const removed = await mac(), survivor = await mac(f.creator);
    await withSystemTx(pool, async tx => {
      await tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]);
      const state = async (userId: string) => (await tx.query(`SELECT
        (SELECT count(*)::int FROM cloud_v2_tokens WHERE workspace_id=$1 AND user_id=$2 AND kind='connect' AND expires_at>clock_timestamp()) AS tickets,
        (SELECT count(*)::int FROM cloud_v2_connected_macs WHERE workspace_id=$1 AND user_id=$2 AND disconnected_at IS NULL) AS macs,
        (SELECT count(*)::int FROM cloud_v2_chat_sender_bindings WHERE workspace_id=$1 AND user_id=$2 AND NOT retired) AS bindings`,
      [f.workspace.id, userId])).rows[0];
      expect(await state(f.viewer.id)).toEqual({ tickets: 0, macs: 0, bindings: 0 });
      expect(await state(f.creator.id)).toEqual({ tickets: 1, macs: 1, bindings: 1 });
    });
    await f.cp.execution.maintenance.workspace(f.workspace.id);
    const receipts = (await pool.query("SELECT user_message_id,state FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 ORDER BY user_message_id", [f.workspace.id])).rows;
    expect(receipts).toEqual(expect.arrayContaining([
      { user_message_id: removed.input.userMessageId, state: "cancelled" },
      { user_message_id: survivor.input.userMessageId, state: "queued" },
    ]));
  });

  it("denies an N-1 member removal at admission and renewal, then reconciles its hidden workspace resources", async () => {
    await f.cp.loginChanges.stop();
    await mac();
    const removed = await begin(f.viewer), survivor = await begin(), before = await workspace();
    const old = await pool.connect();
    try {
      await old.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
      expect((await old.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rowCount).toBe(0);
      expect((await old.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id])).rowCount).toBe(1);
      await old.query("COMMIT");
    } finally { await old.query("ROLLBACK"); old.release(); }
    expect(await workspace()).toEqual(before);
    expect(await context(removed.begun.contextId)).toMatchObject({ state: "revoked", has_material: false });
    await expect(f.cp.execution.deps.authority.admit(f.workspace.id, f.viewer.id)).rejects.toMatchObject({ code: "member_access_revoked" });
    const renewed = await f.worker("execution-leases/renew", { contextIds: [removed.begun.contextId, survivor.begun.contextId] });
    expect((await renewed.json()).leases).toEqual(expect.arrayContaining([
      { contextId: removed.begun.contextId, refused: "access_revoked" },
      { contextId: survivor.begun.contextId, expiresAt: expect.any(Number) },
    ]));
    await f.cp.execution.maintenance.workspace(f.workspace.id);
    expect((await pool.query(`SELECT
      (SELECT count(*)::int FROM cloud_v2_tokens WHERE workspace_id=$1 AND user_id=$2 AND expires_at>clock_timestamp()) AS tickets,
      (SELECT count(*)::int FROM cloud_v2_connected_macs WHERE workspace_id=$1 AND user_id=$2 AND disconnected_at IS NULL) AS macs,
      (SELECT count(*)::int FROM cloud_v2_chat_sender_bindings WHERE workspace_id=$1 AND user_id=$2 AND NOT retired) AS bindings`,
    [f.workspace.id, f.viewer.id])).rows[0]).toEqual({ tickets: 0, macs: 0, bindings: 0 });
  });

  it("discovers an N-1 removal's remaining resources even when the person never leased a context", async () => {
    await f.cp.loginChanges.stop(); await mac();
    expect((await pool.query("SELECT id FROM cloud_v2_execution_contexts WHERE user_id=$1", [f.viewer.id])).rowCount).toBe(0);
    const old = await pool.connect();
    try {
      await old.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
      expect((await old.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rowCount).toBe(0);
      await old.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]);
      await old.query("COMMIT");
    } finally { await old.query("ROLLBACK"); old.release(); }
    const affected = await f.cp.execution.maintenance.affected({ userId: f.viewer.id });
    expect(affected).toContain(f.workspace.id);
    for (const id of affected) await f.cp.execution.maintenance.publish(id, async () => {});
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_connected_macs WHERE workspace_id=$1 AND user_id=$2 AND disconnected_at IS NULL",
      [f.workspace.id, f.viewer.id])).rows[0].n).toBe(0);
    expect((await pool.query("SELECT state FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND creator_user_id=$2", [f.workspace.id, f.viewer.id])).rows)
      .toEqual([{ state: "cancelled" }]);
  });
});
