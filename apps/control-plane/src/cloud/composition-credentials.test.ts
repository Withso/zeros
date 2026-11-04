import { generateKeyPairSync, randomUUID } from "node:crypto";
import type pg from "pg";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import type { CloudV2LifecycleDeps } from "./lifecycle.js";
import { CloudV2ComputerBuilder } from "./computer.js";
import { createCloudV2 } from "./composition.js";
import { createCloudV2WorkerRoutes } from "./worker-routes.js";
import { newCloudV2Token } from "./tokens.js";
import type { CloudV2Workspace } from "./store.js";

const github = vi.hoisted(() => ({
  workspaceToken: vi.fn(async () => ({ token: "synthetic-user-token", expiresAt: Date.now() + 120_000 })),
  token: vi.fn(async () => ({ token: "synthetic-installation-token", expiresAt: Date.now() + 120_000 })),
  authorizeSource: vi.fn(async () => {}), continueSource: vi.fn(async () => {}),
  connections: { authorizeRepositoryConfiguration: vi.fn() },
  source: { invalidate: vi.fn(), targets: vi.fn(async () => {}) },
  binding: vi.fn(async () => ({ repository: "owner/project" })),
}));
vi.mock("./github-composition.js", () => ({ createCloudGithubServices: () => github }));
vi.mock("../postgres-notifications.js", () => ({ postgresNotificationSubscription: () => null }));
vi.mock("./lifecycle.js", async original => ({ ...await original<typeof import("./lifecycle.js")>(),
  CloudV2Lifecycle: class { constructor(readonly deps: CloudV2LifecycleDeps) {} },
}));

it("wires workspace git, gh, legacy, hydration and restore credentials to the creator while Computer builds keep automation credentials", async () => {
  const config = {
    github: null, deploymentChannel: "alpha", cloudAgentCredentials: { settingsSecretKeyV1: Buffer.alloc(32, 1).toString("base64url") },
    cloudV2: { boat: { apiKey: "synthetic-boat-credential" }, apiUrl: "https://api.example.test", realtimeUrl: "https://rt.example.test",
      workerSigningKey: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      runtime: { sha256: "a".repeat(64), store: { endpoint: "https://store.example.test", bucket: "fixture", accessKeyId: "fixture", secretAccessKey: "fixture" } } },
  } as Config;
  const assembled = createCloudV2(config, { query: vi.fn() } as unknown as pg.Pool, { relay: false, lifecycle: true })!;
  const workspace = { id: randomUUID(), organizationId: randomUUID(), creatorUserId: randomUUID(), state: "running", repository: "owner/project", branch: "topic", baseBranch: "main", loginRevision: "0" } as CloudV2Workspace;
  const token = newCloudV2Token("worker").token, boot = randomUUID(), hash = "b".repeat(64);
  vi.spyOn(assembled.store, "workerSession").mockResolvedValue(workspace as Awaited<ReturnType<typeof assembled.store.workerSession>>);
  const app = new Hono().route("/", createCloudV2WorkerRoutes(assembled.workers));
  for (const purpose of [undefined, "git", "gh"] as const) {
    const response = await app.request("/v2/cloud/worker/github-token", { method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-zeros-worker-boot": boot, "content-type": "application/json" },
      body: JSON.stringify({ ...(purpose ? { purpose } : {}), failedTokenSha256: hash }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token: "synthetic-user-token" });
    expect(github.workspaceToken).toHaveBeenLastCalledWith(workspace, "user", purpose ?? "git", hash);
  }
  const { deps } = assembled.lifecycle as unknown as { deps: CloudV2LifecycleDeps };
  expect(await deps.githubToken!(workspace)).toMatchObject({ token: "synthetic-user-token" });
  const exec = vi.spyOn(assembled.compute, "execLong").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  await deps.prepareRepository!(workspace, "fixture-sandbox");
  const input = exec.mock.calls[0]![3]!;
  expect(input === `Authorization: Basic ${Buffer.from("x-access-token:synthetic-user-token").toString("base64")}\n`).toBe(true);
  const builder = deps.builds as CloudV2ComputerBuilder & { deps: ConstructorParameters<typeof CloudV2ComputerBuilder>[0] };
  const target = { repository: workspace.repository, repositoryId: "42" };
  expect(await (builder as unknown as { deps: ConstructorParameters<typeof CloudV2ComputerBuilder>[0] }).deps.cloneToken(workspace.organizationId, workspace.creatorUserId, target)).toBe("synthetic-installation-token");
  expect(github.token).toHaveBeenCalledExactlyOnceWith({ organizationId: workspace.organizationId, userId: workspace.creatorUserId }, target, "read", "computer", expect.any(Function));
});
