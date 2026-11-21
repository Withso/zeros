// P2.4: a project create's GitHub checks, counted. GitHub requests and database
// round trips are counted for 1, 3 and 6 repositories, with and without a
// recent verification (the Create page's warm), before and after.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { CloudV2Store } from "./store.js";
import { createCloudGithubServices } from "./github-composition.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const ids = (count: number) => Array.from({ length: count }, (_, index) => String(500 + index));
const sha = (id: string) => id.padStart(40, "a").slice(-40);

d("a project create's GitHub checks", () => {
  let pool: pg.Pool, org: string, user: string;
  const denied = new Set<string>();
  const requests: string[] = [];
  const defaultFetch = async (value: string | URL | Request): Promise<Response> => {
    const url = new URL(String(value));
    requests.push(url.pathname + url.search);
    if (url.pathname === "/user") return Response.json({ id: 12, login: "fixture" });
    const id = /^\/repositories\/(\d+)/.exec(url.pathname)?.[1] ?? /^\/repos\/example\/r(\d+)$/.exec(url.pathname)?.[1];
    if (!id || denied.has(id)) return Response.json({ message: "Not found" }, { status: 404 });
    if (url.pathname.endsWith("/branches")) return Response.json([]);
    if (url.pathname.endsWith("/branches/main")) return Response.json({ commit: { sha: sha(id) } });
    if (url.pathname.includes("/branches/")) return Response.json({ message: "Not found" }, { status: 404 });
    return Response.json({ id: Number(id), name: `r${id}`, owner: { login: "example" }, default_branch: "main", private: true, archived: false,
      permissions: { pull: true, push: true } });
  };
  const fetcher = vi.fn(defaultFetch);
  let queries = 0;
  const original = pg.Client.prototype.query;
  const count = async <T>(work: () => Promise<T>) => {
    requests.length = 0; queries = 0;
    const result = await work();
    return { result, github: requests.length, paths: [...requests], database: queries };
  };
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 });
    pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) { queries++; return (original as (...a: unknown[]) => unknown).apply(this, args); } as never;
  });
  afterAll(async () => { pg.Client.prototype.query = original; await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    denied.clear();
    user = randomUUID(); org = randomUUID();
    await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'U')", [user, `u-${user}@example.test`]);
    await grantTestPro(pool, user);
    await pool.query("INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed) VALUES ($1,$2,'Org',$3,false,true)", [org, `org-${org}`, user]);
    await pool.query("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1,$2,'member')", [org, user]);
    await connect();
  });
  /** A server with empty process caches, as after a restart; the verification store persists in the database. */
  const services = async () =>
    createCloudGithubServices(pool, null, { currentKeyVersion: 1, keys: { 1: Buffer.alloc(32, 27).toString("base64url") } }, new CloudV2Store(pool), fetcher);
  const connect = async () => {
    const github = await services(), scope = { organizationId: org, userId: user };
    await github.connections.store.save(scope, await github.connections.store.fingerprint(scope), { id: "12", login: "fixture" },
      { method: "pat", accessToken: "synthetic-token", expiresAt: null });
  };
  const project = (size: number) => ids(size).map(id => ({ repository: `example/r${id}`, repositoryId: id, baseBranch: "main" }));

  /** P1's one-repository create, repeated per repository: the member's identity
   * read, the branch head, then the lifecycle's source check before any VM. */
  const before = async (github: Awaited<ReturnType<typeof services>>, repositories: ReturnType<typeof project>) => {
    for (const entry of repositories) {
      const access = await github.connections.access({ organizationId: org, userId: user });
      await access.api.repository({ repository: entry.repository });
      await github.remoteHead(org, user, entry.repository, entry.baseBranch, entry.repositoryId);
      await github.source.targets(org, user, [{ repository: entry.repository, repositoryId: entry.repositoryId }]);
    }
  };

  const targetsOf = (size: number) => project(size).map(({ repository, repositoryId }) => ({ repository, repositoryId }));

  // Measured on this fixture (GitHub requests / database round trips):
  //   repositories | before uncached | before cached | after uncached | after cached
  //              1 |  8 / 120       |  5 / 71       |  4 / 80        | 2 / 39
  //              3 | 24 / 360       | 15 / 213      | 10 / 180       | 4 / 61
  //              6 | 48 / 720       | 30 / 426      | 19 / 336       | 7 / 94
  // GitHub counts are exact. Database counts move by a few between runs (parallel
  // verification claims), so they are bounded rather than pinned.
  it.each([1, 3, 6])("checks a project of %i repositories with far fewer reads, each GitHub read at most once", async size => {
    await pool.query("DELETE FROM cloud_github_source_verifications");
    const oldUncached = await count(async () => before(await services(), project(size)));
    const oldCached = await count(async () => before(await services(), project(size)));
    expect([oldUncached.github, oldCached.github]).toEqual([8 * size, 5 * size]);

    await pool.query("DELETE FROM cloud_github_source_verifications");
    const uncached = await count(async () => (await services()).projectAccess(org, user, project(size)));
    expect(uncached.result).toEqual(project(size).map(entry => ({ ...entry, baseCommit: sha(entry.repositoryId) })));
    expect(uncached.github).toBe(3 * size + 1);
    expect(new Set(uncached.paths).size).toBe(uncached.paths.length);
    expect(uncached.database).toBeLessThanOrEqual(60 * size + 30);
    expect(uncached.database).toBeLessThan(oldUncached.database);

    // The Create page's warm on a fresh server, then the create on another: one identity read and each branch head.
    await (await services()).source.targets(org, user, targetsOf(size), true);
    const cached = await count(async () => (await services()).projectAccess(org, user, project(size)));
    expect(cached.github).toBe(size + 1);
    expect(cached.paths.filter(path => path === "/user")).toHaveLength(1);
    expect(cached.paths.filter(path => path.endsWith("/branches/main"))).toHaveLength(size);
    expect(cached.database).toBeLessThanOrEqual(12 * size + 32);
    // The lifecycle's check before the VM, seconds later, needs GitHub for nothing.
    expect((await count(async () => (await services()).source.targets(org, user, targetsOf(size)))).github).toBe(0);
  });

  it("checks a project's repositories in parallel, a few at a time", async () => {
    let active = 0, peak = 0;
    fetcher.mockImplementation(async (value: string | URL | Request) => {
      const url = new URL(String(value));
      requests.push(url.pathname);
      if (url.pathname === "/user") return Response.json({ id: 12, login: "fixture" });
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 20));
      active--;
      const id = /^\/repositories\/(\d+)/.exec(url.pathname)![1]!;
      if (url.pathname.endsWith("/branches")) return Response.json([]);
      if (url.pathname.endsWith("/branches/main")) return Response.json({ commit: { sha: sha(id) } });
      return Response.json({ id: Number(id), name: `r${id}`, owner: { login: "example" }, default_branch: "main", private: true, archived: false,
        permissions: { pull: true, push: true } });
    });
    try { await (await services()).projectAccess(org, user, project(6)); }
    finally { fetcher.mockReset(); fetcher.mockImplementation(defaultFetch); }
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("refuses at once, naming the repository, when a denial was recorded or the connection changed, recent check or not", async () => {
    await (await services()).source.targets(org, user, targetsOf(3), true);
    // Another check (a worker's token request, say) recorded a denial for one repository.
    await pool.query(`UPDATE cloud_github_source_verifications SET verified_at=NULL, failure_code='github_repository_access_required', failure_status=403,
      retry_at=clock_timestamp()+interval '10 minutes' WHERE repository_id=501`);
    await expect((await services()).projectAccess(org, user, project(3))).rejects.toMatchObject({ status: 403,
      message: expect.stringContaining("example/r501") });
    // A new connection is checked afresh: GitHub denies one repository now.
    denied.add("502");
    const github = await services(), scope = { organizationId: org, userId: user };
    await github.connections.store.save(scope, await github.connections.store.fingerprint(scope), { id: "12", login: "fixture" },
      { method: "pat", accessToken: "synthetic-token-2", expiresAt: null });
    await pool.query("DELETE FROM cloud_github_source_verifications WHERE repository_id=501");
    await expect((await services()).projectAccess(org, user, project(3))).rejects.toMatchObject({ status: 404,
      message: "You can't read example/r502 on GitHub, so this workspace can't be created. Ask for access or remove it from the project." });
  });

  it("names a missing base branch and its repository", async () => {
    const repositories = project(2).map((entry, index) => index === 1 ? { ...entry, baseBranch: "gone" } : entry);
    await expect((await services()).projectAccess(org, user, repositories)).rejects.toMatchObject({ code: "repository_branch_not_found",
      message: "Branch gone does not exist in example/r501." });
  });
});
