import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CloudV2Computers } from "../computer.js";
import * as runtime from "../runtime-capabilities.js";
import { HttpError } from "../../authz.js";
import { withSystemTx, withUserTx } from "../../db.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("new organization workspaces start with personal execution", () => {
  let pool: pg.Pool, f: ExecutionFixture | undefined;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterEach(async () => { await f?.close(); f = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  async function setup(enabled: boolean) {
    vi.spyOn(runtime, "activeRuntimeQualification").mockReturnValue(async () => ({ version: 1, sha256: "b".repeat(64),
      sourceSha256: "c".repeat(64), commit: "d".repeat(40), features: ["acting-user-v1", "sync-context-v1"] }));
    f = await executionFixture(pool, { actingUserDefault: enabled });
    const computers = new CloudV2Computers(pool, pool, async (_org, _user, target) => ({ repository: target.repository, repositoryId: "42" }));
    const build = await computers.enqueue(f.organizationId, f.creator.id, { repositories: [{ repository: "example/project", branch: "main", setup: "" }] });
    await computers.claim(); await computers.activate(build.id, "fresh-fixture-snapshot");
    vi.spyOn(f.cp.routes, "remoteHead").mockResolvedValue("a".repeat(40));
    return f;
  }
  async function row(id: string) {
    return (await pool.query(`SELECT execution_mode,execution_initiator_user_id,execution_intent_id,execution_intent_authority,
      source_pending,boat_sandbox_id,worker_token_hash FROM cloud_v2_workspaces WHERE id=$1`, [id])).rows[0];
  }
  async function fresh() {
    const fixture = await setup(true);
    const response = await fixture.call("/v1/cloud-v2/workspaces", "POST", {
      organizationId: fixture.organizationId, repository: "example/project", name: "First active boot",
    });
    expect(response.status).toBe(201);
    const { workspace } = await response.json();
    await pool.query("UPDATE cloud_v2_workspaces SET boat_sandbox_id='bx_freshfixture' WHERE id=$1", [workspace.id]);
    return { fixture, id: workspace.id as string };
  }
  async function worker(id: string) {
    const token = await f!.cp.store.rotateWorkerToken(id), boot = randomUUID();
    const features = `${f!.features},sync-v1,sync-context-v1`;
    const call = (path: string, body?: unknown, capability = features) => f!.app.request(`/v2/cloud/worker/${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "x-zeros-worker-boot": boot,
        "x-zeros-worker-features": capability, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { boot, call, hello: (capability = features, sha = "b".repeat(64)) => call("hello", { protocol: 2, bootId: boot, runtimeSha256: sha }, capability) };
  }

  it.each([false, true])("persists the channel's choice with the authenticated creator before any VM exists (%s)", async enabled => {
    const fixture = await setup(enabled);
    const response = await fixture.call("/v1/cloud-v2/workspaces", "POST", {
      organizationId: fixture.organizationId, repository: "example/project", name: "Fresh shared workspace",
    }, fixture.viewer, { "X-Zeros-Team-Sharing": "1" });
    expect(response.status).toBe(201);
    const { workspace } = await response.json();
    expect(workspace.creatorUserId).toBe(fixture.viewer.id);
    const stored = await row(workspace.id);
    expect(stored).toMatchObject({ execution_mode: enabled ? "active" : "legacy", execution_initiator_user_id: fixture.viewer.id,
      source_pending: false, boat_sandbox_id: null, worker_token_hash: null });
    expect(stored.execution_intent_id).toMatch(/^[a-f0-9-]{36}$/);
    if (enabled) {
      expect(stored.execution_intent_authority).toMatchObject({ signatureVersion: 3 });
      expect((await pool.query("SELECT * FROM cloud_v2_execution_creations WHERE workspace_id=$1", [workspace.id])).rows[0])
        .toMatchObject({ intent_id: stored.execution_intent_id, runtime_sha256: "b".repeat(64), clean_boot_id: null, first_failed_boot_id: null });
    }
    else expect(stored.execution_intent_authority).toBeNull();
    expect((await row(fixture.workspace.id)).execution_mode).toBe("legacy");
  });

  it.each([
    { transport: "HTTP", credential: "api_key" }, { transport: "MCP", credential: "api_key" },
    { transport: "HTTP", credential: "context_token" }, { transport: "MCP", credential: "context_token" },
  ])("atomically creates an active workspace and its own initial prompt through $transport with $credential", async ({ transport, credential }) => {
    const fixture = await setup(true);
    await fixture.login(fixture.viewer);
    let bearer: string, contextId: string | null = null;
    if (credential === "api_key") bearer = (await fixture.cp.api.credentials.create(fixture.organizationId, fixture.viewer.id, "Fixture")).key;
    else {
      await fixture.login();
      await fixture.activate(); expect((await fixture.hello()).status).toBe(200);
      const origin = await fixture.dispatch(fixture.prompt(randomUUID(), { chatId: "requesting-person" }), fixture.viewer);
      const lease = await fixture.worker("turn-lease", origin.lease); expect(lease.status).toBe(200);
      bearer = (await lease.json()).api.token; contextId = origin.begun.contextId;
    }
    const key = randomUUID(), messageId = randomUUID();
    const input = { repository: "example/project", agent: "claude", message: "My first prompt", messageId };
    const headers = { authorization: `Bearer ${bearer}`, "Idempotency-Key": key };
    async function invoke() {
      if (transport === "HTTP") {
        const response = await fixture.call("/api/v0/workspaces", "POST", input, fixture.viewer, headers);
        expect(response.status).toBe(201); return response.json();
      }
      const response = await fixture.call("/api/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "create_workspace", arguments: { ...input, idempotencyKey: key } } }, fixture.viewer,
      { ...headers, accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" });
      expect(response.status).toBe(200); const reply = await response.json();
      expect(reply.result.isError).not.toBe(true); return reply.result.structuredContent;
    }
    const created = await invoke(); expect(await invoke()).toEqual(created);
    expect(created.workspace.creatorId).toBe(fixture.viewer.id);
    expect(created.session.workspaceId).toBe(created.workspace.id);
    expect(await row(created.workspace.id)).toMatchObject({ execution_mode: "active", execution_initiator_user_id: fixture.viewer.id });
    const receipts = (await pool.query(`SELECT creator_user_id,state,execution_authority,sender_credential_kind,sender_context_id
      FROM cloud_v2_prompt_outbox WHERE workspace_id=$1`, [created.workspace.id])).rows;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ creator_user_id: fixture.viewer.id, state: "queued",
      execution_authority: { signatureVersion: 3 }, sender_credential_kind: credential === "api_key" ? "api_key" : "workspace_token", sender_context_id: contextId });
    expect((await pool.query("SELECT count(*)::int n FROM cloud_v2_execution_creations WHERE workspace_id=$1", [created.workspace.id])).rows[0].n).toBe(1);
  });

  it("refuses an initial API prompt without that person's login and leaves no partial workspace", async () => {
    const fixture = await setup(true); await fixture.login();
    const credential = await fixture.cp.api.credentials.create(fixture.organizationId, fixture.viewer.id, "Fixture");
    const before = (await pool.query("SELECT count(*)::int n FROM cloud_v2_workspaces")).rows[0].n;
    const response = await fixture.call("/api/v0/workspaces", "POST", { repository: "example/project", agent: "claude", message: "Own login required" },
      fixture.viewer, { authorization: `Bearer ${credential.key}`, "Idempotency-Key": randomUUID() });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: "agent_login_required", agent: "claude" } });
    expect((await pool.query("SELECT count(*)::int n FROM cloud_v2_workspaces")).rows[0].n).toBe(before);
    expect((await pool.query("SELECT count(*)::int n FROM cloud_v2_execution_creations")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int n FROM cloud_v2_create_requests")).rows[0].n).toBe(0);
  });

  it("replays a create without repeating or changing the original active decision", async () => {
    const fixture = await setup(true), key = randomUUID();
    const input = { organizationId: fixture.organizationId, repository: "example/project", name: "One decision" };
    const headers = { "Idempotency-Key": key, "X-Zeros-Team-Sharing": "1" };
    const first = await fixture.call("/v1/cloud-v2/workspaces", "POST", input, fixture.creator, headers);
    expect(first.status).toBe(201);
    const original = await first.json(), persisted = await row(original.workspace.id);
    fixture.cp.routes.actingUserDefault = false;
    const replay = await fixture.call("/v1/cloud-v2/workspaces", "POST", input, fixture.creator, headers);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(original);
    expect(persisted.execution_mode).toBe("active");
    expect(await row(original.workspace.id)).toEqual(persisted);
    expect((await pool.query("SELECT count(*)::int n FROM cloud_v2_create_requests WHERE creator_user_id=$1 AND request_key=$2", [fixture.creator.id, key])).rows[0].n).toBe(1);
  });

  it("keeps a legacy receipt legacy after the switch is enabled", async () => {
    const fixture = await setup(false), key = randomUUID();
    const input = { organizationId: fixture.organizationId, repository: "example/project" };
    const first = await fixture.call("/v1/cloud-v2/workspaces", "POST", input, fixture.creator, { "Idempotency-Key": key });
    expect(first.status).toBe(201);
    const original = await first.json(); fixture.cp.routes.actingUserDefault = true;
    const replay = await fixture.call("/v1/cloud-v2/workspaces", "POST", input, fixture.creator, { "Idempotency-Key": key });
    expect(replay.status).toBe(201); expect(await replay.json()).toEqual(original);
    expect((await row(original.workspace.id)).execution_mode).toBe("legacy");
    expect((await pool.query("SELECT count(*)::int n FROM cloud_v2_execution_creations WHERE workspace_id=$1", [original.workspace.id])).rows[0].n).toBe(0);
  });

  it("finishes source verification even when asynchronous creation is enabled", async () => {
    const fixture = await setup(true);
    fixture.cp.routes.asyncCreate = () => true;
    const response = await fixture.call("/v1/cloud-v2/workspaces", "POST", { organizationId: fixture.organizationId, repository: "example/project" });
    expect(response.status).toBe(201);
    const { workspace } = await response.json();
    expect((await row(workspace.id)).source_pending).toBe(false);
    expect((await pool.query("SELECT count(*)::int n FROM cloud_v2_github_sources WHERE workspace_id=$1", [workspace.id])).rows[0].n).toBe(1);
  });

  it("refuses an unqualified runtime without a legacy row or receipt", async () => {
    const fixture = await setup(true), before = (await pool.query("SELECT count(*)::int n FROM cloud_v2_workspaces")).rows[0].n;
    vi.spyOn(fixture.cp.routes, "activeCreateRuntime").mockRejectedValue(new HttpError(409, "worker_update_required", "Fixture qualification refused"));
    const response = await fixture.call("/v1/cloud-v2/workspaces", "POST", { organizationId: fixture.organizationId, repository: "example/project" },
      fixture.creator, { "Idempotency-Key": randomUUID() });
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("worker_update_required");
    expect((await pool.query("SELECT count(*)::int n FROM cloud_v2_workspaces")).rows[0].n).toBe(before);
    expect((await pool.query("SELECT count(*)::int n FROM cloud_v2_create_requests")).rows[0].n).toBe(0);
  });

  it.each(["membership", "source"])("rechecks %s after runtime qualification, before committing the active intent", async lost => {
    const fixture = await setup(true), original = fixture.cp.routes.activeCreateRuntime!;
    vi.spyOn(fixture.cp.routes, "activeCreateRuntime").mockImplementation(async (...args) => {
      const pin = await original(...args);
      if (lost === "membership") await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [fixture.organizationId, fixture.viewer.id]);
      else await pool.query(`UPDATE cloud_github_source_verifications SET failure_code='github_access_required',failure_status=403
        WHERE org_id=$1 AND owner_user_id=$2`, [fixture.organizationId, fixture.viewer.id]);
      return pin;
    });
    const response = await fixture.call("/v1/cloud-v2/workspaces", "POST", { organizationId: fixture.organizationId, repository: "example/project" }, fixture.viewer);
    expect(response.status).toBe(lost === "membership" ? 404 : 403);
    expect((await pool.query("SELECT count(*)::int n FROM cloud_v2_execution_creations")).rows[0].n).toBe(0);
  });

  it("releases no personal material until the exact new boot proves clean", async () => {
    const { id } = await fresh(), w = await worker(id);
    const response = await w.hello(); expect(response.status).toBe(200);
    const { config } = await response.json();
    expect(config).toMatchObject({ actingUser: 1, agents: {}, gitIdentity: null, bootstrapContextId: expect.any(String) });
    for (const key of ["environment", "mcpServers", "api", "codeReview"]) expect(config).not.toHaveProperty(key);
    expect((await w.call("bootstrap-lease", { contextId: config.bootstrapContextId })).status).toBe(409);
    expect((await w.call("github-token", { purpose: "git", contextId: config.bootstrapContextId })).status).toBe(409);
    expect((await pool.query("SELECT count(*)::int n FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND material IS NOT NULL", [id])).rows[0].n).toBe(0);
    const clean = { retirementId: randomUUID(), processes: 0, legacyMaterial: "none" };
    expect((await w.call("execution-leases/boot-clean", clean)).status).toBe(200);
    const lease = await w.call("bootstrap-lease", { contextId: config.bootstrapContextId }); expect(lease.status).toBe(200);
    expect((await lease.json()).userId).toBe(f!.creator.id);
    const receipt = (await pool.query(`SELECT c.clean_boot_id,b.clean_at IS NOT NULL AS clean,x.bootstrap_material_issued AS issued
      FROM cloud_v2_execution_creations c JOIN cloud_v2_execution_boots b ON b.workspace_id=c.workspace_id AND b.boot_id=c.clean_boot_id
      JOIN cloud_v2_execution_contexts x ON x.workspace_id=c.workspace_id AND x.kind='bootstrap' WHERE c.workspace_id=$1`, [id])).rows[0];
    expect(receipt).toMatchObject({ clean_boot_id: w.boot, clean: true, issued: true });
  });

  it("allows the system create path and hides its receipt from ordinary transactions", async () => {
    const { id, fixture } = await fresh();
    expect((await pool.query("SELECT count(*)::int n FROM cloud_v2_execution_creations WHERE workspace_id=$1", [id])).rows[0].n).toBe(1);
    await withUserTx(pool, fixture.creator.id, async tx => {
      expect((await tx.query("SELECT * FROM cloud_v2_execution_creations WHERE workspace_id=$1", [id])).rows).toEqual([]);
      expect((await tx.query("UPDATE cloud_v2_execution_creations SET runtime_sha256=$2 WHERE workspace_id=$1", [id, "e".repeat(64)])).rowCount).toBe(0);
      expect((await tx.query("DELETE FROM cloud_v2_execution_creations WHERE workspace_id=$1", [id])).rowCount).toBe(0);
    });
    await expect(withUserTx(pool, fixture.creator.id, tx => tx.query(`INSERT INTO cloud_v2_execution_creations
      (workspace_id,org_id,intent_id,runtime_sha256,source_sha256,source_sha) VALUES($1,$2,$3,$4,$5,$6)`,
    [fixture.workspace.id, fixture.organizationId, randomUUID(), "b".repeat(64), "c".repeat(64), "d".repeat(40)]))).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses a wrong runtime and either missing feature before binding a new boot", async () => {
    const { id } = await fresh(), w = await worker(id);
    for (const features of [f!.features, f!.features.replace(",acting-user-v1", ",sync-context-v1")]) {
      const response = await w.hello(features); expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("worker_update_required");
    }
    expect((await w.hello(undefined, "e".repeat(64))).status).toBe(409);
    expect((await pool.query("SELECT worker_boot_id FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0].worker_boot_id).toBeNull();
    expect((await pool.query("SELECT count(*)::int n FROM cloud_v2_execution_contexts WHERE workspace_id=$1", [id])).rows[0].n).toBe(0);
  });

  it("advances an R2 boot's authority head on every authority revocation and cut-off", async () => {
    const { id } = await fresh(), w = await worker(id);
    const features = `${f!.features},sync-v1,sync-context-v1,message-authority-v1`;
    expect((await w.hello(features)).status).toBe(200);
    expect((await w.call("execution-leases/boot-clean", { retirementId: randomUUID(), processes: 0, legacyMaterial: "none" }, features)).status).toBe(200);
    const head = async () => (await withSystemTx(pool, tx => tx.query("SELECT count(*)::int AS sequence FROM cloud_v2_authority_events WHERE workspace_id=$1", [id]))).rows[0];
    const contexts = (await pool.query("SELECT id FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND state='active' ORDER BY id", [id])).rows;
    expect(contexts.length).toBeGreaterThan(0);
    expect((await head())?.sequence ?? 0).toBe(0);
    const revoked = await withSystemTx(pool, tx => tx.query(`UPDATE cloud_v2_execution_contexts SET state='revoked',reason='access_revoked',revoked_at=clock_timestamp()
      WHERE workspace_id=$1 AND state='active'`, [id]));
    expect((await head()).sequence).toBe(revoked.rowCount);
    await withSystemTx(pool, tx => tx.query("INSERT INTO cloud_v2_execution_invalidations(workspace_id,user_id) VALUES($1,NULL)", [id]));
    expect((await head()).sequence).toBe(revoked.rowCount! + 1);
    await withUserTx(pool, f!.creator.id, async tx => {
      expect((await tx.query("SELECT * FROM cloud_v2_authority_events")).rows).toEqual([]);
      expect((await tx.query("SELECT * FROM cloud_v2_authority_rechecks")).rows).toEqual([]);
    });
  });

  it("serves R2 freshness from one barrier: extends acknowledged boots, withholds it across a revocation until the worker acknowledges", async () => {
    const { id } = await fresh(), w = await worker(id);
    const features = `${f!.features},sync-v1,sync-context-v1,message-authority-v1`;
    const hello = await w.hello(features); expect(hello.status).toBe(200);
    expect((await hello.json()).config.messageAuthority).toBe(1);
    expect((await w.call("execution-leases/boot-clean", { retirementId: randomUUID(), processes: 0, legacyMaterial: "none" }, features)).status).toBe(200);
    expect((await pool.query("SELECT authority_mode FROM cloud_v2_execution_boots WHERE boot_id=$1", [w.boot])).rows[0].authority_mode).toBe("message-authority-v1");
    const live = (await pool.query("SELECT id FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND state='active'", [id])).rows.map(row => row.id as string);
    expect(live.length).toBeGreaterThan(0);
    const pull = async (acked: string) => (await w.call("execution-leases/authority", { acked, contextIds: live }, features)).json();
    expect(await pull("0")).toMatchObject({ fresh: false, ended: [] });
    const barrier = f!.cp.authorityBarrier;
    await barrier.tick();
    const expiry = async () => (await pool.query("SELECT min(expires_at) AS at FROM cloud_v2_execution_contexts WHERE id=ANY($1::uuid[])", [live])).rows[0].at as Date;
    expect((await expiry()).getTime() - Date.now()).toBeGreaterThan(500_000);
    expect(await pull("0")).toMatchObject({ sequence: "0", fresh: true, ended: [] });
    await withSystemTx(pool, tx => tx.query(`UPDATE cloud_v2_execution_contexts SET state='revoked',reason='access_revoked',revoked_at=clock_timestamp()
      WHERE id=$1`, [live[0]]));
    await barrier.tick();
    const pending = await pull("0");
    expect(pending).toMatchObject({ fresh: false, ended: [{ contextId: live[0], reason: "access_revoked" }] });
    expect(await pull(pending.sequence)).toMatchObject({ fresh: false });
    expect((await pool.query("SELECT authority_acked_sequence::text AS acked FROM cloud_v2_execution_boots WHERE boot_id=$1", [w.boot])).rows[0].acked).toBe(pending.sequence);
    await barrier.tick();
    expect(await pull(pending.sequence)).toMatchObject({ fresh: true, ended: [] });
    const other = await worker(id);
    const unknown = await other.call("execution-leases/authority", { acked: "0", contextIds: [] }, features);
    expect({ status: unknown.status, body: await unknown.json() }).toEqual({ status: 200, body: { sequence: "0", fresh: false, ageMs: 0, untilMs: 0, ended: [] } });
  });

  it("gives a new R2 boot fresh authority at once when earlier boots left authority events behind", async () => {
    const { id } = await fresh();
    const features = `${f!.features},sync-v1,sync-context-v1,message-authority-v1`;
    const first = await worker(id);
    expect((await first.hello(features)).status).toBe(200);
    expect((await first.call("execution-leases/boot-clean", { retirementId: randomUUID(), processes: 0, legacyMaterial: "none" }, features)).status).toBe(200);
    await withSystemTx(pool, tx => tx.query(`UPDATE cloud_v2_execution_contexts SET state='revoked',reason='access_revoked',revoked_at=clock_timestamp()
      WHERE workspace_id=$1 AND state='active'`, [id]));
    const sequence = (await withSystemTx(pool, tx => tx.query("SELECT max(id)::text AS n FROM cloud_v2_authority_events WHERE workspace_id=$1", [id]))).rows[0].n;
    expect(Number(sequence)).toBeGreaterThan(0);
    // The next boot (a wake): those events were about contexts its bind already revoked.
    const next = await worker(id);
    expect((await next.hello(features)).status).toBe(200);
    expect((await next.call("execution-leases/boot-clean", { retirementId: randomUUID(), processes: 0, legacyMaterial: "none" }, features)).status).toBe(200);
    await f!.cp.authorityBarrier.tick();
    const reply = await (await next.call("execution-leases/authority", { acked: "0", contextIds: [] }, features)).json();
    expect(reply).toMatchObject({ sequence, fresh: true });
  });

  it("re-admits an R2 boot's people at the next clock boundary and never extends a context past it", async () => {
    const { id } = await fresh(), w = await worker(id);
    const features = `${f!.features},sync-v1,sync-context-v1,message-authority-v1`;
    expect((await w.hello(features)).status).toBe(200);
    expect((await w.call("execution-leases/boot-clean", { retirementId: randomUUID(), processes: 0, legacyMaterial: "none" }, features)).status).toBe(200);
    const maintenance = f!.cp.execution.maintenance;
    await maintenance.workspace(id);
    const recheck = async () => (await withSystemTx(pool, tx => tx.query("SELECT min(at) AS recheck_at FROM cloud_v2_authority_rechecks WHERE workspace_id=$1", [id]))).rows[0]?.recheck_at as Date;
    const first = await recheck();
    expect(first.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(first.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    await f!.cp.authorityBarrier.tick();
    const latest = (await pool.query("SELECT max(expires_at) AS at FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND state='active'", [id])).rows[0].at as Date;
    expect(latest.getTime()).toBeLessThanOrEqual(first.getTime() + 60_000);
    expect(latest.getTime()).toBeGreaterThan(first.getTime());
    await withSystemTx(pool, tx => tx.query("INSERT INTO cloud_v2_authority_rechecks(workspace_id,at) VALUES($1,clock_timestamp()-interval '1 second')", [id]));
    expect(await maintenance.due()).toContain(id);
    await maintenance.workspace(id);
    expect((await recheck()).getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(await maintenance.due()).not.toContain(id);
  });

  it("rewrites an R2 context only when the barrier moves its expiry, not on every tick before a near re-check", async () => {
    const { id } = await fresh(), w = await worker(id);
    const features = `${f!.features},sync-v1,sync-context-v1,message-authority-v1`;
    expect((await w.hello(features)).status).toBe(200);
    expect((await w.call("execution-leases/boot-clean", { retirementId: randomUUID(), processes: 0, legacyMaterial: "none" }, features)).status).toBe(200);
    await f!.cp.execution.maintenance.workspace(id);
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_authority_rechecks SET at=clock_timestamp()+interval '5 minutes' WHERE workspace_id=$1", [id]));
    const versions = async () => (await pool.query("SELECT id,xmin::text AS version FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND state='active' ORDER BY id", [id])).rows;
    await f!.cp.authorityBarrier.tick();
    const first = await versions();
    expect(first.length).toBeGreaterThan(0);
    await f!.cp.authorityBarrier.tick();
    expect(await versions()).toEqual(first);
  });

  it("leaves the authority head alone when the worker retires its own contexts, and on lease boots", async () => {
    const { id } = await fresh(), w = await worker(id);
    const features = `${f!.features},sync-v1,sync-context-v1,message-authority-v1`;
    expect((await w.hello(features)).status).toBe(200);
    expect((await w.call("execution-leases/boot-clean", { retirementId: randomUUID(), processes: 0, legacyMaterial: "none" }, features)).status).toBe(200);
    const sequence = async () => (await withSystemTx(pool, tx => tx.query("SELECT count(*)::int AS n FROM cloud_v2_authority_events WHERE workspace_id=$1", [id]))).rows[0].n;
    const live = (await pool.query("SELECT id FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND state='active'", [id])).rows.map(row => row.id as string);
    expect(live.length).toBeGreaterThan(0);
    for (const [index, contextId] of live.entries())
      expect((await w.call(`execution-leases/${contextId}/retired`, { retirementId: randomUUID(), reason: index ? "revoked" : "operation_done", processes: 0 }, features)).status).toBe(200);
    expect(await sequence()).toBe(0);
    await pool.query("UPDATE cloud_v2_execution_boots SET authority_mode='lease-v1' WHERE boot_id=$1", [w.boot]);
    await withSystemTx(pool, tx => tx.query("INSERT INTO cloud_v2_execution_invalidations(workspace_id,user_id) VALUES($1,NULL)", [id]));
    expect(await sequence()).toBe(0);
  });

  it("marks running R2 workspaces for re-evaluation when an entitlement changes outside a system transaction", async () => {
    const { id } = await fresh(), w = await worker(id);
    const features = `${f!.features},sync-v1,sync-context-v1,message-authority-v1`;
    expect((await w.hello(features)).status).toBe(200);
    expect((await w.call("execution-leases/boot-clean", { retirementId: randomUUID(), processes: 0, legacyMaterial: "none" }, features)).status).toBe(200);
    await pool.query("INSERT INTO staff_pro_benefits(user_id) VALUES($1) ON CONFLICT (user_id) DO UPDATE SET revision=staff_pro_benefits.revision+1", [f!.creator.id]);
    const due = (await withSystemTx(pool, tx => tx.query("SELECT count(*)::int AS n FROM cloud_v2_authority_rechecks WHERE workspace_id=$1 AND at<=clock_timestamp()", [id]))).rows[0].n;
    expect(due).toBeGreaterThan(0);
  });

  it("clears an earlier boot's failure when a clean boot makes the workspace running", async () => {
    const { id } = await fresh(), w = await worker(id);
    await pool.query("UPDATE cloud_v2_workspaces SET error_code='execution_not_retired' WHERE id=$1", [id]);
    expect((await w.hello()).status).toBe(200);
    expect((await w.call("execution-leases/boot-clean", { retirementId: randomUUID(), processes: 0, legacyMaterial: "none" })).status).toBe(200);
    expect((await pool.query("SELECT state,error_code FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0]).toEqual({ state: "running", error_code: null });
  });

  it("retains the first failure, requests Stop and admits a retry only with a new boot", async () => {
    const { id, fixture } = await fresh(), first = await worker(id);
    const hello = await first.hello(); expect(hello.status).toBe(200);
    const oldContext = (await hello.json()).config.bootstrapContextId;
    const refused = await first.call("execution-leases/boot-clean", { retirementId: randomUUID(), processes: 0, legacyMaterial: "refused", refusals: ["io_error"] });
    expect(refused.status).toBe(409);
    expect((await pool.query("SELECT state,execution_mode,error_code,execution_transition_id FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0])
      .toEqual({ state: "stopping", execution_mode: "active", error_code: "execution_first_boot_failed", execution_transition_id: null });
    expect((await first.call("execution-leases/boot-clean", { retirementId: randomUUID(), processes: 0, legacyMaterial: "none" })).status).toBe(409);
    expect((await first.call("bootstrap-lease", { contextId: oldContext })).status).toBe(409);
    await fixture.cp.store.transition(id, ["stopping"], "stopped", { revoke: true });
    const start = await fixture.call(`/v1/cloud-v2/workspaces/${id}/start`, "POST", {}); expect(start.status).toBe(202);
    const next = await worker(id), nextHello = await next.hello(); expect(nextHello.status).toBe(200);
    expect((await nextHello.json()).config.bootstrapContextId).not.toBe(oldContext);
    expect((await next.call("execution-leases/boot-clean", { retirementId: randomUUID(), processes: 0, legacyMaterial: "none" })).status).toBe(200);
    expect((await pool.query("SELECT first_failed_boot_id,clean_boot_id FROM cloud_v2_execution_creations WHERE workspace_id=$1", [id])).rows[0])
      .toEqual({ first_failed_boot_id: first.boot, clean_boot_id: next.boot });
    expect((await pool.query("SELECT state,error_code FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0]).toEqual({ state: "running", error_code: null });
  });
});
