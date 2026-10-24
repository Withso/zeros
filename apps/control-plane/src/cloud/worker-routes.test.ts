import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { createCloudV2WorkerRoutes, type CloudV2WorkerRouteDeps } from "./worker-routes.js";
import { newCloudV2Token } from "./tokens.js";
import type { CloudV2Store, CloudV2Workspace } from "./store.js";

function fixture(prompts = false) {
  const bootId = randomUUID(), token = newCloudV2Token("worker").token;
  const w = { id: randomUUID(), organizationId: randomUUID(), creatorUserId: randomUUID(), repository: "o/r", branch: "w", baseBranch: "main", state: "running", accessEpoch: "0", loginRevision: "0" } as CloudV2Workspace & { accessEpoch: string; loginRevision: string };
  let allowed = true, revision = "0";
  let notify!: () => void;
  const notified = new Promise<void>(resolve => { notify = resolve; });
  const cancelWait = vi.fn();
  const pull = vi.fn(async () => ({ prompts: [], stops: [] as { chatId: string; epoch: string }[] }));
  const deps: CloudV2WorkerRouteDeps = {
    runtimeSha256: "a".repeat(64),
    promptOutbox: prompts,
    waitForPrompts: vi.fn(() => ({ wait: notified, dispose: cancelWait })),
    store: {
      prompts: { pull } as unknown as CloudV2Store["prompts"],
      acceptWorkerHello: vi.fn(async value => allowed && value === token ? w : null),
      workerSession: vi.fn(async (value, boot) => allowed && value === token && boot === bootId ? { ...w, loginRevision: revision } : null),
      accessEpoch: vi.fn(async () => allowed ? "0" : null),
      loginRevision: vi.fn(async () => revision),
      markActive: vi.fn(async () => {}),
      writeWorkerHistory: vi.fn(async () => {}),
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
  return { bootId, token, deps, request, notify, cancelWait, pull,
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
it("reports the first hello from its prior lifecycle state and accepts bounded optional timings without activity", async () => {
  const f = fixture(), original = await f.deps.store.acceptWorkerHello(f.token, f.bootId);
  f.deps.timing = vi.fn();
  vi.mocked(f.deps.store.acceptWorkerHello).mockResolvedValueOnce({ ...original!, helloTiming: { state: "starting", durationMs: 1250 } });
  expect((await f.request("hello", { bootId: f.bootId, protocol: 2, runtimeSha256: "a".repeat(64) })).status).toBe(200);
  expect(f.deps.timing).toHaveBeenCalledWith({ workspaceId: original!.id.slice(0, 8), phase: "worker_hello", state: "starting", durationMs: 1250 });
  expect((await f.request("timing", { phase: "worker_services", durationMs: 23 })).status).toBe(200);
  expect(f.deps.timing).toHaveBeenLastCalledWith({ workspaceId: original!.id.slice(0, 8), phase: "worker_services", durationMs: 23 });
  for (const input of [{ phase: "private-command", durationMs: 1 }, { phase: "worker_services", durationMs: -1 }, { phase: "worker_services", durationMs: 1, token: "do-not-log" }])
    expect((await f.request("timing", input)).status).toBe(400);
  expect((await f.request("timing", { phase: "worker_services", durationMs: 23 }, { "x-zeros-worker-boot": randomUUID() })).status).toBe(401);
  expect(f.deps.store.markActive).not.toHaveBeenCalled();
  f.deps.timing = () => { throw new Error("diagnostics unavailable"); };
  expect((await f.request("timing", { phase: "worker_services", durationMs: 23 })).status).toBe(200);
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

it("delivers MCP only to feature-advertising workers over both HTTP config carriers", async () => {
  const f = fixture(), original = await f.deps.config({} as CloudV2Workspace);
  const mcpServers = [{ id: randomUUID(), name: "fixture", transport: "http" as const, url: "https://mcp.example.test" }];
  vi.mocked(f.deps.config).mockResolvedValue({ ...original, mcpServers });
  for (const [path, body] of [["hello", { bootId: f.bootId, protocol: 2, runtimeSha256: "a".repeat(64) }], ["config", undefined]] as const) {
    expect((await (await f.request(path, body)).json()).config).not.toHaveProperty("mcpServers");
    expect((await (await f.request(path, body, { "x-zeros-worker-features": "prompt-outbox-v1,mcp-v1" })).json()).config.mcpServers).toEqual(mcpServers);
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
