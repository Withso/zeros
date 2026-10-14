import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createCloudWorkspaceInternalRoutes } from "./internal-routes.js";
import { CloudEngineCheckpointProgressRejected, CloudEngineCheckpointProgressUnavailable } from "./checkpoint-progress.js";

const path = "/internal/v1/cloud-workspaces/engine/checkpoint-progress";
const token = `zwh_${"P".repeat(43)}`;
const progress = {
  version: 1,
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  generation: 1,
  engineInstanceId: "33333333-3333-4333-8333-333333333333",
  requestId: "44444444-4444-4444-8444-444444444444",
  sequence: 1,
  stage: "checkpoint_received",
  state: "running",
  reason: "none",
  elapsedMs: 0,
};

function harness() {
  const service = {
    redeem: vi.fn(async () => ({})),
    registerEngine: vi.fn(async () => ({})),
    heartbeat: vi.fn(async () => ({})),
    authorizeBlobUpload: vi.fn(async () => undefined),
    reportCheckpointProgress: vi.fn(async () => undefined),
  };
  const app = new Hono();
  app.route("/", createCloudWorkspaceInternalRoutes(service));
  return { app, service };
}

describe("closed checkpoint progress route", () => {
  it("routes the exact report and heartbeat credential without invoking heartbeat", async () => {
    const { app, service } = harness();
    const response = await app.request(path, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(progress) });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ version: 1, accepted: true });
    expect(service.reportCheckpointProgress).toHaveBeenCalledExactlyOnceWith({ ...progress, token });
    expect(service.heartbeat).not.toHaveBeenCalled();
  });

  it.each([
    { ...progress, message: "PRIVATE-DIAGNOSTIC-CANARY" },
    { ...progress, reason: "PRIVATE-DIAGNOSTIC-CANARY" },
    { ...progress, state: "failed", reason: "none" },
    { ...progress, sequence: 65 },
    { ...progress, token },
  ])("rejects unbounded or private report fields before service work", async body => {
    const { app, service } = harness();
    const response = await app.request(path, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { code: "invalid_request" } });
    expect(service.reportCheckpointProgress).not.toHaveBeenCalled();
    expect(service.heartbeat).not.toHaveBeenCalled();
  });

  it("bounds report bytes before parsing", async () => {
    const { app, service } = harness();
    const response = await app.request(path, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...progress, text: "x".repeat(2_048) }) });
    expect(response.status).toBe(413);
    expect(service.reportCheckpointProgress).not.toHaveBeenCalled();
  });

  it("returns closed authentication and current-scope refusals", async () => {
    const { app, service } = harness();
    const request = (credential?: string) => app.request(path, { method: "POST",
      headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), "content-type": "application/json" },
      body: JSON.stringify(progress) });
    expect((await request()).status).toBe(401);
    expect((await request("invalid")).status).toBe(401);
    expect(service.reportCheckpointProgress).not.toHaveBeenCalled();
    service.reportCheckpointProgress.mockRejectedValueOnce(new CloudEngineCheckpointProgressRejected());
    const response = await request(token);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "engine_checkpoint_progress_rejected" } });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("preserves absent-service 404 and the exact old heartbeat wire", async () => {
    const { service } = harness();
    const { reportCheckpointProgress: _unused, ...legacy } = service;
    const app = createCloudWorkspaceInternalRoutes(legacy);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    expect((await app.request(path, { method: "POST", headers, body: JSON.stringify(progress) })).status).toBe(404);
    const scope = { organizationId: progress.organizationId, workspaceId: progress.workspaceId,
      generation: 1, engineInstanceId: progress.engineInstanceId };
    const beatPath = "/internal/v1/cloud-workspaces/engine/heartbeat";
    const good = await app.request(beatPath, { method: "POST", headers, body: JSON.stringify(scope) });
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({});
    const extra = await app.request(beatPath, { method: "POST", headers,
      body: JSON.stringify({ ...scope, checkpointProgress: progress }) });
    expect(extra.status).toBe(422);
    expect(service.heartbeat).toHaveBeenCalledTimes(1);
  });

  it("returns a closed best-effort capacity refusal without heartbeat or retry advice", async () => {
    const { app, service } = harness();
    service.reportCheckpointProgress.mockRejectedValueOnce(new CloudEngineCheckpointProgressUnavailable());
    const response = await app.request(path, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(progress) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "engine_checkpoint_progress_unavailable" } });
    expect(response.headers.get("retry-after")).toBeNull();
    expect(service.heartbeat).not.toHaveBeenCalled();
  });
});
