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
import type { CloudV2RelayDeps } from "./relay.js";

const github = vi.hoisted(() => ({
  workspaceToken: vi.fn(async () => ({ token: "synthetic-user-token", expiresAt: Date.now() + 120_000 })),
  token: vi.fn(async () => ({ token: "synthetic-installation-token", expiresAt: Date.now() + 120_000 })),
  authorizeSource: vi.fn(async () => {}), continueSource: vi.fn(async () => {}),
  connections: { authorizeRepositoryConfiguration: vi.fn(), gitIdentity: vi.fn<() => Promise<{ name: string; email: string } | null>>(async () => null) },
  workspaceSetup: vi.fn(async () => null),
  source: { invalidate: vi.fn(), targets: vi.fn(async () => {}) },
  binding: vi.fn(async () => ({ repository: "owner/project" })),
  workerIdentity: vi.fn(),
}));
vi.mock("./github-composition.js", () => ({ createCloudGithubServices: () => github }));
vi.mock("../postgres-notifications.js", () => ({ postgresNotificationSubscription: () => null }));
vi.mock("./agent-logins.js", async original => ({ ...await original<typeof import("./agent-logins.js")>(),
  createCloudV2AgentLogins: () => Object.assign(async () => null, { all: async () => ({ codex: null, claude: null, cursor: null }) }) }));
vi.mock("../mcp/composition.js", () => ({ createMcpServices: () => null }));
vi.mock("./lifecycle.js", async original => ({ ...await original<typeof import("./lifecycle.js")>(),
  CloudV2Lifecycle: class { constructor(readonly deps: CloudV2LifecycleDeps) {} },
}));

it("wires workspace git, gh, legacy, hydration and restore credentials to the creator while Computer builds keep automation credentials", async () => {
  github.workerIdentity.mockImplementation(async workspace => ({ repositoryBinding: await github.binding(),
    gitIdentity: await github.connections.gitIdentity({ organizationId: workspace.organizationId, userId: workspace.creatorUserId }) }));
  const config = {
    github: null, deploymentChannel: "alpha", cloudAgentCredentials: { settingsSecretKeyV1: Buffer.alloc(32, 1).toString("base64url") },
    cloudV2: { boat: { apiKey: "synthetic-boat-credential" }, apiUrl: "https://api.example.test", realtimeUrl: "https://rt.example.test",
      workerSigningKey: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      runtime: { sha256: "a".repeat(64), store: { endpoint: "https://store.example.test", bucket: "fixture", accessKeyId: "fixture", secretAccessKey: "fixture" } } },
  } as Config;
  const assembled = createCloudV2(config, { query: vi.fn() } as unknown as pg.Pool, { relay: false, lifecycle: true })!;
  const environment = vi.spyOn(assembled.routes.environments!, "resolve").mockResolvedValue(undefined);
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
  expect(environment).not.toHaveBeenCalled();
  vi.spyOn(assembled.store, "baseCommit").mockResolvedValue(null);
  vi.spyOn(assembled.store, "loginRevision").mockResolvedValue("0");
  for (const identity of [null, { name: "Verified GitHub reviewer", email: "123+fixture@users.noreply.github.com" }]) {
    github.connections.gitIdentity.mockResolvedValueOnce(identity);
    const configuration = await assembled.workers.config(workspace);
    expect(configuration.codeReview).toEqual({ userId: workspace.creatorUserId, ...(identity ? { userName: identity.name } : {}) });
    expect(github.connections.gitIdentity).toHaveBeenLastCalledWith({ organizationId: workspace.organizationId, userId: workspace.creatorUserId });
  }
  const pinned = { versionId: randomUUID(), repositoryId: "42", variables: { APP_SECRET: "synthetic-app-value" }, files: [] };
  environment.mockResolvedValue(pinned);
  expect((await assembled.workers.config(workspace)).environment).toEqual(pinned);
  let entered!: () => void, release!: () => void, revoked = false;
  const waiting = new Promise<void>(done => { entered = done; }), held = new Promise<void>(done => { release = done; });
  environment.mockImplementationOnce(async () => { entered(); await held; return pinned; });
  github.authorizeSource.mockImplementation(async () => { if (revoked) throw new Error("Source revoked"); });
  const configuring = assembled.workers.config(workspace), outcome = expect(configuring).rejects.toThrow("Source revoked");
  try { await waiting; revoked = true; } finally { release(); }
  await outcome;
});

it("passes the relay room's proof to both source continuation checks while configuring", async () => {
  const config = {
    github: null, deploymentChannel: "alpha", cloudAgentCredentials: { settingsSecretKeyV1: Buffer.alloc(32, 1).toString("base64url") },
    cloudV2: { boat: { apiKey: "synthetic-boat-credential" }, apiUrl: "https://api.example.test", realtimeUrl: "https://rt.example.test",
      workerSigningKey: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      runtime: { sha256: "a".repeat(64), store: { endpoint: "https://store.example.test", bucket: "fixture", accessKeyId: "fixture", secretAccessKey: "fixture" } } },
  } as Config;
  const assembled = createCloudV2(config, { query: vi.fn() } as unknown as pg.Pool, { relay: true, lifecycle: false })!;
  vi.spyOn(assembled.routes.environments!, "resolve").mockResolvedValue(undefined);
  vi.spyOn(assembled.store, "baseCommit").mockResolvedValue(null);
  vi.spyOn(assembled.store, "loginRevision").mockResolvedValue("5");
  github.workerIdentity.mockResolvedValue({ repositoryBinding: { repository: "owner/project" }, gitIdentity: null });
  const workspace = { id: randomUUID(), organizationId: randomUUID(), creatorUserId: randomUUID(), state: "running", repository: "owner/project", branch: "topic", baseBranch: "main" } as CloudV2Workspace;
  const relay = assembled.connections as unknown as { deps: CloudV2RelayDeps };
  const proof = { accessEpoch: "3", loginRevision: "5" };
  github.continueSource.mockClear();
  await relay.deps.config(workspace, "continuation", proof);
  expect(github.continueSource.mock.calls).toEqual([[workspace, proof], [workspace, proof]]);
  github.continueSource.mockClear();
  await relay.deps.config(workspace, "continuation");
  expect(github.continueSource.mock.calls).toEqual([[workspace, undefined], [workspace, undefined]]);
  assembled.connections?.close();
});
