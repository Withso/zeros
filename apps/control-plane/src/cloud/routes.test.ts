import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { createCloudV2Routes, type CloudV2RouteDeps } from "./routes.js";
import type { CloudV2Workspace } from "./store.js";

const org = "11111111-1111-4111-8111-111111111111";
const member = "22222222-2222-4222-8222-222222222222";
const computerPath = `/v1/cloud-v2/organizations/${org}/computer`;

function fixture(repositories: { repository: string; defaultBranch: string | null }[] | null = [
  { repository: "example/project", defaultBranch: "master" },
]) {
  const requireMember = vi.fn(async () => {});
  const authorizeRepository = vi.fn(async () => {});
  const authorizeSourceTargets = vi.fn(async () => {});
  const authorizeBuildRepository = vi.fn(async (_org: string, _user: string, _build: string, repository: string) => ({ repository, repositoryId: "42" }));
  const sourceRepositoryId = vi.fn(async () => "99");
  const requireAdmin = vi.fn(async (): Promise<void> => { throw new HttpError(403, "forbidden", "Requires an owner or admin"); });
  const log = vi.fn(async () => "source-derived-log-canary");
  const logRepositories = vi.fn(async () => [{ repository: "example/project", repositoryId: "42" }, { repository: "example/private", repositoryId: "43" }]);
  const installedRepositories = vi.fn(async () => repositories);
  const buildId = "44444444-4444-4444-8444-444444444444";
  const activeComputer = vi.fn(async () => repositories ? { buildId, repositories } : null);
  const createWorkspace = vi.fn(async (input: Record<string, unknown>) => ({ ...input, state: "creating" }));
  const authorizeSource = vi.fn(async () => {});
  const get = vi.fn(async (id: string) => ({ id }));
  const readCreateReceipt = vi.fn<() => Promise<{ status: 201; response: Record<string, unknown> } | null>>(async () => null);
  const createWorkspaceOnce = vi.fn(async () => ({ status: 201 as const, response: { workspace: { id: "55555555-5555-4555-8555-555555555555", name: "original-source-receipt" } } }));
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("user", { id: member } as never); await next(); });
  app.onError((error, c) => error instanceof HttpError
    ? c.json({ error: { code: error.code } }, error.status)
    : c.json({ error: { code: "internal" } }, 500));
  app.route("/", createCloudV2Routes({
    store: { createWorkspace, activeComputer, get, readCreateReceipt, createWorkspaceOnce }, computers: { requireMember, requireAdmin, log, logRepositories }, installedRepositories, authorizeRepository, authorizeSourceTargets, authorizeBuildRepository, authorizeSource,
    sourceRepositoryId, bridgeBaseUrl: "wss://dev.example.test",
  } as unknown as CloudV2RouteDeps));
  const create = (body: Record<string, unknown> = {}, key?: string) => app.request("/v1/cloud-v2/workspaces", {
    method: "POST", headers: { "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    body: JSON.stringify({ organizationId: org, repository: "example/project", ...body }),
  });
  return { app, create, requireMember, requireAdmin, installedRepositories, authorizeRepository, authorizeSourceTargets, authorizeBuildRepository, sourceRepositoryId, authorizeSource, readCreateReceipt, createWorkspaceOnce, get, activeComputer, buildId, createWorkspace, log, logRepositories };
}

describe("cloud v2 creation", () => {
  it.each(["initial read", "creation lock"])("reauthorizes the stored workspace before releasing a receipt found at the %s", async stage => {
    const f = fixture();
    const receipt = { status: 201 as const, response: { workspace: { id: "55555555-5555-4555-8555-555555555555", name: "original-source-receipt" } } };
    if (stage === "initial read") f.readCreateReceipt.mockResolvedValue(receipt);
    else f.createWorkspaceOnce.mockImplementation(async () => receipt);
    f.authorizeSource.mockRejectedValue(new HttpError(403, "github_cloud_access_denied", "Original access was revoked"));
    const response = await f.create({}, "same-intent");
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("original-source-receipt");
    expect(f.get).toHaveBeenCalledWith(receipt.response.workspace.id, member);
    expect(f.authorizeSource).toHaveBeenCalledWith({ id: receipt.response.workspace.id });
  });
  it("persists the build's verified repository ID without resolving its reused name again", async () => {
    const f = fixture();
    f.authorizeBuildRepository.mockResolvedValue({ repository: "current/project", repositoryId: "42" });
    const response = await f.create();
    expect(response.status).toBe(201);
    expect(f.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ repository: "example/project", sourceRepositoryId: "42" }));
    expect(f.sourceRepositoryId).not.toHaveBeenCalled();
  });

  it("lists the canonical transferred repository and accepts it while preserving the original checkout and branch", async () => {
    const f = fixture();
    f.authorizeBuildRepository.mockResolvedValue({ repository: "current/project", repositoryId: "42" });
    const catalog = await f.app.request(`${computerPath}/repositories`);
    expect(await catalog.json()).toEqual({ repositories: [{ repository: "current/project", defaultBranch: "master" }] });
    expect((await f.create({ repository: "current/project" })).status).toBe(201);
    expect(f.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ repository: "example/project", baseBranch: "master", sourceRepositoryId: "42" }));
  });

  it.each(["builds", "recipe"] as const)("refuses client-supplied provenance on %s without changing the public recipe shape", async endpoint => {
    const f = fixture(); f.requireAdmin.mockResolvedValue(undefined);
    const response = await f.app.request(`${computerPath}/${endpoint}`, {
      method: endpoint === "recipe" ? "PUT" : "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositories: [{ repository: "example/project", repositoryId: "42" }], ...(endpoint === "recipe" ? { revision: 0 } : {}) }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request" } });
  });
  it("does not release repository 42's old log to a reader of replacement repository 99", async () => {
    const f = fixture(); f.requireAdmin.mockResolvedValue(undefined);
    f.logRepositories.mockResolvedValueOnce([{ repository: "example/project", repositoryId: "42" }]);
    f.authorizeSourceTargets.mockRejectedValueOnce(new HttpError(403, "github_cloud_access_denied", "Original source denied"));
    const response = await f.app.request(`${computerPath}/builds/${f.buildId}/log`);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("source-derived-log-canary");
    expect(f.log).not.toHaveBeenCalled();
  });

  it("binds creation to the selected build's source even when the submitted name now names an allowed replacement", async () => {
    const f = fixture();
    f.authorizeBuildRepository.mockRejectedValue(new HttpError(403, "github_cloud_access_denied", "Original source denied"));
    expect((await f.create()).status).toBe(403);
    expect(f.createWorkspace).not.toHaveBeenCalled();
  });
  it("requires personal access to every source scope before returning build logs", async () => {
    const f = fixture();
    f.requireAdmin.mockResolvedValue(undefined);
    f.authorizeSourceTargets.mockRejectedValueOnce(new HttpError(403, "github_cloud_access_denied", "Unavailable"));
    const response = await f.app.request(`${computerPath}/builds/${f.buildId}/log`);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("source-derived-log-canary");
    expect(f.log).not.toHaveBeenCalled();
  });

  it("returns build logs to a currently authorized administrator", async () => {
    const f = fixture();
    f.requireAdmin.mockResolvedValue(undefined);
    const response = await f.app.request(`${computerPath}/builds/${f.buildId}/log`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("source-derived-log-canary");
    expect(f.authorizeSourceTargets).toHaveBeenCalledWith(org, member, [{ repository: "example/project", repositoryId: "42" }, { repository: "example/private", repositoryId: "43" }]);
  });

  it("withholds logs when repository authority is lost while the log read waits", async () => {
    const f = fixture();
    f.requireAdmin.mockResolvedValue(undefined);
    f.log.mockImplementation(async () => {
      f.authorizeSourceTargets.mockRejectedValue(new HttpError(403, "github_cloud_access_denied", "Unavailable"));
      return "source-derived-log-canary";
    });
    const response = await f.app.request(`${computerPath}/builds/${f.buildId}/log`);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("source-derived-log-canary");
    expect(f.log).toHaveBeenCalledTimes(1);
  });

  it("refuses an organization member without personal repository access before creating a VM", async () => {
    const f = fixture();
    f.authorizeBuildRepository.mockRejectedValue(new HttpError(403, "github_cloud_access_denied", "Unavailable"));
    expect((await f.create()).status).toBe(403);
    expect(f.createWorkspace).not.toHaveBeenCalled();
    const catalog = await f.app.request(`${computerPath}/repositories`);
    expect(await catalog.json()).toEqual({ repositories: [] });
  });
  it("lets members read installed repositories while keeping Computer administration restricted", async () => {
    const f = fixture();
    const response = await f.app.request(`${computerPath}/repositories`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ repositories: [{ repository: "example/project", defaultBranch: "master" }] });
    expect(f.requireMember).toHaveBeenCalledWith(org, member);
    expect(f.requireAdmin).not.toHaveBeenCalled();
    expect((await f.app.request(computerPath)).status).toBe(403);
  });

  it("reports no active successful build as null", async () => {
    const f = fixture(null);
    const response = await f.app.request(`${computerPath}/repositories`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ repositories: null });
  });

  it.each([null, [], [{ repository: "example/project", defaultBranch: "master" }]])(
    "rejects non-members before revealing repositories or build availability (%j)", async repositories => {
      const f = fixture(repositories);
      f.requireMember.mockRejectedValue(new HttpError(404, "not_found", "Organization not found"));
      expect((await f.app.request(`${computerPath}/repositories`)).status).toBe(404);
      expect((await f.create()).status).toBe(404);
      expect(f.installedRepositories).not.toHaveBeenCalled();
      expect(f.activeComputer).not.toHaveBeenCalled();
      expect(f.createWorkspace).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["master", undefined, "master"],
    ["release/stable", undefined, "release/stable"],
    ["master", "feature/topic", "feature/topic"],
    [null, "feature/topic", "feature/topic"],
  ] as const)("uses the installed default unless the user selects a branch (%s, %s)", async (defaultBranch, selected, expected) => {
    const f = fixture([{ repository: "Example/Project", defaultBranch }]);
    const response = await f.create(selected ? { baseBranch: selected } : {});
    expect(response.status).toBe(201);
    expect(f.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ baseBranch: expected, creatorUserId: member, repository: "Example/Project", computerBuildId: f.buildId }));
    expect(f.requireMember.mock.invocationCallOrder[0]).toBeLessThan(f.activeComputer.mock.invocationCallOrder[0]!);
    expect(f.installedRepositories).not.toHaveBeenCalled();
  });

  it("refuses an omitted base when the build recorded no usable branch", async () => {
    const f = fixture([{ repository: "example/project", defaultBranch: null }]);
    const response = await f.create();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "repository_branch_required" } });
    expect(f.createWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    [null, "cloud_computer_build_required"],
    [[], "repository_not_installed"],
  ] as const)("keeps availability errors for authorized members (%s)", async (repositories, code) => {
    const f = fixture(repositories as null | []);
    const response = await f.create();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code } });
    expect(f.requireMember).toHaveBeenCalledWith(org, member);
    expect(f.createWorkspace).not.toHaveBeenCalled();
  });
});

describe("cloud v2 connect wake intent", () => {
  const id = "33333333-3333-4333-8333-333333333333";
  const path = `/v1/cloud-v2/workspaces/${id}/connect`;
  function setup() {
    const store = {
      get: vi.fn(async () => ({ id, state: "stopped" })),
      transition: vi.fn(async () => null),
      issueToken: vi.fn(async () => ({ token: "synthetic-connect-ticket", expiresAt: new Date(60_000) })),
    };
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: member } as never); await next(); });
    app.onError((error, c) => error instanceof HttpError
      ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: { code: "internal" } }, 500));
    app.route("/", createCloudV2Routes({ store, bridgeBaseUrl: "wss://dev.example.test" } as unknown as CloudV2RouteDeps));
    return { app, store };
  }

  it.each([
    ["no body", undefined, true], ["omitted wake", {}, true],
    ["explicit open", { wake: true }, true], ["passive reconnect", { wake: false }, false],
  ] as const)("preserves the ticket's wake intent for %s", async (_name, input, wake) => {
    const { app, store } = setup();
    const response = await app.request(path, { method: "POST",
      ...(input === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(input) }) });
    expect(response.status).toBe(200);
    if (wake) expect(store.transition).toHaveBeenCalledWith(id, ["stopped"], "starting");
    else expect(store.transition).not.toHaveBeenCalled();
    expect(store.issueToken).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: id, kind: "connect", userId: member, wake }));
    expect(await response.json()).toMatchObject({
      url: `wss://dev.example.test/v2/cloud/workspaces/${id}/bridge`,
      protocols: ["zeros.cloud.v2", "ticket.synthetic-connect-ticket"],
    });
  });

  it.each(['{"wake":"false"}', 'null', '{', '{"wake":false,"other":true}'])("refuses invalid connect input without waking (%s)", async body => {
    const { app, store } = setup();
    const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(response.status).toBe(400);
    expect(store.transition).not.toHaveBeenCalled();
    expect(store.issueToken).not.toHaveBeenCalled();
  });
});

describe("cloud v2 archive routes", () => {
  const id = "33333333-3333-4333-8333-333333333333";
  const archivedAt = "2026-10-21T12:00:00.000Z";
  const path = `/v1/cloud-v2/workspaces/${id}`;
  const row: CloudV2Workspace = {
    id, organizationId: org, creatorUserId: member, name: "Project", repository: "example/project",
    branch: "zeros/project", baseBranch: "master", state: "stopped", archivedAt,
    boatSandboxId: "fixture-vm", computerBuildId: null, errorCode: null, activeAt: null,
    createdAt: archivedAt, updatedAt: archivedAt,
  };
  function setup() {
    const store = {
      get: vi.fn(async () => row), list: vi.fn(async () => [row]),
      requestLifecycle: vi.fn(async () => ({ workspace: row, moved: false })),
    };
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: member } as never); await next(); });
    app.onError((error, c) => error instanceof HttpError
      ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: { code: "internal" } }, 500));
    app.route("/", createCloudV2Routes({ store, bridgeBaseUrl: "wss://dev.example.test" } as unknown as CloudV2RouteDeps));
    return { app, store };
  }

  it.each([
    ["stopping", true, 202], ["stopping", false, 200], ["stopped", false, 200], ["failed", false, 200],
  ] as const)("returns the archive document for %s (moved %s)", async (state, moved, status) => {
    const { app, store } = setup();
    store.requestLifecycle.mockResolvedValue({ workspace: { ...row, state }, moved });
    const response = await app.request(`${path}/archive`, { method: "POST" });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ workspace: { id, state, archivedAt, version: 2, placement: "cloud" } });
    expect(store.requestLifecycle).toHaveBeenCalledWith(id, member, "archive");
  });

  it.each([404, 409] as const)("preserves creator refusals and state conflicts (%s)", async status => {
    const { app, store } = setup();
    store.requestLifecycle.mockRejectedValue(new HttpError(status, status === 404 ? "not_found" : "workspace_unavailable", "Unavailable"));
    const response = await app.request(`${path}/archive`, { method: "POST" });
    expect(response.status).toBe(status);
    expect(store.requestLifecycle).toHaveBeenCalledWith(id, member, "archive");
  });

  it("returns the restored document from start and includes archive metadata in list/get", async () => {
    const { app, store } = setup();
    expect(await (await app.request(path)).json()).toMatchObject({ workspace: { archivedAt } });
    expect(await (await app.request(`/v1/cloud-v2/workspaces?organizationId=${org}`)).json())
      .toMatchObject({ workspaces: [{ archivedAt }] });
    store.requestLifecycle.mockResolvedValue({ workspace: { ...row, state: "starting", archivedAt: null }, moved: true });
    const response = await app.request(`${path}/start`, { method: "POST" });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ workspace: { state: "starting", archivedAt: null } });
    expect(store.requestLifecycle).toHaveBeenCalledWith(id, member, "start");
  });

  it("rejects an invalid workspace identity before mutation", async () => {
    const { app, store } = setup();
    expect((await app.request("/v1/cloud-v2/workspaces/invalid/archive", { method: "POST" })).status).toBe(404);
    expect(store.requestLifecycle).not.toHaveBeenCalled();
  });
});
