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
    await expect(restarted.authorizeSource(workspace)).rejects.toMatchObject({ code: status === 403 ? "github_rate_limited" : "github_unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await workspaces.get(workspace.id, userId)).state).toBe("running");
  });

  it("ends a running workspace only after a confirmed background denial", async () => {
    const f = await fixture();
    const workspace = await workspaces.get(f.workspace.id, userId);
    await services.authorizeSource(workspace);
    await pool.query("UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp()-interval '11 minutes' WHERE org_id=$1", [organizationId]);
    services.source.invalidate();
    fetcher.mockImplementationOnce(async () => Response.json({ message: "Resource not accessible by personal access token" }, { status: 403 }));
    const lease = await services.continueSource(workspace);
    await expect(lease.refresh).rejects.toMatchObject({ code: "github_cloud_access_denied" });
    await vi.waitFor(async () => expect((await workspaces.get(workspace.id, userId)).state).toBe("stopping"));
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
  it("repairs a missed denial notification on the next authenticated request to another replica", async () => {
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
    await expect(other.continueSource(after, after)).rejects.toMatchObject({ code: "github_cloud_access_denied" });
    expect((await workspaces.get(after.id, userId)).state).toBe("stopping");
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
    expect(await services.workspaceSetup(workspace, computers)).toBe(
      "echo original-source",
    );
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
  it("rejects disconnected credentials, clears PR capability, and retains the disk", async () => {
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
    expect((await services.documents([workspace]))[0]).not.toHaveProperty(
      "github",
    );
    expect((await services.documents([workspace]))[0]).toHaveProperty(
      "githubUnavailableReason",
      "connection-required",
    );
    expect((await workspaces.get(workspace.id, userId)).state).toBe("stopping");
  });
  it("withdraws PR metadata if the selected connection changes while catalog metadata is being read", async () => {
    const { workspace } = await fixture();
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
    expect((await services.documents([workspace]))[0]).not.toHaveProperty(
      "github",
    );
  });
  it("keeps catalog versions monotonic when authorization withdraws newer PR metadata", async () => {
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
    expect(after).not.toHaveProperty("github");
    expect(after?.repository).toBe(workspace.repository);
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
    expect((await services.documents([workspace]))[0]).toHaveProperty(
      "githubUnavailableReason",
      "source-review-required",
    );
  });
  it.each([
    ["github_authorization_expired", "connection-expired"],
    ["github_installation_required", "installation-required"],
    ["github_installation_suspended", "installation-suspended"],
    ["github_cloud_access_denied", "access-denied"],
    ["github_repository_unavailable", "access-denied"],
    ["github_sso_required", "sso-required"],
    ["github_rate_limited", "rate-limited"],
    ["github_unavailable", "unavailable"],
    ["unexpected", "unavailable"],
  ])(
    "reports safe recovery guidance for %s without exposing protected PR data",
    async (code, reason) => {
      const { workspace } = await fixture();
      vi.spyOn(services.source, "workspace").mockRejectedValue(
        new HttpError(503, code, "Private upstream response"),
      );
      const [document] = await services.documents([workspace]);
      expect(document).toHaveProperty("githubUnavailableReason", reason);
      expect(document).not.toHaveProperty("github");
      expect(JSON.stringify(document)).not.toContain(
        "Private upstream response",
      );
    },
  );
  it("reports a missing remote branch as unknown without masking failed repository authorization", async () => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) =>
      new URL(String(input)).pathname.endsWith("/commits/missing")
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
});
