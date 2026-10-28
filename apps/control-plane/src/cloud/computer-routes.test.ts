import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { createCloudV2Routes, type CloudV2RouteDeps } from "./routes.js";

const org = "11111111-1111-4111-8111-111111111111";
const admin = "22222222-2222-4222-8222-222222222222";
const path = `/v1/cloud-v2/organizations/${org}/computer`;
const saved = { recipe: { repositories: [{ repository: "withso/zeros" }] }, recipeRevision: 3 };

function fixture(options: { admin?: boolean } = {}) {
  const computers = {
    requireMember: vi.fn(async () => {}),
    requireAdmin: vi.fn(async () => { if (options.admin === false) throw new HttpError(403, "forbidden", "Requires an owner or admin"); }),
    saveRecipe: vi.fn(async () => saved),
    discardRecipe: vi.fn(async () => saved),
    buildConfigured: vi.fn(async () => ({ id: "build-2" })),
    enqueue: vi.fn(async () => ({ id: "build-legacy" })),
  };
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("user", { id: admin } as never); await next(); });
  app.onError((error, c) => error instanceof HttpError
    ? c.json({ error: { code: error.code } }, error.status)
    : c.json({ error: { code: "internal" } }, 500));
  app.route("/", createCloudV2Routes({ store: {}, computers, installedRepositories: async () => null,
    bridgeBaseUrl: "wss://dev.example.test" } as unknown as CloudV2RouteDeps));
  const send = (route: string, method: string, body: unknown) => app.request(`${path}${route}`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { send, computers };
}

describe("cloud v2 Cloud Computer recipe routes", () => {
  it("saves the configured repositories at the revision the editor saw", async () => {
    const f = fixture();
    const repositories = [{ repository: "withso/zeros", setup: "pnpm install" }, { repository: "withso/zeros-dev-fixture", ref: "main" }];
    const response = await f.send("/recipe", "PUT", { repositories, revision: 2 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(saved);
    expect(f.computers.saveRecipe).toHaveBeenCalledWith(org, admin, repositories, 2);
  });

  it("accepts an empty configuration but never build outputs or duplicates", async () => {
    const f = fixture();
    expect((await f.send("/recipe", "PUT", { repositories: [], revision: 0 })).status).toBe(200);
    for (const repositories of [
      [{ repository: "withso/zeros", commit: "a".repeat(40) }],
      [{ repository: "withso/zeros" }, { repository: "Withso/Zeros" }],
      [{ repository: "withso/.." }],
    ]) expect((await f.send("/recipe", "PUT", { repositories, revision: 0 })).status).toBe(400);
    expect(f.computers.saveRecipe).toHaveBeenCalledTimes(1);
  });

  it("discards unbuilt changes and builds the configured repositories", async () => {
    const f = fixture();
    expect(await (await f.send("/recipe/discard", "POST", { revision: 3 })).json()).toEqual(saved);
    expect(f.computers.discardRecipe).toHaveBeenCalledWith(org, admin, 3);
    const build = await f.send("/builds", "POST", { revision: 4 });
    expect(build.status).toBe(202);
    expect(f.computers.buildConfigured).toHaveBeenCalledWith(org, admin, 4);
    expect(f.computers.enqueue).not.toHaveBeenCalled();
  });

  it("keeps older apps working: their repositories become the configured recipe", async () => {
    const f = fixture();
    const repositories = [{ repository: "withso/zeros" }];
    expect((await f.send("/builds", "POST", { repositories })).status).toBe(202);
    expect(f.computers.enqueue).toHaveBeenCalledWith(org, admin, { repositories }, { configure: true });
    expect((await f.send("/builds", "POST", { repositories, revision: 1 })).status).toBe(400);
  });

  it("lets only owners and admins change the Computer", async () => {
    const f = fixture({ admin: false });
    expect((await f.send("/recipe", "PUT", { repositories: [], revision: 0 })).status).toBe(403);
    expect((await f.send("/recipe/discard", "POST", { revision: 0 })).status).toBe(403);
    expect((await f.send("/builds", "POST", { revision: 0 })).status).toBe(403);
    expect(f.computers.saveRecipe).not.toHaveBeenCalled();
    expect(f.computers.discardRecipe).not.toHaveBeenCalled();
    expect(f.computers.buildConfigured).not.toHaveBeenCalled();
  });
});
