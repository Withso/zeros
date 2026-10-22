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
  const requireAdmin = vi.fn(async () => { throw new HttpError(403, "forbidden", "Requires an owner or admin"); });
  const installedRepositories = vi.fn(async () => repositories);
  const createWorkspace = vi.fn(async (input: Record<string, unknown>) => ({ ...input, state: "creating" }));
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("user", { id: member } as never); await next(); });
  app.onError((error, c) => error instanceof HttpError
    ? c.json({ error: { code: error.code } }, error.status)
    : c.json({ error: { code: "internal" } }, 500));
  app.route("/", createCloudV2Routes({
    store: { createWorkspace }, computers: { requireMember, requireAdmin }, installedRepositories,
    bridgeBaseUrl: "wss://dev.example.test",
  } as unknown as CloudV2RouteDeps));
  const create = (body: Record<string, unknown> = {}) => app.request("/v1/cloud-v2/workspaces", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizationId: org, repository: "example/project", ...body }),
  });
  return { app, create, requireMember, requireAdmin, installedRepositories, createWorkspace };
}

describe("cloud v2 creation", () => {
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
    expect(f.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ baseBranch: expected, creatorUserId: member, repository: "Example/Project" }));
    expect(f.requireMember.mock.invocationCallOrder[0]).toBeLessThan(f.installedRepositories.mock.invocationCallOrder[0]!);
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
