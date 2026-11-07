import type pg from "pg";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { createCloudV2Routes, type CloudV2RouteDeps } from "./routes.js";
import { CloudV2SourceAuthority } from "./source-authority.js";

vi.mock("../db.js", () => ({ withSystemTx: async (pool: unknown, run: (tx: unknown) => unknown) => run(pool) }));
const org = "11111111-1111-4111-8111-111111111111", member = "22222222-2222-4222-8222-222222222222";

// The real authority verifies one repository at a time per creator, and a
// denial invalidates the checks queued behind it. Checking a Computer's
// repositories together made one unreadable repository fail a readable one.
it("creates a workspace for a readable repository when another Computer repository is unreadable", async () => {
  const ids: Record<string, string> = { "example/docs": "43", "example/project": "42" };
  const source = new CloudV2SourceAuthority({} as pg.Pool, { fingerprintFor: vi.fn(async () => "epoch"),
    check: vi.fn(async (input: { repositoryIds?: readonly string[] }) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      if (input.repositoryIds?.[0] === "43") throw new HttpError(404, "github_repository_not_found", "Repository not found");
      return "epoch";
    }) });
  // As composition.ts does: resolve the build's ID binding, then verify that target.
  const authorizeBuildRepository = async (organizationId: string, userId: string, _build: string, repository: string) => {
    const target = { repository, repositoryId: ids[repository]! };
    await source.targets(organizationId, userId, [target]);
    return target;
  };
  const createWorkspace = vi.fn(async (input: Record<string, unknown>) => ({ ...input, state: "creating" }));
  const repositories = [{ repository: "example/docs", defaultBranch: "main" }, { repository: "example/project", defaultBranch: "master" }];
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("user", { id: member } as never); await next(); });
  app.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: { code: "internal" } }, 500));
  app.route("/", createCloudV2Routes({
    store: { activeComputer: async () => ({ buildId: "44444444-4444-4444-8444-444444444444", repositories }), readCreateReceipt: async () => null,
      createWorkspace, get: async (id: string) => ({ id }) },
    computers: { requireMember: async () => {} }, authorizeBuildRepository, authorizeSource: async () => {},
    remoteHead: async () => "a".repeat(40), bridgeBaseUrl: "wss://dev.example.test",
  } as unknown as CloudV2RouteDeps));
  const response = await app.request("/v1/cloud-v2/workspaces", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizationId: org, repository: "example/project" }) });
  expect(response.status).toBe(201);
  expect(createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ sourceRepositoryId: "42", readableRepositoryIds: ["42"] }));
});
