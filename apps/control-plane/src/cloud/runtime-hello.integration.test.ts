import { generateKeyPairSync, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { HttpError } from "../authz.js";
import { observeTransactionTiming, requestTiming, type RequestDatabaseCost } from "../request-timing.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { createCloudV2 } from "./composition.js";
import { createCloudV2WorkerRoutes } from "./worker-routes.js";
import { CLOUD_SOURCE_ADMISSION_MS, CLOUD_SOURCE_GRACE_MS, CLOUD_SOURCE_REFRESH_MS } from "./source-authority.js";
import { DatabaseCloudAgentCredentialService } from "../agent-credentials/agent-credentials.js";
import { cloudAgentModels } from "../agent-credentials/agent-models.js";

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

  async function fixture(privateBoot = true, secondary = false) {
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
      if (url.pathname.endsWith("/branches")) return Response.json([]);
      throw new Error(`Unexpected GitHub fixture path: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const config = {
      github: null, deploymentChannel: "alpha", cloudAgentCredentials: { settingsSecretKeyV1: Buffer.alloc(32, 7).toString("base64url") },
      cloudV2: { boat: { apiKey: "synthetic-boat-credential" }, apiUrl: "https://api.example.test", realtimeUrl: "https://rt.example.test", promptOutbox: true,
        workerSigningKey: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
        runtime: { sha256: "b".repeat(64), store: { endpoint: "https://store.example.test", bucket: "fixture", accessKeyId: "fixture", secretAccessKey: "fixture" } } },
    } as Config;
    const cp = createCloudV2(config, pool, { relay: false, lifecycle: false })!;
    cleanup.push(async () => { cp.runtimeUpdates.close(); await cp.loginChanges?.stop(); await cp.promptChanges?.stop(); });
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
    const hello = (bootId = h.next_boot_id, runtimeSha256 = h.target_sha256, id = h.id) => app.request("/v2/cloud/worker/hello", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-zeros-runtime-handoff": id,
        "x-zeros-worker-features": "runtime-update-v1,prompt-outbox-v1,workspace-environment-v1,repository-setup-v1,mcp-v1,github-pr-v1,git-identity-v1" },
      body: JSON.stringify({ protocol: 2, bootId, runtimeSha256 }),
    });
    const ordinary = (route: "hello" | "config") => app.request(`/v2/cloud/worker/${route}`, {
      method: route === "hello" ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-zeros-worker-boot": boot,
        "x-zeros-worker-features": "runtime-update-v1,prompt-outbox-v1,workspace-environment-v1,repository-setup-v1,mcp-v1,github-pr-v1,git-identity-v1" },
      ...(route === "hello" ? { body: JSON.stringify({ protocol: 2, bootId: boot, runtimeSha256: "b".repeat(64) }) } : {}),
    });
    return { cp, creator, org, workspace, token, boot, h, handoffs, hello, ordinary, costs, fetcher, deny: () => { allowed = false; } };
  }

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
    expect(samples[0]!.transactions).toBeLessThanOrEqual(30);
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
    const response = await f.ordinary("hello"), recover = !backoff && status !== 403;
    expect(response.status).toBe(recover ? 200 : status);
    const body = await response.json();
    if (recover) {
      expect(body.config.workspace.github).toMatchObject({ repositoryId: "42", repository: "fixture/repo" });
      expect((await pool.query("SELECT failure_code FROM cloud_github_source_verifications WHERE org_id=$1", [f.org])).rows)
        .toEqual([{ failure_code: null }]);
      expect(f.fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname === "/repositories/42")).toHaveLength(1);
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
    f.fetcher.mockImplementationOnce(async (...args) => {
      expect(new URL(String(args[0])).pathname).toBe("/user");
      const response = await original(...args); entered(); await held; return response;
    });
    const pending = f.ordinary(route);
    await Promise.race([waiting, pending.then(() => { throw new Error("Configuration completed before the held profile read"); })]);
    return { pending, release };
  }

  it.each((["hello", "config"] as const).flatMap(route =>
    (["member", "access", "stop", "source", "denial", "expiry", "disconnect", "checkout"] as const).map(change => [route, change] as const)))
  ("withholds %s when %s changes during held profile I/O", async (route, change) => {
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
      [f.org, (route === "hello" ? CLOUD_SOURCE_ADMISSION_MS : CLOUD_SOURCE_GRACE_MS) + 1000]);
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
      vi.spyOn(Date, "now").mockReturnValue(now + (route === "hello" ? CLOUD_SOURCE_ADMISSION_MS : CLOUD_SOURCE_REFRESH_MS) + 1000);
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
    const f = await fixture(); f.deny();
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
