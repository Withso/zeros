import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { CloudV2Store } from "./store.js";
import { createCloudGithubServices } from "./github-composition.js";
import { HttpError } from "../authz.js";
import { grantTestPro } from "../test-pro.js";
import { CloudV2Computers } from "./computer.js";
import { PostgresGithubVerificationStore } from "./github-verification-store.js";
import { Hono } from "hono";
import { createCloudV2Routes } from "./routes.js";
import { observeTransactionTiming, requestTiming, type RequestDatabaseCost } from "../request-timing.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("cloud GitHub composition", () => {
  let pool: pg.Pool,
    workspaces: CloudV2Store,
    services: ReturnType<typeof createCloudGithubServices>;
  let userId: string,
    organizationId: string,
    owner: string,
    created: boolean,
    writeCalls: number;
  const head = "a".repeat(40),
    base = "b".repeat(40);
  const keys = {
    currentKeyVersion: 1,
    keys: { 1: Buffer.alloc(32, 7).toString("base64url") },
  };
  const repo = () => ({
    id: 42,
    name: "project",
    owner: { login: owner },
    default_branch: "main",
    private: true,
    archived: false,
    permissions: { pull: true, push: true },
  });
  const pull = () => ({
    number: 7,
    node_id: "PR_synthetic",
    html_url: `https://github.com/${owner}/project/pull/7`,
    state: "open",
    draft: true,
    title: "Change",
    body: "Description",
    user: { login: "contributor" },
    base: { ref: "main", sha: base, repo: repo() },
    head: { ref: "topic", sha: head, repo: repo() },
    mergeable: true,
    mergeable_state: "clean",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    merged_at: null,
  });
  const fetcher = vi.fn(
    async (
      value: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(String(value));
      if (url.pathname === "/user")
        return Response.json({ id: 12, login: "contributor" });
      if (url.pathname === "/repositories/42") return Response.json(repo());
      if (url.pathname === "/repos/former/project")
        return Response.json({ ...repo(), id: owner === "former" ? 42 : 99 }); // Old name was reused.
      if (url.pathname.endsWith("/branches")) return Response.json([]);
      if (url.pathname.endsWith("/commits/topic"))
        return Response.json({ sha: head });
      if (url.pathname.endsWith("/pulls") && init?.method === "POST") {
        created = true;
        writeCalls++;
        return Response.json(pull(), { status: 201 });
      }
      if (url.pathname.endsWith("/pulls"))
        return Response.json(created ? [pull()] : []);
      if (url.pathname.endsWith("/pulls/7")) return Response.json(pull());
      throw new Error(`Unexpected synthetic request ${url.pathname}`);
    },
  );
  const defaultFetch = fetcher.getMockImplementation()!;
  beforeAll(() => {
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 4,
    });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    vi.clearAllMocks();
    fetcher.mockImplementation(defaultFetch);
    owner = "current";
    created = false;
    writeCalls = 0;
    userId = randomUUID();
    organizationId = randomUUID();
    await pool.query(
      "INSERT INTO users(id,email,display_name) VALUES($1,$2,'User')",
      [userId, `${userId}@example.test`],
    );
    await grantTestPro(pool, userId);
    await pool.query(
      "INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Org',$3,false,true)",
      [organizationId, `org-${organizationId}`, userId],
    );
    await pool.query(
      "INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')",
      [organizationId, userId],
    );
    workspaces = new CloudV2Store(pool);
    services = createCloudGithubServices(pool, null, keys, workspaces, fetcher);
    const scope = { organizationId, userId };
    await services.connections.store.save(
      scope,
      await services.connections.store.fingerprint(scope),
      { id: "12", login: "contributor" },
      { method: "pat", accessToken: "synthetic-pat", expiresAt: null },
    );
  });
  async function fixture(pinned = true) {
    const workspace = await workspaces.createWorkspace({
      id: randomUUID(),
      organizationId,
      creatorUserId: userId,
      name: "Workspace",
      repository: "former/project",
      sourceRepositoryId: pinned ? "42" : undefined,
      branch: "topic",
      baseBranch: "main",
      computerBuildId: null,
    });
    const token = await workspaces.rotateWorkerToken(workspace.id),
      boot = randomUUID();
    await workspaces.acceptWorkerHello(token, boot);
    await services.metadata.checkout(token, boot, {
      sequence: 1,
      branch: "topic",
      baseBranch: "main",
      headSha: head,
    });
    return { workspace, token, boot };
  }

  it("bounds warm PR reads through the HTTP route without repeating source admission", async () => {
    const { workspace } = await fixture();
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user", { id: userId } as never);
      await next();
    });
    app.route("/", createCloudV2Routes({
      store: workspaces,
      computers: new CloudV2Computers(pool),
      installedRepositories: async () => null,
      remoteHead: (org, user, target, branch) => services.remoteHead(org, user, target.repository, branch, target.repositoryId),
      bridgeBaseUrl: "wss://bridge.example.test",
      github: services,
    }));
    await services.authorizeSource(await workspaces.get(workspace.id, userId));
    const samples: Array<{ op: string; transactions: number; githubCalls: number }> = [];
    for (const present of [false, true]) {
      created = present;
      for (const op of present ? ["gh.prSync", "gh.prGet"] : ["gh.prSync"]) {
        fetcher.mockClear();
        const response = await observeTransactionTiming(() => app.request(`/v1/cloud-v2/workspaces/${workspace.id}/github`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ op, params: op === "gh.prGet" ? { prNumber: 7 } : {} }),
        }), summary => samples.push({ op, transactions: summary.transactions, githubCalls: fetcher.mock.calls.length }));
        expect(response.status).toBe(200);
        expect((await response.json()).result).toEqual(present ? expect.objectContaining({ number: 7 }) : null);
      }
    }
    expect(samples).toEqual([
      { op: "gh.prSync", transactions: expect.any(Number), githubCalls: expect.any(Number) },
      { op: "gh.prSync", transactions: expect.any(Number), githubCalls: expect.any(Number) },
      { op: "gh.prGet", transactions: expect.any(Number), githubCalls: expect.any(Number) },
    ]);
    console.info("PR read cost", samples);
    expect(samples, JSON.stringify(samples)).toSatisfy(rows => rows.every((row: typeof samples[number]) => row.transactions <= 10 && row.githubCalls <= 2));
  });

  it.each(["gh.prGet", "gh.prChecks"] as const)("restarts an expired PR read through fresh source admission: %s", async op => {
    const { workspace } = await fixture();
    await services.authorizeSource(await workspaces.get(workspace.id, userId));
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: userId } as never); await next(); });
    app.route("/", createCloudV2Routes({ store: workspaces, computers: new CloudV2Computers(pool),
      installedRepositories: async () => null, remoteHead: async () => head,
      bridgeBaseUrl: "wss://bridge.example.test", github: services }));
    app.onError((error, c) => {
      if (error instanceof HttpError) return c.json({ error: { code: error.code } }, error.status);
      throw error;
    });
    let reads = 0, admissions = 0;
    fetcher.mockClear();
    fetcher.mockImplementation(async (value, init) => {
      const path = new URL(String(value)).pathname;
      if (path.endsWith(op === "gh.prGet" ? "/pulls/7" : "/check-runs")) {
        reads++;
        if (reads === 1) {
          expect((await pool.query(`UPDATE cloud_github_source_verifications
            SET verified_at=clock_timestamp()-interval '10 minutes 1 second' WHERE org_id=$1 RETURNING repository_id`, [organizationId])).rowCount).toBe(1);
        }
        return Response.json(op === "gh.prGet" ? { ...pull(), title: reads === 1 ? "Discarded" : "Fresh", draft: reads === 1 } : {
          total_count: 1, check_runs: [{ name: reads === 1 ? "Discarded" : "Fresh", status: "completed", conclusion: "success" }],
        });
      }
      if (path.endsWith("/rules/branches/main") || path.endsWith("/statuses")) return Response.json([]);
      if (path.endsWith("/branches/main")) return Response.json({});
      if (path.endsWith("/branches")) admissions++;
      return defaultFetch(value, init);
    });
    let cost: { transactions: number; githubCalls: number } | undefined;
    const response = await observeTransactionTiming(() => app.request(`/v1/cloud-v2/workspaces/${workspace.id}/github`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, params: { prNumber: 7 } }),
    }), summary => { cost = { transactions: summary.transactions, githubCalls: fetcher.mock.calls.length }; });
    const body = await response.json();
    console.info("PR expiry recovery cost", { op, ...cost, status: response.status, code: body.error?.code, reads, admissions });
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.result).toMatchObject(op === "gh.prGet" ? { title: "Fresh" } : { checks: [{ name: "Fresh" }] });
    expect(reads).toBe(2);
    expect(admissions).toBe(1);
    expect((await pool.query("SELECT pr_state FROM cloud_v2_github_workspaces WHERE workspace_id=$1", [workspace.id])).rows[0].pr_state)
      .toBe(op === "gh.prGet" ? "ready" : null);
  });

  it("bounds warm worker GitHub credential requests while retaining source authorization", async () => {
    const f = await fixture(), workspace = await workspaces.get(f.workspace.id, userId);
    await services.authorizeSource(workspace);
    const samples: Array<{ transactions: number; githubCalls: number }> = [];
    for (let i = 0; i < 2; i++) {
      fetcher.mockClear();
      const result = await observeTransactionTiming(() => services.workspaceToken(workspace, "user", "gh"),
        summary => samples.push({ transactions: summary.transactions, githubCalls: fetcher.mock.calls.length }));
      expect(result.expiresAt).toBeGreaterThan(Date.now());
    }
    console.info("Worker credential service cost", samples);
    expect(samples, JSON.stringify(samples)).toSatisfy(rows => rows.every((row: typeof samples[number]) => row.transactions <= 8 && row.githubCalls <= 2));
  });

  it("bounds warm workspace catalog reads independently of same-owner row count", async () => {
    created = true;
    const fixtures = await Promise.all([fixture(), fixture(), fixture()]);
    for (const { workspace } of fixtures)
      await services.service.execute(workspace.id, userId, { op: "gh.prSync", params: {} });
    const app = new Hono(), costs: RequestDatabaseCost[] = [];
    app.use("*", requestTiming({ slowMs: Infinity, databasePool: pool, costObserver: cost => { costs.push(cost); } }));
    app.use("*", async (c, next) => { c.set("user", { id: userId } as never); await next(); });
    app.route("/", createCloudV2Routes({ store: workspaces, computers: new CloudV2Computers(pool),
      installedRepositories: async () => null, remoteHead: async () => head,
      bridgeBaseUrl: "wss://bridge.example.test", github: services }));
    const list = `/v1/cloud-v2/workspaces?organizationId=${organizationId}`;
    expect((await app.request(list)).status).toBe(200);
    const samples: Array<{ kind: string; transactions: number; queries: number; githubCalls: number }> = [];
    const measure = async (kind: string, path: string) => {
      fetcher.mockClear();
      const response = await observeTransactionTiming(() => app.request(path),
        summary => samples.push({ kind, transactions: summary.transactions, queries: costs.at(-1)!.queriesStarted, githubCalls: fetcher.mock.calls.length }));
      expect(response.status).toBe(200);
      const body = await response.json();
      const rows = body.workspaces ?? [body.workspace];
      expect(rows).toHaveLength(path === list ? 3 : 1);
      for (const row of rows) {
        expect(row).toMatchObject({ github: { prNumber: 7 } });
        expect(row).not.toHaveProperty("accessEpoch");
        expect(row).not.toHaveProperty("loginRevision");
        expect(row).not.toHaveProperty("proof");
      }
    };
    await measure("running-get", `/v1/cloud-v2/workspaces/${fixtures[0]!.workspace.id}`);
    await measure("running-list", list);
    for (const { workspace } of fixtures) await workspaces.transition(workspace.id, ["running"], "stopped");
    await measure("stopped-list", list);
    console.info("Workspace catalog cost", samples);
    expect(samples, JSON.stringify(samples)).toSatisfy(rows => rows.every((row: typeof samples[number]) => row.transactions <= 6 && row.queries <= 18 && row.githubCalls === 0));
  });

  it("binds the first PR snapshot when the original repository name has not moved", async () => {
    owner = "former";
    const { workspace } = await fixture();
    created = true;
    await services.service.execute(workspace.id, userId, { op: "gh.prSync", params: {} });
    expect(await services.metadata.context(workspace.id, userId)).toMatchObject({
      repositoryId: "42", repository: "former/project",
    });
    const { rows } = await pool.query("SELECT pr_number FROM cloud_v2_github_workspaces WHERE workspace_id=$1", [workspace.id]);
    expect(rows[0]).toMatchObject({ pr_number: 7 });
  });

  it("keeps credential issuance independent of an authorized checkout branch change", async () => {
    const f = await fixture(), workspace = await workspaces.get(f.workspace.id, userId);
    await services.authorizeSource(workspace);
    fetcher.mockImplementation(async (value, init) => {
      if (new URL(String(value)).pathname.endsWith("/branches"))
        await services.metadata.checkout(f.token, f.boot, { sequence: 2, branch: "other", baseBranch: "main", headSha: "c".repeat(40) });
      return defaultFetch(value, init);
    });
    const result = await services.workspaceToken(workspace, "user", "gh");
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 120_000);
    expect((await services.metadata.context(workspace.id, userId)).branch).toBe("other");
  });

  it.each(["membership", "connection", "checkout", "source", "denial", "expired observation"] as const)(
    "fences a %s change while a PR read is in flight", async change => {
      const f = await fixture();
      await services.authorizeSource(await workspaces.get(f.workspace.id, userId));
      let reached!: () => void, release!: () => void, reads = 0;
      const reading = new Promise<void>(resolve => { reached = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      fetcher.mockImplementation(async (value, init) => {
        if (new URL(String(value)).pathname.endsWith("/pulls/7")) {
          reads++;
          reached(); await held;
          if (change === "expired observation" && reads > 1)
            expect((await pool.query("UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp()-interval '10 minutes 1 second' WHERE org_id=$1 RETURNING repository_id", [organizationId])).rowCount).toBe(1);
        }
        return defaultFetch(value, init);
      });
      const pending = services.service.execute(f.workspace.id, userId, { op: "gh.prGet", params: { prNumber: 7 } })
        .then(value => ({ value }), error => ({ error }));
      try {
        await reading;
        if (change === "membership") {
          expect((await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2 RETURNING user_id", [organizationId, userId])).rowCount).toBe(1);
        } else if (change === "connection") {
          const scope = { organizationId, userId };
          await services.connections.store.save(scope, await services.connections.fingerprintFor(scope),
            { id: "12", login: "contributor" }, { method: "pat", accessToken: "replacement-synthetic-pat", expiresAt: null });
        } else if (change === "checkout") {
          await services.metadata.checkout(f.token, f.boot, { sequence: 2, branch: "other", baseBranch: "main", headSha: "c".repeat(40) });
        } else if (change === "source") {
          expect((await pool.query("DELETE FROM cloud_v2_github_sources WHERE workspace_id=$1 RETURNING workspace_id", [f.workspace.id])).rowCount).toBe(1);
        } else if (change === "expired observation") {
          expect((await pool.query("UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp()-interval '10 minutes 1 second' WHERE org_id=$1 RETURNING repository_id", [organizationId])).rowCount).toBe(1);
        } else {
          expect((await pool.query(`UPDATE cloud_github_source_verifications SET verified_at=NULL,
            failure_code='github_cloud_access_denied',failure_status=403,retry_at=clock_timestamp()+interval '1 minute'
            WHERE org_id=$1 AND owner_user_id=$2 RETURNING repository_id`, [organizationId, userId])).rowCount).toBe(1);
        }
        release();
        expect(await pending).toMatchObject({ error: expect.any(Error) });
        if (change === "expired observation") expect(reads).toBe(2);
        expect((await pool.query("SELECT pr_number FROM cloud_v2_github_workspaces WHERE workspace_id=$1", [f.workspace.id])).rows[0].pr_number).toBeNull();
      } finally { release(); await pending; }
    },
  );

  it.each([
    ["membership", "not_found"], ["connection", "github_authorization_changed"], ["checkout", "github_authorization_changed"],
    ["denial", "github_cloud_access_denied"], ["backoff", "github_unavailable"],
  ] as const)("refuses an expired read when %s changes during source admission", async (change, code) => {
    const f = await fixture();
    await services.authorizeSource(await workspaces.get(f.workspace.id, userId));
    let reads = 0, admissions = 0;
    fetcher.mockImplementation(async (value, init) => {
      const path = new URL(String(value)).pathname;
      if (path.endsWith("/pulls/7")) {
        reads++;
        expect((await pool.query("UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp()-interval '10 minutes 1 second' WHERE org_id=$1 RETURNING repository_id", [organizationId])).rowCount).toBe(1);
      }
      if (path.endsWith("/branches")) {
        admissions++;
        if (change === "membership")
          expect((await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2 RETURNING user_id", [organizationId, userId])).rowCount).toBe(1);
        if (change === "connection") {
          const scope = { organizationId, userId };
          await services.connections.store.save(scope, await services.connections.fingerprintFor(scope),
            { id: "12", login: "contributor" }, { method: "pat", accessToken: "replacement-synthetic-pat", expiresAt: null });
        }
        if (change === "checkout")
          await services.metadata.checkout(f.token, f.boot, { sequence: 2, branch: "other", baseBranch: "main", headSha: "c".repeat(40) });
        if (change === "denial") return new Response(null, { status: 403 });
        if (change === "backoff") return new Response(null, { status: 503, headers: { "retry-after": "60" } });
      }
      return defaultFetch(value, init);
    });
    await expect(services.service.execute(f.workspace.id, userId, { op: "gh.prGet", params: { prNumber: 7 } }))
      .rejects.toMatchObject({ code });
    expect(reads).toBe(1);
    expect(admissions).toBe(1);
    expect((await pool.query("SELECT pr_number FROM cloud_v2_github_workspaces WHERE workspace_id=$1", [f.workspace.id])).rows[0].pr_number).toBeNull();
    if (change === "backoff") {
      fetcher.mockClear();
      await expect(services.service.execute(f.workspace.id, userId, { op: "gh.prGet", params: { prNumber: 7 } }))
        .rejects.toMatchObject({ code });
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it.each([503, 403] as const)("retains existing workspace access across replicas during GitHub status %s", async status => {
    const f = await fixture();
    const workspace = await workspaces.get(f.workspace.id, userId);
    await services.authorizeSource(workspace);
    await pool.query("UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp()-interval '11 minutes' WHERE org_id=$1", [organizationId]);
    fetcher.mockImplementationOnce(async () => Response.json({ message: status === 403 ? "You have exceeded a secondary rate limit." : "private-provider-canary" },
      { status, headers: { "retry-after": "300" } }));
    const other = createCloudGithubServices(pool, null, keys, workspaces, fetcher);
    const lease = await other.continueSource(workspace);
    await expect(lease.refresh).rejects.toMatchObject({ code: status === 403 ? "github_rate_limited" : "github_unavailable" });
    expect((await workspaces.get(workspace.id, userId)).state).toBe("running");
    fetcher.mockClear();
    const restarted = createCloudGithubServices(pool, null, keys, workspaces, fetcher);
    await expect(restarted.continueSource(workspace)).resolves.toMatchObject({ recheckAt: expect.any(Number) });
    await expect(restarted.authorizeSource(workspace)).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect((await workspaces.get(workspace.id, userId)).state).toBe("running");
  });

  it("keeps a workspace running after a definitive GitHub denial and refuses the network operation", async () => {
    const f = await fixture();
    const workspace = await workspaces.get(f.workspace.id, userId);
    await services.authorizeSource(workspace);
    await pool.query("UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp()-interval '11 minutes' WHERE org_id=$1", [organizationId]);
    services.source.invalidate();
    fetcher.mockImplementationOnce(async () => Response.json({ message: "Resource not accessible by personal access token" }, { status: 403 }));
    const lease = await services.continueSource(workspace);
    await expect(lease.refresh).rejects.toMatchObject({ code: "github_cloud_access_denied" });
    expect((await workspaces.get(workspace.id, userId)).state).toBe("running");
    await expect(services.service.execute(workspace.id, userId, { op: "gh.prSync", params: {} }))
      .rejects.toMatchObject({ code: "github_cloud_access_denied" });
    expect((await pool.query("SELECT verified_at FROM cloud_github_source_verifications WHERE org_id=$1", [organizationId])).rows[0].verified_at).toBeNull();
  });

  it("retains the verified repository binding and catalog during an outage without issuing GitHub credentials", async () => {
    const f = await fixture(), workspace = await workspaces.get(f.workspace.id, userId);
    await services.authorizeSource(workspace);
    const verified = await services.binding(workspace);
    expect(verified.repositoryId).toBe("42");
    expect(verified.repository).toBe("current/project");
    await pool.query("UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp()-interval '11 minutes' WHERE org_id=$1", [organizationId]);
    services.source.invalidate();
    fetcher.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    const lease = await services.continueSource(workspace);
    await expect(lease.refresh).rejects.toMatchObject({ code: "github_unavailable" });
    fetcher.mockClear();
    expect(await services.binding(workspace, "continuation")).toMatchObject({ repositoryId: "42", repository: "current/project" });
    const document = (await services.documents([workspace]))[0]!;
    expect(document.github?.repositoryId).toBe("42");
    expect(document.githubUnavailableReason).toBeUndefined();
    await expect(services.workspaceToken(workspace)).rejects.toMatchObject({ code: "github_unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
    await pool.query("UPDATE cloud_v2_github_workspaces SET repository_id=99 WHERE workspace_id=$1", [workspace.id]);
    await expect(services.binding(workspace, "continuation")).rejects.toMatchObject({ code: "github_repository_changed" });
  });
  it("observes a persisted denial at another replica for network operations without stopping the VM", async () => {
    const f = await fixture(), before = (await workspaces.workerSession(f.token, f.boot))!;
    await services.authorizeSource(before);
    const other = createCloudGithubServices(pool, null, keys, workspaces, fetcher);
    await other.continueSource(before, before);
    const observations = new PostgresGithubVerificationStore(pool);
    const scope = { organizationId, userId, repositoryId: "42", fingerprint: await services.connections.fingerprintFor({ organizationId, userId }) };
    await pool.query("UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp()-interval '11 minutes' WHERE org_id=$1", [organizationId]);
    const claim = await observations.claim(scope);
    await observations.finish(scope, claim!.claimId!, { allowed: false, temporary: false, retryAfterMs: 60_000,
      error: new HttpError(403, "github_cloud_access_denied", "denied") });
    const after = (await workspaces.workerSession(f.token, f.boot))!;
    expect(BigInt(after.loginRevision)).toBeGreaterThan(BigInt(before.loginRevision));
    await expect(other.workspaceToken(after)).rejects.toMatchObject({ code: "github_cloud_access_denied" });
    expect((await workspaces.get(after.id, userId)).state).toBe("running");
  });
  it("updates a running checkout's canonical binding from a healthy continuation without extra GitHub calls", async () => {
    owner = "former";
    const f = await fixture(), workspace = await workspaces.get(f.workspace.id, userId);
    await services.authorizeSource(workspace);
    await services.binding(workspace);
    const before = await workspaces.loginRevision(workspace.id);
    await pool.query("UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp()-interval '11 minutes' WHERE org_id=$1", [organizationId]);
    owner = "current"; // The old name now resolves to repository 99.
    const other = createCloudGithubServices(pool, null, keys, workspaces, fetcher);
    fetcher.mockClear();
    const lease = await other.continueSource(workspace);
    await lease.refresh;
    await vi.waitFor(async () => expect((await other.metadata.context(workspace.id, userId)).repository).toBe("current/project"));
    expect(BigInt((await workspaces.loginRevision(workspace.id))!)).toBeGreaterThan(BigInt(before!));
    const calls = fetcher.mock.calls.length;
    const restarted = createCloudGithubServices(pool, null, keys, workspaces, fetcher);
    expect(await restarted.binding(workspace, "continuation")).toMatchObject({ repositoryId: "42", repository: "current/project",
      previousRepositories: expect.arrayContaining(["former/project"]) });
    expect(fetcher.mock.calls).toHaveLength(calls);
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/user", "/repositories/42", "/repositories/42/branches",
    ]);
  });
  it("uses the selected cloud connection to retain Computer identity and setup through a transfer", async () => {
    owner = "former";
    const computers = new CloudV2Computers(
      pool,
      pool,
      services.resolveRepository,
    );
    const build = await computers.enqueue(organizationId, userId, {
      repositories: [
        {
          repository: "former/project",
          branch: "master",
          setup: "echo original-source",
        },
      ],
    });
    await computers.claim();
    await computers.activate(build.id, "clean-synthetic-snapshot");
    const workspace = await workspaces.createWorkspace({
      id: randomUUID(),
      organizationId,
      creatorUserId: userId,
      name: "Transferred",
      repository: "former/project",
      branch: "topic",
      baseBranch: "master",
      computerBuildId: build.id,
    });
    owner = "current";
    fetcher.mockClear();
    expect(
      await computers.resolveBuildRepository(
        organizationId,
        userId,
        build.id,
        "former/project",
      ),
    ).toEqual({ repository: "current/project", repositoryId: "42" });
    expect(await services.workspaceSetup(workspace, computers)).toEqual({ setup: "echo original-source" });
    expect(
      fetcher.mock.calls.some(
        ([url]) => new URL(String(url)).pathname === "/repos/former/project",
      ),
    ).toBe(false);
    expect((await services.binding(workspace)).repositoryId).toBe("42");
  });

  it("does not offer a replacement repository's setup when an older disk restores onto a newer clean Computer", async () => {
    const { workspace } = await fixture();
    const computers = new CloudV2Computers(
      pool,
      pool,
      async (_org, _user, target) => ({
        repository: target.repository,
        repositoryId: "99",
      }),
    );
    const build = await computers.enqueue(organizationId, userId, {
      repositories: [
        { repository: "former/project", setup: "echo replacement-source" },
      ],
    });
    await computers.claim();
    await computers.activate(build.id, "new-clean-snapshot");
    await pool.query(
      "UPDATE cloud_v2_workspaces SET computer_build_id=$2 WHERE id=$1",
      [workspace.id, build.id],
    );
    const restored = await workspaces.get(workspace.id, userId);
    expect(await services.workspaceSetup(restored, computers)).toBeNull();
    expect(await services.identities.primary(restored)).toEqual({
      repository: "former/project",
      repositoryId: "42",
    });
    await services.authorizeSource(restored);
  });
  it("creates and reads the exact PR after a transfer without waking a stopped VM or using a reused name", async () => {
    const { workspace } = await fixture();
    await pool.query(
      "UPDATE cloud_v2_workspaces SET state='stopped' WHERE id=$1",
      [workspace.id],
    );
    const read = await services.service.execute(workspace.id, userId, {
      op: "gh.prSync",
      params: {},
    });
    expect(read.result).toBeNull();
    await services.service.execute(workspace.id, userId, {
      op: "gh.prCreate",
      expected: read.authority,
      params: { title: "Change", body: "Description", draft: true },
    });
    const result = await services.service.execute(workspace.id, userId, {
      op: "gh.prSync",
      params: {},
    });
    expect(result.result).toMatchObject({
      number: 7,
      url: "https://github.com/current/project/pull/7",
    });
    expect(writeCalls).toBe(1);
    expect((await workspaces.get(workspace.id, userId)).state).toBe("stopped");
    expect(
      fetcher.mock.calls.some(
        ([url]) => new URL(String(url)).pathname === "/repos/former/project",
      ),
    ).toBe(false);
    expect(
      (
        await services.documents([await workspaces.get(workspace.id, userId)])
      )[0],
    ).toMatchObject({
      checkoutPath: "/home/user/former/project",
      repository: "current/project",
      github: { prNumber: 7 },
    });
    expect(
      (
        await pool.query(
          "SELECT source_repositories FROM cloud_v2_workspaces WHERE id=$1",
          [workspace.id],
        )
      ).rows[0].source_repositories,
    ).toEqual(["former/project"]);
  });
  it("retains every alias and the original checkout through later moves", async () => {
    const { workspace } = await fixture();
    await services.binding(workspace);
    owner = "third";
    const binding = await services.binding(workspace);
    expect(binding).toMatchObject({
      repositoryId: "42",
      repository: "third/project",
    });
    expect(binding.previousRepositories).toEqual(
      expect.arrayContaining(["former/project", "current/project"]),
    );
    expect((await workspaces.get(workspace.id, userId)).repository).toBe(
      "former/project",
    );
  });
  it("rejects disconnected credentials for GitHub operations and retains shared checkout metadata", async () => {
    const { workspace } = await fixture();
    await services.service.execute(workspace.id, userId, {
      op: "gh.prSync",
      params: {},
    });
    const scope = { organizationId, userId };
    await services.connections.store.disconnect(
      scope,
      await services.connections.store.fingerprint(scope),
      "pat",
    );
    await expect(
      services.service.execute(workspace.id, userId, {
        op: "gh.prSync",
        params: {},
      }),
    ).rejects.toMatchObject({ code: "github_connection_required" });
    expect((await services.documents([workspace]))[0]?.github).toMatchObject({ repositoryId: "42", prNumber: null });
    expect((await services.documents([workspace]))[0]).not.toHaveProperty("githubUnavailableReason");
    expect((await workspaces.get(workspace.id, userId)).state).toBe("running");
  });
  it("retains shared PR metadata if the selected connection changes during the catalog read", async () => {
    const { workspace } = await fixture();
    created = true;
    await services.service.execute(workspace.id, userId, {
      op: "gh.prSync",
      params: {},
    });
    const original = services.metadata.documents.bind(services.metadata);
    vi.spyOn(services.metadata, "documents").mockImplementation(
      async (...args) => {
        const result = await original(...args),
          scope = { organizationId, userId };
        await services.connections.store.disconnect(
          scope,
          await services.connections.store.fingerprint(scope),
          "pat",
        );
        return result;
      },
    );
    expect((await services.documents([workspace]))[0]?.github).toMatchObject({ repositoryId: "42", prNumber: 7 });
    expect(services.metadata.documents).toHaveBeenCalled();
  });
  it.each(["membership", "login", "access", "state", "sources"] as const)(
    "rechecks membership and retains shared metadata when %s changes during its read", async change => {
      const f = await fixture();
      created = true;
      await services.service.execute(f.workspace.id, userId, { op: "gh.prSync", params: {} });
      const workspace = await workspaces.get(f.workspace.id, userId);
      const original = services.metadata.documents.bind(services.metadata);
      vi.spyOn(services.metadata, "documents").mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        if (change === "membership") await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [organizationId, userId]);
        else if (change === "login") await pool.query("UPDATE cloud_v2_workspaces SET login_revision=login_revision+1 WHERE id=$1", [workspace.id]);
        else if (change === "access") await pool.query("UPDATE cloud_v2_workspaces SET access_epoch=access_epoch+1 WHERE id=$1", [workspace.id]);
        else if (change === "state") await workspaces.transition(workspace.id, ["running"], "stopped");
        else await pool.query("DELETE FROM cloud_v2_github_sources WHERE workspace_id=$1", [workspace.id]);
        return result;
      });
      const [document] = await services.documents([workspace]);
      expect(services.metadata.documents).toHaveBeenCalled();
      if (change === "membership") expect(document).toBeUndefined();
      else {
        expect(document?.github).toMatchObject({ repositoryId: "42", prNumber: 7 });
        expect(document?.checkoutPath).toBe(`/home/user/${workspace.repository}`);
        expect(Date.parse(document!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(workspace.updatedAt));
      }
    },
  );
  it("retains a shared catalog row when a secondary source is denied during the metadata read", async () => {
    const id = randomUUID();
    // Historical workspaces retain every source from their original snapshot.
    await pool.query(`INSERT INTO cloud_v2_workspaces(id,org_id,creator_user_id,name,repository,branch,base_branch,state,source_repositories)
      VALUES($1,$2,$3,'Historical workspace','former/project','topic','main','creating',$4)`,
      [id, organizationId, userId, ["former/project", "secondary/project"]]);
    await pool.query(`INSERT INTO cloud_v2_github_sources(workspace_id,source_repository,repository_id)
      VALUES($1,'former/project',42),($1,'secondary/project',43)`, [id]);
    const token = await workspaces.rotateWorkerToken(id), boot = randomUUID();
    await workspaces.acceptWorkerHello(token, boot);
    await services.metadata.checkout(token, boot, { sequence: 1, branch: "topic", baseBranch: "main", headSha: head });
    fetcher.mockImplementation(async (value, init) => new URL(String(value)).pathname === "/repositories/43"
      ? Response.json({ ...repo(), id: 43, owner: { login: "secondary" } }) : defaultFetch(value, init));
    created = true;
    await services.service.execute(id, userId, { op: "gh.prSync", params: {} });
    const workspace = await workspaces.get(id, userId);
    const original = services.metadata.documents.bind(services.metadata);
    vi.spyOn(services.metadata, "documents").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await pool.query(`UPDATE cloud_github_source_verifications SET verified_at=NULL,failure_code='github_cloud_access_denied',
        failure_status=403,retry_at=clock_timestamp()+interval '1 minute' WHERE org_id=$1 AND owner_user_id=$2 AND repository_id=43`, [organizationId, userId]);
      return result;
    });
    const [document] = await services.documents([workspace]);
    expect(document?.github).toMatchObject({ repositoryId: "42", prNumber: 7 });
    expect(document).not.toHaveProperty("githubUnavailableReason");
    expect(services.metadata.documents).toHaveBeenCalled();
  });
  it.each(["held-creator", "cloud-disabled"] as const)("withholds catalog metadata without stopping work when local access is %s", async reason => {
    const { workspace } = await fixture();
    created = true;
    await services.service.execute(workspace.id, userId, { op: "gh.prSync", params: {} });
    if (reason === "cloud-disabled") await pool.query("UPDATE organizations SET cloud_workspaces_allowed=false WHERE id=$1", [organizationId]);
    else {
      for (let i = 0; i < 5; i++) {
        const member = randomUUID();
        await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Free member')", [member, `${member}@example.test`]);
        await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [organizationId, member]);
      }
      await pool.query("UPDATE account_entitlements SET status='cancelled',cloud_workspaces_allowed=false WHERE user_id=$1", [userId]);
    }
    await expect(workspaces.get(workspace.id, userId)).rejects.toMatchObject({ code: reason === "held-creator" ? "organization_member_on_hold" : "not_found" });
    expect((await pool.query("SELECT state FROM cloud_v2_workspaces WHERE id=$1", [workspace.id])).rows[0].state).toBe("running");
    const rows = await workspaces.list(organizationId, userId);
    expect(rows).toHaveLength(1);
    expect(await services.documents(rows)).toEqual([]);
    expect((await pool.query("SELECT state FROM cloud_v2_workspaces WHERE id=$1", [workspace.id])).rows[0].state).toBe("running");
  });
  it("retains a stopped catalog through a temporary refresh failure", async () => {
    const f = await fixture();
    await services.service.execute(f.workspace.id, userId, { op: "gh.prSync", params: {} });
    const running = await workspaces.get(f.workspace.id, userId);
    await services.documents([running]);
    await pool.query("UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp()-interval '10 minutes 1 second' WHERE org_id=$1", [organizationId]);
    await workspaces.transition(running.id, ["running"], "stopped");
    fetcher.mockClear();
    fetcher.mockImplementation(async () => new Response(null, { status: 503 }));
    const [document] = await services.documents([await workspaces.get(running.id, userId)]);
    expect(document?.github).toBeDefined();
    expect(document?.githubUnavailableReason).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect((await workspaces.get(running.id, userId)).state).toBe("stopped");
  });
  it("keeps shared catalog metadata keyed by workspace across organizations", async () => {
    const first = await fixture(), firstOrg = organizationId;
    created = true;
    await services.service.execute(first.workspace.id, userId, { op: "gh.prSync", params: {} });
    organizationId = randomUUID();
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Other',$3,false,true)",
      [organizationId, `org-${organizationId}`, userId]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [organizationId, userId]);
    const second = await fixture();
    const rows = await Promise.all([first, second].map(f => workspaces.get(f.workspace.id, userId)));
    for (const ordered of [rows, [...rows].reverse(), rows]) {
      const documents = await services.documents(ordered);
      expect(documents.find(row => row.organizationId === firstOrg)).toMatchObject({ github: { prNumber: 7 } });
      expect(documents.find(row => row.organizationId === organizationId)?.github?.prNumber ?? null).toBeNull();
      expect(documents.find(row => row.organizationId === organizationId)).not.toHaveProperty("githubUnavailableReason");
    }
  });
  it("keeps catalog versions and shared metadata after the selected connection is removed", async () => {
    const { workspace } = await fixture();
    await services.service.execute(workspace.id, userId, {
      op: "gh.prSync",
      params: {},
    });
    const [before] = await services.documents([workspace]);
    expect(Date.parse(before!.updatedAt)).toBeGreaterThan(
      Date.parse(workspace.updatedAt),
    );
    const scope = { organizationId, userId };
    await services.connections.store.disconnect(
      scope,
      await services.connections.store.fingerprint(scope),
      "pat",
    );
    const [after] = await services.documents([workspace]);
    expect(Date.parse(after!.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(before!.updatedAt),
    );
    expect(after?.github).toEqual(before?.github);
    expect(after?.repository).toBe(before?.repository);
  });
  it("does not invent historical repository IDs from a reusable name", async () => {
    const { workspace } = await fixture(false);
    await expect(services.authorizeSource(workspace)).rejects.toMatchObject({
      code: "cloud_source_review_required",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await workspaces.get(workspace.id, userId)).toMatchObject({
      repository: "former/project",
    });
    expect((await services.documents([workspace]))[0]).not.toHaveProperty("github");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("withholds an in-flight workspace token when deletion retires its source scope", async () => {
    const f = await fixture(), workspace = await workspaces.get(f.workspace.id, userId);
    await services.authorizeSource(workspace);
    const original = fetcher.getMockImplementation()!;
    let reached!: () => void, release!: () => void;
    const reading = new Promise<void>(resolve => { reached = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    fetcher.mockImplementation(async (value, init) => {
      if (new URL(String(value)).pathname.endsWith("/branches")) { reached(); await held; }
      return original(value, init);
    });
    const pending = services.workspaceToken(workspace).then(value => ({ value }), error => ({ error }));
    try {
      await reading;
      expect(await workspaces.transition(workspace.id, ["running"], "deleting")).toMatchObject({ state: "deleting" });
      release();
      expect(await pending).toMatchObject({ error: { code: "cloud_source_review_required" } });
      const sources = await pool.query("SELECT repository_id FROM cloud_v2_github_sources WHERE workspace_id=$1", [workspace.id]);
      expect(sources.rows).toHaveLength(1);
      expect(await workspaces.get(workspace.id, userId)).toMatchObject({ state: "deleting" });
    } finally { release(); await pending; fetcher.mockImplementation(original); }
  });
  it.each([
    "github_authorization_expired", "github_installation_required", "github_installation_suspended",
    "github_cloud_access_denied", "github_repository_unavailable", "github_sso_required",
    "github_rate_limited", "github_unavailable", "unexpected",
  ])("does not consult GitHub for shared catalog metadata when verification would return %s", async code => {
    const { workspace } = await fixture();
    created = true;
    await services.service.execute(workspace.id, userId, { op: "gh.prSync", params: {} });
    const source = vi.spyOn(services.source, "workspace").mockRejectedValue(new HttpError(503, code, "Private upstream response"));
    fetcher.mockClear();
    const [document] = await services.documents([workspace]);
    expect(document?.github).toMatchObject({ repositoryId: "42", prNumber: 7 });
    expect(document).not.toHaveProperty("githubUnavailableReason");
    expect(source).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(document)).not.toContain("Private upstream response");
  });
  it("reports a missing remote branch as unknown without masking failed repository authorization", async () => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) =>
      new URL(String(input)).pathname.endsWith("/branches/missing")
        ? new Response(null, { status: 404 })
        : original(input, init),
    );
    await expect(
      services.remoteHead(
        organizationId,
        userId,
        "former/project",
        "missing",
        "42",
      ),
    ).resolves.toBeNull();
    fetcher.mockResolvedValue(new Response(null, { status: 401 }));
    await expect(
      services.remoteHead(
        organizationId,
        userId,
        "former/project",
        "missing",
        "42",
      ),
    ).rejects.toMatchObject({ code: "github_authorization_expired" });
  });
  it("looks up an exact branch by the admitted repository ID, never a tag or commit", async () => {
    const original = fetcher.getMockImplementation()!;
    const paths: string[] = [];
    fetcher.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname; paths.push(path);
      if (path === "/repositories/42/branches/release%2Fstable") return Response.json({ name: "release/stable", commit: { sha: head } });
      if (path === "/repositories/42/branches/tag-only") return new Response(null, { status: 404 });
      if (path.endsWith("/commits/tag-only")) return Response.json({ sha: head });
      return original(input, init);
    });
    try {
      await expect(services.remoteHead(organizationId, userId, "former/project", "release/stable", "42")).resolves.toBe(head);
      await expect(services.remoteHead(organizationId, userId, "former/project", "tag-only", "42")).resolves.toBeNull();
      expect(paths).toContain("/repositories/42/branches/release%2Fstable");
      expect(paths.some(path => path.includes("/commits/"))).toBe(false);
      expect(paths.some(path => path.startsWith("/repos/former/"))).toBe(false);
    } finally { fetcher.mockImplementation(original); }
  });

  it.each([503, 429])("does not report a GitHub %s branch lookup as missing", async status => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) => new URL(String(input)).pathname.includes("/branches/")
      ? new Response(null, { status, headers: { "retry-after": "60" } }) : original(input, init));
    try {
      await expect(services.remoteHead(organizationId, userId, "former/project", "main", "42"))
        .rejects.toMatchObject({ code: status === 429 ? "github_rate_limited" : "github_unavailable" });
    } finally { fetcher.mockImplementation(original); }
  });

  it.each([200, 404])("fences a selected-connection change during a branch lookup returning %s", async status => {
    const original = fetcher.getMockImplementation()!;
    let changed = false;
    fetcher.mockImplementation(async (input, init) => {
      if (!new URL(String(input)).pathname.includes("/branches/")) return original(input, init);
      const scope = { organizationId, userId };
      await services.connections.store.disconnect(scope, await services.connections.store.fingerprint(scope), "pat");
      changed = true;
      return status === 200 ? Response.json({ name: "main", commit: { sha: head } }) : new Response(null, { status });
    });
    try {
      await expect(services.remoteHead(organizationId, userId, "former/project", "main", "42")).rejects.toMatchObject({ code: "github_authorization_changed" });
      expect(changed).toBe(true);
    } finally { fetcher.mockImplementation(original); }
  });
});
