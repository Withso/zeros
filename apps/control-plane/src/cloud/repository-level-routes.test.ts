import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { createCloudV2Routes, type CloudV2RouteDeps } from "./routes.js";
import { createRepositoryLevelRoutes, type RepositoryLevelRouteDeps } from "./repository-level-routes.js";
import type { CloudRepositoryEntry } from "./repository-levels.js";

const org = "11111111-1111-4111-8111-111111111111";
const alice = "22222222-2222-4222-8222-222222222222", bob = "33333333-3333-4333-8333-333333333333";
const here = path.dirname(fileURLToPath(import.meta.url));
const released = JSON.parse(readFileSync(path.join(here, "../client-contracts/released/desktop-0.1.30.json"), "utf8")) as
  { entries: { id: string; response: Record<string, unknown> }[] };
const releasedRepositories = z.fromJSONSchema(released.entries.find(entry => entry.id === "cloud-v2.computer.repositories")!.response as never);
const C1 = "66666666-6666-4666-8666-666666666666", C2 = "77777777-7777-4777-8777-777777777777";
const own = (repository: string, id: string): CloudRepositoryEntry =>
  ({ id: "44444444-4444-4444-8444-444444444444", repository, repositoryId: id, level: "private", connectionId: null, createdAt: "2026-11-01T00:00:00.000Z" });

function app(deps: Partial<CloudV2RouteDeps>, user: string) {
  const hono = new Hono();
  hono.use("*", async (c, next) => { c.set("user", { id: user } as never); await next(); });
  hono.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: { code: "internal" } }, 500));
  hono.route("/", createCloudV2Routes({ store: { activeComputer: async () => ({ buildId: "55555555-5555-4555-8555-555555555555", baseOnly: true,
    repositories: [{ repository: "withso/zeros", defaultBranch: "main" }] }) }, computers: { requireMember: async () => {} },
    authorizeBuildRepository: async (_o: string, _u: string, _b: string, repository: string) => ({ repository, repositoryId: "42" }),
    installedRepositories: async () => null, bridgeBaseUrl: "wss://dev.example.test", ...deps } as unknown as CloudV2RouteDeps));
  return hono;
}

describe("Create's cloud repositories at two levels", () => {
  const levels = {
    levelFor: vi.fn(),
    repositories: vi.fn(async (_org: string, user: string) => ({ shared: [], personalAllowed: true,
      private: user === alice ? [own("withso/notes", "9001")] : [] })),
  };
  const get = async (user: string) => (await app({ repositoryLevels: levels }, user).request(`/v1/cloud-v2/organizations/${org}/computer/repositories`)).json();

  it("lists the organization's repositories and the caller's own, marked, and never another member's", async () => {
    expect(await get(alice)).toEqual({ repositories: [
      { repository: "withso/zeros", defaultBranch: "main", level: "shared" },
      { repository: "withso/notes", defaultBranch: null, level: "private" },
    ] });
    expect(await get(bob)).toEqual({ repositories: [{ repository: "withso/zeros", defaultBranch: "main", level: "shared" }] });
  });

  it("answers a released desktop in the shape it parses", async () => {
    for (const user of [alice, bob]) expect(releasedRepositories.safeParse(await get(user)).success).toBe(true);
  });

  it("drops the caller's private repositories while the organization forbids them", async () => {
    levels.repositories.mockResolvedValueOnce({ shared: [], personalAllowed: false, private: [own("withso/notes", "9001")] });
    expect(await get(alice)).toEqual({ repositories: [{ repository: "withso/zeros", defaultBranch: "main", level: "shared" }] });
  });
});

describe("GitHub level routes", () => {
  function routes(user: string) {
    const deps = {
      levels: {
        connections: vi.fn(async () => [
          { id: C1, installationId: 501, accountLogin: "withso", level: "organization", state: "active", mine: false },
          { id: C2, installationId: 700, accountLogin: "alice-gh", level: "personal", state: "active", mine: true }]),
        connect: vi.fn(async (_o: string, _u: string, input: { installationId: number; accountLogin: string; level: string }) =>
          ({ id: "c3", ...input, state: "active", mine: input.level === "personal" })),
        installationState: vi.fn(async () => 1),
        solo: vi.fn(async () => false),
        add: vi.fn(async (_o: string, _u: string, input: { repository: string; repositoryId: string; level: string }) =>
          ({ id: "r1", ...input, connectionId: null, createdAt: "2026-11-01T00:00:00.000Z" })),
        repositories: vi.fn(async () => ({ shared: [{ repositoryId: "42" }], private: [], personalAllowed: true })),
      },
      visibleInstallation: vi.fn(async () => ({ accountLogin: "withso", suspended: true })),
      installationRepositories: vi.fn(async () => ({ repositories: [{ id: "42", repository: "withso/zeros", defaultBranch: "main", private: true },
        { id: "43", repository: "withso/web", defaultBranch: "main", private: false }], nextPage: null })),
      resolveMemberRepository: vi.fn(async (_o: string, _u: string, repository: string) => ({ repository: repository.toLowerCase(), repositoryId: "43" })),
      onShared: vi.fn(async () => {}), onPrivate: vi.fn(async () => {}),
    };
    const hono = new Hono();
    hono.use("*", async (c, next) => { c.set("user", { id: user } as never); await next(); });
    hono.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: { code: "internal" } }, 500));
    hono.route("/", createRepositoryLevelRoutes(deps as unknown as RepositoryLevelRouteDeps));
    const send = (route: string, method = "GET", body?: unknown) => hono.request(`/v1/cloud-v2/organizations/${org}${route}`, {
      method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    return { deps, send };
  }

  it("splits connections into the organization's and the caller's own, and marks what the drawer already holds", async () => {
    const f = routes(alice);
    expect(await (await f.send("/github/connections")).json()).toEqual({
      organization: [expect.objectContaining({ id: C1 })], personal: [expect.objectContaining({ id: C2, mine: true })], solo: false });
    const drawer = await (await f.send(`/github/connections/${C1}/repositories`)).json();
    expect(drawer.repositories.map((row: { repository: string; added: string | null }) => [row.repository, row.added]))
      .toEqual([["withso/zeros", "shared"], ["withso/web", null]]);
    expect(f.deps.installationRepositories).toHaveBeenCalledWith(org, alice, 501, 1);
  });

  it("records an installation only after the caller's own GitHub sees it, with GitHub's account and state", async () => {
    const f = routes(alice);
    const response = await f.send("/github/connections", "POST", { installationId: 501, level: "organization" });
    expect(response.status).toBe(201);
    expect(f.deps.visibleInstallation).toHaveBeenCalledWith(org, alice, 501);
    expect(f.deps.levels.connect).toHaveBeenCalledWith(org, alice, { installationId: 501, accountLogin: "withso", level: "organization" });
    expect((await response.json()).connection.state).toBe("suspended");
  });

  it("adds a repository with the identity the caller's GitHub resolved, then makes its copy at its level", async () => {
    const f = routes(alice);
    expect((await f.send("/cloud-repositories", "POST", { repository: "Withso/Web", level: "private" })).status).toBe(201);
    expect(f.deps.levels.add).toHaveBeenCalledWith(org, alice, { repository: "withso/web", repositoryId: "43", level: "private", connectionId: null });
    expect(f.deps.onPrivate).toHaveBeenCalledWith(org, alice, "withso/web");
    await f.send("/cloud-repositories", "POST", { repository: "withso/web", level: "shared" });
    expect(f.deps.onShared).toHaveBeenCalledWith(org, alice, "withso/web");
    expect((await f.send("/cloud-repositories", "POST", { repository: "withso/web", level: "everyone" })).status).toBe(400);
  });
});

describe("a repository's ready copy on its project page", () => {
  const at = (iso: string) => new Date(iso);
  const generation = (n: number, state: string, extra: Record<string, unknown> = {}) => ({ generation: n, state, stale: false, stoppedAt: null,
    startedAt: at("2026-11-20T10:00:00Z"), finishedAt: at("2026-11-20T10:05:00Z"), commit: "c".repeat(40), branch: "main", trigger: "weekly_update",
    triggeredBy: null, failureReason: null, failureDetail: null, setupOutput: null, ...extra });
  const shared = [generation(3, "failed", { failureReason: "ready_copy_secret_left", failureDetail: "/home/user/withso/zeros/.npmrc", setupOutput: "npm ERR!",
    trigger: "manual", triggeredBy: alice }), generation(2, "ready", { stoppedAt: new Date(Date.now() - 2 * 86_400_000) })];
  function routes(user: string, roles: Record<string, string>, privateOwner: string | null) {
    const deps = {
      levels: {
        memberRole: vi.fn(async (_o: string, caller: string) => { if (!roles[caller]) throw new HttpError(404, "not_found", "Organization not found"); return roles[caller]!; }),
        levelFor: vi.fn(async (_o: string, caller: string, repository: string) => repository === "withso/notes"
          ? caller === privateOwner ? { level: "private", entry: own("withso/notes", "9001"), allowed: true } : null
          : { level: "shared", entry: { ...own("withso/zeros", "42"), level: "shared" } }),
        people: vi.fn(async () => new Map([[alice, "Alice"]])),
      },
      readyCopies: {
        copies: { history: vi.fn(async () => shared), retryState: vi.fn(async () => ({ failures: 1, nextAt: new Date("2026-11-21T11:05:00Z"), allowed: false })),
          inputs: vi.fn(async () => "a".repeat(64)), base: vi.fn(async () => ({ repositories: [{ repository: "withso/zeros" }] })) },
        buildNow: vi.fn(async () => ({})),
      },
    };
    const hono = new Hono();
    hono.use("*", async (c, next) => { c.set("user", { id: user } as never); await next(); });
    hono.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: { code: "internal" } }, 500));
    hono.route("/", createRepositoryLevelRoutes(deps as unknown as RepositoryLevelRouteDeps));
    const base = `/v1/cloud-v2/organizations/${org}/cloud-repositories/ready-copy`;
    return {
      deps,
      status: async (repository: string) => { const response = await hono.request(`${base}?repository=${repository}`); return { code: response.status, body: await response.json() }; },
      output: async (repository: string) => (await hono.request(`${base}/output?repository=${repository}&generation=3`)).status,
      build: async (repository: string) => (await hono.request(`${base}/build`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ repository }) })).status,
    };
  }
  const roles = { [alice]: "admin", [bob]: "member" };

  it("shows owners and admins the cause, where, the next retry, the history and its output, and lets them build", async () => {
    const f = routes(alice, roles, null);
    const { code, body } = await f.status("withso/zeros");
    expect(code).toBe(200);
    expect(body.status).toMatchObject({ state: "update_failed", failure: { reason: "ready_copy_secret_left", detail: "/home/user/withso/zeros/.npmrc",
      failures: 1, nextRetryAt: "2026-11-21T11:05:00.000Z" } });
    expect(body.history[0]).toMatchObject({ generation: 3, trigger: "manual", startedBy: "Alice", output: true });
    expect(body.canBuild).toBe(true);
    expect(await f.output("withso/zeros")).toBe(200);
    expect(await f.build("withso/zeros")).toBe(202);
    expect(f.deps.readyCopies.buildNow).toHaveBeenCalledWith(org, "withso/zeros", null, alice);
  });

  it("shows members the status line only: no cause, no history, no output, no Build now", async () => {
    const f = routes(bob, roles, null);
    const { body } = await f.status("withso/zeros");
    expect(body).toEqual({ status: { state: "ready", updatedAt: expect.any(String), nextUpdateAt: expect.any(String) } });
    expect(JSON.stringify(body)).not.toMatch(/secret|npmrc|failure/);
    expect(await f.output("withso/zeros")).toBe(404);
    expect(await f.build("withso/zeros")).toBe(403);
  });

  it("shows a private repository's copy to its member only, and nothing to admins, others or a departed member", async () => {
    const mine = routes(bob, roles, bob);
    expect((await mine.status("withso/notes")).body).toHaveProperty("history");
    expect(await mine.build("withso/notes")).toBe(202);
    expect(mine.deps.readyCopies.buildNow).toHaveBeenCalledWith(org, "withso/notes", bob, bob);
    for (const [caller, everyone] of [[alice, roles], [bob, { [alice]: "admin" }]] as const) {
      const f = routes(caller, everyone, caller === bob ? bob : "someone-else");
      if (caller === bob) {
        // The member has left: nothing at all, including their own.
        expect((await f.status("withso/notes")).code).toBe(404);
      } else {
        expect((await f.status("withso/notes")).code).toBe(404);
        expect(await f.output("withso/notes")).toBe(404);
        expect(await f.build("withso/notes")).toBe(404);
      }
    }
  });
});
