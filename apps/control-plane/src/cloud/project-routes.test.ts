import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { createCloudV2Routes, type CloudV2RouteDeps } from "./routes.js";
import { createProjectRoutes, type ProjectRouteDeps } from "./project-routes.js";
import type { CloudProject, CloudProjectView } from "./projects.js";

const org = "11111111-1111-4111-8111-111111111111";
const alice = "22222222-2222-4222-8222-222222222222", bob = "33333333-3333-4333-8333-333333333333";
const here = path.dirname(fileURLToPath(import.meta.url));
const released = JSON.parse(readFileSync(path.join(here, "../client-contracts/released/desktop-0.1.30.json"), "utf8")) as
  { entries: { id: string; response: Record<string, unknown> }[] };
const releasedRepositories = z.fromJSONSchema(released.entries.find(entry => entry.id === "cloud-v2.computer.repositories")!.response as never);
const C1 = "66666666-6666-4666-8666-666666666666", C2 = "77777777-7777-4777-8777-777777777777";
const P1 = "88888888-8888-4888-8888-888888888881", P2 = "88888888-8888-4888-8888-888888888882", P3 = "88888888-8888-4888-8888-888888888883";
const project = (id: string, name: string, level: "organization" | "personal", owner: string | null, repositories: [string, string][],
  extra: Partial<CloudProjectView> = {}): CloudProjectView => ({
  id, organizationId: org, name, level, ownerUserId: owner, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", canEdit: false,
  repositories: repositories.map(([repository, repositoryId], position) => ({ repository, repositoryId, connectionId: null, defaultBranch: position ? null : "main",
    setup: null, setupScript: null, position })), ...extra,
});
const onError = (hono: Hono) => hono.onError((error, c) =>
  error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: { code: "internal" } }, 500));

describe("released desktops' Create and Cloud Computer, answered from one-repository projects", () => {
  // The organization's, alice's own, and a two-repository one that is never offered.
  const oneRepository = vi.fn(async (_o: string, user: string | null): Promise<CloudProject[]> => [
    project(P1, "zeros", "organization", null, [["withso/zeros", "42"]]),
    ...(user === alice ? [project(P2, "notes", "personal", alice, [["withso/notes", "9001"]])] : []),
  ]);
  function app(user: string, extra: Partial<CloudV2RouteDeps> = {}) {
    const hono = new Hono();
    hono.use("*", async (c, next) => { c.set("user", { id: user } as never); await next(); });
    onError(hono);
    const deps = {
      store: { activeComputer: async () => ({ buildId: "55555555-5555-4555-8555-555555555555", baseOnly: true, repositories: [] }) },
      computers: { requireMember: async () => {}, requireAdmin: async () => {}, saveRecipe: vi.fn(), buildConfigured: vi.fn(async () => ({ id: "b" })),
        overview: async () => ({ activeBuildId: "b", snapshotName: "s", builds: [], recipe: { repositories: [] }, recipeRevision: 4, installScript: null, readyCopies: true }),
        saveInstallScript: vi.fn(async () => ({ installScript: null, recipeRevision: 5 })) },
      projects: { oneRepositoryProjects: oneRepository, forRepository: vi.fn(), syncRecipe: vi.fn(async () => [{ projectId: P3, change: "project_created" }]) },
      readyCopies: { status: async () => new Map([[P1, "ready" as const]]), failures: async () => [], changed: vi.fn(async () => {}) },
      authorizeSourceTargets: vi.fn(async () => {}),
      resolveMemberRepository: vi.fn(async (_o: string, _u: string, repository: string) => ({ repository, repositoryId: "77", defaultBranch: "main" })),
      installedRepositories: async () => null, bridgeBaseUrl: "wss://dev.example.test", ...extra,
    };
    hono.route("/", createCloudV2Routes(deps as unknown as CloudV2RouteDeps));
    const send = (route: string, method = "GET", body?: unknown) => hono.request(`/v1/cloud-v2/organizations/${org}${route}`, {
      method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    return { deps, send };
  }

  it("lists the organization's one-repository projects and the caller's own, marked, and never another member's or a multi-repository one", async () => {
    expect(await (await app(alice).send("/computer/repositories")).json()).toEqual({ repositories: [
      { repository: "withso/zeros", defaultBranch: "main", level: "shared", projectId: P1, readyCopy: "ready" },
      { repository: "withso/notes", defaultBranch: "main", level: "private", projectId: P2, readyCopy: null },
    ] });
    expect(await (await app(bob).send("/computer/repositories")).json()).toEqual({ repositories: [
      { repository: "withso/zeros", defaultBranch: "main", level: "shared", projectId: P1, readyCopy: "ready" }] });
    for (const user of [alice, bob]) expect(releasedRepositories.safeParse(await (await app(user).send("/computer/repositories")).json()).success).toBe(true);
  });

  it("leaves out a project whose repository the caller can't read", async () => {
    const denied = vi.fn(async (_o: string, _u: string, targets: { repository: string }[]) => {
      if (targets[0]!.repository === "withso/zeros") throw new HttpError(403, "github_repository_access_required", "No");
    });
    expect((await (await app(alice, { authorizeSourceTargets: denied } as never).send("/computer/repositories")).json()).repositories
      .map((row: { repository: string }) => row.repository)).toEqual(["withso/notes"]);
  });

  it("shows the Cloud Computer's old recipe as the organization's one-repository projects, and saves a released recipe into them", async () => {
    const f = app(alice);
    expect((await (await f.send("/computer")).json()).recipe).toEqual({ repositories: [{ repository: "withso/zeros", ref: "main" }] });
    const saved = await f.send("/computer/recipe", "PUT", { repositories: [{ repository: "withso/zeros", ref: "main" }, { repository: "Withso/Web", setup: "make" }], revision: 4 });
    expect(saved.status).toBe(200);
    expect(f.deps.computers.saveRecipe).not.toHaveBeenCalled();
    // A kept project keeps its ID; a new repository's is read from GitHub as the caller.
    expect(f.deps.resolveMemberRepository).toHaveBeenCalledTimes(1);
    expect(f.deps.projects.syncRecipe).toHaveBeenCalledWith(org, alice, [{ repository: "withso/zeros", repositoryId: "42", ref: "main" },
      { repository: "withso/web", repositoryId: "77", setup: "make" }]);
    expect(f.deps.readyCopies.changed).toHaveBeenCalledWith(org, P3, "project_created");
    expect((await saved.json()).recipeRevision).toBe(5);
    expect((await f.send("/computer/recipe", "PUT", { repositories: [], revision: 3 })).status).toBe(409);
    // A build is the base only: tools, no repository.
    expect((await f.send("/computer/builds", "POST", { revision: 5 })).status).toBe(202);
  });
});

describe("a create from a one-repository project", () => {
  const ZEROS = project(P1, "zeros", "organization", null, [["withso/zeros", "42"]]);
  function create(user: string, found: CloudProjectView | null, extra: Record<string, unknown> = {}) {
    const createWorkspace = vi.fn(async (input: Record<string, unknown>) => ({ ...input, state: "creating", createdAt: "2026-11-21T00:00:00.000Z" }));
    const hono = new Hono();
    hono.use("*", async (c, next) => { c.set("user", { id: user } as never); await next(); });
    onError(hono);
    const deps = {
      store: { activeComputer: async () => ({ buildId: "55555555-5555-4555-8555-555555555555", baseOnly: true, repositories: [] }), createWorkspace },
      computers: { requireMember: async () => {}, requireAdmin: async () => {}, overview: async () => ({ activeBuildId: "b" }) },
      projects: { forRepository: vi.fn(async () => found), oneRepositoryProjects: vi.fn(), syncRecipe: vi.fn() },
      resolveMemberRepository: vi.fn(async (_o: string, _u: string, repository: string) => ({ repository, repositoryId: "42", defaultBranch: "trunk" })),
      remoteHead: vi.fn(async () => "c".repeat(40)),
      installedRepositories: async () => null, bridgeBaseUrl: "wss://dev.example.test", ...extra,
    };
    hono.route("/", createCloudV2Routes(deps as unknown as CloudV2RouteDeps));
    const send = async (body: unknown) => {
      const response = await hono.request("/v1/cloud-v2/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    return { deps, createWorkspace, send };
  }

  it("creates the workspace from the project, checked as the caller's own GitHub, on the project's branch", async () => {
    const f = create(alice, ZEROS);
    expect((await f.send({ organizationId: org, repository: "Withso/Zeros" })).status).toBe(201);
    expect(f.deps.projects.forRepository).toHaveBeenCalledWith(org, alice, "Withso/Zeros");
    expect(f.deps.resolveMemberRepository).toHaveBeenCalledWith(org, alice, "withso/zeros");
    expect(f.deps.remoteHead).toHaveBeenCalledWith(org, alice, { repository: "withso/zeros", repositoryId: "42" }, "main");
    expect(f.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ repository: "withso/zeros", baseBranch: "main", projectId: P1,
      sourceRepositoryId: "42", creatorUserId: alice }));
  });

  it("refuses a repository in no project, a renamed identity and a missing branch", async () => {
    expect((await create(alice, null).send({ organizationId: org, repository: "withso/zeros" })).body.error.code).toBe("repository_not_in_project");
    const moved = create(alice, ZEROS, { resolveMemberRepository: async () => ({ repository: "withso/zeros", repositoryId: "99", defaultBranch: "main" }) });
    expect((await moved.send({ organizationId: org, repository: "withso/zeros" })).body.error.code).toBe("cloud_source_review_required");
    const gone = create(alice, ZEROS, { remoteHead: async () => null });
    expect((await gone.send({ organizationId: org, repository: "withso/zeros", baseBranch: "gone" })).body.error.code).toBe("repository_branch_not_found");
    for (const f of [moved, gone]) expect(f.createWorkspace).not.toHaveBeenCalled();
  });

  it("asks for a Cloud Computer build while the live one still holds repositories", async () => {
    const f = create(alice, ZEROS, { store: { activeComputer: async () => ({ buildId: "b", repositories: [{ repository: "withso/zeros", defaultBranch: "main" }] }),
      createWorkspace: vi.fn() } });
    expect((await f.send({ organizationId: org, repository: "withso/zeros" })).body.error.code).toBe("cloud_computer_rebuild_required");
  });
});

describe("GitHub connections and projects", () => {
  const view = (user: string) => [
    project(P1, "zeros", "organization", null, [["withso/zeros", "42"], ["withso/web", "43"]], { canEdit: user === alice }),
    ...(user === bob ? [project(P2, "notes", "personal", bob, [["withso/notes", "9001"]], { canEdit: true })] : []),
  ];
  function routes(user: string, roles: Record<string, string> = { [alice]: "admin", [bob]: "member" }) {
    const known = (caller: string) => { if (!roles[caller]) throw new HttpError(404, "not_found", "Organization not found"); };
    const history = [{ generation: 3, state: "failed", stale: false, stoppedAt: null, startedAt: new Date("2026-11-20T10:00:00Z"),
      finishedAt: new Date("2026-11-20T10:05:00Z"), result: null, trigger: "manual", triggeredBy: alice, failureReason: "ready_copy_setup_failed",
      failureRepository: "withso/web", failureStep: "setup", failureDetail: null, setupOutput: "npm ERR!" },
      { generation: 2, state: "ready", stale: false, stoppedAt: new Date(Date.now() - 2 * 86_400_000), startedAt: null, finishedAt: null,
        result: [{ repository: "withso/zeros", repositoryId: "42", branch: "main", commit: "c".repeat(40) }], trigger: "weekly_update", triggeredBy: null,
        failureReason: null, failureRepository: null, failureStep: null, failureDetail: null, setupOutput: null }];
    const deps = {
      levels: {
        connections: vi.fn(async (_o: string, caller: string) => { known(caller); return [
          { id: C1, installationId: 501, accountLogin: "withso", level: "organization", state: "active", mine: false },
          { id: C2, installationId: 700, accountLogin: "alice-gh", level: "personal", state: "active", mine: true }]; }),
        connect: vi.fn(async (_o: string, _u: string, input: { installationId: number; accountLogin: string; level: string }) =>
          ({ id: "c3", ...input, state: "active", mine: input.level === "personal" })),
        installationState: vi.fn(async () => 1), solo: vi.fn(async () => false),
        access: vi.fn(async (_o: string, caller: string) => { known(caller); return { admin: roles[caller] === "admin", personalAllowed: true }; }),
        people: vi.fn(async () => new Map([[alice, "Alice"]])),
      },
      projects: {
        list: vi.fn(async (_o: string, caller: string) => { known(caller); return view(caller); }),
        get: vi.fn(async (_o: string, caller: string, id: string) => {
          known(caller);
          const found = view(caller).find(row => row.id === id);
          if (!found) throw new HttpError(404, "not_found", "Project not found");
          return found;
        }),
        usedBy: vi.fn(async () => new Map([["42", [{ id: P1, name: "zeros" }]]])),
        create: vi.fn(async (_o: string, _u: string, input: { name: string; level: "organization" | "personal"; repositories: { repository: string; repositoryId: string }[] }) =>
          project(P3, input.name, input.level, input.level === "personal" ? bob : null, input.repositories.map(entry => [entry.repository, entry.repositoryId]), { canEdit: true })),
        update: vi.fn(async (_o: string, caller: string, id: string) => ({ project: view(caller).find(row => row.id === id)!, change: "repositories_changed" })),
      },
      visibleInstallation: vi.fn(async () => ({ accountLogin: "withso", suspended: true })),
      installationRepositories: vi.fn(async () => ({ repositories: [{ id: "42", repository: "withso/zeros", defaultBranch: "main", private: true },
        { id: "43", repository: "withso/web", defaultBranch: "main", private: false }], nextPage: null })),
      resolveMemberRepository: vi.fn(async (_o: string, _u: string, repository: string) => ({ repository: repository.toLowerCase(), repositoryId: "44" })),
      readyCopies: {
        copies: { history: vi.fn(async () => history), retryState: vi.fn(async () => ({ failures: 1, nextAt: new Date("2026-11-21T11:05:00Z"), allowed: false })),
          inputs: vi.fn(async () => "a".repeat(64)), status: vi.fn(async () => new Map()) },
        secrets: { names: vi.fn(async () => ["NPM_TOKEN"]), save: vi.fn(async () => ["NPM_TOKEN"]), update: vi.fn(async () => []) },
        changed: vi.fn(async () => {}), buildNow: vi.fn(async () => ({})), retryNow: vi.fn(async () => ({})),
      },
    };
    const hono = new Hono();
    hono.use("*", async (c, next) => { c.set("user", { id: user } as never); await next(); });
    onError(hono);
    hono.route("/", createProjectRoutes(deps as unknown as ProjectRouteDeps));
    const send = (route: string, method = "GET", body?: unknown) => hono.request(`/v1/cloud-v2/organizations/${org}${route}`, {
      method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    return { deps, send };
  }

  it("splits connections into the organization's and the caller's own, and shows which projects use each repository, with no add step", async () => {
    const f = routes(alice);
    expect(await (await f.send("/github/connections")).json()).toEqual({
      organization: [expect.objectContaining({ id: C1 })], personal: [expect.objectContaining({ id: C2, mine: true })], solo: false });
    const drawer = await (await f.send(`/github/connections/${C1}/repositories`)).json();
    expect(drawer.repositories.map((row: { repository: string; projects: unknown[] }) => [row.repository, row.projects]))
      .toEqual([["withso/zeros", [{ id: P1, name: "zeros" }]], ["withso/web", []]]);
    expect(f.deps.projects.usedBy).toHaveBeenCalledWith(org, alice, ["42", "43"]);
    for (const [route, method] of [["/cloud-repositories", "POST"], ["/cloud-repositories", "GET"], ["/cloud-repositories/ready-copy?repository=withso/zeros", "GET"]] as const)
      expect((await f.send(route, method, method === "POST" ? { repository: "withso/web", level: "shared" } : undefined)).status).toBe(404);
  });

  it("records an installation only after the caller's own GitHub sees it, with GitHub's account and state", async () => {
    const f = routes(alice);
    const response = await f.send("/github/connections", "POST", { installationId: 501, level: "organization" });
    expect(response.status).toBe(201);
    expect(f.deps.visibleInstallation).toHaveBeenCalledWith(org, alice, 501);
    expect(f.deps.levels.connect).toHaveBeenCalledWith(org, alice, { installationId: 501, accountLogin: "withso", level: "organization" });
    expect((await response.json()).connection.state).toBe("suspended");
  });

  it("creates a project with each repository's identity read from GitHub as the caller, never from the request, then builds its copy", async () => {
    const f = routes(bob);
    const created = await f.send("/cloud-projects", "POST", { name: "Mine", level: "personal",
      repositories: [{ repository: "Withso/Notes", defaultBranch: "main", setup: "make" }, { repository: "withso/docs" }] });
    expect(created.status).toBe(201);
    expect(f.deps.projects.create).toHaveBeenCalledWith(org, bob, { name: "Mine", level: "personal", repositories: [
      { repository: "Withso/Notes", defaultBranch: "main", setup: "make", repositoryId: "44" }, { repository: "withso/docs", repositoryId: "44" }] });
    expect(f.deps.readyCopies.changed).toHaveBeenCalledWith(org, P3, "project_created");
    expect((await f.send("/cloud-projects", "POST", { name: "Mine", level: "personal", repositories: [{ repository: "withso/notes", repositoryId: "1" }] })).status).toBe(400);
    expect((await f.send("/cloud-projects", "POST", { name: "Many", level: "personal",
      repositories: Array.from({ length: 11 }, (_, index) => ({ repository: `withso/r${index}` })) })).status).toBe(400);
    expect(await (await f.send("/cloud-projects")).json()).toMatchObject({ personalAllowed: true, canCreateOrganization: false, limits: { personal: 20, repositories: 10 } });
  });

  it("keeps a project's repository IDs on edit, reads new ones, and lets only its editors save", async () => {
    const f = routes(alice);
    expect((await f.send(`/cloud-projects/${P1}`, "PATCH", { repositories: [{ repository: "withso/zeros" }, { repository: "withso/new" }] })).status).toBe(200);
    expect(f.deps.resolveMemberRepository).toHaveBeenCalledTimes(1);
    expect(f.deps.projects.update).toHaveBeenCalledWith(org, alice, P1, { repositories: [{ repository: "withso/zeros", repositoryId: "42" },
      { repository: "withso/new", repositoryId: "44" }] });
    expect(f.deps.readyCopies.changed).toHaveBeenCalledWith(org, P1, "repositories_changed");
    expect((await routes(bob).send(`/cloud-projects/${P1}`, "PATCH", { name: "Ours" })).status).toBe(403);
  });

  it("shows editors the cause, the repository and step, the history and its output, and lets them build; members see the status line only", async () => {
    const admin = routes(alice);
    const body = await (await admin.send(`/cloud-projects/${P1}/ready-copy`)).json();
    expect(body.status).toMatchObject({ state: "update_failed", failure: { reason: "ready_copy_setup_failed", repository: "withso/web", step: "setup",
      failures: 1, nextRetryAt: "2026-11-21T11:05:00.000Z" } });
    expect(body.history[0]).toMatchObject({ generation: 3, trigger: "manual", startedBy: "Alice", output: true,
      failure: { reason: "ready_copy_setup_failed", repository: "withso/web", step: "setup", detail: null } });
    expect(body.history[1].repositories).toEqual([{ repository: "withso/zeros", repositoryId: "42", branch: "main", commit: "c".repeat(40) }]);
    expect((await admin.send(`/cloud-projects/${P1}/ready-copy/output?generation=3`)).status).toBe(200);
    expect((await admin.send(`/cloud-projects/${P1}/ready-copy/build`, "POST")).status).toBe(202);
    expect(admin.deps.readyCopies.buildNow).toHaveBeenCalledWith(org, P1, alice);
    expect(await (await admin.send(`/cloud-projects/${P1}/build-secrets`)).json()).toEqual({ names: ["NPM_TOKEN"] });

    const member = routes(bob);
    const line = await (await member.send(`/cloud-projects/${P1}/ready-copy`)).json();
    expect(line).toEqual({ status: { state: "ready", updatedAt: expect.any(String), nextUpdateAt: expect.any(String) } });
    expect(JSON.stringify(line)).not.toMatch(/setup|web|failure/);
    expect((await member.send(`/cloud-projects/${P1}/ready-copy/output?generation=3`)).status).toBe(404);
    for (const route of ["/ready-copy/build", "/ready-copy/retry"]) expect((await member.send(`/cloud-projects/${P1}${route}`, "POST")).status).toBe(403);
    expect((await member.send(`/cloud-projects/${P1}/build-secrets`)).status).toBe(403);
    expect((await member.send(`/cloud-projects/${P1}/build-secrets`, "PUT", { secrets: { NPM_TOKEN: "x" } })).status).toBe(403);
  });

  it("shows a personal project and its copy to its member only, and nothing to admins or a departed member", async () => {
    const mine = routes(bob);
    expect(await (await mine.send(`/cloud-projects/${P2}/ready-copy`)).json()).toHaveProperty("history");
    expect((await mine.send(`/cloud-projects/${P2}/ready-copy/build`, "POST")).status).toBe(202);
    expect((await mine.send(`/cloud-projects/${P2}/build-secrets`, "PUT", { secrets: { NPM_TOKEN: "x" } })).status).toBe(200);
    expect(mine.deps.readyCopies.changed).toHaveBeenCalledWith(org, P2, "secrets_changed");
    for (const f of [routes(alice), routes(bob, { [alice]: "admin" })])
      for (const [route, method] of [["", "GET"], ["/ready-copy", "GET"], ["/ready-copy/output?generation=3", "GET"], ["/ready-copy/build", "POST"],
        ["/build-secrets", "GET"]] as const)
        expect((await f.send(`/cloud-projects/${P2}${route}`, method)).status).toBe(404);
  });
});
