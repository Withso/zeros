import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../../db.js";
import { createCloudV2ProxyRoutes } from "../proxy.js";
import { EXECUTION_AUTHORIZATION_INPUTS, ExecutionAuthorizationCache } from "./authorization-cache.js";
import type { CachedTokenContext } from "./store.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("in-memory execution token verdicts", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  beforeEach(async () => {
    f = await executionFixture(pool, { authCache: "on" });
    await f.login(f.creator, "codex"); await f.login(f.viewer, "codex"); await f.activate(); expect((await f.hello()).status).toBe(200);
  });
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  afterAll(() => pool.end());

  const turn = async () => {
    const dispatched = await f.dispatch(f.prompt(randomUUID(), { agentId: "codex" }), f.viewer);
    const lease = await (await f.worker("turn-lease", dispatched.lease)).json();
    const end = () => f.worker("prompts/outcome", { userMessageId: dispatched.input.userMessageId, dispatchId: dispatched.begin.dispatchId, state: "completed" });
    return { proxy: lease.agents.codex.token as string, api: lease.api?.token as string | undefined, end };
  };
  const transactions = async (run: () => Promise<unknown>) => {
    const scope = new AsyncLocalStorage<boolean>(), query = pg.Client.prototype.query;
    let count = 0;
    const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      if (scope.getStore() && typeof args[0] === "string" && /^BEGIN\b/.test(args[0])) count += 1;
      return (query as (...values: unknown[]) => unknown).apply(this, args);
    } as never);
    try { await scope.run(true, run); } finally { spy.mockRestore(); }
    return count;
  };
  const refusedWithin = async (check: () => Promise<unknown>, ms: number) => {
    const started = performance.now();
    while (performance.now() - started < ms) {
      try { await check(); } catch { return performance.now() - started; }
      await delay(10);
    }
    throw new Error(`still allowed after ${ms} ms`);
  };

  it("serves a repeated proxy check from memory and refuses it as soon as the turn ends", async () => {
    const { proxy, end } = await turn();
    const access = await f.cp.execution.proxyAccess(proxy);
    expect(await transactions(() => access.check())).toBe(1);
    expect(await transactions(() => access.check())).toBe(0);
    expect((await end()).status).toBe(200);
    // The outcome's commit notifies; the 5 s age bound alone would take far longer.
    expect(await refusedWithin(() => access.check(), 2_000)).toBeLessThan(1_000);
  });

  it("refuses a cached API token as soon as API access is turned off", async () => {
    const { api } = await turn();
    expect(api).toBeTruthy();
    if (!api) return;
    await f.cp.execution.cachedTokenContext("api", { token: api });
    expect(await transactions(() => f.cp.execution.cachedTokenContext("api", { token: api }))).toBe(0);
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_workspaces SET api_access=false WHERE id=$1", [f.workspace.id]));
    expect(await refusedWithin(() => f.cp.execution.cachedTokenContext("api", { token: api }), 2_000)).toBeLessThan(1_000);
  });

  it("bounds a lost notification by the age limit", async () => {
    const { proxy, end } = await turn();
    // No listener at all: only the age bound can drop the entry.
    const lost = new ExecutionAuthorizationCache<CachedTokenContext>({ mode: "on", healthy: () => true, maxAgeMs: 300 });
    lost.invalidate = () => {}; lost.flush = () => {};
    f.cp.execution.authorizations = lost;
    const access = await f.cp.execution.proxyAccess(proxy);
    await access.check();
    expect((await end()).status).toBe(200);
    await access.check();
    const waited = await refusedWithin(() => access.check(), 2_000);
    expect(waited).toBeGreaterThan(100);
    expect(waited).toBeLessThan(1_000);
  });

  it("checks every streamed chunk against memory, so a stream costs no transaction per chunk", async () => {
    const { proxy } = await turn();
    const chunks = Array.from({ length: 10 }, (_, index) => `chunk-${index};`);
    const app = createCloudV2ProxyRoutes({ ...f.cp.proxy, fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    } })) });
    const get = vi.spyOn(f.cp.execution.authorizations!, "get");
    let text = "";
    const count = await transactions(async () => {
      const response = await app.request("/v2/cloud/proxy/openai/responses", { method: "POST",
        headers: { authorization: `Bearer ${proxy}`, "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(200); text = await response.text();
    });
    expect(text).toBe(chunks.join(""));
    // One check per chunk and one for the end, plus the checks after the upstream reply and at stream start.
    expect(get.mock.calls.length).toBeGreaterThanOrEqual(chunks.length + 1);
    // proxyAccess 1, the first load 1 (the rest are hits), and the stream-start check unless it finds the entry.
    expect(count).toBeLessThanOrEqual(3);
  });

  it("answers 401, as without the cache, when the live API fence refuses a cached verdict", async () => {
    const { api, end } = await turn();
    // Hold the verdict as a delayed notification would.
    const held = new ExecutionAuthorizationCache<CachedTokenContext>({ mode: "on", healthy: () => true });
    held.invalidate = () => {}; held.flush = () => {};
    f.cp.execution.authorizations = held;
    await f.cp.api.credentials.resolve(`Bearer ${api}`);
    expect((await end()).status).toBe(200);
    await expect(f.cp.api.credentials.resolve(`Bearer ${api}`)).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });

  const terminalToken = async () => {
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST", { wake: false }, f.viewer, { "X-Zeros-Team-Sharing": "1" });
    expect(response.status).toBe(200);
    const grant = await f.cp.store.consumeConnectTicket((await response.json()).protocols[1].slice(7), f.workspace.id);
    const clientId = randomUUID(), client = await f.cp.execution.clients.open(f.workspace.id, clientId, grant!);
    await f.cp.execution.clients.forward(f.workspace.id, client.contextId, { type: "PTY_CREATE", id: "terminal", sessionId: "terminal" });
    const lease = await (await f.worker("terminal-lease", { clientId, requestId: "terminal", terminalId: "terminal" })).json();
    return lease.api?.token as string | undefined;
  };

  it("knows every table the token check reads and how each one drops a verdict", async () => {
    const { proxy, api } = await turn();
    const terminal = await terminalToken();
    expect([proxy, api, terminal].every(Boolean)).toBe(true);
    const fresh = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    try {
      const read = new Set<string>();
      for (const [kind, token] of [["proxy", proxy], ["api", api], ["api", terminal]] as const) {
        // The view lists what this backend has read since its last statistics flush; the connection is fresh and only
        // ever runs these checks, and the union is what matters.
        const tables = await withSystemTx(fresh, async tx => {
          await (f.cp.execution as unknown as { tokenContextOnce: (...args: unknown[]) => Promise<unknown> }).tokenContextOnce(kind, { token }, tx);
          return (await tx.query<{ relname: string }>(`SELECT relname FROM pg_stat_xact_user_tables
            WHERE coalesce(seq_scan,0)+coalesce(idx_scan,0)>0`)).rows.map(row => row.relname);
        });
        for (const table of tables) read.add(table);
      }
      expect(read.has("cloud_v2_execution_contexts")).toBe(true);
      expect(read.has("auth_sessions")).toBe(true);
      expect([...read].filter(table => !(table in EXECUTION_AUTHORIZATION_INPUTS)).sort()).toEqual([]);
      // Pinned definitions: narrowing a column list or a WHEN clause must be a deliberate change here.
      const triggers = (await pool.query<{ relname: string; proname: string; definition: string }>(`SELECT c.relname,p.proname,
          pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE NOT t.tgisinternal AND c.relname=ANY($1) AND p.proname=ANY($2) ORDER BY 1,3`,
        [Object.keys(EXECUTION_AUTHORIZATION_INPUTS), ["notify_cloud_v2_authorization", "fence_cloud_execution_authority", "erase_cloud_execution_material"]])).rows;
      const has = (table: string, proname: string) => triggers.some(row => row.relname === table && row.proname === proname);
      for (const [table, ways] of Object.entries(EXECUTION_AUTHORIZATION_INPUTS) as [string, readonly string[]][]) {
        if (ways.includes("hint")) expect(has(table, "notify_cloud_v2_authorization"), table).toBe(true);
        if (ways.includes("fence")) expect(has(table, "fence_cloud_execution_authority"), table).toBe(true);
        if (ways.includes("context")) expect(table === "cloud_v2_execution_tokens" || has(table, "erase_cloud_execution_material"), table).toBe(true);
      }
      expect(triggers.map(row => row.definition.replace(/ ON public\./, " ON "))).toEqual(PINNED_TRIGGERS);
    } finally { await fresh.end(); }
  });

  it("hints the settings the fence does not see, and stays silent on renewals", async () => {
    const { proxy } = await turn();
    const context = (await pool.query<{ id: string }>(`SELECT c.id FROM cloud_v2_execution_tokens t JOIN cloud_v2_execution_contexts c ON c.id=t.context_id
      WHERE t.kind='proxy' ORDER BY c.created_at DESC LIMIT 1`)).rows[0]!;
    expect(proxy).toBeTruthy();
    const listener = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await listener.connect();
    const heard: string[] = [];
    listener.on("notification", notice => { if (notice.channel === "zeros_cloud_v2_authorization" || notice.channel === "zeros_cloud_v2_execution") heard.push(`${notice.channel}|${notice.payload}`); });
    await listener.query("LISTEN zeros_cloud_v2_authorization; LISTEN zeros_cloud_v2_execution");
    const after = async (sql: string, values: unknown[]) => {
      heard.length = 0; await withSystemTx(pool, tx => tx.query(sql, values)); await delay(150); return [...heard];
    };
    const authorization = (payload: string) => `zeros_cloud_v2_authorization|${payload}`;
    try {
      expect(await after("UPDATE cloud_v2_execution_contexts SET expires_at=expires_at+interval '1 minute' WHERE id=$1", [context.id])).toEqual([]);
      expect(await after("UPDATE cloud_v2_workspaces SET api_access=api_access WHERE id=$1", [f.workspace.id])).toEqual([]);
      expect(await after("UPDATE cloud_v2_workspaces SET api_access=NOT api_access WHERE id=$1", [f.workspace.id])).toEqual([authorization(`w:${f.workspace.id}`)]);
      expect(await after("UPDATE cloud_v2_execution_contexts SET sender_ended_at=clock_timestamp() WHERE id=$1", [context.id])).toEqual([authorization(`w:${f.workspace.id}`)]);
      expect(await after("UPDATE cloud_v2_execution_contexts SET sender_ended_at=clock_timestamp() WHERE id=$1", [context.id])).toEqual([]);
      expect(await after(`INSERT INTO cloud_api_access_settings (org_id,user_id,workspace_api_access) VALUES ($1,$2,true)
        ON CONFLICT (org_id,user_id) DO UPDATE SET workspace_api_access=NOT cloud_api_access_settings.workspace_api_access`, [f.organizationId, f.viewer.id]))
        .toEqual([authorization(`u:${f.viewer.id}`)]);
    } finally { await listener.end(); }
  });
});

// The fence, context and hint triggers on the token check's inputs, as `pg_get_triggerdef` prints them after 0255.
const PINNED_TRIGGERS = [
  "CREATE TRIGGER execution_session_fence AFTER INSERT OR UPDATE OF status, revoked_at ON auth_sessions FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_authority()",
  "CREATE TRIGGER zz_cloud_v2_authorization AFTER UPDATE OF provider_session_expires_at ON auth_sessions FOR EACH ROW WHEN (((new.provider_session_expires_at IS NOT NULL) AND ((old.provider_session_expires_at IS NULL) OR (new.provider_session_expires_at < old.provider_session_expires_at)))) EXECUTE FUNCTION notify_cloud_v2_authorization('u', 'user_id')",
  "CREATE TRIGGER execution_credential_delete BEFORE DELETE ON cloud_agent_credentials FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_authority()",
  "CREATE TRIGGER execution_credential_update AFTER UPDATE OF revision, revoked_at ON cloud_agent_credentials FOR EACH ROW WHEN (((old.revision IS DISTINCT FROM new.revision) OR (old.revoked_at IS DISTINCT FROM new.revoked_at))) EXECUTE FUNCTION fence_cloud_execution_authority()",
  "CREATE TRIGGER execution_connection_fence AFTER DELETE OR UPDATE ON cloud_agent_organization_connections FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_authority()",
  "CREATE TRIGGER zz_cloud_v2_authorization AFTER INSERT OR DELETE ON cloud_api_access_settings FOR EACH ROW EXECUTE FUNCTION notify_cloud_v2_authorization('u', 'user_id')",
  "CREATE TRIGGER zz_cloud_v2_authorization_update AFTER UPDATE OF workspace_api_access, user_id ON cloud_api_access_settings FOR EACH ROW WHEN (((old.workspace_api_access IS DISTINCT FROM new.workspace_api_access) OR (old.user_id IS DISTINCT FROM new.user_id))) EXECUTE FUNCTION notify_cloud_v2_authorization('u', 'user_id')",
  "CREATE TRIGGER execution_context_revoked AFTER UPDATE OF state, user_id ON cloud_v2_execution_contexts FOR EACH ROW WHEN (((old.state = 'active'::text) AND (new.state <> 'active'::text))) EXECUTE FUNCTION erase_cloud_execution_material()",
  "CREATE TRIGGER execution_material_erase BEFORE UPDATE OF state, user_id ON cloud_v2_execution_contexts FOR EACH ROW EXECUTE FUNCTION erase_cloud_execution_material()",
  "CREATE TRIGGER zz_cloud_v2_authorization AFTER UPDATE OF sender_ended_at ON cloud_v2_execution_contexts FOR EACH ROW WHEN (((old.sender_ended_at IS NULL) AND (new.sender_ended_at IS NOT NULL))) EXECUTE FUNCTION notify_cloud_v2_authorization('w', 'workspace_id')",
  "CREATE TRIGGER zz_cloud_v2_authorization AFTER INSERT OR DELETE OR UPDATE ON cloud_v2_github_sources FOR EACH ROW EXECUTE FUNCTION notify_cloud_v2_authorization('w', 'workspace_id')",
  "CREATE TRIGGER execution_workspace_fence AFTER UPDATE OF state, archived_at, access_epoch, stop_generation, worker_boot_id, worker_token_hash, execution_mode ON cloud_v2_workspaces FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_authority()",
  "CREATE TRIGGER zz_cloud_v2_authorization AFTER UPDATE OF api_access, acting_user_boot_ids, source_pending, source_repositories, repository, execution_intent_id, execution_initiator_user_id ON cloud_v2_workspaces FOR EACH ROW WHEN (((old.api_access IS DISTINCT FROM new.api_access) OR (old.acting_user_boot_ids IS DISTINCT FROM new.acting_user_boot_ids) OR (old.source_pending IS DISTINCT FROM new.source_pending) OR (old.source_repositories IS DISTINCT FROM new.source_repositories) OR (old.repository IS DISTINCT FROM new.repository) OR (old.execution_intent_id IS DISTINCT FROM new.execution_intent_id) OR (old.execution_initiator_user_id IS DISTINCT FROM new.execution_initiator_user_id))) EXECUTE FUNCTION notify_cloud_v2_authorization('w', 'id')",
  "CREATE TRIGGER zz_cloud_v2_authorization AFTER INSERT OR DELETE ON organization_member_seat_periods FOR EACH ROW EXECUTE FUNCTION notify_cloud_v2_authorization('o', 'org_id')",
  "CREATE TRIGGER zz_cloud_v2_authorization_update AFTER UPDATE OF hold_periods, org_id ON organization_member_seat_periods FOR EACH ROW WHEN (((old.hold_periods IS DISTINCT FROM new.hold_periods) OR (old.org_id IS DISTINCT FROM new.org_id))) EXECUTE FUNCTION notify_cloud_v2_authorization('o', 'org_id')",
  "CREATE TRIGGER execution_member_delete AFTER DELETE ON organization_members FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_authority()",
  "CREATE TRIGGER execution_member_insert AFTER INSERT ON organization_members FOR EACH ROW EXECUTE FUNCTION fence_cloud_execution_authority()",
  "CREATE TRIGGER execution_member_update AFTER UPDATE OF role, authorization_revision ON organization_members FOR EACH ROW WHEN (((old.role IS DISTINCT FROM new.role) OR (old.authorization_revision IS DISTINCT FROM new.authorization_revision))) EXECUTE FUNCTION fence_cloud_execution_authority()",
  "CREATE TRIGGER execution_organization_personal AFTER UPDATE OF is_personal ON organizations FOR EACH ROW WHEN ((old.is_personal IS DISTINCT FROM new.is_personal)) EXECUTE FUNCTION fence_cloud_execution_authority()",
  "CREATE TRIGGER execution_organization_update AFTER UPDATE OF authorization_revision, cloud_workspaces_allowed, deleted_at ON organizations FOR EACH ROW WHEN (((old.authorization_revision IS DISTINCT FROM new.authorization_revision) OR (old.cloud_workspaces_allowed IS DISTINCT FROM new.cloud_workspaces_allowed) OR (old.deleted_at IS DISTINCT FROM new.deleted_at))) EXECUTE FUNCTION fence_cloud_execution_authority()",
  "CREATE TRIGGER execution_user_fence AFTER UPDATE OF auth_revision, auth_status, deleted_at ON users FOR EACH ROW WHEN (((old.auth_revision IS DISTINCT FROM new.auth_revision) OR (old.auth_status IS DISTINCT FROM new.auth_status) OR (old.deleted_at IS DISTINCT FROM new.deleted_at))) EXECUTE FUNCTION fence_cloud_execution_authority()",
];
