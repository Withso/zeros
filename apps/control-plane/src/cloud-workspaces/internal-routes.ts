import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import {
  CloudWorkspaceSetupMaterialError,
  type CloudWorkspaceEngineHeartbeatInput,
  type CloudWorkspaceEngineRegistrationInput,
  type CloudWorkspaceSetupRedemptionInput,
} from "./setup-materials.js";
import {
  WorkspaceRecordError,
  type DatabaseCloudWorkspaceDurableRecordService,
} from "./durable-record.js";
import {
  MAX_WORKSPACE_FILE_BYTES,
  MAX_WORKSPACE_FILE_MUTATIONS,
  WorkspaceContentError,
  type DatabaseCloudWorkspaceContentService,
} from "./content-record.js";
import {
  WorkspaceBlobError,
  type DatabaseCloudWorkspaceBlobService,
} from "./object-store.js";
import {
  CLOUD_WORKSPACE_USAGE_METERS,
  CloudWorkspaceUsageError,
  type DatabaseCloudWorkspaceUsageService,
} from "./usage.js";
import {
  CloudWorkspaceSetupRecoveryError,
  type DatabaseCloudWorkspaceSetupRecoveryService,
} from "./setup-recovery.js";
import {
  CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_PATH,
  CloudWorkspaceEngineClientAdmissionError,
  type DatabaseCloudWorkspaceEngineClientAdmissionService,
} from "./engine-client-admission.js";

export const CLOUD_WORKSPACE_SETUP_ADMISSION_PATH =
  "/internal/v1/cloud-workspaces/setup/admission";
export const CLOUD_WORKSPACE_ENGINE_REGISTRATION_PATH =
  "/internal/v1/cloud-workspaces/engine/register";
export const CLOUD_WORKSPACE_ENGINE_HEARTBEAT_PATH =
  "/internal/v1/cloud-workspaces/engine/heartbeat";
export const CLOUD_WORKSPACE_RECORD_APPEND_PATH =
  "/internal/v1/cloud-workspaces/engine/record/append";
export const CLOUD_WORKSPACE_RECORD_HEAD_PATH =
  "/internal/v1/cloud-workspaces/engine/record/head";
export const CLOUD_WORKSPACE_CONTENT_APPEND_PATH =
  "/internal/v1/cloud-workspaces/engine/content/append";
export const CLOUD_WORKSPACE_CONTENT_HEAD_PATH =
  "/internal/v1/cloud-workspaces/engine/content/head";
export const CLOUD_WORKSPACE_CHECKPOINT_COMMIT_PATH =
  "/internal/v1/cloud-workspaces/engine/checkpoints/commit";
export const CLOUD_WORKSPACE_BLOB_PATH =
  "/internal/v1/cloud-workspaces/engine/blobs";
export const CLOUD_WORKSPACE_USAGE_PATH =
  "/internal/v1/cloud-workspaces/engine/usage";
export const CLOUD_WORKSPACE_SETUP_RECOVERY_PATH =
  "/internal/v1/cloud-workspaces/setup/recovery";

const UUID = z.string().uuid();
const POSITIVE_INTEGER = z.number().int().safe().positive();
const SETUP_TOKEN_PATTERN = /^zws_[A-Za-z0-9_-]{43}$/;
const HEARTBEAT_TOKEN_PATTERN = /^zwh_[A-Za-z0-9_-]{43}$/;
const RECOVERY_TOKEN_PATTERN = /^zrc_[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const INTERNAL_BODY_BYTES = 64 * 1024;
const RECORD_BODY_BYTES = 2_250_000;
const CONTENT_BODY_BYTES = 8 * 1024 * 1024;
const BLOB_BODY_BYTES = 64 * 1024 * 1024;

const SetupAdmissionBody = z
  .object({
    workspaceId: UUID,
    organizationId: UUID,
    generation: POSITIVE_INTEGER,
    setupRunId: UUID,
    executionFence: POSITIVE_INTEGER,
    expected: z
      .object({
        imageRef: z.string().trim().min(1).max(1_024),
        imageSourceCommit: z.string().regex(COMMIT_PATTERN),
        repositoryRevision: z.string().trim().min(1).max(512),
        settingsVersion: POSITIVE_INTEGER,
        settingsSha256: z.string().regex(SHA256_PATTERN),
      })
      .strict(),
  })
  .strict();

const EngineRegistrationBody = z
  .object({
    workspaceId: UUID,
    organizationId: UUID,
    generation: POSITIVE_INTEGER,
    setupRunId: UUID,
    executionFence: POSITIVE_INTEGER,
    engineInstanceId: UUID,
    protocolVersion: POSITIVE_INTEGER.max(65_535),
  })
  .strict();

const EngineHeartbeatBody = z
  .object({
    workspaceId: UUID,
    organizationId: UUID,
    generation: POSITIVE_INTEGER,
    engineInstanceId: UUID,
    observedPorts: z
      .array(
        z
          .object({
            port: z.number().int().min(1_024).max(65_535),
            protocol: z.literal("tcp"),
          })
          .strict(),
      )
      .max(128)
      .optional(),
    repositoryCredentialRefresh: z
      .object({
        generation: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/),
        requestedAtMs: POSITIVE_INTEGER,
        ownerSubjectSha256: z.string().regex(SHA256_PATTERN),
        method: z.literal("github-app"),
        reason: z.literal("credential-invalid"),
      })
      .strict()
      .optional(),
  })
  .strict();

const EngineClientAdmissionBody = z
  .object({
    workspaceId: UUID,
    organizationId: UUID,
    generation: POSITIVE_INTEGER,
    engineInstanceId: UUID,
    grantToken: z.string().regex(SETUP_TOKEN_PATTERN),
  })
  .strict();

const EngineScope = {
  workspaceId: UUID,
  organizationId: UUID,
  generation: POSITIVE_INTEGER,
  engineInstanceId: UUID,
} as const;

const RecordAppendBody = z
  .object({
    ...EngineScope,
    expectedRevision: z.number().int().safe().nonnegative(),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
    mutations: z
      .array(
        z
          .object({
            entityKind: z.enum([
              "workspace",
              "chat",
              "message",
              "turn",
              "agent_session",
              "run",
              "terminal",
              "design_transaction",
              "metadata",
            ]),
            entityId: z.string().min(1).max(255),
            operation: z.enum(["upsert", "tombstone"]),
            schemaVersion: POSITIVE_INTEGER.max(65_535),
            document: z.record(z.unknown()).optional(),
            occurredAt: z.string().datetime({ offset: true }),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

const RecordHeadScope = z
  .object({
    ...EngineScope,
    generation: z.coerce.number().int().safe().positive(),
    limit: z.coerce.number().int().min(1).max(10).optional(),
    afterEntityKind: z
      .enum([
        "workspace",
        "chat",
        "message",
        "turn",
        "agent_session",
        "run",
        "terminal",
        "design_transaction",
        "metadata",
      ])
      .optional(),
    afterEntityId: z.string().min(1).max(255).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.afterEntityKind === undefined) ===
      (value.afterEntityId === undefined),
  );

const ContentMutation = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("upsert"),
      path: z.string().min(1).max(4_096),
      entryType: z.enum(["file", "symlink"]),
      mode: z.union([z.literal(33188), z.literal(33261), z.literal(40960)]),
      blobId: UUID,
      contentSha256: z.string().regex(SHA256_PATTERN),
      sizeBytes: z
        .number()
        .int()
        .safe()
        .nonnegative()
        .max(MAX_WORKSPACE_FILE_BYTES),
    })
    .strict(),
  z
    .object({
      operation: z.literal("delete"),
      path: z.string().min(1).max(4_096),
    })
    .strict(),
]);

const ContentAppendBody = z
  .object({
    ...EngineScope,
    expectedRevision: z.number().int().safe().nonnegative(),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
    gitBaseCommit: z.string().regex(COMMIT_PATTERN).nullable(),
    gitHeadRef: z.string().min(1).max(512).nullable(),
    mutations: z.array(ContentMutation).max(MAX_WORKSPACE_FILE_MUTATIONS),
  })
  .strict();

const CheckpointCommitBody = z
  .object({
    ...EngineScope,
    requestId: UUID.optional(),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
    contentRevision: POSITIVE_INTEGER,
    reason: z.enum([
      "periodic",
      "before_stop",
      "before_archive",
      "before_delete",
      "before_fork",
      "before_rebuild",
      "manual",
      "recovery",
    ]),
    manifestBlobId: UUID,
    artifactBlobId: UUID.nullable(),
    inclusionPolicy: z.record(z.unknown()),
    fileCount: z.number().int().safe().nonnegative().max(1_000_000),
    totalBytes: z
      .number()
      .int()
      .safe()
      .nonnegative()
      .max(10 * 1024 ** 3),
    integritySha256: z.string().regex(SHA256_PATTERN),
  })
  .strict();

const BlobQuery = z
  .object({
    workspaceId: UUID,
    organizationId: UUID,
    generation: z.coerce.number().int().safe().positive(),
    engineInstanceId: UUID,
  })
  .strict();

const ContentHeadScope = z
  .object({
    workspaceId: UUID,
    organizationId: UUID,
    generation: z.coerce.number().int().safe().positive(),
    engineInstanceId: UUID,
    limit: z.coerce.number().int().min(1).max(1_000).optional(),
  })
  .strict();

const UsageBody = z
  .object({
    ...EngineScope,
    meter: z.enum(CLOUD_WORKSPACE_USAGE_METERS),
    quantity: z.union([
      z.number().finite().nonnegative(),
      z.string().regex(/^(?:0|[1-9][0-9]{0,23})(?:\.[0-9]{1,6})?$/),
    ]),
    sourceIdempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,512}$/),
    occurredAt: z.string().datetime({ offset: true }),
    metadata: z.record(z.unknown()),
  })
  .strict();

export interface CloudWorkspaceInternalSetupService {
  redeem(input: CloudWorkspaceSetupRedemptionInput): Promise<unknown>;
  registerEngine(
    input: CloudWorkspaceEngineRegistrationInput,
  ): Promise<unknown>;
  heartbeat(input: CloudWorkspaceEngineHeartbeatInput): Promise<unknown>;
  admitEngineClient?: DatabaseCloudWorkspaceEngineClientAdmissionService["consume"];
  appendRecord?: DatabaseCloudWorkspaceDurableRecordService["append"];
  readRecordHead?: DatabaseCloudWorkspaceDurableRecordService["headForEngine"];
  appendContent?: DatabaseCloudWorkspaceContentService["append"];
  readContentHead?: DatabaseCloudWorkspaceContentService["headForEngine"];
  commitCheckpoint?: DatabaseCloudWorkspaceContentService["commitCheckpoint"];
  putBlob?: DatabaseCloudWorkspaceBlobService["put"];
  getBlob?: DatabaseCloudWorkspaceBlobService["getForEngine"];
  ingestUsage?: DatabaseCloudWorkspaceUsageService["ingestEngine"];
  readRecoveryManifest?: DatabaseCloudWorkspaceSetupRecoveryService["manifestPage"];
  getRecoveryBlob?: DatabaseCloudWorkspaceSetupRecoveryService["blob"];
}

function bearerToken(
  value: string | undefined,
  pattern: RegExp,
): string | null {
  const match = /^Bearer ([^ ]+)$/.exec(value ?? "");
  return match?.[1] && pattern.test(match[1]) ? match[1] : null;
}

function contentTypeIsJson(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function errorStatus(
  error: CloudWorkspaceSetupMaterialError,
): 401 | 409 | 422 | 503 {
  switch (error.code) {
    case "setup_authority_changed":
      return 409;
    case "setup_settings_invalid":
      return 422;
    case "setup_repository_unavailable":
      return 503;
    case "setup_admission_rejected":
    case "engine_registration_rejected":
    case "engine_heartbeat_rejected":
      return 401;
  }
}

function durableErrorResponse(
  error:
    | WorkspaceRecordError
    | WorkspaceContentError
    | WorkspaceBlobError
    | CloudWorkspaceUsageError,
): { status: 401 | 404 | 409 | 422 | 503; code: string } {
  if (error.code === "engine_authority_rejected") {
    return { status: 401, code: error.code };
  }
  if (
    error.code === "revision_conflict" ||
    error.code === "idempotency_conflict" ||
    error.code === "checkpoint_request_rejected"
  ) {
    return { status: 409, code: error.code };
  }
  if (error.code === "object_unavailable") {
    return { status: 404, code: error.code };
  }
  if (error.code === "object_store_unavailable") {
    return { status: 503, code: error.code };
  }
  if (error.code === "object_storage_limit_not_configured") {
    return { status: 503, code: error.code };
  }
  if (
    error.code === "organization_object_storage_limit_exceeded" ||
    error.code === "workspace_object_storage_limit_exceeded"
  ) {
    return { status: 409, code: error.code };
  }
  if (error.code === "billing_authority_unavailable") {
    return { status: 409, code: error.code };
  }
  return { status: 422, code: error.code };
}

async function strictJson<T>(
  request: {
    header(name: string): string | undefined;
    json(): Promise<unknown>;
  },
  schema: z.ZodType<T>,
): Promise<T | null> {
  if (!contentTypeIsJson(request.header("content-type"))) return null;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return null;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function recoveryCursor(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return null;
  if (raw.length < 2 || raw.length > 8_192 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    return undefined;
  }
  const bytes = Buffer.from(raw, "base64url");
  try {
    if (bytes.toString("base64url") !== raw || bytes.length > 4_096) {
      return undefined;
    }
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return value.length > 0 && value === value.normalize("NFC")
      ? value
      : undefined;
  } catch {
    return undefined;
  } finally {
    bytes.fill(0);
  }
}

/** Capability-authenticated, non-browser endpoints used only by the immutable
 * sandbox helper and engine. They intentionally sit outside `/v1/*` account
 * middleware: the one-use/heartbeat bearer is the complete authority. */
export function createCloudWorkspaceInternalRoutes(
  service: CloudWorkspaceInternalSetupService,
): Hono {
  const routes = new Hono();
  routes.use("/internal/v1/cloud-workspaces/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  for (const path of [
    CLOUD_WORKSPACE_SETUP_ADMISSION_PATH,
    CLOUD_WORKSPACE_ENGINE_REGISTRATION_PATH,
    CLOUD_WORKSPACE_ENGINE_HEARTBEAT_PATH,
    CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_PATH,
  ]) {
    routes.use(path, bodyLimit({ maxSize: INTERNAL_BODY_BYTES }));
  }

  routes.post(CLOUD_WORKSPACE_SETUP_ADMISSION_PATH, async (c) => {
    const token = bearerToken(
      c.req.header("authorization"),
      SETUP_TOKEN_PATTERN,
    );
    if (!token) return c.json({ error: { code: "invalid_capability" } }, 401);
    const input = await strictJson(c.req, SetupAdmissionBody);
    if (!input) return c.json({ error: { code: "invalid_request" } }, 422);
    try {
      return c.json(await service.redeem({ ...input, token }));
    } catch (error) {
      if (!(error instanceof CloudWorkspaceSetupMaterialError)) throw error;
      return c.json(
        { error: { code: error.code, retryable: error.retryable } },
        errorStatus(error),
      );
    }
  });

  routes.post(CLOUD_WORKSPACE_ENGINE_REGISTRATION_PATH, async (c) => {
    const token = bearerToken(
      c.req.header("authorization"),
      SETUP_TOKEN_PATTERN,
    );
    if (!token) return c.json({ error: { code: "invalid_capability" } }, 401);
    const input = await strictJson(c.req, EngineRegistrationBody);
    if (!input) return c.json({ error: { code: "invalid_request" } }, 422);
    try {
      return c.json(await service.registerEngine({ ...input, token }));
    } catch (error) {
      if (!(error instanceof CloudWorkspaceSetupMaterialError)) throw error;
      return c.json(
        { error: { code: error.code, retryable: error.retryable } },
        errorStatus(error),
      );
    }
  });

  routes.post(CLOUD_WORKSPACE_ENGINE_HEARTBEAT_PATH, async (c) => {
    const token = bearerToken(
      c.req.header("authorization"),
      HEARTBEAT_TOKEN_PATTERN,
    );
    if (!token) return c.json({ error: { code: "invalid_capability" } }, 401);
    const input = await strictJson(c.req, EngineHeartbeatBody);
    if (!input) return c.json({ error: { code: "invalid_request" } }, 422);
    try {
      const { repositoryCredentialRefresh, observedPorts, ...heartbeat } = input;
      return c.json(
        await service.heartbeat({
          ...heartbeat,
          token,
          ...(observedPorts === undefined ? {} : { observedPorts }),
          ...(repositoryCredentialRefresh === undefined
            ? {}
            : { repositoryCredentialRefresh }),
        }),
      );
    } catch (error) {
      if (!(error instanceof CloudWorkspaceSetupMaterialError)) throw error;
      return c.json(
        { error: { code: error.code, retryable: error.retryable } },
        errorStatus(error),
      );
    }
  });

  if (service.admitEngineClient) {
    routes.post(CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_PATH, async (c) => {
      const heartbeatToken = bearerToken(
        c.req.header("authorization"),
        HEARTBEAT_TOKEN_PATTERN,
      );
      if (!heartbeatToken) {
        return c.json({ error: { code: "invalid_capability" } }, 401);
      }
      const input = await strictJson(c.req, EngineClientAdmissionBody);
      if (!input) return c.json({ error: { code: "invalid_request" } }, 422);
      try {
        const { grantToken, ...scope } = input;
        return c.json(
          await service.admitEngineClient!({
            ...scope,
            token: grantToken,
            heartbeatToken,
          }),
        );
      } catch (error) {
        if (!(error instanceof CloudWorkspaceEngineClientAdmissionError)) {
          throw error;
        }
        return c.json({ error: { code: error.code } }, 401);
      }
    });
  }

  if (service.readRecoveryManifest && service.getRecoveryBlob) {
    routes.get(`${CLOUD_WORKSPACE_SETUP_RECOVERY_PATH}/manifest`, async (c) => {
      const token = bearerToken(
        c.req.header("authorization"),
        RECOVERY_TOKEN_PATTERN,
      );
      const afterPath = recoveryCursor(c.req.query("after"));
      const limitRaw = c.req.query("limit");
      const limit = limitRaw === undefined ? undefined : Number(limitRaw);
      if (
        !token ||
        afterPath === undefined ||
        (limit !== undefined &&
          (!Number.isSafeInteger(limit) || limit < 1 || limit > 500))
      ) {
        return c.json({ error: { code: "invalid_capability" } }, 401);
      }
      try {
        return c.json(
          await service.readRecoveryManifest!({
            token,
            afterPath,
            ...(limit === undefined ? {} : { limit }),
          }),
        );
      } catch (error) {
        if (!(error instanceof CloudWorkspaceSetupRecoveryError)) throw error;
        return c.json(
          { error: { code: error.code } },
          error.code === "recovery_blob_unavailable" ? 503 : 401,
        );
      }
    });
    routes.get(
      `${CLOUD_WORKSPACE_SETUP_RECOVERY_PATH}/blobs/:blobId`,
      async (c) => {
        const token = bearerToken(
          c.req.header("authorization"),
          RECOVERY_TOKEN_PATTERN,
        );
        const blobId = UUID.safeParse(c.req.param("blobId"));
        if (!token || !blobId.success) {
          return c.json({ error: { code: "invalid_capability" } }, 401);
        }
        try {
          const bytes = await service.getRecoveryBlob!({
            token,
            blobId: blobId.data,
          });
          return new Response(bytes, {
            status: 200,
            headers: {
              "cache-control": "no-store",
              "content-type": "application/octet-stream",
              "content-length": String(bytes.length),
              "x-content-type-options": "nosniff",
            },
          });
        } catch (error) {
          if (!(error instanceof CloudWorkspaceSetupRecoveryError)) throw error;
          return c.json(
            { error: { code: error.code } },
            error.code === "recovery_blob_unavailable" ? 503 : 401,
          );
        }
      },
    );
  }

  if (service.appendRecord) {
    routes.use(
      CLOUD_WORKSPACE_RECORD_APPEND_PATH,
      bodyLimit({ maxSize: RECORD_BODY_BYTES }),
    );
    routes.post(CLOUD_WORKSPACE_RECORD_APPEND_PATH, async (c) => {
      const token = bearerToken(
        c.req.header("authorization"),
        HEARTBEAT_TOKEN_PATTERN,
      );
      if (!token) return c.json({ error: { code: "invalid_capability" } }, 401);
      const input = await strictJson(c.req, RecordAppendBody);
      if (!input) return c.json({ error: { code: "invalid_request" } }, 422);
      try {
        return c.json(
          await service.appendRecord!({
            ...input,
            mutations: input.mutations.map(({ document, ...mutation }) =>
              document === undefined ? mutation : { ...mutation, document },
            ),
            heartbeatToken: token,
          }),
        );
      } catch (error) {
        if (!(error instanceof WorkspaceRecordError)) throw error;
        const response = durableErrorResponse(error);
        return c.json({ error: { code: response.code } }, response.status);
      }
    });
  }

  if (service.readRecordHead) {
    routes.get(CLOUD_WORKSPACE_RECORD_HEAD_PATH, async (c) => {
      const token = bearerToken(
        c.req.header("authorization"),
        HEARTBEAT_TOKEN_PATTERN,
      );
      const scope = RecordHeadScope.safeParse(c.req.query());
      if (!token || !scope.success) {
        return c.json({ error: { code: "invalid_request" } }, 422);
      }
      try {
        return c.json(
          await service.readRecordHead!({
            workspaceId: scope.data.workspaceId,
            organizationId: scope.data.organizationId,
            generation: scope.data.generation,
            engineInstanceId: scope.data.engineInstanceId,
            heartbeatToken: token,
            afterEntityKind: scope.data.afterEntityKind ?? null,
            afterEntityId: scope.data.afterEntityId ?? null,
            ...(scope.data.limit === undefined
              ? {}
              : { limit: scope.data.limit }),
          }),
        );
      } catch (error) {
        if (!(error instanceof WorkspaceRecordError)) throw error;
        const response = durableErrorResponse(error);
        return c.json({ error: { code: response.code } }, response.status);
      }
    });
  }

  if (service.appendContent) {
    routes.use(
      CLOUD_WORKSPACE_CONTENT_APPEND_PATH,
      bodyLimit({ maxSize: CONTENT_BODY_BYTES }),
    );
    routes.post(CLOUD_WORKSPACE_CONTENT_APPEND_PATH, async (c) => {
      const token = bearerToken(
        c.req.header("authorization"),
        HEARTBEAT_TOKEN_PATTERN,
      );
      if (!token) return c.json({ error: { code: "invalid_capability" } }, 401);
      const input = await strictJson(c.req, ContentAppendBody);
      if (!input) return c.json({ error: { code: "invalid_request" } }, 422);
      try {
        return c.json(
          await service.appendContent!({ ...input, heartbeatToken: token }),
        );
      } catch (error) {
        if (!(error instanceof WorkspaceContentError)) throw error;
        const response = durableErrorResponse(error);
        return c.json({ error: { code: response.code } }, response.status);
      }
    });
  }

  if (service.readContentHead) {
    routes.get(CLOUD_WORKSPACE_CONTENT_HEAD_PATH, async (c) => {
      const token = bearerToken(
        c.req.header("authorization"),
        HEARTBEAT_TOKEN_PATTERN,
      );
      const { after, ...rawScope } = c.req.query();
      const scope = ContentHeadScope.safeParse(rawScope);
      const afterPath = recoveryCursor(after);
      if (!token || !scope.success || afterPath === undefined) {
        return c.json({ error: { code: "invalid_request" } }, 422);
      }
      try {
        return c.json(
          await service.readContentHead!({
            workspaceId: scope.data.workspaceId,
            organizationId: scope.data.organizationId,
            generation: scope.data.generation,
            engineInstanceId: scope.data.engineInstanceId,
            ...(scope.data.limit === undefined
              ? {}
              : { limit: scope.data.limit }),
            afterPath,
            heartbeatToken: token,
          }),
        );
      } catch (error) {
        if (!(error instanceof WorkspaceContentError)) throw error;
        const response = durableErrorResponse(error);
        return c.json({ error: { code: response.code } }, response.status);
      }
    });
  }

  if (service.commitCheckpoint) {
    routes.use(
      CLOUD_WORKSPACE_CHECKPOINT_COMMIT_PATH,
      bodyLimit({ maxSize: 256 * 1024 }),
    );
    routes.post(CLOUD_WORKSPACE_CHECKPOINT_COMMIT_PATH, async (c) => {
      const token = bearerToken(
        c.req.header("authorization"),
        HEARTBEAT_TOKEN_PATTERN,
      );
      if (!token) return c.json({ error: { code: "invalid_capability" } }, 401);
      const input = await strictJson(c.req, CheckpointCommitBody);
      if (!input) return c.json({ error: { code: "invalid_request" } }, 422);
      try {
        const { requestId, ...checkpoint } = input;
        return c.json(
          await service.commitCheckpoint!({
            ...checkpoint,
            ...(requestId === undefined ? {} : { requestId }),
            heartbeatToken: token,
          }),
        );
      } catch (error) {
        if (!(error instanceof WorkspaceContentError)) throw error;
        const response = durableErrorResponse(error);
        return c.json({ error: { code: response.code } }, response.status);
      }
    });
  }

  if (service.putBlob && service.getBlob) {
    routes.use(
      CLOUD_WORKSPACE_BLOB_PATH,
      bodyLimit({ maxSize: BLOB_BODY_BYTES }),
    );
    routes.post(CLOUD_WORKSPACE_BLOB_PATH, async (c) => {
      const token = bearerToken(
        c.req.header("authorization"),
        HEARTBEAT_TOKEN_PATTERN,
      );
      if (!token) return c.json({ error: { code: "invalid_capability" } }, 401);
      if (
        c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/octet-stream"
      ) {
        return c.json({ error: { code: "invalid_request" } }, 422);
      }
      const query = BlobQuery.safeParse(c.req.query());
      if (!query.success) {
        return c.json({ error: { code: "invalid_request" } }, 422);
      }
      try {
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        return c.json(
          await service.putBlob!({
            ...query.data,
            heartbeatToken: token,
            bytes,
          }),
        );
      } catch (error) {
        if (!(error instanceof WorkspaceBlobError)) throw error;
        const response = durableErrorResponse(error);
        return c.json({ error: { code: response.code } }, response.status);
      }
    });
    routes.get(`${CLOUD_WORKSPACE_BLOB_PATH}/:blobId`, async (c) => {
      const token = bearerToken(
        c.req.header("authorization"),
        HEARTBEAT_TOKEN_PATTERN,
      );
      if (!token) return c.json({ error: { code: "invalid_capability" } }, 401);
      const query = BlobQuery.safeParse(c.req.query());
      const blobId = UUID.safeParse(c.req.param("blobId"));
      if (!query.success || !blobId.success) {
        return c.json({ error: { code: "invalid_request" } }, 422);
      }
      try {
        const bytes = await service.getBlob!({
          ...query.data,
          blobId: blobId.data,
          heartbeatToken: token,
        });
        return new Response(bytes, {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/octet-stream",
            "content-length": String(bytes.length),
            "x-content-type-options": "nosniff",
          },
        });
      } catch (error) {
        if (!(error instanceof WorkspaceBlobError)) throw error;
        const response = durableErrorResponse(error);
        return c.json({ error: { code: response.code } }, response.status);
      }
    });
  }

  if (service.ingestUsage) {
    routes.use(CLOUD_WORKSPACE_USAGE_PATH, bodyLimit({ maxSize: 64 * 1024 }));
    routes.post(CLOUD_WORKSPACE_USAGE_PATH, async (c) => {
      const token = bearerToken(
        c.req.header("authorization"),
        HEARTBEAT_TOKEN_PATTERN,
      );
      if (!token) return c.json({ error: { code: "invalid_capability" } }, 401);
      const input = await strictJson(c.req, UsageBody);
      if (!input) return c.json({ error: { code: "invalid_request" } }, 422);
      try {
        return c.json(
          await service.ingestUsage!({
            ...input,
            heartbeatToken: token,
          }),
        );
      } catch (error) {
        if (!(error instanceof CloudWorkspaceUsageError)) throw error;
        const response = durableErrorResponse(error);
        return c.json({ error: { code: response.code } }, response.status);
      }
    });
  }

  return routes;
}
