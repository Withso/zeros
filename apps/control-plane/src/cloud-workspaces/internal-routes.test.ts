import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import {
  CLOUD_WORKSPACE_ENGINE_HEARTBEAT_PATH,
  CLOUD_WORKSPACE_ENGINE_REGISTRATION_PATH,
  CLOUD_WORKSPACE_SETUP_ADMISSION_PATH,
  createCloudWorkspaceInternalRoutes,
  type CloudWorkspaceInternalSetupService,
} from "./internal-routes.js";
import { CloudWorkspaceSetupMaterialError } from "./setup-materials.js";

const SETUP_TOKEN = `zws_${"A".repeat(43)}`;
const HEARTBEAT_TOKEN = `zwh_${"B".repeat(43)}`;
const body = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  generation: 1,
  setupRunId: "33333333-3333-4333-8333-333333333333",
  executionFence: 4,
  expected: {
    imageRef: "snapshot-pinned",
    imageSourceCommit: "a".repeat(40),
    repositoryRevision: "refs/heads/main",
    settingsVersion: 1,
    settingsSha256: "b".repeat(64),
  },
};

function harness(overrides: Partial<CloudWorkspaceInternalSetupService> = {}) {
  const service: CloudWorkspaceInternalSetupService = {
    redeem: vi.fn(async () => ({ version: 1, material: "secret" })),
    registerEngine: vi.fn(async () => ({ version: 1, registered: true })),
    heartbeat: vi.fn(async () => ({ version: 1, accepted: true })),
    ...overrides,
  };
  const app = new Hono();
  app.route("/", createCloudWorkspaceInternalRoutes(service));
  app.onError((error, c) =>
    c.json({ error: { code: "internal", message: String(error) } }, 500),
  );
  return { app, service };
}

describe("cloud workspace internal setup routes", () => {
  it("redeems an admission from the Authorization header and never caches materials", async () => {
    const { app, service } = harness();
    const response = await app.request(CLOUD_WORKSPACE_SETUP_ADMISSION_PATH, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SETUP_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(await response.json()).toEqual({ version: 1, material: "secret" });
    expect(service.redeem).toHaveBeenCalledWith({
      ...body,
      token: SETUP_TOKEN,
    });
  });

  it("registers and heartbeats only the exactly bound engine", async () => {
    const { app, service } = harness();
    const registrationBody = {
      workspaceId: body.workspaceId,
      organizationId: body.organizationId,
      generation: 1,
      setupRunId: body.setupRunId,
      executionFence: 4,
      engineInstanceId: "44444444-4444-4444-8444-444444444444",
      protocolVersion: 11,
    };
    const registration = await app.request(
      CLOUD_WORKSPACE_ENGINE_REGISTRATION_PATH,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${SETUP_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(registrationBody),
      },
    );
    expect(registration.status).toBe(200);
    expect(service.registerEngine).toHaveBeenCalledWith({
      ...registrationBody,
      token: SETUP_TOKEN,
    });

    const heartbeatBody = {
      workspaceId: body.workspaceId,
      organizationId: body.organizationId,
      generation: 1,
      engineInstanceId: registrationBody.engineInstanceId,
      repositoryCredentialRefresh: {
        generation: "refresh-generation-000000000001",
        requestedAtMs: 1_800_000_000_000,
        ownerSubjectSha256: "c".repeat(64),
        method: "github-app" as const,
        reason: "credential-invalid" as const,
      },
    };
    const heartbeat = await app.request(CLOUD_WORKSPACE_ENGINE_HEARTBEAT_PATH, {
      method: "POST",
      headers: {
        authorization: `Bearer ${HEARTBEAT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(heartbeatBody),
    });
    expect(heartbeat.status).toBe(200);
    expect(service.heartbeat).toHaveBeenCalledWith({
      ...heartbeatBody,
      token: HEARTBEAT_TOKEN,
    });
  });

  it("rejects missing, wrong-kind, body-carried, and malformed credentials before service I/O", async () => {
    const { app, service } = harness();
    for (const [path, authorization, requestBody] of [
      [CLOUD_WORKSPACE_SETUP_ADMISSION_PATH, undefined, body],
      [CLOUD_WORKSPACE_SETUP_ADMISSION_PATH, `Bearer ${HEARTBEAT_TOKEN}`, body],
      [
        CLOUD_WORKSPACE_SETUP_ADMISSION_PATH,
        undefined,
        { ...body, token: SETUP_TOKEN },
      ],
      [
        CLOUD_WORKSPACE_ENGINE_HEARTBEAT_PATH,
        `Bearer ${SETUP_TOKEN}`,
        {
          workspaceId: body.workspaceId,
          organizationId: body.organizationId,
          generation: 1,
          engineInstanceId: "44444444-4444-4444-8444-444444444444",
        },
      ],
    ] as const) {
      const response = await app.request(path, {
        method: "POST",
        headers: {
          ...(authorization ? { authorization } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });
      expect(response.status).toBe(401);
    }
    expect(service.redeem).not.toHaveBeenCalled();
    expect(service.registerEngine).not.toHaveBeenCalled();
    expect(service.heartbeat).not.toHaveBeenCalled();
  });

  it("uses bounded strict JSON and does not reflect validation input", async () => {
    const { app, service } = harness();
    const response = await app.request(CLOUD_WORKSPACE_SETUP_ADMISSION_PATH, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SETUP_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...body,
        unexpected: "secret-that-must-not-be-reflected",
      }),
    });
    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain(
      "secret-that-must-not-be-reflected",
    );
    expect(service.redeem).not.toHaveBeenCalled();
  });

  it("maps known failures without exposing their internal message", async () => {
    const { app } = harness({
      redeem: vi.fn(async () => {
        throw new CloudWorkspaceSetupMaterialError(
          "setup_repository_unavailable",
          "sensitive provider response",
          true,
        );
      }),
    });
    const response = await app.request(CLOUD_WORKSPACE_SETUP_ADMISSION_PATH, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SETUP_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "setup_repository_unavailable", retryable: true },
    });
  });
});
