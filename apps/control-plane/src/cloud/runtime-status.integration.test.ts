import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { observeTransactionTiming } from "../request-timing.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { createCloudGithubServices } from "./github-composition.js";
import { RuntimeAdoption } from "./runtime-adoption.js";
import { workspaceRuntimeResolver } from "./runtime-canary-store.js";
import type { RuntimeCanaryPolicy } from "./runtime-canary.js";
import { RuntimeHandoffStore } from "./runtime-handoff-store.js";
import { CloudV2Store } from "./store.js";
import { createCloudV2WorkerRoutes } from "./worker-routes.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("idle worker runtime status", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  beforeEach(() => resetMigratedTestDatabase(pool));
  afterAll(() => pool.end());

  async function fixture(canary = false) {
    const creator = randomUUID(), org = randomUUID(), key = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')", [creator, `${creator}@example.test`]);
    await grantTestPro(pool, creator);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Fixture',$3,false,true)", [org, `org-${org}`, creator]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, creator]);
    const store = new CloudV2Store(pool), handoffs = new RuntimeHandoffStore(pool);
    const issuedAt = Math.floor(Date.now() / 1000);
    const input = { id: randomUUID(), organizationId: org, creatorUserId: creator, name: "Runtime", repository: "fixture/repo",
      sourceRepositoryId: "42", branch: "topic", baseBranch: "main", computerBuildId: null,
      ...(canary ? { runtimeCanary: { version: 1 as const, iss: "zeros-runtime-release" as const, aud: "zeros-cloud-runtime-canary" as const,
        channel: "alpha" as const, jti: randomUUID(), iat: issuedAt, exp: issuedAt + 600, runId: "123", runAttempt: 1,
        runtimeSha256: "b".repeat(64), sourceSha: "c".repeat(40), creatorUserId: creator, organizationId: org,
        repositoryId: "42", createKey: key, grantHash: "d".repeat(64) } } : {}),
    };
    await store.createWorkspaceOnce(input, key, "e".repeat(64), workspace => ({ id: workspace.id }));
    await pool.query("UPDATE cloud_v2_workspaces SET boat_sandbox_id='bx_fixture1234' WHERE id=$1", [input.id]);
    const token = await store.rotateWorkerToken(input.id), boot = randomUUID();
    await store.beginWorkerHello(token, boot); await store.acceptWorkerHello(token, boot);
    await handoffs.recordRuntime(token, boot, (canary ? "b" : "a").repeat(64));
    let allowed = true, target = "a".repeat(64);
    const fetcher = vi.fn(async (value: string | URL | Request) => {
      const path = new URL(String(value)).pathname;
      if (!allowed) return Response.json({ message: "Resource not accessible by personal access token" }, { status: 403 });
      if (path === "/user") return Response.json({ id: 12, login: "fixture" });
      if (path === "/repositories/42") return Response.json({ id: 42, name: "repo", owner: { login: "fixture" }, default_branch: "main",
        private: true, archived: false, permissions: { pull: true, push: true } });
      if (path.endsWith("/branches")) return Response.json([]);
      throw new Error("Unexpected fixture request");
    });
    const github = createCloudGithubServices(pool, null, { currentKeyVersion: 1, keys: { 1: Buffer.alloc(32, 7).toString("base64url") } }, store, fetcher);
    const scope = { organizationId: org, userId: creator };
    await github.connections.store.save(scope, await github.connections.store.fingerprint(scope), { id: "12", login: "fixture" },
      { method: "pat", accessToken: "synthetic-pat", expiresAt: null });
    const url = vi.fn(async () => "https://fixture.example.test/runtime.tar.gz");
    const policy: RuntimeCanaryPolicy = { keys: [{ id: "fixture", publicKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64") }],
      fixture: { creatorUserId: creator, organizationId: org, repositoryId: "42" } };
    const authorize = vi.fn(github.authorizeSource), compute = { execLong: vi.fn(async () => ({ exitCode: 0, stdout: "", timedOut: false })) };
    const adoption = new RuntimeAdoption({ store, handoffs, compute, authorizeSource: authorize,
      runtimeForWorkspace: workspace => workspaceRuntimeResolver(pool, { sha256: target, url }, canary ? policy : undefined)(workspace) });
    const app = new Hono();
    app.onError((error, c) => c.json({ code: error instanceof HttpError ? error.code : "internal" }, error instanceof HttpError ? error.status : 500));
    app.route("/", createCloudV2WorkerRoutes({ store, runtimeSha256: target, runtimeUpdates: adoption, runtimeHandoffs: handoffs,
      config: async () => { throw new Error("No configuration for a runtime status"); }, githubToken: async () => { throw new Error("No credentials for a runtime status"); } }));
    const request = async (body: Record<string, unknown> = { op: "status" }, requestBoot = boot) => {
      const reply = await app.request("/v2/cloud/worker/runtime", { method: "POST", headers: { authorization: `Bearer ${token}`,
        "x-zeros-worker-boot": requestBoot, "x-zeros-worker-features": "runtime-update-v1", "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(reply.status).toBe(200); return reply.json();
    };
    const row = async () => (await pool.query("SELECT * FROM cloud_v2_workspaces WHERE id=$1", [input.id])).rows[0];
    return { store, handoffs, adoption, request, token, boot, input, authorize, compute, url, fetcher, row, policy,
      deny: () => { allowed = false; github.source.invalidate(); }, pin: (sha: string) => { target = sha; } };
  }

  it("bounds repeated already-current HTTP polls to a constant number of database transactions", async () => {
    const f = await fixture(), counts: number[] = [];
    try {
      for (let i = 0; i < 3; i++) expect(await observeTransactionTiming(() => f.request(), summary => { counts.push(summary.transactions); })).toEqual({ status: "current" });
      expect(counts).toEqual([3, 3, 3]);
      expect(f.authorize).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
      expect(f.url).not.toHaveBeenCalled(); expect(f.compute.execLong).not.toHaveBeenCalled();
    } finally { f.adoption.close(); }
  });

  it("keeps the same budget after each minute exceeds source-admission freshness", async () => {
    const f = await fixture(), counts: number[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        await pool.query("UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp()-interval '61 seconds' WHERE org_id=$1", [f.input.organizationId]);
        expect(await observeTransactionTiming(() => f.request(), summary => { counts.push(summary.transactions); })).toEqual({ status: "current" });
      }
      expect(counts).toEqual([3, 3, 3]);
      expect(f.authorize).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
    } finally { f.adoption.close(); }
  });

  it.each([false, true])("returns only current for a revoked source at its unchanged effective pin (canary=%s)", async canary => {
    const f = await fixture(canary), before = await f.row(); f.deny();
    try {
      expect(await f.request()).toEqual({ status: "current" });
      expect(f.authorize).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
      expect(f.compute.execLong).not.toHaveBeenCalled(); expect(f.url).not.toHaveBeenCalled();
      expect(await f.row()).toEqual(before);
      expect((await pool.query("SELECT id FROM cloud_worker_runtime_handoffs WHERE workspace_id=$1", [f.input.id])).rowCount).toBe(0);
      expect(await f.request({ op: "prepare", revision: "0", generation: 1, instanceId: randomUUID() })).toEqual({ status: "unavailable" });
      expect(f.authorize).toHaveBeenCalledOnce(); expect(f.compute.execLong).not.toHaveBeenCalled(); expect(f.url).not.toHaveBeenCalled();
    } finally { f.adoption.close(); }
  });

  it("keeps source authorization before preparing a different runtime", async () => {
    const f = await fixture(); f.deny(); f.pin("b".repeat(64));
    try {
      expect(await f.request({ op: "prepare", revision: "0", generation: 1, instanceId: randomUUID() })).toEqual({ status: "unavailable" });
      expect(f.authorize).toHaveBeenCalledOnce(); expect(f.compute.execLong).not.toHaveBeenCalled(); expect(f.url).not.toHaveBeenCalled();
      expect((await pool.query("SELECT id FROM cloud_worker_runtime_handoffs WHERE workspace_id=$1", [f.input.id])).rowCount).toBe(0);
    } finally { f.adoption.close(); }
  });

  it.each(["missing", "old-boot", "foreign-boot"])("never treats %s runtime identity as current", async identity => {
    const f = await fixture();
    if (identity === "missing") await pool.query("UPDATE cloud_v2_workspaces SET worker_runtime_sha256=NULL WHERE id=$1", [f.input.id]);
    if (identity === "old-boot") await pool.query("UPDATE cloud_v2_workspaces SET worker_boot_id=$2 WHERE id=$1", [f.input.id, randomUUID()]);
    try {
      expect(await f.request({ op: "status" }, identity === "foreign-boot" ? randomUUID() : f.boot)).toEqual({ status: "unavailable" });
      if (identity === "missing") expect(f.authorize).toHaveBeenCalledOnce();
      expect(f.compute.execLong).not.toHaveBeenCalled(); expect(f.url).not.toHaveBeenCalled();
    } finally { f.adoption.close(); }
  });

  it("refuses an invalid canary binding instead of using the channel pin", async () => {
    const f = await fixture(true); f.pin("b".repeat(64)); f.policy.fixture.repositoryId = "99";
    try { expect(await f.request()).toEqual({ status: "unavailable" }); expect(f.compute.execLong).not.toHaveBeenCalled(); }
    finally { f.adoption.close(); }
  });
});
