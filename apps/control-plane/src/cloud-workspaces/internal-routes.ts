import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import {
  CloudWorkspaceSetupMaterialError,
  type CloudWorkspaceEngineHeartbeatInput,
  type CloudWorkspaceEngineRegistrationInput,
  type CloudWorkspaceSetupRedemptionInput,
} from "./setup-materials.js";

export const CLOUD_WORKSPACE_SETUP_ADMISSION_PATH =
  "/internal/v1/cloud-workspaces/setup/admission";
export const CLOUD_WORKSPACE_ENGINE_REGISTRATION_PATH =
  "/internal/v1/cloud-workspaces/engine/register";
export const CLOUD_WORKSPACE_ENGINE_HEARTBEAT_PATH =
  "/internal/v1/cloud-workspaces/engine/heartbeat";

const UUID = z.string().uuid();
const POSITIVE_INTEGER = z.number().int().safe().positive();
const SETUP_TOKEN_PATTERN = /^zws_[A-Za-z0-9_-]{43}$/;
const HEARTBEAT_TOKEN_PATTERN = /^zwh_[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const INTERNAL_BODY_BYTES = 64 * 1024;

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

export interface CloudWorkspaceInternalSetupService {
  redeem(input: CloudWorkspaceSetupRedemptionInput): Promise<unknown>;
  registerEngine(
    input: CloudWorkspaceEngineRegistrationInput,
  ): Promise<unknown>;
  heartbeat(input: CloudWorkspaceEngineHeartbeatInput): Promise<unknown>;
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
  routes.use(
    "/internal/v1/cloud-workspaces/*",
    bodyLimit({ maxSize: INTERNAL_BODY_BYTES }),
  );

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
      const { repositoryCredentialRefresh, ...heartbeat } = input;
      return c.json(
        await service.heartbeat({
          ...heartbeat,
          token,
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

  return routes;
}
