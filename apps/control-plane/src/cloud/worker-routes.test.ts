import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { createCloudV2WorkerRoutes, type CloudV2WorkerRouteDeps } from "./worker-routes.js";
import { newCloudV2Token } from "./tokens.js";
import type { CloudV2Store, CloudV2Workspace } from "./store.js";
import { CloudV2ControlFrameSchema as legacyWorkerFrame } from "./__fixtures__/worker-contract-before-identity.js";
import { CloudV2PromptSchema, type CloudV2PromptPullReply } from "./prompt-contract.js";

function fixture(prompts = false) {
  const bootId = randomUUID(), token = newCloudV2Token("worker").token;
  const w = { id: randomUUID(), organizationId: randomUUID(), creatorUserId: randomUUID(), repository: "o/r", branch: "w", baseBranch: "main", state: "running", accessEpoch: "0", loginRevision: "0" } as CloudV2Workspace & { accessEpoch: string; loginRevision: string };
  let allowed = true, revision = "0";
  let notify!: () => void;
  const notified = new Promise<void>(resolve => { notify = resolve; });
  const cancelWait = vi.fn();
  const pull = vi.fn(async (): Promise<CloudV2PromptPullReply> => ({ prompts: [], stops: [] }));
  const outcome = vi.fn(async () => ({ state: "failed" as const }));
  const deps: CloudV2WorkerRouteDeps = {
    runtimeSha256: "a".repeat(64),
    promptOutbox: prompts,
    waitForPrompts: vi.fn(() => ({ wait: notified, dispose: cancelWait })),
    store: {
      prompts: { pull, outcome } as unknown as CloudV2Store["prompts"],
      beginWorkerHello: vi.fn(async value => allowed && value === token ? w : null),
      workerHelloIdentity: vi.fn(async value => allowed && value === token ? w : null),
      acceptWorkerHello: vi.fn(async value => allowed && value === token ? w : null),
      workerSession: vi.fn(async (value, boot) => allowed && value === token && boot === bootId ? { ...w, loginRevision: revision } : null),
      accessEpoch: vi.fn(async () => allowed ? "0" : null),
      loginRevision: vi.fn(async () => revision),
      markActive: vi.fn(async () => {}),
      writeWorkerHistory: vi.fn(async () => {}),
      failWorkerCheckout: vi.fn(async () => true),
    },
    config: vi.fn(async () => ({ t: "config", loginRevision: revision,
      workspace: { id: w.id, organizationId: w.organizationId, repository: w.repository, branch: w.branch, baseBranch: w.baseBranch, checkoutPath: "/home/user/o/r" }, agents: {} })),
    githubToken: vi.fn(async () => ({ token: "synthetic-github-token", expiresAt: 5000 })),
  };
  const app = new Hono();
  app.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: { code: "internal" } }, 500));
  app.route("/", createCloudV2WorkerRoutes(deps));
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => app.request(`/v2/cloud/worker/${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "x-zeros-worker-boot": bootId, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { bootId, token, deps, request, notify, cancelWait, pull, outcome,
    revoke: () => { allowed = false; }, revise: (value: string) => { revision = value; } };
}
it("accepts outbound hello and returns configuration, refusing stale runtimes", async () => {
  const f = fixture();
  const body = { bootId: f.bootId, protocol: 2, runtimeSha256: "a".repeat(64) };
  const response = await f.request("hello", body);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ config: { t: "config", loginRevision: "0" } });
  expect((await f.request("hello", { ...body, runtimeSha256: "b".repeat(64) })).status).toBe(409);
});
it("selects the authenticated workspace's runtime before mutating its boot or publishing config", async () => {
  const f = fixture(), candidate = "b".repeat(64);
  f.deps.runtimeSha256ForWorkspace = vi.fn(async () => candidate);
  const body = { bootId: f.bootId, protocol: 2, runtimeSha256: candidate };
  expect((await f.request("hello", { ...body, runtimeSha256: "a".repeat(64) })).status).toBe(409);
  expect(f.deps.store.beginWorkerHello).not.toHaveBeenCalled();
  expect(f.deps.config).not.toHaveBeenCalled();
  expect((await f.request("hello", body)).status).toBe(200);
  expect(f.deps.runtimeSha256ForWorkspace).toHaveBeenCalledWith(expect.objectContaining({ creatorUserId: expect.any(String) }));
});
it("does not fall back to the channel runtime when workspace runtime lookup fails", async () => {
  const f = fixture();
  f.deps.runtimeSha256ForWorkspace = vi.fn(async () => { throw new Error("synthetic-private-lookup-error"); });
  const response = await f.request("hello", { bootId: f.bootId, protocol: 2, runtimeSha256: "a".repeat(64) });
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("synthetic-private");
  expect(f.deps.store.beginWorkerHello).not.toHaveBeenCalled();
  expect(f.deps.store.acceptWorkerHello).not.toHaveBeenCalled();
});
it("carries a bounded rejected-token digest and purpose from the authenticated worker to the token source", async () => {
  const f = fixture(), failedTokenSha256 = "a".repeat(64);
  for (const purpose of ["git", "gh"] as const) {
    const response = await f.request("github-token", { purpose, failedTokenSha256 });
    expect(response.status).toBe(200);
    expect(f.deps.githubToken).toHaveBeenLastCalledWith(expect.objectContaining({ creatorUserId: expect.any(String) }), purpose, failedTokenSha256);
  }
  for (const hash of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "a".repeat(64) + "\n"])
    expect((await f.request("github-token", { failedTokenSha256: hash })).status).toBe(400);
});
it("negotiates user-token recovery for hello and refreshed configuration without breaking legacy workers", async () => {
  const f = fixture(), original = await f.deps.config({} as CloudV2Workspace);
  vi.mocked(f.deps.config).mockResolvedValue({ ...original, githubUserTokens: 1 });
  for (const [path, body] of [["hello", { bootId: f.bootId, protocol: 2, runtimeSha256: "a".repeat(64) }], ["config", undefined]] as const) {
    const old = (await (await f.request(path, body)).json()).config;
    expect(old).not.toHaveProperty("githubUserTokens");
    expect(legacyWorkerFrame.safeParse(old).success).toBe(true);
    expect((await (await f.request(path, body, { "x-zeros-worker-features": "github-user-token-v1" })).json()).config.githubUserTokens).toBe(1);
  }
});
it("delivers the trusted review identity only after exact feature negotiation on hello and refresh", async () => {
  const f = fixture(), original = await f.deps.config({} as CloudV2Workspace);
  const codeReview = { userId: randomUUID(), userName: "Fixture reviewer" };
  vi.mocked(f.deps.config).mockResolvedValue({ ...original, codeReview });
  for (const [path, body] of [["hello", { bootId: f.bootId, protocol: 2, runtimeSha256: "a".repeat(64) }], ["config", undefined]] as const) {
    for (const features of ["", "mcp-v1", "code-review-v10"]) {
      const frame = (await (await f.request(path, body, { "x-zeros-worker-features": features })).json()).config;
      expect(frame).not.toHaveProperty("codeReview");
      expect(legacyWorkerFrame.safeParse(frame).success).toBe(true);
    }
    expect((await (await f.request(path, body, { "x-zeros-worker-features": "mcp-v1, code-review-v1" })).json()).config.codeReview).toEqual(codeReview);
  }
});
it("refuses required environment pins on old workers instead of stripping or releasing values", async () => {
  const f = fixture(), original = await f.deps.config({} as CloudV2Workspace);
  const environment = { versionId: randomUUID(), repositoryId: "42", variables: { APP_SECRET: "synthetic-environment-secret" }, files: [] };
  vi.mocked(f.deps.config).mockResolvedValue({ ...original, environment });
  for (const [path, input] of [["hello", { bootId: f.bootId, protocol: 2, runtimeSha256: "a".repeat(64) }], ["config", undefined]] as const) {
    for (const features of ["", "workspace-environment-v10", "mcp-v1"]) {
      const response = await f.request(path, input, { "x-zeros-worker-features": features });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "cloud_environment_runtime_required" } });
    }
    expect((await (await f.request(path, input, { "x-zeros-worker-features": "mcp-v1, workspace-environment-v1" })).json()).config.environment).toEqual(environment);
  }
  expect(f.deps.store.acceptWorkerHello).toHaveBeenCalledTimes(1);
});
it("requires exact repository setup support before hello readiness or refreshed config", async () => {
  const f = fixture(), original = await f.deps.config({} as CloudV2Workspace);
  vi.mocked(f.deps.config).mockResolvedValue({ ...original, workspace: { ...original.workspace, setupScript: "fixture-setup/install.sh", setup: "echo inline" } });
  for (const [path, input] of [["hello", { bootId: f.bootId, protocol: 2, runtimeSha256: "a".repeat(64) }], ["config", undefined]] as const) {
    for (const features of ["", "workspace-setup-v1", "repository-setup-v10"]) {
      const response = await f.request(path, input, { "x-zeros-worker-features": features });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "cloud_repository_setup_runtime_required" } });
    }
    const response = await f.request(path, input, { "x-zeros-worker-features": "workspace-setup-v1, repository-setup-v1" });
    expect(response.status).toBe(200);
    expect((await response.json()).config.workspace).toMatchObject({ setupScript: "fixture-setup/install.sh", setup: "echo inline" });
  }
  expect(f.deps.store.acceptWorkerHello).toHaveBeenCalledTimes(1);
});
it("acknowledges bounded environment status only for the current authenticated boot", async () => {
  const f = fixture(), status = { versionId: randomUUID(), sequence: 1, state: "ready" };
  f.deps.environmentReport = vi.fn(async () => {});
  const response = await f.request("environment", status);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sequence: 1 });
  expect(f.deps.environmentReport).toHaveBeenCalledExactlyOnceWith(f.token, f.bootId, status);
  expect((await f.request("environment", { ...status, message: "synthetic-value-must-not-echo" })).status).toBe(400);
  expect((await f.request("environment", status, { "x-zeros-worker-boot": randomUUID() })).status).toBe(401);
  expect(f.deps.environmentReport).toHaveBeenCalledTimes(1);
});
it("reports checkout failure using only worker identity even during a GitHub outage", async () => {
  const f = fixture();
  f.deps.authorizeSource = vi.fn(async () => { throw new HttpError(503, "github_unavailable", "Unavailable"); });
  expect((await f.request("checkout-failed", {})).status).toBe(200);
  expect(f.deps.store.failWorkerCheckout).toHaveBeenCalledExactlyOnceWith(f.token, f.bootId);
  expect(f.deps.authorizeSource).not.toHaveBeenCalled();
  expect(f.deps.store.markActive).not.toHaveBeenCalled();
});
it("refuses a stale boot at the atomic failure write and rejects arbitrary error payloads", async () => {
  const f = fixture();
  expect((await f.request("checkout-failed", { code: "arbitrary", message: "private-output" })).status).toBe(400);
  expect(f.deps.store.failWorkerCheckout).not.toHaveBeenCalled();
  expect((await f.request("checkout-failed", {}, { "x-zeros-worker-boot": randomUUID() })).status).toBe(401);
  expect(f.deps.store.failWorkerCheckout).not.toHaveBeenCalled();
  vi.mocked(f.deps.store.failWorkerCheckout).mockResolvedValue(false);
  expect((await f.request("checkout-failed", {})).status).toBe(401);
});
it("reports the first hello from its prior lifecycle state and accepts bounded optional timings without activity", async () => {
  const f = fixture(), original = await f.deps.store.acceptWorkerHello(f.token, f.bootId);
  f.deps.timing = vi.fn();
  vi.mocked(f.deps.store.acceptWorkerHello).mockResolvedValueOnce({ ...original!, helloTiming: { state: "starting", durationMs: 1250 } });
  expect((await f.request("hello", { bootId: f.bootId, protocol: 2, runtimeSha256: "a".repeat(64) })).status).toBe(200);
  expect(f.deps.timing).toHaveBeenCalledWith({ workspaceId: original!.id.slice(0, 8), phase: "worker_hello", state: "starting", durationMs: 1250, configMs: expect.any(Number) });
  expect((await f.request("timing", { phase: "worker_services", durationMs: 23 })).status).toBe(200);
  expect(f.deps.timing).toHaveBeenLastCalledWith({ workspaceId: original!.id.slice(0, 8), phase: "worker_services", durationMs: 23 });
  for (const input of [{ phase: "private-command", durationMs: 1 }, { phase: "worker_services", durationMs: -1 }, { phase: "worker_services", durationMs: 1, token: "do-not-log" }])
    expect((await f.request("timing", input)).status).toBe(400);
  expect((await f.request("timing", { phase: "worker_services", durationMs: 23 }, { "x-zeros-worker-boot": randomUUID() })).status).toBe(401);
  expect(f.deps.store.markActive).not.toHaveBeenCalled();
  f.deps.timing = () => { throw new Error("diagnostics unavailable"); };
  expect((await f.request("timing", { phase: "worker_services", durationMs: 23 })).status).toBe(200);
});
it("logs each optional timing phase only once per authorized workspace boot and acknowledges excess", async () => {
  const f = fixture(); f.deps.timing = vi.fn();
  for (let i = 0; i < 20; i++) expect((await f.request("timing", { phase: "worker_services", durationMs: i })).status).toBe(200);
  expect(f.deps.timing).toHaveBeenCalledTimes(1);
  expect((await f.request("timing", { phase: "worker_checkout", durationMs: 1 })).status).toBe(200);
  expect(f.deps.timing).toHaveBeenCalledTimes(2);
});
it("authenticates each HTTP carrier and fences obsolete boots before credentials or rows", async () => {
  const f = fixture();
  for (const [path, body] of [["activity", { idle: false }], ["history", { t: "history", bootId: f.bootId, sequence: 1, chats: [] }], ["github-token", {}], ["config", undefined]] as const) {
    expect((await f.request(path, body, { authorization: "Bearer invalid" })).status).toBe(401);
    expect((await f.request(path, body, { authorization: f.token })).status).toBe(401);
    expect((await f.request(path, body, { "x-zeros-worker-boot": randomUUID() })).status).toBe(401);
  }
  expect(f.deps.githubToken).not.toHaveBeenCalled(); expect(f.deps.store.writeWorkerHistory).not.toHaveBeenCalled();
});
it("reports the committed login revision for poll repair and retains native history shape", async () => {
  const f = fixture(); f.revise("3");
  expect(await (await f.request("activity", { idle: false })).json()).toEqual({ state: "running", loginRevision: "3" });
  expect(f.deps.store.markActive).toHaveBeenCalledTimes(1);
  const history = { t: "history", bootId: f.bootId, sequence: 1, chats: [{ id: "native-chat" }] };
  expect((await f.request("history", history)).status).toBe(200);
  expect(f.deps.store.writeWorkerHistory).toHaveBeenCalledWith(f.token, f.bootId, 1, { chats: [{ id: "native-chat" }] });
  expect((await f.request("history", { ...history, chats: Array.from({ length: 501 }, () => ({ id: "x" })) })).status).toBe(400);
});

it.each([false, true])("records authenticated activity during a GitHub outage with prompt outbox=%s", async prompts => {
  const f = fixture(prompts);
  f.deps.authorizeSource = vi.fn(async () => { throw new HttpError(503, "github_unavailable", "GitHub unavailable"); });
  const response = await f.request("activity", { idle: false });
  expect(response.status).toBe(200);
  expect(f.deps.store.markActive).toHaveBeenCalledTimes(1);
  expect(f.deps.authorizeSource).not.toHaveBeenCalled();
  expect((await f.request("activity", { idle: true })).status).toBe(200);
  expect(f.deps.store.markActive).toHaveBeenCalledTimes(1);
  f.revoke();
  expect((await f.request("activity", { idle: false })).status).toBe(401);
  expect(f.deps.store.markActive).toHaveBeenCalledTimes(1);
});
it("refreshes an existing worker's configuration during grace but keeps initial hello strict", async () => {
  const f = fixture();
  f.deps.authorizeSource = vi.fn(async () => { throw new HttpError(503, "github_unavailable", "unavailable"); });
  f.deps.continueSource = vi.fn(async () => ({ recheckAt: Date.now() + 60_000 }));
  f.revise("2");
  const response = await f.request("config");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ config: { loginRevision: "2", agents: {} } });
  expect(f.deps.authorizeSource).not.toHaveBeenCalled();
  expect((await f.request("hello", { bootId: f.bootId, protocol: 2, runtimeSha256: "a".repeat(64) })).status).toBe(503);
});
it("discards credential reads made obsolete by a concurrent committed Settings change", async () => {
  const f = fixture(), original = await f.deps.config({} as CloudV2Workspace);
  vi.mocked(f.deps.config).mockImplementationOnce(async () => { f.revise("1"); return { ...original, agents: { cursor: { apiKey: "synthetic-old-token" } } }; });
  const response = await f.request("config");
  expect(await response.json()).toMatchObject({ config: { loginRevision: "1", agents: {} } });
});
it("rechecks authority after a slow token provider and returns a typed refusal", async () => {
  const f = fixture();
  vi.mocked(f.deps.githubToken).mockImplementationOnce(async () => { f.revoke(); return { token: "never-disclose", expiresAt: 50 }; });
  const response = await f.request("github-token", {});
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("never-disclose");
});

it.each([
  ["github_connection_required", "connection-required"],
  ["github_authorization_expired", "connection-expired"],
  ["github_authorization_changed", "connection-changed"],
  ["github_installation_required", "installation-required"],
  ["github_installation_suspended", "installation-suspended"],
  ["github_cloud_write_denied", "access-denied"],
  ["github_sso_required", "sso-required"],
  ["cloud_source_review_required", "source-review-required"],
  ["github_rate_limited", "rate-limited"],
  ["github_refresh_pending", "unavailable"],
  ["github_refresh_uncertain", "connection-expired"],
])("returns the closed GitHub reason for %s and logs only a safe cause", async (code, reason) => {
  const f = fixture(), logger = { warn: vi.fn() };
  f.deps.logger = logger;
  vi.mocked(f.deps.githubToken).mockRejectedValue(new HttpError(409, code, "PRIVATE_PROVIDER_DETAIL"));
  const response = await f.request("github-token", {});
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: { code: "github_token_unavailable", reason } });
  expect(logger.warn).toHaveBeenCalledOnce();
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("PRIVATE_PROVIDER_DETAIL");
  expect(JSON.stringify(logger.warn.mock.calls)).toContain(code);
});

it("keeps source-authorization failures typed at the GitHub credential boundary", async () => {
  const f = fixture();
  f.deps.authorizeSource = vi.fn(async () => { throw new HttpError(409, "cloud_source_review_required", "PRIVATE_SOURCE_DETAIL"); });
  expect(await (await f.request("github-token", {})).json()).toEqual({ error: { code: "github_token_unavailable", reason: "source-review-required" } });
  expect(f.deps.githubToken).not.toHaveBeenCalled();
});

it("delivers managed identity only to workers negotiating it on both config carriers", async () => {
  const f = fixture(), original = await f.deps.config({} as CloudV2Workspace);
  const gitIdentity = { name: "Fixture Contributor", email: "123+contributor@users.noreply.github.com" };
  vi.mocked(f.deps.config).mockResolvedValue({ ...original, gitIdentity });
  for (const [path, body] of [["hello", { bootId: f.bootId, protocol: 2, runtimeSha256: "a".repeat(64) }], ["config", undefined]] as const) {
    for (const features of ["", "github-pr-v1", "git-identity-v10"]) {
      const frame = (await (await f.request(path, body, { "x-zeros-worker-features": features })).json()).config;
      expect(frame).not.toHaveProperty("gitIdentity");
      expect(legacyWorkerFrame.safeParse(frame).success).toBe(true);
    }
    expect((await (await f.request(path, body, { "x-zeros-worker-features": "git-identity-v1" })).json()).config.gitIdentity).toEqual(gitIdentity);
  }
});

it("delivers MCP only to feature-advertising workers over both HTTP config carriers", async () => {
  const f = fixture(), original = await f.deps.config({} as CloudV2Workspace);
  const mcpServers = [{ id: randomUUID(), name: "fixture", transport: "http" as const, url: "https://mcp.example.test" }];
  vi.mocked(f.deps.config).mockResolvedValue({ ...original, mcpServers });
  for (const [path, body] of [["hello", { bootId: f.bootId, protocol: 2, runtimeSha256: "a".repeat(64) }], ["config", undefined]] as const) {
    expect((await (await f.request(path, body)).json()).config).not.toHaveProperty("mcpServers");
    expect((await (await f.request(path, body, { "x-zeros-worker-features": "prompt-outbox-v1,mcp-v1" })).json()).config.mcpServers).toEqual(mcpServers);
  }
});

it("delivers setup only to supporting workers on hello and config refresh", async () => {
  const f = fixture(), original = await f.deps.config({} as CloudV2Workspace);
  vi.mocked(f.deps.config).mockResolvedValue({ ...original, workspace: { ...original.workspace, setup: "pnpm install" } });
  for (const [path, body] of [["hello", { bootId: f.bootId, protocol: 2, runtimeSha256: "a".repeat(64) }], ["config", undefined]] as const) {
    for (const features of ["", "mcp-v1", "workspace-setup-v10"])
      expect((await (await f.request(path, body, { "x-zeros-worker-features": features })).json()).config.workspace).not.toHaveProperty("setup");
    expect((await (await f.request(path, body, { "x-zeros-worker-features": "mcp-v1, workspace-setup-v1" })).json()).config.workspace.setup).toBe("pnpm install");
  }
});

it("independently gates baseCommit and setup on hello and HTTP config refresh", async () => {
  const f = fixture(), original = await f.deps.config({} as CloudV2Workspace), baseCommit = "a".repeat(40);
  vi.mocked(f.deps.config).mockResolvedValue({ ...original, workspace: { ...original.workspace, baseCommit, setup: "pnpm install" } });
  for (const [path, body] of [["hello", { bootId: f.bootId, protocol: 2, runtimeSha256: "a".repeat(64) }], ["config", undefined]] as const) {
    for (const features of ["", "workspace-setup-v1", "checkout-v20", "checkout-v2", "mcp-v1, checkout-v2, workspace-setup-v1"]) {
      const workspace = (await (await f.request(path, body, { "x-zeros-worker-features": features })).json()).config.workspace;
      if (features.split(",").some(value => value.trim() === "checkout-v2")) expect(workspace.baseCommit).toBe(baseCommit);
      else expect(workspace).not.toHaveProperty("baseCommit");
      if (features.includes("workspace-setup-v1")) expect(workspace.setup).toBe("pnpm install");
      else expect(workspace).not.toHaveProperty("setup");
    }
  }
});

it("fences refreshed MCP authorization by the exact worker boot and never returns provider errors", async () => {
  const f = fixture(), id = randomUUID();
  f.deps.mcpAuthorization = vi.fn(async () => ({ headers: { Authorization: "Bearer fixture-mcp" }, expiresAt: 5000 }));
  expect((await f.request(`mcp/${id}/authorization`, { force: true }, { "x-zeros-worker-boot": randomUUID() })).status).toBe(401);
  expect(f.deps.mcpAuthorization).not.toHaveBeenCalled();
  const response = await f.request(`mcp/${id}/authorization`, { force: true });
  expect(await response.json()).toEqual({ headers: { Authorization: "Bearer fixture-mcp" }, expiresAt: 5000 });
  expect(f.deps.mcpAuthorization).toHaveBeenCalledWith(expect.objectContaining({ repository: "o/r" }), id, true);
  vi.mocked(f.deps.mcpAuthorization).mockImplementationOnce(async () => { f.revoke(); return { headers: { Authorization: "never-disclose" } }; });
  const revoked = await f.request(`mcp/${id}/authorization`, {});
  expect(revoked.status).toBe(401); expect(await revoked.text()).not.toContain("never-disclose");
});

it("refuses an outbox-incompatible worker before accepting its hello", async () => {
  const f = fixture(true), body = { bootId: f.bootId, protocol: 2, runtimeSha256: "a".repeat(64) };
  expect((await f.request("hello", body)).status).toBe(409);
  expect(f.deps.store.acceptWorkerHello).not.toHaveBeenCalled();
  expect((await f.request("hello", body, { "x-zeros-worker-features": "prompt-outbox-v1" })).status).toBe(200);
  expect(await (await f.request("config")).json()).toMatchObject({ config: { promptOutbox: 1 } });
});

it("registers a long poll before reading, releases it on a hint, and never marks activity", async () => {
  const f = fixture(true);
  let answered = false;
  const response = f.request("prompts/pull", { waitMs: 25_000 }).then(value => { answered = true; return value; });
  await expect.poll(() => f.pull.mock.calls.length).toBe(1);
  expect(answered).toBe(false);
  expect(f.deps.waitForPrompts).toHaveBeenCalledBefore(f.pull);
  f.pull.mockResolvedValueOnce({ prompts: [], stops: [{ chatId: "chat", epoch: "1" }] });
  f.notify();
  expect(await (await response).json()).toEqual({ prompts: [], stops: [{ chatId: "chat", epoch: "1" }] });
  expect(f.cancelWait).toHaveBeenCalledTimes(1);
  expect(f.deps.store.markActive).not.toHaveBeenCalled();
});

it("rechecks worker authority when a long poll wakes", async () => {
  const f = fixture(true);
  const response = f.request("prompts/pull", { waitMs: 25_000 });
  await expect.poll(() => f.pull.mock.calls.length).toBe(1);
  f.revoke(); f.notify();
  expect((await response).status).toBe(401);
  expect(f.pull).toHaveBeenCalledTimes(1);
  expect(f.cancelWait).toHaveBeenCalledTimes(1);
});

it("negotiates questions and Plan only with the exact feature on hello and refresh", async () => {
  const f = fixture(), original = await f.deps.config({} as CloudV2Workspace);
  vi.mocked(f.deps.config).mockResolvedValue({ ...original, agentInteractions: 1 });
  for (const [path, body] of [["hello", { bootId: f.bootId, protocol: 2, runtimeSha256: "a".repeat(64) }], ["config", undefined]] as const) {
    for (const features of ["", "mcp-v1", "agent-interactions-v10"]) {
      const config = (await (await f.request(path, body, { "x-zeros-worker-features": features })).json()).config;
      expect(config).not.toHaveProperty("agentInteractions"); expect(legacyWorkerFrame.safeParse(config).success).toBe(true);
    }
    expect((await (await f.request(path, body, { "x-zeros-worker-features": "mcp-v1, agent-interactions-v1" })).json()).config.agentInteractions).toBe(1);
  }
});

it.each([false, true])("keeps durable mode payloads compatible with interaction support=%s", async supported => {
  const f = fixture(true), workspaceId = randomUUID();
  const prompts = (["plan", "bypass"] as const).map(permissionMode => ({
    payload: { chatId: permissionMode, userMessageId: permissionMode, agentId: "codex" as const, permissionMode,
      prompt: [{ type: "text" as const, text: "task" }], startedAt: 1 },
    receipt: { workspaceId, chatId: permissionMode, userMessageId: permissionMode, epoch: "0", sequence: "1", acceptedAt: new Date(1).toISOString(), workspaceState: "running" as const },
    deliveryId: randomUUID(),
  }));
  for (const waited of [false, true]) {
    f.pull.mockClear(); f.outcome.mockClear();
    if (waited) f.pull.mockResolvedValueOnce({ prompts: [], stops: [] });
    f.pull.mockResolvedValueOnce({ prompts, stops: [{ chatId: "stopped", epoch: "1" }] });
    const reply = f.request("prompts/pull", { waitMs: waited ? 25_000 : 0 }, {
      "x-zeros-worker-features": supported ? "prompt-outbox-v1,agent-interactions-v1" : "prompt-outbox-v1,agent-interactions-v10",
    });
    if (waited) { await expect.poll(() => f.pull.mock.calls.length).toBe(1); f.notify(); }
    const batch = await (await reply).json() as CloudV2PromptPullReply;
    expect(batch.stops).toEqual([{ chatId: "stopped", epoch: "1" }]);
    if (supported) { expect(batch.prompts).toEqual(prompts); expect(f.outcome).not.toHaveBeenCalled(); }
    else {
      expect(batch.prompts).toHaveLength(1);
      expect(batch.prompts[0].payload).not.toHaveProperty("permissionMode");
      expect(CloudV2PromptSchema.omit({ permissionMode: true }).safeParse(batch.prompts[0].payload).success).toBe(true);
      expect(f.outcome).toHaveBeenCalledOnce();
      expect(vi.mocked(f.deps.store.prompts!.outcome).mock.calls[0][2]).toEqual({ userMessageId: "plan", deliveryId: prompts[0].deliveryId, state: "failed" });
    }
  }
});

it("negotiates history replacement only with supporting workers on both config carriers", async () => {
  const f = fixture();
  for (const [path, body] of [["hello", { bootId: f.bootId, protocol: 2, runtimeSha256: "a".repeat(64) }], ["config", undefined]] as const) {
    const legacy = (await (await f.request(path, body)).json()).config;
    expect(legacy).not.toHaveProperty("historyReplacement");
    expect(legacyWorkerFrame.safeParse(legacy).success).toBe(true);
    expect((await (await f.request(path, body, { "x-zeros-worker-features": "history-replace-v1" })).json()).config.historyReplacement).toBe(1);
  }
});
