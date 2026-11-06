import { generateKeyPairSync, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { HttpError } from "../authz.js";
import { observeTransactionTiming } from "../request-timing.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { createCloudV2 } from "./composition.js";
import { createCloudV2WorkerRoutes } from "./worker-routes.js";

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

  async function fixture() {
    const creator = randomUUID(), org = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')", [creator, `${creator}@example.test`]);
    await grantTestPro(pool, creator);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Fixture',$3,false,true)", [org, `org-${org}`, creator]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, creator]);
    let allowed = true;
    const fetcher = vi.fn(async (value: string | URL | Request) => {
      const url = new URL(String(value));
      if (url.hostname !== "api.github.com") throw new Error("Unexpected provider");
      if (!allowed) return Response.json({ message: "Resource not accessible by personal access token" }, { status: 403 });
      if (url.pathname === "/user") return Response.json({ id: 12, login: "fixture", name: "Fixture", email: "fixture@example.test" });
      if (url.pathname === "/user/emails") return Response.json([{ email: "fixture@example.test", primary: true, verified: true, visibility: null }]);
      if (url.pathname === "/repositories/42") return Response.json({ id: 42, name: "repo", owner: { login: "fixture" }, default_branch: "main",
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
    const workspace = await cp.store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: creator, name: "Runtime",
      repository: "fixture/repo", sourceRepositoryId: "42", branch: "workspace/fixture", baseBranch: "main", computerBuildId: null });
    await pool.query("UPDATE cloud_v2_workspaces SET boat_sandbox_id='bx_fixture1234' WHERE id=$1", [workspace.id]);
    const token = await cp.store.rotateWorkerToken(workspace.id), boot = randomUUID(), handoffs = cp.workers.runtimeHandoffs!;
    await cp.store.beginWorkerHello(token, boot); await cp.store.acceptWorkerHello(token, boot);
    await handoffs.recordRuntime(token, boot, "a".repeat(64));
    const current = (await cp.store.workerSession(token, boot))!;
    const h = (await handoffs.prepare(token, boot, { target: "b".repeat(64), instanceId: randomUUID(), revision: current.loginRevision, generation: 7 }))!;
    expect(await handoffs.commit(token, boot, h.id, current.loginRevision, 7, h.target_sha256)).toBe(true);
    await handoffs.activate(token, h.id);
    const app = new Hono();
    app.onError((error, c) => c.json({ code: error instanceof HttpError ? error.code : "internal" }, error instanceof HttpError ? error.status : 500));
    app.route("/", createCloudV2WorkerRoutes(cp.workers));
    const hello = (bootId = h.next_boot_id, runtimeSha256 = h.target_sha256, id = h.id) => app.request("/v2/cloud/worker/hello", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-zeros-runtime-handoff": id,
        "x-zeros-worker-features": "runtime-update-v1,prompt-outbox-v1,workspace-environment-v1,repository-setup-v1,mcp-v1,github-pr-v1,git-identity-v1" },
      body: JSON.stringify({ protocol: 2, bootId, runtimeSha256 }),
    });
    return { cp, creator, org, workspace, token, boot, h, handoffs, hello, fetcher, deny: () => { allowed = false; } };
  }

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
