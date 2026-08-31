import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import {
  CLOUD_WORKSPACE_BLOB_PATH,
  CLOUD_WORKSPACE_CHECKPOINT_COMMIT_PATH,
  CLOUD_WORKSPACE_CONTENT_APPEND_PATH,
  CLOUD_WORKSPACE_ENGINE_HEARTBEAT_PATH,
  CLOUD_WORKSPACE_ENGINE_REGISTRATION_PATH,
  CLOUD_WORKSPACE_RECORD_APPEND_PATH,
  CLOUD_WORKSPACE_SETUP_ADMISSION_PATH,
  createCloudWorkspaceInternalRoutes,
  type CloudWorkspaceInternalSetupService,
} from "./internal-routes.js";
import { WorkspaceContentError } from "./content-record.js";
import { CloudWorkspaceSetupMaterialError } from "./setup-materials.js";
import { CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_PATH } from "./engine-client-admission.js";

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

  it("keeps engine proof in the bearer while redeeming a separate client grant", async () => {
    const admitEngineClient = vi.fn(async () => ({
      version: 1 as const,
      audience: "zeros-cloud-workspace-engine-client-admission-v1" as const,
      admitted: true as const,
      authorityEpoch: 3,
      accountUserId: "55555555-5555-4555-8555-555555555555",
    }));
    const { app } = harness({ admitEngineClient });
    const grantToken = `zws_${"C".repeat(43)}`;
    const engineScope = {
      workspaceId: body.workspaceId,
      organizationId: body.organizationId,
      generation: 1,
      engineInstanceId: "44444444-4444-4444-8444-444444444444",
    };
    const response = await app.request(
      CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_PATH,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${HEARTBEAT_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...engineScope, grantToken }),
      },
    );
    expect(response.status).toBe(200);
    expect(admitEngineClient).toHaveBeenCalledWith({
      ...engineScope,
      token: grantToken,
      heartbeatToken: HEARTBEAT_TOKEN,
    });
    const responseText = await response.text();
    expect(responseText).not.toContain(grantToken);
    expect(responseText).not.toContain(HEARTBEAT_TOKEN);
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

  it("keeps durable engine capabilities in the header and forwards binary blobs byte-for-byte", async () => {
    const putBlob = vi.fn(async () => ({
      blobId: "55555555-5555-4555-8555-555555555555",
      replayed: false,
    }));
    const getBlob = vi.fn(async () => new Uint8Array([0, 255, 1, 2, 3]));
    const appendRecord = vi.fn(async () => ({ revision: 1, replayed: false }));
    const appendContent = vi.fn(async () => ({ revision: 1, replayed: false }));
    const commitCheckpoint = vi.fn(async () => ({
      checkpointId: "66666666-6666-4666-8666-666666666666",
      replayed: false,
    }));
    const { app } = harness({
      putBlob,
      getBlob,
      appendRecord,
      appendContent,
      commitCheckpoint,
    });
    const engineScope = {
      workspaceId: body.workspaceId,
      organizationId: body.organizationId,
      generation: 1,
      engineInstanceId: "44444444-4444-4444-8444-444444444444",
    };
    const bytes = new Uint8Array([0, 255, 1, 2, 3]);
    const blobQuery = new URLSearchParams({
      ...engineScope,
      generation: String(engineScope.generation),
    });
    const uploaded = await app.request(
      `${CLOUD_WORKSPACE_BLOB_PATH}?${blobQuery.toString()}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${HEARTBEAT_TOKEN}`,
          "content-type": "application/octet-stream",
        },
        body: bytes,
      },
    );
    expect(uploaded.status).toBe(200);
    expect(putBlob).toHaveBeenCalledOnce();
    expect(putBlob.mock.calls[0]![0]).toMatchObject({
      ...engineScope,
      heartbeatToken: HEARTBEAT_TOKEN,
    });
    expect([...putBlob.mock.calls[0]![0].bytes]).toEqual([...bytes]);

    const downloaded = await app.request(
      `${CLOUD_WORKSPACE_BLOB_PATH}/55555555-5555-4555-8555-555555555555?${blobQuery.toString()}`,
      { headers: { authorization: `Bearer ${HEARTBEAT_TOKEN}` } },
    );
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);

    const record = await app.request(CLOUD_WORKSPACE_RECORD_APPEND_PATH, {
      method: "POST",
      headers: {
        authorization: `Bearer ${HEARTBEAT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...engineScope,
        expectedRevision: 0,
        idempotencyKey: "record:00000001",
        mutations: [
          {
            entityKind: "chat",
            entityId: "chat-1",
            operation: "upsert",
            schemaVersion: 1,
            document: { title: "Hello" },
            occurredAt: "2026-08-30T00:00:00.000Z",
          },
        ],
      }),
    });
    expect(record.status).toBe(200);
    expect(appendRecord).toHaveBeenCalledWith(
      expect.objectContaining({ heartbeatToken: HEARTBEAT_TOKEN }),
    );

    const content = await app.request(CLOUD_WORKSPACE_CONTENT_APPEND_PATH, {
      method: "POST",
      headers: {
        authorization: `Bearer ${HEARTBEAT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...engineScope,
        expectedRevision: 0,
        idempotencyKey: "content:00000001",
        gitBaseCommit: null,
        gitHeadRef: null,
        mutations: [{ operation: "delete", path: "src/old.ts" }],
      }),
    });
    expect(content.status).toBe(200);
    expect(appendContent).toHaveBeenCalledWith(
      expect.objectContaining({ heartbeatToken: HEARTBEAT_TOKEN }),
    );

    const checkpoint = await app.request(
      CLOUD_WORKSPACE_CHECKPOINT_COMMIT_PATH,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${HEARTBEAT_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...engineScope,
          idempotencyKey: "checkpoint:00000001",
          contentRevision: 1,
          reason: "periodic",
          manifestBlobId: "77777777-7777-4777-8777-777777777777",
          artifactBlobId: null,
          inclusionPolicy: {},
          fileCount: 0,
          totalBytes: 0,
          integritySha256: "a".repeat(64),
        }),
      },
    );
    expect(checkpoint.status).toBe(200);
    expect(commitCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ heartbeatToken: HEARTBEAT_TOKEN }),
    );
  });

  it("sanitizes durable failures and rejects body-carried heartbeat capabilities", async () => {
    const appendContent = vi.fn(async () => {
      throw new WorkspaceContentError(
        "revision_conflict",
        "sensitive current manifest details",
      );
    });
    const { app } = harness({ appendContent });
    const requestBody = {
      workspaceId: body.workspaceId,
      organizationId: body.organizationId,
      generation: 1,
      engineInstanceId: "44444444-4444-4444-8444-444444444444",
      expectedRevision: 0,
      idempotencyKey: "content:00000002",
      gitBaseCommit: null,
      gitHeadRef: null,
      mutations: [{ operation: "delete", path: "src/old.ts" }],
    };
    const conflicted = await app.request(CLOUD_WORKSPACE_CONTENT_APPEND_PATH, {
      method: "POST",
      headers: {
        authorization: `Bearer ${HEARTBEAT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
    expect(conflicted.status).toBe(409);
    expect(await conflicted.json()).toEqual({
      error: { code: "revision_conflict" },
    });

    const bodyCarried = await app.request(CLOUD_WORKSPACE_CONTENT_APPEND_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...requestBody,
        heartbeatToken: HEARTBEAT_TOKEN,
      }),
    });
    expect(bodyCarried.status).toBe(401);
    expect(appendContent).toHaveBeenCalledOnce();
  });
});
