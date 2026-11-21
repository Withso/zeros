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
