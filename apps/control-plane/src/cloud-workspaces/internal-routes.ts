import { Hono, type MiddlewareHandler } from "hono";
import {createCloudAgentExecutionRoutes} from "./agent-credential-routes.js";
import type {DatabaseCloudAgentExecutionService} from "./agent-executions.js";
import { HttpError } from "../authz.js";
import { CLOUD_ACTOR_ADMISSION_PATH, CLOUD_ACTOR_TOKEN_PATTERN } from "./actor-sessions.js";
import { CloudWorkspaceEngineAuthorityError } from "./engine-authority.js";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { createCloudCommandRoutes } from "./command-routes.js";
import type { DatabaseCloudWorkspaceCommandService } from "./commands.js";
import { createCloudEventRoutes } from "./event-routes.js";
import type { DatabaseCloudWorkspaceEventService } from "./event-streams.js";
import { createCloudActionRoutes } from "./action-routes.js";
import type { DatabaseCloudWorkspaceActionService } from "./action-receipts.js";

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
  MAX_WORKSPACE_BLOB_BATCH_ENTRIES,
  MAX_WORKSPACE_BLOB_BATCH_BYTES,
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
import {
  CLOUD_RUNTIME_ACCESS_ADMISSION_PATH,
  CloudRuntimeAccessAdmissionError,
  type DatabaseCloudRuntimeAccessAdmissionService,
} from "./runtime-access-admission.js";

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
    materialVersion: z.literal(2).optional(),
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
    actorProtocolVersion: z.literal(2).optional(),
    agentRuntime:z.object({profile:z.literal("zeros-cloud-worker-v3"),contractSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional(),
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
    renew: z.boolean().optional(),
  })
  .strict();

const EngineScope = {
  workspaceId: UUID,
  organizationId: UUID,
  generation: POSITIVE_INTEGER,
  engineInstanceId: UUID,
} as const;
const BlobBatchBody = z.object({
  ...EngineScope,
  entries: z.array(z.object({ bytesBase64: z.string().max(Math.ceil(MAX_WORKSPACE_BLOB_BATCH_BYTES / 3) * 4)
    .refine(value => value.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(value)) }).strict())
    .min(1).max(MAX_WORKSPACE_BLOB_BATCH_ENTRIES),
}).strict();
let activeBlobBatchBodies = 0;
let activeBlobIngressBytes = 0;

const RuntimeAccessAdmissionBody = z
  .object({
    ...EngineScope,
    grantToken: z.string().regex(/^(?:zwp|zsh)_[A-Za-z0-9_-]{43}$/),
    relativeLease: z.literal(true).optional(),
  })
  .strict();

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
    artifactBlobIds: z.array(UUID).max(1_024).optional(),
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
  agentExecutions?: DatabaseCloudAgentExecutionService;
  commands?: DatabaseCloudWorkspaceCommandService;
  events?: DatabaseCloudWorkspaceEventService;
  actions?: DatabaseCloudWorkspaceActionService;
  redeem(input: CloudWorkspaceSetupRedemptionInput): Promise<unknown>;
  registerEngine(
    input: CloudWorkspaceEngineRegistrationInput,
  ): Promise<unknown>;
  heartbeat(input: CloudWorkspaceEngineHeartbeatInput): Promise<unknown>;
  admitEngineClient?: DatabaseCloudWorkspaceEngineClientAdmissionService["consume"];
  admitActorClient?: DatabaseCloudWorkspaceEngineClientAdmissionService["consumeActor"];
  admitRuntimeAccess?: DatabaseCloudRuntimeAccessAdmissionService["admit"];
  appendRecord?: DatabaseCloudWorkspaceDurableRecordService["append"];
  readRecordHead?: DatabaseCloudWorkspaceDurableRecordService["headForEngine"];
  appendContent?: DatabaseCloudWorkspaceContentService["append"];
  readContentHead?: DatabaseCloudWorkspaceContentService["headForEngine"];
  commitCheckpoint?: DatabaseCloudWorkspaceContentService["commitCheckpoint"];
  authorizeBlobUpload?: DatabaseCloudWorkspaceBlobService["authorizeUpload"];
  putBlob?: DatabaseCloudWorkspaceBlobService["put"];
  putBlobBatch?: DatabaseCloudWorkspaceBlobService["putBatch"];
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

class WorkspaceBlobBodyError extends Error {
  constructor(readonly status: 408 | 413) { super("Workspace upload body did not complete"); }
}
async function readWorkspaceBlobBody(request: Request, maximum: number): Promise<Buffer> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > maximum)) throw new WorkspaceBlobBodyError(413);
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const slabs: Buffer[] = [];
  let slab: Buffer | undefined, used = 0, allocated = 0;
  let length = 0, fragments = 0, done = false, expired = false, cancellation: Promise<void> | null = null;
  const abort = () => {
    expired = true;
    // Cancel closes the active read. Avoid a new Promise.race reaction on one
    // shared pending deadline for every tiny network fragment.
    cancellation ??= reader.cancel().catch(() => undefined);
  };
  const timer = setTimeout(abort, 15_000);
  timer.unref();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  try {
    while (true) {
      const chunk = await reader.read();
      if (expired) { if (!chunk.done) chunk.value.fill(0); throw new WorkspaceBlobBodyError(408); }
      if (chunk.done) { done = true; break; }
      length += chunk.value.byteLength;
      try {
        if (length > maximum) throw new WorkspaceBlobBodyError(413);
        let offset = 0;
        while (offset < chunk.value.byteLength) {
          if (!slab || used === slab.length) {
            slab = Buffer.allocUnsafe(Math.min(64 * 1024, maximum - allocated));
            allocated += slab.length; used = 0; slabs.push(slab);
          }
          const count = Math.min(slab.length - used, chunk.value.byteLength - offset);
          slab.set(chunk.value.subarray(offset, offset + count), used);
          used += count; offset += count;
        }
      } finally { chunk.value.fill(0); }
      if (++fragments % 256 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (declared !== null && length !== Number(declared)) throw new WorkspaceBlobBodyError(413);
    return Buffer.concat(slabs, length);
  } finally {
    clearTimeout(timer); request.signal.removeEventListener("abort", abort);
    if (!done) cancellation ??= reader.cancel().catch(() => undefined);
    await cancellation;
    for (const slab of slabs) slab.fill(0);
    reader.releaseLock();
  }
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
export const CLOUD_WORKSPACE_INTERNAL_PATHS = [
  "/internal/v1/cloud-workspaces/*",
  "/internal/v2/cloud-workspaces/*",
] as const;

export const cloudWorkspaceInternalResponseHeaders: MiddlewareHandler = async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  c.header("X-Content-Type-Options", "nosniff");
  await next();
};

export function createCloudWorkspaceInternalRoutes(
  service: CloudWorkspaceInternalSetupService,
): Hono {
  const routes = new Hono();
  const authenticateBlobIngress: MiddlewareHandler = async (c, next) => {
    if (c.req.method !== "POST") return next();
    const token = bearerToken(c.req.header("authorization"), HEARTBEAT_TOKEN_PATTERN);
    if (!token) return c.json({ error: { code: "invalid_capability" } }, 401);
    if (!service.authorizeBlobUpload) return c.json({ error: { code: "object_store_unavailable" } }, 503);
    try { await service.authorizeBlobUpload(token); }
    catch (error) {
      if (!(error instanceof WorkspaceBlobError)) throw error;
      const response = durableErrorResponse(error);
      return c.json({ error: { code: response.code } }, response.status);
    }
    return next();
  };
  for (const path of CLOUD_WORKSPACE_INTERNAL_PATHS) routes.use(path, cloudWorkspaceInternalResponseHeaders);
  if (service.commands) routes.route("/", createCloudCommandRoutes(service.commands));
  if (service.events) routes.route("/", createCloudEventRoutes(service.events));
  if (service.actions) routes.route("/", createCloudActionRoutes(service.actions));
  if (service.agentExecutions) routes.route("/",createCloudAgentExecutionRoutes(service.agentExecutions));
  for (const path of [
    CLOUD_WORKSPACE_SETUP_ADMISSION_PATH,
    CLOUD_WORKSPACE_ENGINE_REGISTRATION_PATH,
    CLOUD_WORKSPACE_ENGINE_HEARTBEAT_PATH,
    CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_PATH,
    CLOUD_ACTOR_ADMISSION_PATH,
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
      const {actorProtocolVersion,agentRuntime,...binding}=input;
      return c.json(await service.registerEngine({ ...binding, token,
        ...(actorProtocolVersion===undefined?{}:{actorProtocolVersion}),...(agentRuntime===undefined?{}:{agentRuntime}) }));
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
      const { repositoryCredentialRefresh, observedPorts, ...heartbeat } =
        input;
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

  if (service.admitActorClient) {
    routes.post(CLOUD_ACTOR_ADMISSION_PATH, async c => {
      c.header("Cache-Control","no-store");
      const heartbeatToken=bearerToken(c.req.header("authorization"),HEARTBEAT_TOKEN_PATTERN);
      if (!heartbeatToken) return c.json({error:{code:"invalid_capability"}},401);
      const input=await strictJson(c.req,EngineClientAdmissionBody.extend({grantToken:z.string().regex(CLOUD_ACTOR_TOKEN_PATTERN)}));
      if (!input) return c.json({error:{code:"invalid_request"}},422);
      try {
        const {grantToken,renew,...scope}=input;
        return c.json(await service.admitActorClient!({...scope,token:grantToken,heartbeatToken,
          ...(renew===undefined?{}:{renew})}));
      } catch (error) {
        if (!(error instanceof HttpError) && !(error instanceof CloudWorkspaceEngineAuthorityError) && !(error instanceof CloudWorkspaceEngineClientAdmissionError)) throw error;
        return c.json({error:{code:"cloud_actor_admission_rejected"}},401);
      }
    });
  }
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
        const { grantToken, renew, ...scope } = input;
        return c.json(
          await service.admitEngineClient!({
            ...scope,
            ...(renew === undefined ? {} : { renew }),
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

  if (service.admitRuntimeAccess) {
    routes.post(CLOUD_RUNTIME_ACCESS_ADMISSION_PATH, async (c) => {
      const heartbeatToken = bearerToken(
        c.req.header("authorization"),
        HEARTBEAT_TOKEN_PATTERN,
      );
      if (!heartbeatToken)
        return c.json({ error: { code: "invalid_capability" } }, 401);
      const input = await strictJson(c.req, RuntimeAccessAdmissionBody);
      if (!input) return c.json({ error: { code: "invalid_request" } }, 422);
      try {
        const { grantToken, relativeLease, ...scope } = input;
        return c.json(
          await service.admitRuntimeAccess!({
            ...scope,
            token: grantToken,
            heartbeatToken,
            ...(relativeLease ? { relativeLease } : {}),
          }),
        );
      } catch (error) {
        if (!(error instanceof CloudRuntimeAccessAdmissionError)) throw error;
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
      const version = c.req.query("version");
      if (
        !token ||
        afterPath === undefined ||
        (version !== undefined && version !== "1" && version !== "2") ||
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
            ...(version === undefined ? {} : { version: version === "2" ? 2 : 1 }),
          }),
        );
      } catch (error) {
        if (!(error instanceof CloudWorkspaceSetupRecoveryError)) throw error;
        return c.json(
          { error: { code: error.code } },
          error.code === "recovery_blob_unavailable" ? 503
            : error.code === "recovery_format_unsupported" ? 409 : 401,
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
      if (!token) return c.json({ error: { code: "invalid_capability" } }, 401);
      const scope = RecordHeadScope.safeParse(c.req.query());
      if (!scope.success) {
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
      if (!token) return c.json({ error: { code: "invalid_capability" } }, 401);
      const { after, ...rawScope } = c.req.query();
      const scope = ContentHeadScope.safeParse(rawScope);
      const afterPath = recoveryCursor(after);
      if (!scope.success || afterPath === undefined) {
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
        const { requestId, artifactBlobIds, ...checkpoint } = input;
        return c.json(
          await service.commitCheckpoint!({
            ...checkpoint,
            ...(requestId === undefined ? {} : { requestId }),
            ...(artifactBlobIds === undefined ? {} : { artifactBlobIds }),
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

  if (service.putBlobBatch) {
    const path = `${CLOUD_WORKSPACE_BLOB_PATH}/batch`;
    routes.use(path, authenticateBlobIngress);
    routes.use(path, async (c, next) => {
      if (!bearerToken(c.req.header("authorization"), HEARTBEAT_TOKEN_PATTERN)) return c.json({ error: { code: "invalid_capability" } }, 401);
      if (!contentTypeIsJson(c.req.header("content-type"))) return c.json({ error: { code: "invalid_request" } }, 422);
      if (activeBlobBatchBodies >= 8 || activeBlobIngressBytes + 6 * 1024 * 1024 > 128 * 1024 * 1024) return c.json({ error: { code: "object_store_unavailable" } }, 503);
      activeBlobBatchBodies += 1; activeBlobIngressBytes += 6 * 1024 * 1024;
      try { await next(); } finally { activeBlobBatchBodies -= 1; activeBlobIngressBytes -= 6 * 1024 * 1024; }
    });
    routes.post(path, async c => {
      const token = bearerToken(c.req.header("authorization"), HEARTBEAT_TOKEN_PATTERN);
      if (!token) return c.json({ error: { code: "invalid_capability" } }, 401);
      const entries: Buffer[] = [];
      let bodyBytes: Buffer | undefined;
      try {
        bodyBytes = await readWorkspaceBlobBody(c.req.raw, 6 * 1024 * 1024);
        let parsed: z.SafeParseReturnType<unknown, z.infer<typeof BlobBatchBody>>;
        try { parsed = BlobBatchBody.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes))); }
        catch { return c.json({ error: { code: "invalid_request" } }, 422); }
        if (!parsed.success) return c.json({ error: { code: "invalid_request" } }, 422);
        const input = parsed.data;
        let total = 0;
        for (const entry of input.entries) {
          const bytes = Buffer.from(entry.bytesBase64, "base64");
          entries.push(bytes); total += bytes.length;
          if (bytes.toString("base64") !== entry.bytesBase64 || total > MAX_WORKSPACE_BLOB_BATCH_BYTES) {
            return c.json({ error: { code: "invalid_request" } }, 422);
          }
        }
        return c.json(await service.putBlobBatch!({ ...input, entries, heartbeatToken: token, signal: c.req.raw.signal }));
      } catch (error) {
        if (error instanceof WorkspaceBlobBodyError) return c.json({ error: { code: "invalid_request" } }, error.status);
        if (!(error instanceof WorkspaceBlobError)) throw error;
        const response = durableErrorResponse(error);
        return c.json({ error: { code: response.code } }, response.status);
      } finally { bodyBytes?.fill(0); for (const bytes of entries) bytes.fill(0); }
    });
  }

  if (service.putBlob && service.getBlob) {
    routes.use(CLOUD_WORKSPACE_BLOB_PATH, authenticateBlobIngress);
    routes.use(CLOUD_WORKSPACE_BLOB_PATH, async (c, next) => {
      if (c.req.method !== "POST") return next();
      if (!bearerToken(c.req.header("authorization"), HEARTBEAT_TOKEN_PATTERN)) return c.json({ error: { code: "invalid_capability" } }, 401);
      if (c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/octet-stream") return c.json({ error: { code: "invalid_request" } }, 422);
      if (activeBlobIngressBytes + BLOB_BODY_BYTES > 128 * 1024 * 1024) return c.json({ error: { code: "object_store_unavailable" } }, 503);
      activeBlobIngressBytes += BLOB_BODY_BYTES;
      try { await next(); } finally { activeBlobIngressBytes -= BLOB_BODY_BYTES; }
    });
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
      let bytes: Buffer | undefined;
      try {
        bytes = await readWorkspaceBlobBody(c.req.raw, BLOB_BODY_BYTES);
        return c.json(
          await service.putBlob!({
            ...query.data,
            heartbeatToken: token,
            bytes,
            signal: c.req.raw.signal,
          }),
        );
      } catch (error) {
        if (error instanceof WorkspaceBlobBodyError) return c.json({ error: { code: "invalid_request" } }, error.status);
        if (!(error instanceof WorkspaceBlobError)) throw error;
        const response = durableErrorResponse(error);
        return c.json({ error: { code: response.code } }, response.status);
      } finally { bytes?.fill(0); }
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
