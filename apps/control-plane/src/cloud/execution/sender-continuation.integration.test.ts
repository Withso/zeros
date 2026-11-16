import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../../db.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

// Owner rule (2026-11-13): B's started turn, paid for by Creator A, survives B's removal; B's own access ends at once.
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("a started turn survives its sender's access loss on its pinned payer", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool, { teamOwnership: true }); await f.login(); await f.activate(); expect((await f.hello()).status).toBe(200); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); });
  afterAll(() => pool.end());
  const row = async (id: string) => (await pool.query(`SELECT state,reason,sender_ended_at IS NOT NULL AS sender_ended,material IS NOT NULL AS has_material
    FROM cloud_v2_execution_contexts WHERE id=$1`, [id])).rows[0];
  const outbox = async (messageId: string) => (await pool.query("SELECT state,cancel_requested FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2",
    [f.workspace.id, messageId])).rows[0];
  const remove = (userId: string) => withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, userId]));
  /** A cut the fence never sees (a Hold window opening on the clock): no trigger runs. */
  const silentlyRemove = async (userId: string) => {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN; SET LOCAL session_replication_role=replica");
      await tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, userId]);
      await tx.query("COMMIT");
    } finally { await tx.query("ROLLBACK"); tx.release(); }
  };
  const started = async (input = f.prompt()) => {
    const turn = await f.dispatch(input, f.viewer);
    const lease = await f.worker("turn-lease", turn.lease);
    expect(lease.status).toBe(200);
    return { ...turn, input, material: await lease.json() };
  };
  const renew = async (id: string) => (await (await f.worker("execution-leases/renew", { contextIds: [id] })).json()).leases[0];

  it("keeps B's started turn on A after B is removed, while B's client context and other messages end", async () => {
    const turn = await started();
    const queued = f.prompt(randomUUID(), { chatId: "other" });
    expect((await f.send(queued, f.viewer)).status).toBe(201);
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST", { wake: false }, f.viewer, { "X-Zeros-Team-Sharing": "1" });
    const { protocols } = await response.json(), grant = await f.cp.store.consumeConnectTicket(protocols[1].slice(7), f.workspace.id);
    const handle = await f.cp.execution.clients.open(f.workspace.id, randomUUID(), grant!);
    await remove(f.viewer.id);
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "active", sender_ended: true, has_material: true });
    expect(await row(handle.contextId)).toMatchObject({ state: "revoked", reason: "access_revoked" });
    await f.cp.execution.maintenance.workspace(f.workspace.id);
    expect(await outbox(turn.input.userMessageId)).toMatchObject({ cancel_requested: false });
    expect(await outbox(queued.userMessageId)).toMatchObject({ state: "cancelled" });
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "active", sender_ended: true });
    expect(await renew(turn.begun.contextId)).toEqual({ contextId: turn.begun.contextId, expiresAt: expect.any(Number) });
  });

  it("cuts B once on an R2 boot: later passes add no authority event, and the barrier keeps extending the turn", async () => {
    const turn = await started();
    await pool.query("UPDATE cloud_v2_execution_boots SET authority_mode='message-authority-v1' WHERE boot_id=$1", [f.boot]);
    const events = async () => (await withSystemTx(pool, tx => tx.query("SELECT count(*)::int AS n FROM cloud_v2_authority_events WHERE workspace_id=$1", [f.workspace.id]))).rows[0].n;
    await remove(f.viewer.id);
    await f.cp.execution.maintenance.workspace(f.workspace.id);
    const cut = await events();
    expect(cut).toBeGreaterThan(0);
    await f.cp.execution.maintenance.workspace(f.workspace.id);
    await withSystemTx(pool, tx => f.cp.execution.maintenance.cancelQueued(tx, f.workspace.id));
    expect(await events()).toBe(cut);
    await pool.query("UPDATE cloud_v2_execution_boots SET authority_acked_sequence=(SELECT max(id) FROM cloud_v2_authority_events WHERE workspace_id=$1) WHERE boot_id=$2",
      [f.workspace.id, f.boot]);
    await f.cp.authorityBarrier.tick();
    const expiry = (await pool.query("SELECT expires_at FROM cloud_v2_execution_contexts WHERE id=$1", [turn.begun.contextId])).rows[0].expires_at as Date;
    expect(expiry.getTime() - Date.now()).toBeGreaterThan(500_000);
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "active", sender_ended: true });
  });

  it("refuses B's GitHub token, API token and another lease on the sponsored turn without ending it", async () => {
    const turn = await started();
    await remove(f.viewer.id);
    const github = await f.worker("github-token", { contextId: turn.begun.contextId, purpose: "git" });
    expect(github.status).toBe(409);
    expect(await github.json()).toMatchObject({ error: { code: "github_token_unavailable", reason: "access-denied" } });
    if (turn.material.api) await expect(f.cp.execution.tokenContext("api", { token: turn.material.api.token })).rejects.toMatchObject({ status: 401 });
    expect((await f.worker("turn-lease", turn.lease)).status).toBe(409);
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "active", sender_ended: true });
  });

  it("keeps Codex inference on A after B is removed, even before maintenance sees a silent cut", async () => {
    await f.login(f.creator, "codex");
    const turn = await started(f.prompt(randomUUID(), { agentId: "codex" }));
    await silentlyRemove(f.viewer.id);
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "active", sender_ended: false });
    expect((await f.cp.execution.proxyAccess(turn.material.agents.codex.token)).login).toBeDefined();
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "active", sender_ended: true });
    await remove(f.creator.id);
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "revoked" });
    await expect(f.cp.execution.proxyAccess(turn.material.agents.codex.token)).rejects.toMatchObject({ status: 401 });
  });

  it("moves the turn to A on renewal and in maintenance when the cut had no write", async () => {
    const first = await started();
    const second = await started(f.prompt(randomUUID(), { chatId: "second" }));
    await silentlyRemove(f.viewer.id);
    expect(await renew(first.begun.contextId)).toEqual({ contextId: first.begun.contextId, expiresAt: expect.any(Number) });
    expect(await row(first.begun.contextId)).toMatchObject({ state: "active", sender_ended: true });
    await f.cp.execution.maintenance.workspace(f.workspace.id);
    expect(await row(second.begun.contextId)).toMatchObject({ state: "active", sender_ended: true });
    expect(await outbox(second.input.userMessageId)).toMatchObject({ cancel_requested: false });
  });

  it("revokes a begun turn whose material was never issued", async () => {
    const begun = await f.dispatch(f.prompt(), f.viewer);
    await remove(f.viewer.id);
    expect(await row(begun.begun.contextId)).toMatchObject({ state: "revoked", has_material: false });
  });

  it("ends the sponsored turn on Stop by A", async () => {
    const turn = await started();
    await remove(f.viewer.id);
    const stop = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/prompts/stop`, "POST", { chatId: "chat", throughEpoch: "0" }, f.creator, { "X-Zeros-Team-Sharing": "1" });
    expect(stop.status).toBe(200);
    await f.cp.execution.maintenance.workspace(f.workspace.id);
    expect((await row(turn.begun.contextId)).state).not.toBe("active");
  });

  it("stays sponsored when B rejoins: B's steer waits and GitHub stays refused", async () => {
    const turn = await started();
    await remove(f.viewer.id);
    await withSystemTx(pool, tx => tx.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [f.organizationId, f.viewer.id]));
    expect(await renew(turn.begun.contextId)).toEqual({ contextId: turn.begun.contextId, expiresAt: expect.any(Number) });
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "active", sender_ended: true });
    expect((await f.worker("github-token", { contextId: turn.begun.contextId, purpose: "git" })).status).toBe(409);
    const steer = f.prompt(randomUUID(), { mode: "steer" });
    expect((await f.send(steer, f.viewer)).status).toBe(201);
    const delivery = (await (await f.worker("prompts/pull", { waitMs: 0, held: [] })).json()).prompts.find((value: any) => value.payload.userMessageId === steer.userMessageId);
    expect((await f.worker("prompts/ack", { userMessageId: steer.userMessageId, deliveryId: delivery.deliveryId })).status).toBe(200);
    const begun = await f.worker("prompts/begin", { userMessageId: steer.userMessageId, deliveryId: delivery.deliveryId, dispatchId: randomUUID() });
    expect(begun.status).toBe(409); expect(await begun.json()).toMatchObject({ error: { code: "actor_busy" } });
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "active", sender_ended: true });
  });

  const replica = async (run: (tx: pg.PoolClient) => Promise<unknown>) => {
    const tx = await pool.connect();
    try { await tx.query("BEGIN; SET LOCAL session_replication_role=replica"); await run(tx); await tx.query("COMMIT"); }
    finally { await tx.query("ROLLBACK"); tx.release(); }
  };
  const extension = async (owner: string | null) => {
    const id = randomUUID();
    await replica(tx => tx.query(`INSERT INTO organization_extensions(id,org_id,owner_user_id,kind,repository,revision,config,secret_names,secret_envelope,oauth_binding)
      VALUES($1,$2,$3,'mcp',NULL,1,$4,$5,$6,$7)`, [id, f.organizationId, owner, { name: "fixture", transport: "http", url: "https://mcp.example.test" },
      { env: [], headers: [], oauthClientSecret: false }, {}, "ab".repeat(32)]));
    return id;
  };

  it("keeps the turn when B's removal cascades into B's personal MCP extension and MCP sign-in", async () => {
    const turn = await started();
    await extension(f.viewer.id);
    const shared = await extension(null);
    await replica(tx => tx.query(`INSERT INTO organization_mcp_oauth(extension_id,owner_user_id,org_id,binding,revision,envelope,refreshable)
      VALUES($1,$2,$3,$4,1,$5,false)`, [shared, f.viewer.id, f.organizationId, "ab".repeat(32), {}]));
    await remove(f.viewer.id);
    expect((await pool.query("SELECT count(*)::int AS n FROM organization_mcp_oauth WHERE owner_user_id=$1", [f.viewer.id])).rows[0].n).toBe(0);
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "active", sender_ended: true, has_material: true });
  });

  it("still ends B's turn when B, still a member, signs out of an MCP server", async () => {
    const turn = await started();
    const shared = await extension(null);
    await replica(tx => tx.query(`INSERT INTO organization_mcp_oauth(extension_id,owner_user_id,org_id,binding,revision,envelope,refreshable)
      VALUES($1,$2,$3,$4,1,$5,false)`, [shared, f.viewer.id, f.organizationId, "ab".repeat(32), {}]));
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_mcp_oauth WHERE owner_user_id=$1", [f.viewer.id]));
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "revoked", reason: "actor_changed" });
  });

  /** Runs `then` right after the first continuation admission of `user`: a cut that commits before the caller's locked read. */
  const afterAdmit = (user: string, then: () => Promise<unknown>) => {
    const authority = f.cp.execution.deps.authority, original = authority.admit.bind(authority);
    let fired = false;
    vi.spyOn(authority, "admit").mockImplementation(async (...args: Parameters<typeof original>) => {
      const proof = await original(...args);
      if (!fired && args[1] === user) { fired = true; await then(); }
      return proof;
    });
  };

  it.each([
    ["removal", () => remove(f.viewer.id)],
    ["account revision", () => withSystemTx(pool, tx => tx.query("UPDATE users SET auth_revision=auth_revision+1 WHERE id=$1", [f.viewer.id]))],
  ] as const)("renews the turn on A when B's %s commits between B's admission and the locked renewal", async (_name, cut) => {
    const turn = await started();
    afterAdmit(f.viewer.id, cut);
    expect(await renew(turn.begun.contextId)).toEqual({ contextId: turn.begun.contextId, expiresAt: expect.any(Number) });
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "active", sender_ended: true });
  });

  it("answers the Codex proxy on A when B's removal commits between B's admission and the check", async () => {
    await f.login(f.creator, "codex");
    const turn = await started(f.prompt(randomUUID(), { agentId: "codex" }));
    afterAdmit(f.viewer.id, () => remove(f.viewer.id));
    expect((await f.cp.execution.proxyAccess(turn.material.agents.codex.token)).login).toBeDefined();
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "active", sender_ended: true });
  });

  it("re-delivers no sender material when another lease follows a silent cut; the next renewal moves the turn", async () => {
    const turn = await started();
    await silentlyRemove(f.viewer.id);
    const again = await f.worker("turn-lease", turn.lease);
    expect(again.status).not.toBe(200);
    const refused = await again.json();
    for (const field of ["agents", "mcpServers", "api", "environment"]) expect(refused).not.toHaveProperty(field);
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "active" });
    expect(await renew(turn.begun.contextId)).toEqual({ contextId: turn.begun.contextId, expiresAt: expect.any(Number) });
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "active", sender_ended: true });
    expect((await f.worker("turn-lease", turn.lease)).status).toBe(409);
  });

  it("re-delivers no sender material when the removal commits while another lease is prepared", async () => {
    const turn = await started();
    afterAdmit(f.viewer.id, () => remove(f.viewer.id));
    const again = await f.worker("turn-lease", turn.lease);
    expect(again.status).toBe(409);
    const refused = await again.json();
    for (const field of ["agents", "mcpServers", "api", "environment"]) expect(refused).not.toHaveProperty(field);
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "active", sender_ended: true });
  });

  it("refuses MCP authorization on the sponsored turn without ending it", async () => {
    const turn = await started();
    await remove(f.viewer.id);
    await expect(f.cp.execution.mcpAuthorization({ token: f.token, bootId: f.boot }, turn.begun.contextId, "any", false))
      .rejects.toMatchObject({ status: 403, code: "mcp_access_denied" });
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "active", sender_ended: true });
  });

  it("still revokes an old-format turn with no pinned payer when its sender is removed", async () => {
    await f.login(f.viewer);
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_workspaces SET creator_user_id=$2 WHERE id=$1", [f.workspace.id, f.viewer.id]));
    const old = vi.spyOn(f.cp.execution.deps.logins, "forWorkspace").mockImplementation((_id, actor, agent, expected, tx) =>
      f.cp.execution.deps.logins.select(f.organizationId, actor, agent, expected, tx));
    const turn = await started(); old.mockRestore();
    expect((await pool.query("SELECT selection FROM cloud_v2_execution_contexts WHERE id=$1", [turn.begun.contextId])).rows[0].selection).not.toHaveProperty("version");
    await remove(f.viewer.id);
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "revoked", sender_ended: false });
  });

  it("keeps the turn when B's account revision changes", async () => {
    const turn = await started();
    await withSystemTx(pool, tx => tx.query("UPDATE users SET auth_revision=auth_revision+1 WHERE id=$1", [f.viewer.id]));
    expect(await row(turn.begun.contextId)).toMatchObject({ state: "active", sender_ended: true });
    expect(await renew(turn.begun.contextId)).toEqual({ contextId: turn.begun.contextId, expiresAt: expect.any(Number) });
  });
});
