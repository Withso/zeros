import type pg from "pg";
import { expect, it, vi } from "vitest";
import { CloudV2SourceAuthority, hydrateCloudRepository, type CloudSourceTarget } from "./source-authority.js";
import { mkdtemp, mkdir, writeFile, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CloudV2Workspace } from "./store.js";
import { Hono } from "hono";
import { HttpError } from "../authz.js";
import { createCloudV2Routes, type CloudV2RouteDeps } from "./routes.js";

vi.mock("../db.js", () => ({ withSystemTx: async (pool: unknown, run: (tx: unknown) => unknown) => run(pool) }));

it("pins every retained source to its original ID and isolates leases from a reused name", async () => {
  const github = { fingerprintFor: vi.fn(async () => "epoch"), check: vi.fn(async () => "epoch") };
  const pool = { query: async () => ({ rows: [{ source_repositories: ["former/project", "other/dependency"] }] }) };
  let id = "42";
  const source = new CloudV2SourceAuthority(pool as unknown as pg.Pool, github, Date.now,
    async () => [{ repository: "former/project", repositoryId: id }, { repository: "other/dependency", repositoryId: "99" }]);
  const workspace = { id: "workspace", organizationId: "org", creatorUserId: "user", repository: "former/project" } as CloudV2Workspace;
  await source.workspace(workspace);
  expect(github.check).toHaveBeenCalledWith(expect.objectContaining({ owner: "former", repositoryIds: ["42"] }));
  expect(github.check).toHaveBeenCalledWith(expect.objectContaining({ owner: "other", repositoryIds: ["99"] }));
  id = "77";
  await source.workspace(workspace);
  expect(github.check).toHaveBeenCalledTimes(3);
});

it("refuses incomplete or substituted source identity mappings", async () => {
  const github = { fingerprintFor: vi.fn(), check: vi.fn() };
  const pool = { query: async () => ({ rows: [{ source_repositories: ["original/project", "other/dependency"] }] }) };
  const source = new CloudV2SourceAuthority(pool as unknown as pg.Pool, github, Date.now,
    async () => [{ repository: "replacement/project", repositoryId: "42" }]);
  await expect(source.workspace({ id: "workspace", organizationId: "org", creatorUserId: "user", repository: "original/project" } as CloudV2Workspace))
    .rejects.toMatchObject({ code: "cloud_source_review_required" });
  expect(github.check).not.toHaveBeenCalled();
});

it("never shares an authorization lease between a name-only request and either repository ID at that name", async () => {
  const github = { fingerprintFor: vi.fn(async () => "same-generation"), check: vi.fn(async (input: { repositoryIds?: readonly string[] }) => {
    if (input.repositoryIds?.[0] === "42") throw new HttpError(403, "github_cloud_access_denied", "Original source denied");
    return "same-generation";
  }) };
  const source = new CloudV2SourceAuthority({} as pg.Pool, github);
  await source.repository("org", "user", "former/project");
  await source.targets("org", "user", [{ repository: "former/project", repositoryId: "99" }]);
  await expect(source.targets("org", "user", [{ repository: "former/project", repositoryId: "42" }])).rejects.toMatchObject({ status: 403 });
  expect(github.check.mock.calls.map(([input]) => input.repositoryIds)).toEqual([undefined, ["99"], ["42"]]);
});

it.each(["", "0", "01", "9007199254740992", "-1", "1e2"])("rejects an invalid source ID %j before consulting authority", async repositoryId => {
  const github = { fingerprintFor: vi.fn(), check: vi.fn() };
  const source = new CloudV2SourceAuthority({} as pg.Pool, github);
  await expect(source.targets("org", "user", [{ repository: "example/project", repositoryId }])).rejects.toMatchObject({ code: "cloud_source_review_required" });
  expect(github.fingerprintFor).not.toHaveBeenCalled(); expect(github.check).not.toHaveBeenCalled();
});

it("forwards workspace ledger IDs without replacing the original source names", async () => {
  const pool = { query: async () => ({ rows: [{ source_repositories: ["former/project", "other/private"] }] }) };
  const github = { fingerprintFor: vi.fn(async () => "epoch"), check: vi.fn(async () => "epoch") };
  const targets = [{ repository: "former/project", repositoryId: "42" }, { repository: "other/private", repositoryId: "43" }];
  const resolver = vi.fn(async () => targets);
  const source = new CloudV2SourceAuthority(pool as unknown as pg.Pool, github, Date.now, resolver);
  const workspace = { id: "workspace", organizationId: "org", creatorUserId: "user", repository: "former/project" } as CloudV2Workspace;
  await source.workspace(workspace);
  expect(resolver).toHaveBeenCalledWith(workspace, ["former/project", "other/private"]);
  expect(github.check).toHaveBeenCalledWith(expect.objectContaining({ owner: "former", repositories: ["project"], repositoryIds: ["42"] }));
  resolver.mockResolvedValueOnce([{ repository: "current/project", repositoryId: "42" }, targets[1]!]);
  await expect(source.workspace(workspace)).rejects.toMatchObject({ code: "cloud_source_review_required" });
  resolver.mockResolvedValueOnce(targets.slice(0, 1));
  await expect(source.workspace(workspace)).rejects.toMatchObject({ code: "cloud_source_review_required" });
});

it("does not publish an interrupted clone over the workspace's final directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "zeros-hydration-"));
  try {
    const bin = join(root, "bin"); await mkdir(bin);
    // Model a clone process that leaves files behind before it fails.
    await writeFile(join(bin, "git"), '#!/bin/bash\nlast="${@: -1}"\nmkdir -p "$last"\necho partial > "$last/partial"\nexit 1\n', { mode: 0o700 });
    const command = hydrateCloudRepository({ repository: "example/project" } as CloudV2Workspace)
      .replaceAll("/home/user", root).replace("bash -lc", `env PATH=${bin}:/usr/bin:/bin bash -c`);
    const child = promisify(execFile)("bash", ["-c", command]);
    child.child.stdin?.end("Authorization: synthetic\n");
    await expect(child).rejects.toThrow();
    await expect(access(join(root, "example/project"))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("requires every legacy source, even when the selected checkout is allowed", async () => {
  const github = { fingerprintFor: vi.fn(async () => "epoch"), check: vi.fn(async (input: { repositories: readonly string[] }) => {
    if (input.repositories[0] === "private") throw new HttpError(403, "github_cloud_access_denied", "denied");
    return "epoch";
  }) };
  const pool = { query: async () => ({ rows: [{ source_repositories: ["example/selected", "example/private"] }] }) };
  const source = new CloudV2SourceAuthority(pool as unknown as pg.Pool, github);
  await expect(source.workspace({ id: "workspace", organizationId: "org", creatorUserId: "member", repository: "example/selected" } as CloudV2Workspace)).rejects.toThrow("denied");
  expect(github.check.mock.calls.map(([scope]) => scope.repositories[0])).toEqual(["selected", "private"]);
});

it("refuses a source scope when an earlier cached observation expires during a later repository check", async () => {
  let now = 0;
  const github = { fingerprintFor: vi.fn(async () => "epoch"), check: vi.fn(async (input: { owner?: string }) => {
    if (input.owner === "other") now += 20;
    return "epoch";
  }) };
  const pool = { query: async () => ({ rows: [{ source_repositories: ["example/selected", "other/additional"] }] }) };
  const source = new CloudV2SourceAuthority(pool as unknown as pg.Pool, github, () => now);
  await source.repository("org", "member", "example/selected");
  now = 29_990;
  const workspace = { id: "workspace", organizationId: "org", creatorUserId: "member", repository: "example/selected" } as CloudV2Workspace;
  await expect(source.workspace(workspace)).rejects.toMatchObject({ code: "github_verification_expired" });
  // A retry can refresh just the expired observation and use the fresh neighbor.
  await expect(source.workspace(workspace)).resolves.toBeUndefined();
  expect(github.check).toHaveBeenCalledTimes(3);
});

it("rechecks earlier repository identity after the whole legacy source scope has been observed", async () => {
  let selectedConnection = "original";
  const github = {
    fingerprintFor: vi.fn(async (input: { owner?: string }) => input.owner === "example" ? selectedConnection : "other"),
    check: vi.fn(async (input: { owner?: string }) => {
      if (input.owner === "other") { selectedConnection = "reconnected"; return "other"; }
      return selectedConnection;
    }),
  };
  const pool = { query: async () => ({ rows: [{ source_repositories: ["example/selected", "other/additional"] }] }) };
  const source = new CloudV2SourceAuthority(pool as unknown as pg.Pool, github);
  await expect(source.workspace({ id: "workspace", organizationId: "org", creatorUserId: "member", repository: "example/selected" } as CloudV2Workspace))
    .rejects.toMatchObject({ code: "github_authorization_changed" });
});

it("keeps the original observation deadline through the final durable identity reads", async () => {
  let now = 0, otherIdentityReads = 0;
  const github = {
    fingerprintFor: vi.fn(async (input: { owner?: string }) => {
      if (input.owner === "other" && ++otherIdentityReads === 2) now = 30_001;
      return "epoch";
    }),
    check: vi.fn(async () => "epoch"),
  };
  const pool = { query: async () => ({ rows: [{ source_repositories: ["example/selected", "other/additional"] }] }) };
  const source = new CloudV2SourceAuthority(pool as unknown as pg.Pool, github, () => now);
  await expect(source.workspace({ id: "workspace", organizationId: "org", creatorUserId: "member", repository: "example/selected" } as CloudV2Workspace))
    .rejects.toMatchObject({ code: "github_verification_expired" });
});

it("coalesces checks, expires positive observations, and never reuses them across reconnects", async () => {
  let now = 0, generation = "one";
  const github = { fingerprintFor: vi.fn(async () => generation), check: vi.fn(async () => generation) };
  const source = new CloudV2SourceAuthority({} as pg.Pool, github, () => now);
  await Promise.all(Array.from({ length: 30 }, () => source.repository("org", "user", "example/repo")));
  expect(github.check).toHaveBeenCalledTimes(1);
  now = 30_001;
  await source.repository("org", "user", "example/repo");
  expect(github.check).toHaveBeenCalledTimes(2);
  generation = "two";
  await source.repository("org", "user", "example/repo");
  expect(github.check).toHaveBeenCalledTimes(3);
  github.check.mockRejectedValue(new HttpError(403, "github_cloud_access_denied", "revoked")); now += 30_001;
  await expect(source.repository("org", "user", "example/repo")).rejects.toThrow("revoked");
  await expect(source.repository("org", "user", "example/repo")).rejects.toThrow("revoked");
});

it("fails closed for legacy disks whose provenance is unknown", async () => {
  const pool = { query: async () => ({ rows: [{ source_repositories: null }] }) };
  const github = { fingerprintFor: vi.fn(), check: vi.fn() };
  const source = new CloudV2SourceAuthority(pool as unknown as pg.Pool, github);
  await expect(source.workspace({ id: "workspace", organizationId: "org", creatorUserId: "member", repository: "example/repo" } as CloudV2Workspace))
    .rejects.toMatchObject({ code: "cloud_source_review_required" });
  expect(github.check).not.toHaveBeenCalled();
});

it.each(["expires", "reconnects"] as const)("does not disclose a build log when earlier repository authority %s during a later check", async change => {
  let now = 0, selectedGeneration = "original";
  const github = {
    fingerprintFor: vi.fn(async (input: { owner?: string }) => input.owner === "example" ? selectedGeneration : "other"),
    check: vi.fn(async (input: { owner?: string }) => {
      if (input.owner === "other") {
        if (change === "expires") now += 20;
        else selectedGeneration = "successor";
        return "other";
      }
      return selectedGeneration;
    }),
  };
  const source = new CloudV2SourceAuthority({} as pg.Pool, github, () => now);
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const userId = "22222222-2222-4222-8222-222222222222";
  const buildId = "44444444-4444-4444-8444-444444444444";
  const targets = [{ repository: "example/selected", repositoryId: "42" }, { repository: "other/additional", repositoryId: "43" }];
  await source.targets(organizationId, userId, targets.slice(0, 1));
  now = 29_990;
  const log = vi.fn(async () => "private-build-log-canary");
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("user", { id: userId } as never); await next(); });
  app.onError((error, c) => error instanceof HttpError
    ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: { code: "internal" } }, 500));
  app.route("/", createCloudV2Routes({
    computers: { requireAdmin: async () => {}, logRepositories: async () => targets, log },
    store: {}, bridgeBaseUrl: "wss://dev.example.test",
    authorizeRepository: (organization: string, user: string, repository: string) => source.repository(organization, user, repository),
    authorizeSourceTargets: (organization: string, user: string, targets: readonly CloudSourceTarget[]) => source.targets(organization, user, targets),
  } as unknown as CloudV2RouteDeps));
  const response = await app.request(`/v1/cloud-v2/organizations/${organizationId}/computer/builds/${buildId}/log`);
  expect(response.status).toBe(change === "expires" ? 503 : 409);
  expect(await response.text()).not.toContain("private-build-log-canary");
  expect(log).not.toHaveBeenCalled();
});
