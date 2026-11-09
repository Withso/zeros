// The Create page lists the Cloud Computer's repositories just before a create
// checks the same ones. Inside the source authority's 30 s window, a repeated
// check must not resolve each repository through GitHub again.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { CloudV2Store } from "./store.js";
import { CloudV2Computers } from "./computer.js";
import { createCloudGithubServices } from "./github-composition.js";
import { createCloudV2Routes } from "./routes.js";
import type { CloudSourceTarget } from "./source-authority.js";
import { observeTransactionTiming, requestTiming, type RequestDatabaseCost } from "../request-timing.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("Cloud Computer repository list cost", () => {
  let pool: pg.Pool;
  const keys = { currentKeyVersion: 1, keys: { 1: Buffer.alloc(32, 7).toString("base64url") } };
  const repo = (id: number, name: string) => ({ id, name, owner: { login: "current" }, default_branch: "main", private: true, archived: false, permissions: { pull: true, push: true } });
  const revoked = new Set<number>();
  const fetcher = vi.fn(async (value: string | URL | Request): Promise<Response> => {
    const url = new URL(String(value));
    if (url.pathname === "/user") return Response.json({ id: 12, login: "contributor" });
    for (const [id, name] of [[42, "project"], [43, "other"]] as const) {
      if (!url.pathname.startsWith(`/repositories/${id}`) && url.pathname !== `/repos/current/${name}`) continue;
      if (revoked.has(id)) return Response.json({ message: "Not Found" }, { status: 404 });
      if (url.pathname === `/repositories/${id}` || url.pathname === `/repos/current/${name}`) return Response.json(repo(id, name));
      if (url.pathname === `/repositories/${id}/branches`) return Response.json([]);
      if (url.pathname === `/repositories/${id}/branches/main`) return Response.json({ commit: { sha: "a".repeat(40) } });
    }
    throw new Error(`Unexpected synthetic request ${url.pathname}`);
  });
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await resetMigratedTestDatabase(pool); fetcher.mockClear(); revoked.clear(); });

  async function setup(count: number) {
    const userId = randomUUID(), organizationId = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'User')", [userId, `${userId}@example.test`]);
    await grantTestPro(pool, userId);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Org',$3,false,true)",
      [organizationId, `org-${organizationId}`, userId]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [organizationId, userId]);
    const workspaces = new CloudV2Store(pool);
    const services = createCloudGithubServices(pool, null, keys, workspaces, fetcher);
    const scope = { organizationId, userId };
    await services.connections.store.save(scope, await services.connections.store.fingerprint(scope),
      { id: "12", login: "contributor" }, { method: "pat", accessToken: "synthetic-pat", expiresAt: null });
    const computers = new CloudV2Computers(pool, pool, services.resolveRepository, services.resolveRecentRepository);
    const repositories = [{ repository: "current/project", branch: "main" }, { repository: "current/other", branch: "main" }].slice(0, count);
    const build = await computers.enqueue(organizationId, userId, { repositories });
    await computers.claim();
    await computers.activate(build.id, "clean-synthetic-snapshot");
    // As composition.ts wires them.
    const authorizeBuildRepository = async (org: string, user: string, buildId: string, repository: string, options?: { fresh?: boolean }) => {
      const target = await computers.resolveBuildRepository(org, user, buildId, repository, options);
      await services.source.targets(org, user, [target]);
      return target;
    };
    const remoteHead = (org: string, user: string, target: CloudSourceTarget, branch: string) =>
      services.remoteHead(org, user, target.repository, branch, target.repositoryId);
    const app = new Hono(), costs: RequestDatabaseCost[] = [];
    app.use("*", requestTiming({ slowMs: Infinity, databasePool: pool, costObserver: cost => { costs.push(cost); } }));
    app.use("*", async (c, next) => { c.set("user", { id: userId } as never); await next(); });
    app.route("/", createCloudV2Routes({ store: workspaces, computers, installedRepositories: organization => workspaces.installedRepositories(organization),
      authorizeBuildRepository, remoteHead, bridgeBaseUrl: "wss://bridge.example.test", github: services } as never));
    const create = () => app.request("/v1/cloud-v2/workspaces", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId, repository: "current/project", name: `p-${randomUUID().slice(0, 8)}` }) });
    return { app, costs, organizationId, create, list: `/v1/cloud-v2/organizations/${organizationId}/computer/repositories` };
  }

  it.each([1, 2])("a repeated request inside the 30 s window makes no GitHub calls (%i repositories)", async count => {
    const { app, costs, list } = await setup(count);
    const samples: { request: string; status: number; repositories: number; transactions: number; queries: number; github: string[] }[] = [];
    for (const request of ["first (cold)", "+0 s (verification cached)", "+0 s again"]) {
      fetcher.mockClear();
      let status = 0, listed = 0;
      await observeTransactionTiming(async () => {
        const response = await app.request(list);
        status = response.status;
        listed = ((await response.json()) as { repositories: unknown[] | null }).repositories?.length ?? -1;
      }, summary => samples.push({ request, status, repositories: listed, transactions: summary.transactions,
        queries: costs.at(-1)?.queriesStarted ?? -1, github: fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname) }));
    }
    expect(samples.every(sample => sample.status === 200 && sample.repositories === count)).toBe(true);
    expect(samples.slice(1).map(sample => sample.github.length)).toEqual([0, 0]);
  });

  // The other repositories decide whether a create may take a v3 image that
  // holds their source, so a create reads them live, never from the window.
  it("drops a repository revoked inside the window from a create's v3 scope", async () => {
    const { app, organizationId, create, list } = await setup(2);
    expect((await app.request(list)).status).toBe(200);
    expect((await create()).status).toBe(201);
    revoked.add(43);
    expect((await create()).status).toBe(201);
    const { rows } = await pool.query<{ source_repositories: string[] }>(
      "SELECT source_repositories FROM cloud_v2_workspaces WHERE org_id=$1 ORDER BY created_at", [organizationId]);
    expect(rows.map(row => row.source_repositories)).toEqual([["current/project", "current/other"], ["current/project"]]);
  });
});
