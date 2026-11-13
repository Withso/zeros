import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { createCloudV2Routes, type CloudV2RouteDeps } from "./routes.js";
import type { CloudV2Workspace } from "./store.js";

const id = "11111111-1111-4111-8111-111111111111";
function fixture(state: CloudV2Workspace["state"] = "running") {
  const workspace = { id, state, organizationId: "org", creatorUserId: "user", repository: "owner/repo" } as CloudV2Workspace;
  const authorizeSource = vi.fn(async () => { throw new HttpError(503, "github_unavailable", "unavailable"); });
  const continueSource = vi.fn(async () => ({ recheckAt: Date.now() + 60_000 }));
  const enqueue = vi.fn(async () => ({ receipt: { workspaceId: id }, replay: false }));
  const list = vi.fn(async () => ({ prompts: [] })), stop = vi.fn(async () => ({ epoch: "1" }));
  const issueToken = vi.fn(async () => ({ token: "synthetic-ticket", expiresAt: new Date(Date.now()+60_000) }));
  const requestLifecycle = vi.fn(async () => ({ workspace, moved: false }));
  const get = vi.fn(async () => workspace);
  const proof = { accessEpoch: "3", loginRevision: "7" };
  const promptContext = vi.fn(async () => ({ workspace, proof }));
  const listChats = vi.fn(async () => ({ chats: [] }));
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("user", { id: "user" } as never); await next(); });
  app.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: "internal" }, 500));
  app.route("/", createCloudV2Routes({
    store: { get, promptContext, prompts: { enqueue, list, stop }, issueToken, requestLifecycle, listChats },
    promptOutbox: true, authorizeSource, continueSource, bridgeBaseUrl: "wss://example.test",
  } as unknown as CloudV2RouteDeps));
  const request = (path: string, value?: unknown) => app.request(`/v1/cloud-v2/workspaces/${id}/${path}`, {
    method: value === undefined ? "GET" : "POST", headers: { "content-type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  return { request, authorizeSource, continueSource, enqueue, list, stop, issueToken, requestLifecycle, get, promptContext, workspace, proof, listChats };
}
const prompt = { chatId: "chat", userMessageId: "message", agentId: "codex", startedAt: 1000, prompt: [{ type: "text", text: "Continue" }] };

it("accepts durable prompts and their status without GitHub verification", async () => {
  const f = fixture();
  expect((await f.request("prompts", prompt)).status).toBe(201);
  expect((await f.request("prompts?chatId=chat")).status).toBe(200);
  expect(f.enqueue).toHaveBeenCalledTimes(1);
  expect(f.list).toHaveBeenCalledTimes(1);
  expect(f.authorizeSource).not.toHaveBeenCalled();
  expect(f.continueSource).not.toHaveBeenCalled();
  expect(f.promptContext).toHaveBeenCalledWith(id, "user");
  expect(f.get).not.toHaveBeenCalled();
});

it.each(["stopped", "starting"] as const)("admits a prompt to a %s workspace without repository verification", async state => {
  const f = fixture(state);
  expect((await f.request("prompts", prompt)).status).toBe(201);
  expect(f.enqueue).toHaveBeenCalledOnce();
  expect(f.continueSource).not.toHaveBeenCalled();
});

it("issues a connect ticket and admits wake without repository verification", async () => {
  const f = fixture();
  expect((await f.request("connect", {})).status).toBe(200);
  expect((await f.request("start", {})).status).toBe(200);
  expect(f.issueToken).toHaveBeenCalledOnce();
  expect(f.requestLifecycle).toHaveBeenCalledOnce();
  expect(f.continueSource).not.toHaveBeenCalled();
});

it("keeps Stop available after grace expires or a repository is denied", async () => {
  const f = fixture();
  f.continueSource.mockRejectedValue(new HttpError(403, "github_cloud_access_denied", "denied"));
  expect((await f.request("prompts/stop", { chatId: "chat", throughEpoch: "0" })).status).toBe(200);
  expect(f.authorizeSource).not.toHaveBeenCalled();
  expect(f.continueSource).not.toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledTimes(1);
});

it("retains Creator authorization for legacy prompt admission", async () => {
  const f = fixture();
  f.promptContext.mockRejectedValue(new HttpError(404, "not_found", "not found"));
  expect((await f.request("prompts", prompt)).status).toBe(404);
  expect(f.continueSource).not.toHaveBeenCalled();
  expect(f.enqueue).not.toHaveBeenCalled();
});

it("reads running and stopped history without GitHub access", async () => {
  const active = fixture();
  expect((await active.request("history", { op: "chats.list", params: {} })).status).toBe(200);
  expect(active.listChats).toHaveBeenCalledOnce();
  expect(active.authorizeSource).not.toHaveBeenCalled();
  expect(active.continueSource).not.toHaveBeenCalled();
  expect(active.promptContext).not.toHaveBeenCalled();
  const stopped = fixture("stopped");
  expect((await stopped.request("history", { op: "chats.list", params: {} })).status).toBe(200);
  expect(stopped.listChats).toHaveBeenCalledOnce();
  expect(stopped.authorizeSource).not.toHaveBeenCalled();
});
