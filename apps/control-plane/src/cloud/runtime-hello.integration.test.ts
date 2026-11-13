import { generateKeyPairSync, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { HttpError } from "../authz.js";
import { observeTransactionTiming, requestTiming, type RequestDatabaseCost } from "../request-timing.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { CLOUD_V2_ASYNC_CREATE_DELAY_MS, createCloudV2 } from "./composition.js";
import { createCloudV2WorkerRoutes } from "./worker-routes.js";
import type { CloudV2LifecycleDeps } from "./lifecycle.js";
import { CLOUD_SOURCE_ADMISSION_MS, CLOUD_SOURCE_GRACE_MS, CLOUD_SOURCE_REFRESH_MS } from "./source-authority.js";
import { DatabaseCloudAgentCredentialService } from "../agent-credentials/agent-credentials.js";
import { cloudAgentModels } from "../agent-credentials/agent-models.js";
import { createCloudApiRoutes } from "./api/routes.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("runtime hello through the production composition", () => {
  let pool: pg.Pool;
  const cleanup: Array<() => Promise<unknown> | void> = [];
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10 }); });
  beforeEach(() => resetMigratedTestDatabase(pool));
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  afterAll(() => pool.end());

  async function fixture(privateBoot = true, secondary = false, api = false, beforeApiColumn = false, localCommands = false) {
    if (beforeApiColumn) await pool.query("ALTER TABLE cloud_v2_workspaces DROP COLUMN api_access, DROP COLUMN restart_stop_generation");
    const creator = randomUUID(), org = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')", [creator, `${creator}@example.test`]);
    await grantTestPro(pool, creator);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Fixture',$3,false,true)", [org, `org-${org}`, creator]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, creator]);
    let allowed = true;
    const fetcher = vi.fn<typeof fetch>(async value => {
      const url = new URL(String(value));
      if (url.hostname !== "api.github.com") throw new Error("Unexpected provider");
      if (!allowed) return Response.json({ message: "Resource not accessible by personal access token" }, { status: 403 });
      if (url.pathname === "/user") return Response.json({ id: 12, login: "fixture", name: "Fixture", email: "fixture@example.test" });
      if (url.pathname === "/user/emails") return Response.json([{ email: "fixture@example.test", primary: true, verified: true, visibility: null }]);
      if (["/repositories/42", "/repositories/43"].includes(url.pathname)) return Response.json({ id: Number(url.pathname.split("/").at(-1)),
        name: "repo", owner: { login: url.pathname.endsWith("43") ? "secondary" : "fixture" }, default_branch: "main",
        private: true, archived: false, permissions: { pull: true, push: true } });
      if (url.pathname === "/repositories/42/branches/main") return Response.json({ commit: { sha: "c".repeat(40) } });
      if (url.pathname.endsWith("/branches")) return Response.json([]);
      throw new Error(`Unexpected GitHub fixture path: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const config = {
      github: null, deploymentChannel: "alpha", inviteLinkBase: "https://app.example.test/invite", cloudAgentCredentials: { settingsSecretKeyV1: Buffer.alloc(32, 7).toString("base64url") },
      cloudV2: { boat: { apiKey: "synthetic-boat-credential" }, apiUrl: "https://api.example.test", realtimeUrl: "https://rt.example.test", promptOutbox: true,
        workerSigningKey: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
        runtime: { sha256: "b".repeat(64), store: { endpoint: "https://store.example.test", bucket: "fixture", accessKeyId: "fixture", secretAccessKey: "fixture" } } },
    } as Config;
    const cp = createCloudV2(config, pool, { relay: false, lifecycle: false })!;
    cleanup.push(async () => { cp.runtimeUpdates.close(); await cp.api.credentials.close(); await cp.loginChanges?.stop(); await cp.promptChanges?.stop(); await cp.localCommandSignals.close(); });
    const scope = { organizationId: org, userId: creator }, connections = cp.routes.githubConnections!;
    await connections.store.save(scope, await connections.store.fingerprint(scope), { id: "12", login: "fixture" },
      { method: "pat", accessToken: "synthetic-pat", expiresAt: null });
    const id = randomUUID();
    if (secondary) {
      await pool.query(`INSERT INTO cloud_v2_workspaces(id,org_id,creator_user_id,name,repository,branch,base_branch,state,source_repositories)
        VALUES($1,$2,$3,'Historical workspace','fixture/repo','workspace/fixture','main','creating',ARRAY['fixture/repo','secondary/repo'])`, [id, org, creator]);
      await pool.query(`INSERT INTO cloud_v2_github_sources(workspace_id,source_repository,repository_id)
        VALUES($1,'fixture/repo',42),($1,'secondary/repo',43)`, [id]);
    }
    if (beforeApiColumn) {
      const migration = await readFile(new URL("../../migrations/0226_cloud_api.sql", import.meta.url), "utf8");
      const expansion = migration.match(/ALTER TABLE cloud_v2_workspaces\s[\s\S]*?;/)?.[0];
      expect(expansion).toBeDefined();
      await pool.query(expansion!);
    }
    const workspace = secondary ? await cp.store.get(id, creator) : await cp.store.createWorkspace({ id, organizationId: org, creatorUserId: creator, name: "Runtime",
      repository: "fixture/repo", sourceRepositoryId: "42", branch: "workspace/fixture", baseBranch: "main", computerBuildId: null });
    await pool.query("UPDATE cloud_v2_workspaces SET boat_sandbox_id='bx_fixture1234' WHERE id=$1", [workspace.id]);
    const token = await cp.store.rotateWorkerToken(workspace.id), boot = randomUUID(), handoffs = cp.workers.runtimeHandoffs!;
    await cp.store.beginWorkerHello(token, boot); await cp.store.acceptWorkerHello(token, boot);
    await handoffs.recordRuntime(token, boot, "a".repeat(64));
    const current = (await cp.store.workerSession(token, boot))!;
    const h = (await handoffs.prepare(token, boot, { target: "b".repeat(64), instanceId: randomUUID(), revision: current.loginRevision, generation: 7 }))!;
    if (privateBoot) {
      expect(await handoffs.commit(token, boot, h.id, current.loginRevision, 7, h.target_sha256)).toBe(true);
      await handoffs.activate(token, h.id);
    }
    const costs: RequestDatabaseCost[] = [];
    const app = new Hono();
    app.use("*", requestTiming({ slowMs: Infinity, databasePool: pool, costObserver: value => { costs.push(value); } }));
    app.onError((error, c) => c.json({ code: error instanceof HttpError ? error.code : "internal" }, error instanceof HttpError ? error.status : 500));
    app.route("/", createCloudV2WorkerRoutes(cp.workers));
    const hello = (bootId = h.next_boot_id, runtimeSha256 = h.target_sha256, id = h.id, chatEdits = false, localFeature = localCommands, notifyFeature = false, reasonFeature = false) => app.request("/v2/cloud/worker/hello", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-zeros-runtime-handoff": id,
        "x-zeros-worker-features": `runtime-update-v1,prompt-outbox-v1,workspace-environment-v1,repository-setup-v1,mcp-v1,github-pr-v1,git-identity-v1${api ? ",workspace-api-v1" : ""}${chatEdits ? ",chat-edit-v1" : ""}${localFeature ? ",local-commands-v1" : ""}${notifyFeature ? ",notify-user-v1" : ""}${reasonFeature ? ",local-commands-reason-v1" : ""}` },
      body: JSON.stringify({ protocol: 2, bootId, runtimeSha256 }),
    });
    const ordinary = (route: "hello" | "config", apiFeature = api, runtimeSha256 = "b".repeat(64), localFeature = localCommands, notifyFeature = false, reasonFeature = false) => app.request(`/v2/cloud/worker/${route}`, {
      method: route === "hello" ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-zeros-worker-boot": boot,
        "x-zeros-worker-features": `runtime-update-v1,prompt-outbox-v1,workspace-environment-v1,repository-setup-v1,mcp-v1,github-pr-v1,git-identity-v1${apiFeature ? ",workspace-api-v1" : ""}${localFeature ? ",local-commands-v1" : ""}${notifyFeature ? ",notify-user-v1" : ""}${reasonFeature ? ",local-commands-reason-v1" : ""}` },
      ...(route === "hello" ? { body: JSON.stringify({ protocol: 2, bootId: boot, runtimeSha256 }) } : {}),
    });
    return { cp, creator, org, workspace, token, boot, h, handoffs, hello, ordinary, costs, fetcher, app, deny: () => { allowed = false; } };
  }

  it("accepts setup metadata from the current or private adoption boot without source I/O, and fences a cancelled candidate", async () => {
    const f = await fixture(true), initial = await f.cp.store.get(f.workspace.id, f.creator);
    const report = (boot: string, value: unknown, handoff?: string) => f.app.request("/v2/cloud/worker/setup", {
      method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json",
        "x-zeros-worker-boot": boot, "x-zeros-worker-features": "setup-status-v1",
        ...(handoff ? { "x-zeros-runtime-handoff": handoff } : {}) }, body: JSON.stringify(value),
    });
    const calls = f.fetcher.mock.calls.length;
    const running = { state: "running", startedAt: 1 }, complete = { state: "succeeded", startedAt: 1, finishedAt: 2, exitCode: 0 };
    expect((await report(f.boot, running)).status).toBe(204);
    expect((await report(f.h.next_boot_id, complete)).status).toBe(401);
    expect((await report(f.h.next_boot_id, complete, randomUUID())).status).toBe(401);
    expect((await report(f.h.next_boot_id, complete, f.h.id)).status).toBe(204);
    expect(await f.cp.store.get(f.workspace.id, f.creator)).toEqual({ ...initial, setup: complete });
    await f.handoffs.settleUnstarted(f.h.id);
    expect((await report(f.h.next_boot_id, { state: "running", startedAt: 3 }, f.h.id)).status).toBe(401);
    expect(await f.cp.store.get(f.workspace.id, f.creator)).toEqual({ ...initial, setup: complete });
    expect(f.fetcher).toHaveBeenCalledTimes(calls);
  });

  it("encrypts API create environment with the production keyring and resolves it in the worker configuration", async () => {
    const f = await fixture(false), build = randomUUID();
    await pool.query(`INSERT INTO cloud_v2_computer_builds(id,org_id,version,recipe,state,snapshot_id,created_by,source_policy_version,source_targets)
      VALUES($1,$2,1,$3,'succeeded','synthetic-snapshot',$4,2,$5)`, [build, f.org,
      { repositories: [{ repository: "fixture/repo", branch: "main" }] }, f.creator, JSON.stringify([{ repository: "fixture/repo", repositoryId: "42" }])]);
    await pool.query("INSERT INTO cloud_v2_computers(org_id,active_build_id,snapshot_name) VALUES($1,$2,'synthetic-snapshot')", [f.org, build]);
    const key = await f.cp.api.credentials.create(f.org, f.creator, "Environment fixture");
    const env = { APP_SECRET: "synthetic-composition-environment" };
    const response = await createCloudApiRoutes(f.cp.api).request("/workspaces", { method: "POST",
      headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" }, body: JSON.stringify({ repository: "fixture/repo", env }) });
    expect(response.status).toBe(201);
    const { workspace } = await response.json();
    expect(workspace).not.toHaveProperty("env");
    const worker = await f.cp.store.rotateWorkerToken(workspace.id), bootId = randomUUID();
    const hello = await f.app.request("/v2/cloud/worker/hello", { method: "POST", headers: {
      authorization: `Bearer ${worker}`, "content-type": "application/json", "x-zeros-worker-features": "prompt-outbox-v1,workspace-environment-v1,repository-setup-v1" },
    body: JSON.stringify({ protocol: 2, bootId, runtimeSha256: "b".repeat(64) }) });
    const configured = await hello.json();
    expect({ status: hello.status, code: configured.code }).toEqual({ status: 200, code: undefined });
    expect(configured.config.environment).toMatchObject({ repositoryId: "42", variables: env, files: [] });
    expect(JSON.stringify((await pool.query("SELECT envelope FROM cloud_environment_versions")).rows).includes(env.APP_SECRET)).toBe(false);
  });

  it("negotiates local commands only with the feature, organization switch and durable outbox", async () => {
    const f = await fixture(false,false,false,false,true);
    const legacy = await f.ordinary("hello",false,f.h.previous_sha256,false);
    expect(legacy.status).toBe(200); expect((await legacy.json()).config).not.toHaveProperty("localCommands");
    const capable = await f.ordinary("hello",false,f.h.previous_sha256);
    expect(capable.status).toBe(200); expect((await capable.json()).config.localCommands).toBe(1);
    expect((await pool.query("SELECT local_command_boot_ids FROM cloud_v2_workspaces WHERE id=$1",[f.workspace.id])).rows[0].local_command_boot_ids).toContain(f.boot);
    await pool.query("UPDATE organizations SET local_commands_allowed=false WHERE id=$1",[f.org]);
    const switched = await f.ordinary("config"), switchedBody = await switched.json();
    expect({ status: switched.status,code: switchedBody.code }).toEqual({ status: 200,code: undefined });
    expect(switchedBody.config).not.toHaveProperty("localCommands");
    const disabled = await f.app.request("/v2/cloud/worker/local-commands",{ method: "POST",headers: {
      authorization: `Bearer ${f.token}`,"x-zeros-worker-boot": f.boot,"x-zeros-worker-features": "local-commands-v1","content-type": "application/json",
    },body: JSON.stringify({ requestId: randomUUID(),chatId: "chat",executionId: "execution",input: { command: "x" } }) });
    expect(disabled.status).toBe(201); expect((await disabled.json()).result).toEqual({ outcome: "disabled" });
    await pool.query("UPDATE organizations SET local_commands_allowed=true WHERE id=$1",[f.org]);
    f.cp.workers.promptOutbox = false;
    expect((await (await f.ordinary("config")).json()).config).not.toHaveProperty("localCommands");
  });

  it.each([false, true])("gates local command reasons in current and private-boot configurations (private=%s)", async privateBoot => {
    const f = await fixture(privateBoot,false,false,false,true);
    const configure = (local: boolean, reason: boolean) => privateBoot
      ? f.hello(undefined,undefined,undefined,false,local,false,reason)
      : f.ordinary("hello",false,f.h.previous_sha256,local,false,reason);
    const legacy = await configure(true,false);
    expect(legacy.status).toBe(200); expect((await legacy.json()).config).not.toHaveProperty("localCommandReason");
    const capable = await configure(true,true);
    expect(capable.status).toBe(200); expect((await capable.json()).config).toMatchObject({ localCommands: 1,localCommandReason: 1 });
    const reasonOnly = await configure(false,true);
    expect(reasonOnly.status).toBe(200); expect((await reasonOnly.json()).config).not.toHaveProperty("localCommandReason");
    await pool.query("UPDATE organizations SET local_commands_allowed=false WHERE id=$1",[f.org]);
    const disabled = await configure(true,true);
    if (privateBoot) { expect(disabled.status).toBe(401); return; }
    expect(disabled.status).toBe(200); expect((await disabled.json()).config).not.toHaveProperty("localCommandReason");
    await pool.query("UPDATE organizations SET local_commands_allowed=true WHERE id=$1",[f.org]);
    f.cp.workers.promptOutbox = false;
    expect((await (await configure(true,true)).json()).config).not.toHaveProperty("localCommandReason");
  });

  it("negotiates NotifyUser only for capable workers with the durable outbox, independently of local commands", async () => {
    const f = await fixture(false);
    const legacy = await f.ordinary("hello",false,f.h.previous_sha256);
    expect(legacy.status).toBe(200); expect((await legacy.json()).config).not.toHaveProperty("notifyUser");
    await pool.query("UPDATE organizations SET local_commands_allowed=false WHERE id=$1",[f.org]);
    const capable = await f.ordinary("hello",false,f.h.previous_sha256,false,true);
    expect(capable.status).toBe(200); expect((await capable.json()).config.notifyUser).toBe(1);
    expect((await (await f.ordinary("config",false,f.h.previous_sha256,false,true)).json()).config.notifyUser).toBe(1);
    f.cp.workers.promptOutbox = false;
    expect((await (await f.ordinary("config",false,f.h.previous_sha256,false,true)).json()).config).not.toHaveProperty("notifyUser");
  });

  it("configures a runtime adoption candidate's NotifyUser capability without promoting the candidate", async () => {
    const f = await fixture(true);
    const configured = await f.hello(f.h.next_boot_id,f.h.target_sha256,f.h.id,false,false,true);
    expect(configured.status).toBe(200); expect((await configured.json()).config.notifyUser).toBe(1);
    expect(await f.cp.store.workerSession(f.token,f.h.next_boot_id)).toBeNull();
    const notification = await f.app.request("/v2/cloud/worker/notifications",{ method: "POST",headers: {
      authorization: `Bearer ${f.token}`,"x-zeros-worker-boot": f.h.next_boot_id,"x-zeros-runtime-handoff": f.h.id,
      "x-zeros-worker-features": "notify-user-v1","content-type": "application/json",
    },body: JSON.stringify({ notificationId: randomUUID(),chatId: "chat",userMessageId: "turn",executionId: "native",
      kind: "review",title: "Review",message: "Ready" }) });
    expect(notification.status).toBe(401);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_notifications WHERE workspace_id=$1",[f.workspace.id])).rows[0].n).toBe(0);
    const legacy = await f.hello();
    expect(legacy.status).toBe(200); expect((await legacy.json()).config).not.toHaveProperty("notifyUser");
  });

  it.each([false,true])("negotiates private local-command support without granting requests before promotion, rollback=%s",async rollback => {
    const f = await fixture(true,false,false,false,true);
    const candidate = await f.hello(); expect(candidate.status).toBe(200); expect((await candidate.json()).config.localCommands).toBe(1);
    const create = (bootId: string) => f.app.request("/v2/cloud/worker/local-commands",{ method: "POST",headers: {
      authorization: `Bearer ${f.token}`,"x-zeros-worker-boot": bootId,"x-zeros-worker-features": "local-commands-v1","content-type": "application/json",
    },body: JSON.stringify({ requestId: randomUUID(),chatId: "chat",executionId: "execution",input: { command: "x" } }) });
    expect((await create(f.h.next_boot_id)).status).toBe(401);
    expect((await f.ordinary("hello",false,f.h.previous_sha256,false)).status).toBe(200);
    if (rollback) {
      await f.handoffs.rollback(f.h.id);
      const fallback = await f.hello(f.h.rollback_boot_id,f.h.previous_sha256,f.h.id,false,false);
      expect(fallback.status).toBe(200); expect((await fallback.json()).config).not.toHaveProperty("localCommands");
    }
    const promoted = rollback ? f.h.rollback_boot_id : f.h.next_boot_id;
    expect(await f.handoffs.promote(f.token,f.h.id,promoted)).toBe(true);
    expect((await create(promoted)).status).toBe(rollback ? 401 : 201);
    expect((await pool.query("SELECT cardinality(local_command_boot_ids) AS n FROM cloud_v2_workspaces WHERE id=$1",[f.workspace.id])).rows[0].n).toBeLessThanOrEqual(2);
  });

  it("skips N-1 setting reads and retries a configuration whose organization was disabled during the read",async () => {
    const f = await fixture(false,false,false,false,true), commands = f.cp.workers.localCommands!.requests;
    const read = commands.enabled.bind(commands), spy = vi.spyOn(commands,"enabled");
    const legacy = await f.ordinary("config",false,f.h.previous_sha256,false);
    expect(legacy.status).toBe(200); expect(spy).not.toHaveBeenCalled();
    let entered!: () => void, release!: () => void;
    const observed = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    spy.mockImplementationOnce(async id => { const value = await read(id); entered(); await held; return value; });
    const pending = f.ordinary("config");
    try {
      await observed;
      await pool.query("UPDATE organizations SET local_commands_allowed=false WHERE id=$1",[f.org]);
      release();
      const response = await pending; expect(response.status).toBe(200);
      expect((await response.json()).config).not.toHaveProperty("localCommands");
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally { release(); await pending; }
  });

  it("grants a pre-column workspace API access only to a worker advertising the feature", async () => {
    const f = await fixture(false, true, false, true);
    const legacy = await f.ordinary("config");
    expect(legacy.status).toBe(200); expect((await legacy.json()).config).not.toHaveProperty("api");
    expect((await pool.query("SELECT 1 FROM cloud_v2_tokens WHERE workspace_id=$1 AND kind='api'", [f.workspace.id])).rowCount).toBe(0);
    const capable = await f.ordinary("config", true);
    expect(capable.status).toBe(200);
    const api = (await capable.json()).config.api;
    expect(typeof api?.token).toBe("string");
    const authenticated = await createCloudApiRoutes(f.cp.api).request("/me", { headers: { authorization: `Bearer ${api.token}` } });
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toMatchObject({ workspaceId: f.workspace.id, userId: f.creator, organizationId: f.org });
    const oldAgain = await f.ordinary("config", false);
    expect(oldAgain.status).toBe(200); expect((await oldAgain.json()).config).not.toHaveProperty("api");
  });

  it.each([false, true])("shares one VM-run API token with the current and private worker through rollback=%s", async rollback => {
    const f = await fixture(false, false, true);
    const original = await f.ordinary("config"); expect(original.status).toBe(200);
    const api = (await original.json()).config.api;
    expect(typeof api?.token).toBe("string");
    expect(await f.handoffs.commit(f.token, f.boot, f.h.id, f.h.login_revision, 7, f.h.target_sha256)).toBe(true);
    await f.handoffs.activate(f.token, f.h.id);
    const response = await f.hello();
    expect(response.status).toBe(200);
    expect((await response.json()).config.api?.token === api.token).toBe(true);
    if (rollback) {
      expect(await f.handoffs.rollback(f.h.id)).not.toBeNull();
      expect((await (await f.hello(f.h.rollback_boot_id, f.h.previous_sha256)).json()).config.api?.token === api.token).toBe(true);
    }
    expect(await f.handoffs.promote(f.token, f.h.id, rollback ? f.h.rollback_boot_id : f.h.next_boot_id)).toBe(true);
    expect((await f.cp.api.credentials.resolve(`Bearer ${api.token}`)).workspaceId).toBe(f.workspace.id);
    const repeated = (await (await (rollback ? f.hello(f.h.rollback_boot_id, f.h.previous_sha256) : f.hello())).json()).config.api;
    expect(repeated?.token === api.token).toBe(true);
    expect((await pool.query("SELECT stop_generation::text AS generation FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].generation).toBe(f.h.stop_generation);
    expect((await pool.query("SELECT 1 FROM cloud_v2_tokens WHERE workspace_id=$1 AND kind='api'", [f.workspace.id])).rowCount).toBe(1);
  });

  it.each([false, true])("retains the current worker's API token when a committed=%s runtime adoption is cancelled", async committed => {
    const f = await fixture(false, false, true);
    const before = await f.ordinary("config"); expect(before.status).toBe(200);
    const token = (await before.json()).config.api?.token;
    expect(typeof token).toBe("string");
    if (committed) expect(await f.handoffs.commit(f.token, f.boot, f.h.id, f.h.login_revision, 7, f.h.target_sha256)).toBe(true);
    expect(await f.handoffs.cancel(f.token, f.h.id, f.boot)).toBe(true);
    const after = await f.ordinary("config"); expect(after.status).toBe(200);
    expect((await after.json()).config.api?.token === token).toBe(true);
    expect((await f.cp.api.credentials.resolve(`Bearer ${token}`)).workspaceId).toBe(f.workspace.id);
    expect((await pool.query("SELECT stop_generation::text AS generation FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].generation).toBe(f.h.stop_generation);
  });

  it.each([false, true])("binds session-edit support to the promoted worker, including rollback=%s", async rollback => {
    const f = await fixture(), sessionId = randomUUID();
    await f.cp.store.writeHistory(f.workspace.id, { chats: [{ id: sessionId, title: "Original", agentId: "codex" } as never] });
    const key = (await f.cp.api.credentials.create(f.org, f.creator, "Capability test")).key;
    const api = createCloudApiRoutes(f.cp.api);
    const rename = () => api.request(`/sessions/${sessionId}/rename`, { method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Edited" }) });
    expect((await rename()).status).toBe(409);
    expect((await f.hello(f.h.next_boot_id, f.h.target_sha256, f.h.id, true)).status).toBe(200);
    const beforePromotion = await rename();
    expect(beforePromotion.status).toBe(409);
    expect((await beforePromotion.json()).error.code).toBe("worker_update_required");
    if (rollback) {
      expect(await f.handoffs.rollback(f.h.id)).not.toBeNull();
      expect((await f.hello(f.h.rollback_boot_id, f.h.previous_sha256, f.h.id, false)).status).toBe(200);
    }
    expect(await f.handoffs.promote(f.token, f.h.id, rollback ? f.h.rollback_boot_id : f.h.next_boot_id)).toBe(true);
    expect((await rename()).status).toBe(rollback ? 409 : 200);
    expect((await pool.query("SELECT cardinality(chat_edit_boot_ids) AS n FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].n).toBeLessThanOrEqual(2);
  });

  it("preserves an adoption candidate's session-edit support through a repeated current hello", async () => {
    const f = await fixture(), sessionId = randomUUID();
    await f.cp.store.writeHistory(f.workspace.id, { chats: [{ id: sessionId, title: "Original", agentId: "codex" } as never] });
    const key = (await f.cp.api.credentials.create(f.org, f.creator, "Capability test")).key;
    expect((await f.hello(f.h.next_boot_id, f.h.target_sha256, f.h.id, true)).status).toBe(200);
    expect((await f.ordinary("hello", false, f.h.previous_sha256)).status).toBe(200);
    expect(await f.handoffs.promote(f.token, f.h.id, f.h.next_boot_id)).toBe(true);
    const response = await createCloudApiRoutes(f.cp.api).request(`/sessions/${sessionId}/rename`, { method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Edited" }) });
    expect(response.status).toBe(200);
    expect((await response.json()).name).toBe("Edited");
  });

  it("bounds ordinary hello and configuration refresh through the real services", async () => {
    const f = await fixture(false), samples: Array<{ phase: string; transactions: number; queries: number; githubCalls: number }> = [];
    for (const phase of ["hello", "hello", "config"] as const) {
      f.fetcher.mockClear();
      const response = await observeTransactionTiming(() => f.ordinary(phase), timing => samples.push({ phase,
        transactions: timing.transactions, queries: f.costs.at(-1)!.queriesStarted, githubCalls: f.fetcher.mock.calls.length }));
      expect(response.status).toBe(200);
      expect((await response.json()).config.workspace.github).toMatchObject({ repositoryId: "42", repository: "fixture/repo" });
    }
    console.info("Ordinary worker configuration cost", samples);
    expect(samples[0]!.transactions).toBeLessThanOrEqual(31);
    expect(samples[0]!.queries).toBeLessThanOrEqual(145);
    for (const sample of samples.slice(1)) expect(sample.transactions).toBeLessThanOrEqual(20);
    for (const sample of samples.slice(1)) expect(sample.queries).toBeLessThanOrEqual(85);
    for (const sample of samples.slice(1)) expect(sample.githubCalls).toBeLessThanOrEqual(1);
  });

  it.each([
    ["github_unavailable", 503, false], ["github_rate_limited", 429, false],
    ["github_unavailable", 503, true], ["github_rate_limited", 429, true],
    ["github_cloud_access_denied", 403, false],
  ] as const)("rechecks a stored %s at hello configuration without bypassing backoff (%s, %s)", async (code, status, backoff) => {
    const f = await fixture(false);
    expect((await f.ordinary("hello")).status).toBe(200);
    const config = f.cp.workers.config;
    vi.spyOn(f.cp.workers, "config").mockImplementationOnce(async (...args) => {
      // A different replica may record a failure after the route's admission.
      await pool.query(`UPDATE cloud_github_source_verifications SET
        verified_at=clock_timestamp()-interval '1 minute',failure_code=$2,failure_status=$3,
        retry_at=clock_timestamp()+($4::double precision * interval '1 minute') WHERE org_id=$1`,
      [f.org, code, status, backoff ? 1 : -1]);
      return config(...args);
    });
    f.fetcher.mockClear();
    const response = await f.ordinary("hello");
    expect(response.status).toBe(status === 403 ? 403 : 200);
    const body = await response.json();
    if (status !== 403) {
      expect(body.config.workspace.github).toMatchObject({ repositoryId: "42", repository: "fixture/repo" });
      expect(f.fetcher).not.toHaveBeenCalled();
      if (!backoff) {
        expect((await f.ordinary("hello")).status).toBe(200);
        await vi.waitFor(async () => expect((await pool.query("SELECT failure_code FROM cloud_github_source_verifications WHERE org_id=$1", [f.org])).rows)
          .toEqual([{ failure_code: null }]));
        expect(f.fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname === "/repositories/42")).toHaveLength(1);
      }
    } else {
      expect(body).toEqual({ code });
      expect(f.fetcher).not.toHaveBeenCalled();
    }
    expect((await f.cp.store.get(f.workspace.id, f.creator)).state).toBe(status === 403 ? "stopping" : "running");
  });

  async function holdProfile(f: Awaited<ReturnType<typeof fixture>>, route: "hello" | "config") {
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const original = f.fetcher.getMockImplementation()!;
    // Hold the profile read itself, not a reused answer from the hello before.
    f.cp.routes.githubConnections!.forgetRecentProfiles();
    f.fetcher.mockImplementationOnce(async (...args) => {
      expect(new URL(String(args[0])).pathname).toBe("/user");
      const response = await original(...args); entered(); await held; return response;
    });
    const pending = f.ordinary(route);
    await Promise.race([waiting, pending.then(() => { throw new Error("Configuration completed before the held profile read"); })]);
    return { pending, release };
  }

  it.each((["hello", "config"] as const).flatMap(route =>
    (["member", "access", "stop", "source", "denial", "expiry", "disconnect", "checkout"] as const).map(change => [route, change] as const)))(
  "withholds %s when %s changes during held profile I/O", async (route, change) => {
    const f = await fixture(false);
    expect((await f.ordinary("hello")).status).toBe(200);
    await f.cp.loginChanges?.stop();
    const held = await holdProfile(f, route);
    try {
      if (change === "member") await pool.query("DELETE FROM organization_members WHERE org_id=$1", [f.org]);
      else if (change === "access") await pool.query("UPDATE cloud_v2_workspaces SET access_epoch=access_epoch+1 WHERE id=$1", [f.workspace.id]);
      else if (change === "stop") await f.cp.store.transition(f.workspace.id, ["running"], "stopping");
      else if (change === "checkout") await f.cp.workers.githubCheckout!(f.token, f.boot,
        { sequence: 1, branch: "workspace/changed", baseBranch: "main", headSha: "c".repeat(40) });
      else if (change === "source") await pool.query("DELETE FROM cloud_v2_github_sources WHERE workspace_id=$1", [f.workspace.id]);
      else if (change === "denial") await pool.query(`UPDATE cloud_github_source_verifications
        SET verified_at=NULL,failure_code='github_cloud_access_denied',failure_status=403 WHERE org_id=$1`, [f.org]);
      else if (change === "expiry") await pool.query(`UPDATE cloud_github_source_verifications
        SET verified_at=clock_timestamp()-($2::double precision * interval '1 millisecond') WHERE org_id=$1`,
      [f.org, CLOUD_SOURCE_GRACE_MS + 1000]);
      else {
        const scope = { organizationId: f.org, userId: f.creator }, connections = f.cp.routes.githubConnections!;
        await connections.store.disconnect(scope, await connections.store.fingerprint(scope), "pat");
      }
    } finally { held.release(); }
    const response = await held.pending;
    expect(response.status, change).not.toBe(200);
    expect(await response.json(), change).not.toHaveProperty("config");
    if (change === "denial") expect((await f.cp.store.get(f.workspace.id, f.creator)).state).toBe("stopping");
  });

  // The lifecycle verifies the source (reading /user) seconds before the
  // worker's hello, whose Git identity read /user again on the critical path.
  it("reuses the creator's /user answer from the lifecycle's check at hello, still fencing the credential", async () => {
    const f = await fixture(false);
    await f.cp.routes.authorizeSource!(f.workspace);
    f.fetcher.mockClear();
    const response = await f.ordinary("hello");
    expect(response.status).toBe(200);
    expect((await response.json()).config.gitIdentity).toMatchObject({ name: "Fixture" });
    expect(f.fetcher.mock.calls.filter(([value]) => new URL(String(value)).pathname === "/user")).toHaveLength(0);
  });

  it("renews a booting workspace's aging verification at the lifecycle's check, so its hello makes no GitHub request", async () => {
    const f = await fixture(false);
    await f.cp.routes.authorizeSource!(f.workspace);
    const age = async () => Number((await pool.query<{ age: string }>(`SELECT (extract(epoch FROM clock_timestamp()-verified_at)*1000)::bigint AS age
      FROM cloud_github_source_verifications WHERE org_id=$1`, [f.org])).rows[0]!.age);
    // A wake in progress, whose last positive has 10 s left.
    await pool.query("UPDATE cloud_v2_workspaces SET state='starting' WHERE id=$1", [f.workspace.id]);
    await pool.query("UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp()-($2::double precision * interval '1 millisecond') WHERE org_id=$1", [f.org, CLOUD_SOURCE_ADMISSION_MS - 10_000]);
    f.cp.routes.githubConnections!.forgetRecentProfiles();
    f.fetcher.mockClear();
    // The composition gives the lifecycle this same check, which asks to renew.
    const lifecycleCheck: NonNullable<CloudV2LifecycleDeps["authorizeSource"]> = f.cp.routes.authorizeSource!;
    const started = performance.now();
    await lifecycleCheck(await f.cp.store.get(f.workspace.id, f.creator), { renew: true });
    expect(performance.now() - started).toBeLessThan(5000);
    await vi.waitFor(async () => expect(await age(), "renewed in the background").toBeLessThan(10_000), { timeout: 2500 });
    // The worker's hello, 12 s later: past the original positive's expiry.
    await pool.query("UPDATE cloud_github_source_verifications SET verified_at=verified_at-interval '12 seconds' WHERE org_id=$1", [f.org]);
    f.fetcher.mockClear();
    const response = await f.ordinary("hello");
    expect(response.status).toBe(200);
    expect((await response.json()).config.gitIdentity).toMatchObject({ name: "Fixture" });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect((await f.cp.store.get(f.workspace.id, f.creator)).state).toBe("running");
  });

  // A draining replica would refuse a pending create's row, as for #903.
  it("returns creates early only one lifecycle scan interval after start", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const f = await fixture(false);
      expect(f.cp.routes.asyncCreate?.()).toBe(false);
      vi.setSystemTime(Date.now() + CLOUD_V2_ASYNC_CREATE_DELAY_MS);
      expect(f.cp.routes.asyncCreate?.()).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("rechecks a secondary original source after held configuration I/O", async () => {
    const f = await fixture(false, true);
    expect((await f.ordinary("hello")).status).toBe(200);
    await f.cp.loginChanges?.stop();
    const held = await holdProfile(f, "config");
    try {
      await pool.query(`UPDATE cloud_github_source_verifications SET verified_at=NULL,
        failure_code='github_cloud_access_denied',failure_status=403 WHERE org_id=$1 AND repository_id=43`, [f.org]);
    } finally { held.release(); }
    const response = await held.pending;
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty("config");
  });

  it.each(["hello", "config"] as const)("keeps the original %s deadline even if a later positive appears while profile I/O is held", async route => {
    const f = await fixture(false);
    expect((await f.ordinary("hello")).status).toBe(200);
    const held = await holdProfile(f, route), now = Date.now();
    try {
      await pool.query("UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp() WHERE org_id=$1", [f.org]);
      vi.spyOn(Date, "now").mockReturnValue(now + (route === "hello" ? CLOUD_SOURCE_GRACE_MS : CLOUD_SOURCE_REFRESH_MS) + 1000);
    } finally { held.release(); }
    const response = await held.pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "github_verification_expired" });
  });

  it("restarts configuration for a new selected GitHub account instead of publishing the held account", async () => {
    const f = await fixture(false);
    expect((await f.ordinary("hello")).status).toBe(200);
    await f.cp.loginChanges?.stop();
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (value, init) => new URL(String(value)).pathname === "/user" &&
      new Headers(init?.headers).get("authorization") === "Bearer synthetic-reselected-pat"
      ? Response.json({ id: 99, login: "reselected", name: "Reselected Author" }) : original(value, init));
    const held = await holdProfile(f, "config");
    try {
      const scope = { organizationId: f.org, userId: f.creator }, connections = f.cp.routes.githubConnections!;
      await connections.store.save(scope, await connections.store.fingerprint(scope), { id: "99", login: "reselected" },
        { method: "pat", accessToken: "synthetic-reselected-pat", expiresAt: null });
    } finally { held.release(); }
    const response = await held.pending;
    expect(response.status).toBe(200);
    expect((await response.json()).config.gitIdentity).toEqual({ name: "Reselected Author", email: "99+reselected@users.noreply.github.com" });
  });

  it("removes a provider revoked after the config read before publishing the new revision", async () => {
    const f = await fixture(false), id = randomUUID();
    await pool.query("INSERT INTO user_identities(user_id,provider,provider_sub,email_at_link,email_verified_at) VALUES($1,'workos',$2,$3,now())",
      [f.creator, `workos|${f.creator}`, `${f.creator}@example.test`]);
    const service = new DatabaseCloudAgentCredentialService(pool, { currentKeyVersion: 1, keys: { 1: Buffer.alloc(32, 7).toString("base64url") } });
    await service.put({ ownerUserId: f.creator, organizationId: f.org, credentialId: id, operationId: randomUUID(), expectedRevision: 0,
      displayName: "Fixture", material: { kind: "claude-api-key", apiKey: "synthetic-selected-provider" } });
    await service.setOrganizationConnection(f.creator, f.org, "claude", { expectedRevision: 0, credentialId: id, credentialRevision: 1,
      models: [cloudAgentModels("claude")[0]], consent: "zeros-managed" });
    const before = await f.ordinary("hello");
    expect((await before.json()).config.agents.claude).toBeDefined();
    await f.cp.loginChanges?.stop();
    const held = await holdProfile(f, "config");
    try { await service.revoke(f.creator, id); } finally { held.release(); }
    const response = await held.pending;
    expect(response.status).toBe(200);
    expect((await response.json()).config.agents).toEqual({});
  });

  it("retains the selected author and confirmed binding during a temporary profile outage", async () => {
    const f = await fixture(false);
    expect((await f.ordinary("hello")).status).toBe(200);
    f.cp.routes.githubConnections!.forgetRecentProfiles();
    f.fetcher.mockImplementation(async () => Response.json({}, { status: 503 }));
    const response = await f.ordinary("config");
    expect(response.status).toBe(200);
    expect((await response.json()).config).toMatchObject({
      gitIdentity: { name: "fixture", email: "12+fixture@users.noreply.github.com" },
      workspace: { github: { repositoryId: "42", repository: "fixture/repo" } },
    });
  });

  it("retains aliases and the newest binding observation through canonical moves and older positives", async () => {
    const f = await fixture(false);
    expect((await f.ordinary("hello")).status).toBe(200);
    const original = (await pool.query("SELECT verified_at FROM cloud_github_source_verifications WHERE org_id=$1", [f.org])).rows[0].verified_at;
    await pool.query("UPDATE cloud_github_source_verifications SET canonical_repository='moved/repo',verified_at=clock_timestamp() WHERE org_id=$1", [f.org]);
    const moved = await f.ordinary("config");
    expect(moved.status).toBe(200);
    expect((await moved.json()).config.workspace.github).toMatchObject({ repositoryId: "42", repository: "moved/repo",
      previousRepositories: expect.arrayContaining(["fixture/repo", "moved/repo"]) });
    await pool.query("UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp() WHERE org_id=$1", [f.org]);
    expect((await f.ordinary("config")).status).toBe(200);
    const observed = (await pool.query("SELECT repository_observed_at FROM cloud_v2_github_workspaces WHERE workspace_id=$1", [f.workspace.id])).rows[0].repository_observed_at;
    expect(observed.getTime()).toBeGreaterThan(original.getTime());
    await pool.query("UPDATE cloud_github_source_verifications SET canonical_repository='fixture/repo',verified_at=$2 WHERE org_id=$1", [f.org, original]);
    const retained = await f.ordinary("config");
    expect(retained.status).toBe(200);
    expect((await retained.json()).config.workspace.github.repository).toBe("moved/repo");
    expect((await pool.query("SELECT repository_observed_at FROM cloud_v2_github_workspaces WHERE workspace_id=$1", [f.workspace.id])).rows[0].repository_observed_at).toEqual(observed);
    expect((await f.cp.store.get(f.workspace.id, f.creator)).repository).toBe("fixture/repo");
  });

  it("bounds cold and repeated private hello database work with the real configuration and source services", async () => {
    const f = await fixture(), samples: Array<{ transactions: number; durationMs: number }> = [];
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      const reply = await observeTransactionTiming(() => f.hello(), summary => samples.push({ transactions: summary.transactions, durationMs: performance.now() - started }));
      expect(reply.status).toBe(200);
      expect((await reply.json()).config.workspace.github).toMatchObject({ repositoryId: "42", repository: "fixture/repo" });
    }
    console.log("runtime-hello-measurement", JSON.stringify(samples));
    expect(samples.map(sample => sample.transactions)).toEqual([expect.any(Number), expect.any(Number), expect.any(Number)]);
    expect(samples[0]!.transactions).toBeLessThanOrEqual(44);
    for (const sample of samples.slice(1)) expect(sample.transactions).toBeLessThanOrEqual(32);
  });

  it.each(["member", "login", "stop", "access", "expiry", "source", "foreign-boot", "old-boot", "digest", "foreign-handoff"])("refuses a changed %s at private hello admission", async change => {
    const f = await fixture(), config = vi.spyOn(f.cp.workers, "config");
    const mutations: Record<string, string> = {
      member: "DELETE FROM organization_members WHERE org_id=$1",
      login: "UPDATE cloud_v2_workspaces SET login_revision=login_revision+1 WHERE id=$1",
      stop: "UPDATE cloud_v2_workspaces SET stop_generation=stop_generation+1 WHERE id=$1",
      access: "UPDATE cloud_v2_workspaces SET access_epoch=access_epoch+1 WHERE id=$1",
      expiry: "UPDATE cloud_worker_runtime_handoffs SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",
      source: "UPDATE cloud_v2_github_sources SET repository_id='43' WHERE workspace_id=$1",
    };
    if (mutations[change]) await pool.query(mutations[change]!, [change === "member" ? f.org : f.workspace.id]);
    const reply = await f.hello(change === "foreign-boot" ? randomUUID() : change === "old-boot" ? f.boot : f.h.next_boot_id,
      change === "digest" ? "c".repeat(64) : f.h.target_sha256, change === "foreign-handoff" ? randomUUID() : f.h.id);
    expect(reply.status).toBe(401); expect(await reply.json()).toEqual({ code: "worker_unauthorized" });
    expect(config).not.toHaveBeenCalled();
  });

  it("refuses a revoked original source before releasing private configuration", async () => {
    const f = await fixture();
    await f.cp.loginChanges?.stop();
    f.deny();
    const reply = await f.hello();
    expect(reply.status).toBe(403); expect(await reply.json()).not.toHaveProperty("config");
  });

  it.each(["login", "stop", "access", "expiry", "member", "source"])("revalidates %s after the last awaited configuration read", async change => {
    const f = await fixture();
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const original = f.cp.workers.config;
    vi.spyOn(f.cp.workers, "config").mockImplementation(async (...args) => { const value = await original(...args); entered(); await held; return value; });
    const pending = f.hello();
    try {
      await waiting;
      await pool.query(change === "member" ? "DELETE FROM organization_members WHERE org_id=$1"
        : change === "source" ? "UPDATE cloud_v2_github_sources SET repository_id='43' WHERE workspace_id=$1"
        : change === "expiry" ? "UPDATE cloud_worker_runtime_handoffs SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1"
        : `UPDATE cloud_v2_workspaces SET ${change === "login" ? "login_revision=login_revision+1" : change === "stop" ? "stop_generation=stop_generation+1" : "access_epoch=access_epoch+1"} WHERE id=$1`,
      [change === "member" ? f.org : f.workspace.id]);
    } finally { release(); }
    const reply = await pending;
    expect(reply.status).toBe(401); expect(await reply.json()).not.toHaveProperty("config");
  });

  it("continues refusing both retired boots after rollback and a later prepared receipt", async () => {
    const f = await fixture();
    await f.handoffs.rollback(f.h.id);
    expect(await f.handoffs.promote(f.token, f.h.id, f.h.rollback_boot_id)).toBe(true);
    await f.handoffs.complete(f.h.id);
    for (let i = 0; i < 3; i++) {
      expect((await f.hello(f.boot, f.h.previous_sha256)).status).toBe(401);
      expect((await f.hello()).status).toBe(401);
    }
    expect((await f.hello(f.h.rollback_boot_id, f.h.previous_sha256)).status).toBe(200);
    const next = await f.handoffs.prepare(f.token, f.h.rollback_boot_id, { target: "c".repeat(64), instanceId: f.h.instance_id, revision: f.h.login_revision, generation: 8 });
    expect(next).not.toBeNull();
    expect((await f.hello(f.h.rollback_boot_id, f.h.previous_sha256)).status).toBe(200);
    expect((await f.hello()).status).toBe(401);
  });
});
