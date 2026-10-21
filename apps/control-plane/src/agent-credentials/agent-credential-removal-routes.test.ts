import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AuthedUser } from "../auth.js";
import { HttpError } from "../authz.js";
import { createCloudAgentCredentialRoutes } from "./agent-credential-routes.js";
import type { DatabaseCloudAgentCredentialService } from "./agent-credentials.js";

const userId = randomUUID(), operationId = randomUUID();
const target = { kind: "revoke-credential", credentialId: randomUUID(), expectedCredentialRevision: 1 };
const pending = { version: 1, state: "pending", phase: "preparing", operationId, revision: 1, retryAfterMs: 1000 };
const headers = { "content-type": "application/json" };
function publicApp(service: unknown) {
  const app = new Hono(); app.use("*", async (context, next) => { context.set("user", { id: userId } as AuthedUser); await next(); });
  app.route("/", createCloudAgentCredentialRoutes(service as DatabaseCloudAgentCredentialService)); return app;
}
describe("credential removal HTTP boundary", () => {
  it("prepares with only the authenticated user and strict public target", async () => {
    const prepareRemoval = vi.fn().mockResolvedValue(pending), app = publicApp({ prepareRemoval });
    const body = { version: 1, operationId, target };
    const response = await app.request("/v1/cloud-agent-credentials/removals/prepare", { method: "POST", headers, body: JSON.stringify(body) });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(pending);
    expect(prepareRemoval).toHaveBeenCalledWith(userId, body);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it.each(["confirm", "cancel"])("routes exact %s decision identity", async action => {
    const decideRemoval = vi.fn().mockResolvedValue(pending), app = publicApp({ decideRemoval });
    const body = { version: 1, requestId: randomUUID(), expectedRevision: 1 };
    const response = await app.request(`/v1/cloud-agent-credentials/removals/${operationId}/${action}`, { method: "POST", headers, body: JSON.stringify(body) });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(pending);
    expect(decideRemoval).toHaveBeenCalledWith(userId, operationId, action, body);
  });
  it("reads the existing operation without engine admission or wake", async () => {
    const readRemoval = vi.fn().mockResolvedValue(pending), app = publicApp({ readRemoval });
    const response = await app.request(`/v1/cloud-agent-credentials/removals/${operationId}`);
    expect(response.status).toBe(200); expect(await response.json()).toEqual(pending);
    expect(readRemoval).toHaveBeenCalledWith(userId, operationId);
  });
  it("rejects actor/boot authority fields before the public service", async () => {
    const prepareRemoval = vi.fn(), app = publicApp({ prepareRemoval });
    const response = await app.request("/v1/cloud-agent-credentials/removals/prepare", { method: "POST", headers,
      body: JSON.stringify({ version: 1, operationId, target, ownerUserId: userId }) });
    expect(response.status).toBe(422); expect(prepareRemoval).not.toHaveBeenCalled();
  });
  it("returns only bounded closed errors and never service prose", async () => {
    const prepareRemoval = vi.fn().mockRejectedValue(new HttpError(404, "not_found", "synthetic-private-diagnostics"));
    const response = await publicApp({ prepareRemoval }).request("/v1/cloud-agent-credentials/removals/prepare", {
      method: "POST", headers, body: JSON.stringify({ version: 1, operationId, target }) });
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "cloud_validation_access_denied" });
  });
  it("rejects a malformed or private public outcome", async () => {
    const prepareRemoval = vi.fn().mockResolvedValue({ ...pending, material: "synthetic-private" });
    const response = await publicApp({ prepareRemoval }).request("/v1/cloud-agent-credentials/removals/prepare", {
      method: "POST", headers, body: JSON.stringify({ version: 1, operationId, target }) });
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "cloud_agent_credential_busy" });
  });
  it.each([
    ["POST","/v1/cloud-agent-credentials/delegations"],
    ["GET","/v1/cloud-workspaces/workspace/agent-credentials"],
    ["POST","/internal/v2/cloud-workspaces/engine/agent-credential-controls"],
    ["POST","/internal/v1/cloud-workspaces/engine/agent-executions"],
  ])("leaves retired %s %s unregistered",async(method,path)=>{
    expect((await publicApp({}).request(path!,{method})).status).toBe(404);
  });
});
