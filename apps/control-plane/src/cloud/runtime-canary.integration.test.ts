import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { withUserTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { CloudV2Computers } from "./computer.js";
import type { CloudV2Compute } from "./boat.js";
import { CloudV2Lifecycle } from "./lifecycle.js";
import { RuntimeCanaryAuthority, type RuntimeCanaryAdmission, type RuntimeCanaryPolicy } from "./runtime-canary.js";
import { readRuntimeCanary, workspaceRuntimeResolver } from "./runtime-canary-store.js";
import { createCloudV2Routes } from "./routes.js";
import { CloudV2Store, type CloudV2Workspace } from "./store.js";
import { hashCloudV2Token, newCloudV2Token } from "./tokens.js";
import { createCloudV2WorkerRoutes } from "./worker-routes.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const pair = generateKeyPairSync("ed25519");
const ordinary = "a".repeat(64), candidate = "b".repeat(64);
suite("runtime canary admission and isolation", () => {
  let pool: pg.Pool, store: CloudV2Store, computers: CloudV2Computers, app: Hono;
  let org: string, user: string, actor: string, buildId: string, now: number, policy: RuntimeCanaryPolicy;
  let authority: RuntimeCanaryAuthority;
  const runtime = { sha256: ordinary, url: async (digest = ordinary) => `https://store.example.test/${digest}.tar.gz` };
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    org = randomUUID(); user = randomUUID(); actor = user; now = Date.now();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Release fixture')", [user, `${user}@example.test`]);
    await grantTestPro(pool, user);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Release fixture',$3,false,true)", [org, `release-${org}`, user]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, user]);
    store = new CloudV2Store(pool);
    computers = new CloudV2Computers(pool, pool, async (_org, _user, target) => ({ repository: target.repository, repositoryId: "42" }));
    const build = await computers.enqueue(org, user, { repositories: [{ repository: "fixture/repo" }] });
    buildId = build.id;
    await computers.claim(); await computers.activate(buildId, `fixture-${buildId}`);
    policy = { keys: [{ id: "current", publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64") }],
      fixture: { creatorUserId: user, organizationId: org, repositoryId: "42" } };
    authority = new RuntimeCanaryAuthority(policy, () => now);
    app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: actor } as never); await next(); });
    app.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: { code: "internal" } }, 500));
    app.route("/", createCloudV2Routes({ store, computers, runtimeCanary: authority,
      runtimeCanaryStatus: (userId, grantId) => readRuntimeCanary(pool, policy, userId, grantId),
      installedRepositories: async () => [{ repository: "fixture/repo", defaultBranch: "main" }],
      authorizeBuildRepository: async () => ({ repository: "fixture/repo", repositoryId: "42" }),
      authorizeSource: async () => {}, remoteHead: async () => "c".repeat(40), bridgeBaseUrl: "wss://bridge.example.test" }));
  });
  function grant(patch: Partial<RuntimeCanaryAdmission> = {}) {
    const claims = { version: 1, iss: "zeros-runtime-release", aud: "zeros-cloud-runtime-canary", channel: "alpha",
      jti: randomUUID(), iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 900,
      runId: "123", runAttempt: 1, runtimeSha256: candidate, sourceSha: "d".repeat(40),
      creatorUserId: user, organizationId: org, repositoryId: "42", createKey: randomUUID(), ...patch };
    const unsigned = [{ alg: "EdDSA", typ: "zeros-runtime-canary+jwt", kid: "current" }, claims]
      .map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
    return { claims, token: `${unsigned}.${sign(null, Buffer.from(unsigned), pair.privateKey).toString("base64url")}` };
  }
  const create = (signed?: ReturnType<typeof grant>, key = signed?.claims.createKey ?? randomUUID()) => app.request("/v1/cloud-v2/workspaces", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": key,
      ...(signed ? { "x-zeros-runtime-canary": signed.token } : {}) },
    body: JSON.stringify({ organizationId: org, repository: "fixture/repo", baseBranch: "main" }),
  });
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM cloud_v2_workspaces) AS workspaces,
    (SELECT count(*)::int FROM cloud_v2_create_requests) AS receipts,
    (SELECT count(*)::int FROM cloud_v2_runtime_canaries) AS grants`)).rows[0];
  async function created(signed?: ReturnType<typeof grant>): Promise<CloudV2Workspace> {
    const reply = await create(signed); expect(reply.status).toBe(201);
    return (await reply.json()).workspace;
  }

  it("atomically admits one workspace for concurrent exact creates and replays after grant expiry", async () => {
    const signed = grant(), replies = await Promise.all([create(signed), create(signed)]);
    expect(replies.map(reply => reply.status)).toEqual([201, 201]);
    const bodies = await Promise.all(replies.map(reply => reply.json()));
    expect(bodies[0]).toEqual(bodies[1]);
    expect(await counts()).toEqual({ workspaces: 1, receipts: 1, grants: 1 });
    now += 901_000;
    const retry = await create(signed);
    expect(retry.status).toBe(201); expect(await retry.json()).toEqual(bodies[0]);
    expect(JSON.stringify(bodies[0])).not.toContain(signed.token);
    expect(bodies[0].workspace).not.toHaveProperty("runtimeCanary");
  });

  it("consumes a nonce once across differently keyed signed attempts without a partial workspace", async () => {
    const first = grant(), second = grant({ jti: first.claims.jti });
    const replies = await Promise.all([create(first), create(second)]);
    expect(replies.map(reply => reply.status).sort()).toEqual([201, 403]);
    expect(await counts()).toEqual({ workspaces: 1, receipts: 1, grants: 1 });
  });

  it("rejects changed signed authority at the same create key", async () => {
    const first = grant(); await created(first);
    expect((await create(grant({ createKey: first.claims.createKey, runtimeSha256: "e".repeat(64) }))).status).toBe(409);
    expect((await create(undefined, first.claims.createKey)).status).toBe(409);
    expect(await counts()).toEqual({ workspaces: 1, receipts: 1, grants: 1 });
  });

  it("rechecks expiration at SQL admission after earlier validation", async () => {
    now -= 10_000;
    const signed = grant({ exp: Math.floor(Date.now() / 1000) - 1 });
    expect(authority.verify(signed.token, signed.claims)).toBeTruthy();
    expect((await create(signed)).status).toBe(403);
    expect(await counts()).toEqual({ workspaces: 0, receipts: 0, grants: 0 });
  });

  it.each(["creatorUserId", "organizationId", "repositoryId"] as const)("refuses a grant for another %s", async field => {
    const signed = grant({ [field]: field === "repositoryId" ? "99" : randomUUID() });
    expect((await create(signed)).status).toBe(403);
    expect(await counts()).toEqual({ workspaces: 0, receipts: 0, grants: 0 });
  });

  it("keeps candidate authority out of ungranted workspaces even in the fixture organization", async () => {
    const canary = await created(grant()), regular = await created();
    const resolve = workspaceRuntimeResolver(pool, runtime, policy);
    expect((await resolve(canary)).sha256).toBe(candidate);
    expect((await resolve(regular)).sha256).toBe(ordinary);
    const next = workspaceRuntimeResolver(pool, { ...runtime, sha256: "f".repeat(64) }, policy);
    const pinned = await next(canary);
    expect(pinned.sha256).toBe(candidate); expect(await pinned.url()).toContain(candidate);
    expect((await next(regular)).sha256).toBe("f".repeat(64));
  });

  it("boots and wakes only the grant's workspace on the candidate with the actual store and lifecycle", async () => {
    const canary = await created(grant()), regular = await created();
    const compute: CloudV2Compute = {
      create: vi.fn(async input => ({ sandboxId: input.key === canary.id ? "bx_canary01" : "bx_regular01" })),
      fork: vi.fn(async () => { throw new Error("Unexpected fork"); }),
      inspect: vi.fn(async () => ({ name: null, state: "archived" })), findSandbox: vi.fn(async () => null),
      resume: vi.fn(async () => {}), extendLease: vi.fn(async () => {}), stop: vi.fn(async () => {}), delete: vi.fn(async () => {}),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: "", timedOut: false })), execLong: vi.fn(async () => ({ exitCode: 0, stdout: "", timedOut: false })),
      saveSnapshot: vi.fn(async () => {}), deleteSnapshot: vi.fn(async () => {}),
      hostPort: vi.fn(async () => ({ url: "https://fixture-41783.on.boat.dev", token: "synthetic-port-token" })),
    };
    const lifecycle = new CloudV2Lifecycle({ store, compute, runtime, runtimeForWorkspace: workspaceRuntimeResolver(pool, runtime, policy),
      publicKeys: [pair.publicKey.export({ format: "pem", type: "spki" }).toString()], sealPortToken: () => ({ encrypted: true }),
      stopWorker: async () => true, bootEnv: async (workspace, selected) => ({ ZEROS_WORKSPACE_ID: workspace.id, CLOUD_V2_RUNTIME_SHA256: selected!.sha256 }),
      sandboxName: workspace => `fixture-${workspace.id}`, sleep: async () => {} });
    await lifecycle.tick();
    expect(vi.mocked(compute.create).mock.calls.map(([input]) => [input.key, input.env.CLOUD_V2_RUNTIME_SHA256]).sort())
      .toEqual([[canary.id, candidate], [regular.id, ordinary]].sort());
    for (const [workspace, sandboxId, digest] of [[canary, "bx_canary01", candidate], [regular, "bx_regular01", ordinary]] as const) {
      const commands = vi.mocked(compute.exec).mock.calls.filter(([id]) => id === sandboxId).map(([, command]) => command).join("\n");
      expect(commands).toContain(`/opt/zeros/runtime/${digest}`);
      expect(commands).not.toContain(`/opt/zeros/runtime/${digest === ordinary ? candidate : ordinary}`);
      await store.transition(workspace.id, ["creating"], "stopped");
      await store.requestLifecycle(workspace.id, user, "start");
    }
    vi.mocked(compute.exec).mockClear();
    await lifecycle.tick();
    expect(compute.resume).toHaveBeenCalledTimes(2);
    for (const [sandboxId, digest] of [["bx_canary01", candidate], ["bx_regular01", ordinary]]) {
      const commands = vi.mocked(compute.exec).mock.calls.filter(([id]) => id === sandboxId).map(([, command]) => command).join("\n");
      expect(commands).toContain(`/opt/zeros/runtime/${digest}`);
      expect(commands).not.toContain(`/opt/zeros/runtime/${digest === ordinary ? candidate : ordinary}`);
    }
  });

  it("refuses an admitted candidate when its fixture policy or original source can no longer be proven", async () => {
    const workspace = await created(grant());
    await expect(workspaceRuntimeResolver(pool, runtime)(workspace)).rejects.toMatchObject({ code: "cloud_runtime_canary_refused" });
    await expect(workspaceRuntimeResolver(pool, runtime, { ...policy, fixture: { ...policy.fixture, repositoryId: "99" } })(workspace))
      .rejects.toMatchObject({ code: "cloud_runtime_canary_refused" });
    await pool.query("UPDATE cloud_v2_github_sources SET repository_id=99 WHERE workspace_id=$1", [workspace.id]);
    await expect(workspaceRuntimeResolver(pool, runtime, policy)(workspace)).rejects.toMatchObject({ code: "cloud_runtime_canary_refused" });
  });

  it("does not turn an unknown pin lookup into the global runtime", async () => {
    const workspace = await created(grant());
    const failedPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 }); await failedPool.end();
    await expect(workspaceRuntimeResolver(failedPool, runtime, policy)(workspace)).rejects.toThrow();
  });

  it("keeps the consumed nonce after physical deletion and hides audit rows from user SQL", async () => {
    const signed = grant(), workspace = await created(signed);
    const audit = (await pool.query("SELECT grant_sha256, workspace_id FROM cloud_v2_runtime_canaries")).rows[0];
    expect(audit).toEqual({ grant_sha256: createHash("sha256").update(signed.token).digest("hex"), workspace_id: workspace.id });
    expect(await withUserTx(pool, user, async tx => (await tx.query("SELECT * FROM cloud_v2_runtime_canaries")).rows)).toEqual([]);
    await pool.query("DELETE FROM cloud_v2_workspaces WHERE id=$1", [workspace.id]);
    expect((await pool.query("SELECT workspace_id FROM cloud_v2_runtime_canaries")).rows).toEqual([{ workspace_id: null }]);
    expect((await create(grant({ jti: signed.claims.jti }))).status).toBe(403);
  });

  it("checks the exact runtime before hello changes the current boot", async () => {
    const workspace = await created(grant()), token = newCloudV2Token("worker").token, oldBoot = randomUUID(), newBoot = randomUUID();
    await pool.query("UPDATE cloud_v2_workspaces SET state='running', worker_token_hash=$2, worker_boot_id=$3, worker_history_sequence=7 WHERE id=$1", [workspace.id, hashCloudV2Token(token), oldBoot]);
    const config = vi.fn(async () => ({ t: "config" as const, workspace: { id: workspace.id, organizationId: org,
      repository: "fixture/repo", branch: workspace.branch, baseBranch: "main", checkoutPath: "/home/user/fixture/repo" }, agents: {} }));
    const worker = new Hono();
    worker.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: { code: "internal" } }, 500));
    worker.route("/", createCloudV2WorkerRoutes({ store, runtimeSha256: ordinary,
      runtimeSha256ForWorkspace: async w => (await workspaceRuntimeResolver(pool, runtime, policy)(w)).sha256,
      config, githubToken: async () => ({ token: "synthetic-github-token", expiresAt: 5000 }) }));
    const hello = (runtimeSha256: string) => worker.request("/v2/cloud/worker/hello", { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ bootId: newBoot, protocol: 2, runtimeSha256 }) });
    expect((await hello(ordinary)).status).toBe(409);
    expect(config).not.toHaveBeenCalled();
    expect((await pool.query("SELECT state, worker_boot_id, worker_history_sequence::int FROM cloud_v2_workspaces WHERE id=$1", [workspace.id])).rows[0])
      .toEqual({ state: "running", worker_boot_id: oldBoot, worker_history_sequence: 7 });
    expect((await hello(candidate)).status).toBe(200); expect(config).toHaveBeenCalledOnce();
  });

  it("reports bound deletion only from a retained lifecycle row", async () => {
    const signed = grant(), workspace = await created(signed);
    const status = () => app.request(`/v1/cloud-v2/runtime-canaries/${signed.claims.jti}`);
    const before = await status();
    expect(before.status).toBe(200); expect(before.headers.get("cache-control")).toBe("no-store");
    expect(await before.json()).toMatchObject({ version: 1, workspaceId: workspace.id, runtimeSha256: candidate, deleted: false, runId: "123", runAttempt: 1 });
    expect((await app.request(`/v1/cloud-v2/workspaces/${workspace.id}`, { method: "DELETE" })).status).toBe(202);
    expect(await (await status()).json()).toMatchObject({ state: "deleting", deleted: false });
    await store.transition(workspace.id, ["deleting"], "deleted");
    expect((await app.request(`/v1/cloud-v2/workspaces/${workspace.id}`)).status).toBe(404);
    expect(await (await status()).json()).toMatchObject({ state: "deleted", deleted: true, workspaceId: workspace.id });
    await pool.query("DELETE FROM cloud_v2_workspaces WHERE id=$1", [workspace.id]);
    expect((await status()).status).toBe(404);
  });

  it("does not turn loss of creator membership or another caller into cleanup proof", async () => {
    const signed = grant(), workspace = await created(signed);
    const status = () => app.request(`/v1/cloud-v2/runtime-canaries/${signed.claims.jti}`);
    actor = randomUUID(); expect((await status()).status).toBe(404);
    actor = user;
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, user]);
    expect((await status()).status).toBe(404);
    expect((await pool.query("SELECT state FROM cloud_v2_workspaces WHERE id=$1", [workspace.id])).rows[0].state).not.toBe("deleted");
  });
});
