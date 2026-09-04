import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";

import { HttpError } from "../authz.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { rateLimit } from "../ratelimit.js";
import { DatabaseCloudWorkspaceManagementService } from "./management.js";
import type { DaytonaProviderConnectionQualifier } from "./provider-qualification.js";

const Uuid = z.string().uuid();
const ExpectedVersion = z.number().int().nonnegative();
const PositiveExpectedVersion = z.number().int().positive();
const SettingsDocument = z.record(z.string(), z.unknown());
const IdempotencyKey = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const EnvironmentName = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,127}$/);

const RepositorySettings = z
  .object({ expectedVersion: ExpectedVersion, document: SettingsDocument })
  .strict();
const EnvironmentProfileCreate = z
  .object({
    id: Uuid,
    name: z.string().trim().min(1).max(120),
    placement: z.enum(["local", "cloud", "both"]),
    isDefault: z.boolean().default(false),
    document: SettingsDocument,
  })
  .strict();
const EnvironmentProfileUpdate = z
  .object({
    expectedVersion: PositiveExpectedVersion,
    name: z.string().trim().min(1).max(120).optional(),
    placement: z.enum(["local", "cloud", "both"]).optional(),
    isDefault: z.boolean().optional(),
    document: SettingsDocument.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.placement !== undefined ||
      value.isDefault !== undefined ||
      value.document !== undefined,
    "At least one profile field is required",
  );
const ManagedPolicy = z
  .object({ expectedVersion: ExpectedVersion, document: SettingsDocument })
  .strict();
const ProfileConsent = z
  .object({
    id: Uuid,
    personalProfileId: Uuid,
    personalProfileVersion: PositiveExpectedVersion,
    allowedPaths: z
      .array(
        z
          .string()
          .min(9)
          .max(1_024)
          .regex(/^\/values\/(?:[^/~]|~[01])+(?:\/(?:[^/~]|~[01])+)*$/),
      )
      .min(1)
      .max(64),
    expiresAt: z.string().datetime().nullable().default(null),
  })
  .strict();
const SecretBindingCreate = z
  .object({
    id: Uuid,
    name: EnvironmentName,
    purpose: z.enum(["environment", "mcp", "provider", "agent"]),
    placement: z.enum(["cloud", "both"]),
    value: z.string().min(1).max(65_536),
  })
  .strict();
const Rotation = z
  .object({
    expectedVersion: PositiveExpectedVersion,
    value: z.string().min(1).max(65_536),
  })
  .strict();
const ProviderConnectionCreate = z
  .object({
    id: Uuid,
    ownerKind: z.enum(["user", "organization"]),
    displayName: z.string().trim().min(1).max(120),
    apiKey: z.string().min(16).max(65_536),
  })
  .strict();
const ProviderRotation = z
  .object({
    expectedVersion: PositiveExpectedVersion,
    apiKey: z.string().min(16).max(65_536),
  })
  .strict();
const Retention = z
  .object({
    expectedVersion: PositiveExpectedVersion,
    recordEventDays: z.number().int().min(1).max(3_650),
    contentEventDays: z.number().int().min(1).max(3_650),
    checkpointDays: z.number().int().min(1).max(3_650),
    exportDays: z.number().int().min(1).max(90),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(422, "invalid_input", parsed.error.issues[0]?.message ?? "Invalid input");
  }
  return parsed.data;
}

function uuid(value: string): string {
  return parse(Uuid, value);
}

function expectedVersion(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]{0,15}$/.test(value)) {
    throw new HttpError(422, "invalid_input", "A positive expectedVersion is required");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new HttpError(422, "invalid_input", "A positive expectedVersion is required");
  }
  return parsed;
}

function idempotency(value: string | undefined): string {
  return parse(IdempotencyKey, value ?? "");
}

export function createCloudWorkspaceManagementRoutes(
  pool: pg.Pool,
  config: CloudWorkspaceBackendConfig,
  options: {
    workosEnabled: boolean;
    qualifier?: DaytonaProviderConnectionQualifier;
  },
): Hono {
  const app = new Hono();
  const service = new DatabaseCloudWorkspaceManagementService(pool, config, options);
  const root = "/v1/organizations/:organization/cloud-workspace-management";
  const workspaceRoot = "/v1/organizations/:organization/cloud-workspaces/:workspace";

  app.use(`${root}/*`, rateLimit("cloud-workspace-management", 120, 60_000));
  app.use(
    `${workspaceRoot}/management/*`,
    rateLimit("cloud-workspace-management", 120, 60_000),
  );

  app.get(`${root}/repositories/:repository/settings`, async (c) =>
    c.json(
      await service.repositorySettings({
        organizationId: uuid(c.req.param("organization")),
        repositoryId: uuid(c.req.param("repository")),
        actorUserId: c.get("user").id,
      }),
    ),
  );
  app.put(`${root}/repositories/:repository/settings/:scope`, async (c) => {
    const scope = c.req.param("scope");
    if (scope !== "shared" && scope !== "cloud") {
      throw new HttpError(404, "not_found", "Settings scope not found");
    }
    const body = parse(RepositorySettings, await c.req.json().catch(() => ({})));
    const result = await service.putRepositorySettings({
      organizationId: uuid(c.req.param("organization")),
      repositoryId: uuid(c.req.param("repository")),
      actorUserId: c.get("user").id,
      scope,
      ...body,
    });
    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(result);
  });

  app.get(`${root}/environment-profiles`, async (c) =>
    c.json(
      await service.listEnvironmentProfiles({
        organizationId: uuid(c.req.param("organization")),
        actorUserId: c.get("user").id,
      }),
    ),
  );
  app.post(`${root}/environment-profiles`, async (c) => {
    const body = parse(EnvironmentProfileCreate, await c.req.json().catch(() => ({})));
    const result = await service.createEnvironmentProfile({
      organizationId: uuid(c.req.param("organization")),
      actorUserId: c.get("user").id,
      ...body,
      isDefault: body.isDefault ?? false,
    });
    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(result, result.replayed ? 200 : 201);
  });
  app.patch(`${root}/environment-profiles/:profile`, async (c) => {
    const body = parse(EnvironmentProfileUpdate, await c.req.json().catch(() => ({})));
    const result = await service.updateEnvironmentProfile({
      id: uuid(c.req.param("profile")),
      organizationId: uuid(c.req.param("organization")),
      actorUserId: c.get("user").id,
      expectedVersion: body.expectedVersion,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.placement !== undefined ? { placement: body.placement } : {}),
      ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
      ...(body.document !== undefined ? { document: body.document } : {}),
    });
    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(result);
  });
  app.delete(`${root}/environment-profiles/:profile`, async (c) => {
    const result = await service.deleteEnvironmentProfile({
      id: uuid(c.req.param("profile")),
      organizationId: uuid(c.req.param("organization")),
      actorUserId: c.get("user").id,
      expectedVersion: expectedVersion(c.req.query("expectedVersion")),
    });
    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(result);
  });

  app.get(`${root}/managed-policy`, async (c) =>
    c.json(
      await service.organizationManagedPolicy({
        organizationId: uuid(c.req.param("organization")),
        actorUserId: c.get("user").id,
      }),
    ),
  );
  app.put(`${root}/managed-policy`, async (c) => {
    const body = parse(ManagedPolicy, await c.req.json().catch(() => ({})));
    const result = await service.putOrganizationManagedPolicy({
      organizationId: uuid(c.req.param("organization")),
      actorUserId: c.get("user").id,
      ...body,
    });
    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(result);
  });

  app.get(`${root}/personal-profile-consents`, async (c) =>
    c.json(
      await service.listPersonalProfileConsents({
        organizationId: uuid(c.req.param("organization")),
        actorUserId: c.get("user").id,
      }),
    ),
  );
  app.post(`${root}/personal-profile-consents`, async (c) => {
    const body = parse(ProfileConsent, await c.req.json().catch(() => ({})));
    const result = await service.createPersonalProfileConsent({
      organizationId: uuid(c.req.param("organization")),
      actorUserId: c.get("user").id,
      ...body,
      expiresAt: body.expiresAt ?? null,
    });
    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(result, result.replayed ? 200 : 201);
  });
  app.delete(`${root}/personal-profile-consents/:consent`, async (c) => {
    const result = await service.revokePersonalProfileConsent({
      id: uuid(c.req.param("consent")),
      organizationId: uuid(c.req.param("organization")),
      actorUserId: c.get("user").id,
    });
    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(result);
  });

  app.get(`${root}/secret-bindings`, async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(
      await service.listSecretBindings({
        organizationId: uuid(c.req.param("organization")),
        actorUserId: c.get("user").id,
      }),
    );
  });
  app.post(`${root}/secret-bindings`, async (c) => {
    c.header("Cache-Control", "no-store");
    const body = parse(SecretBindingCreate, await c.req.json().catch(() => ({})));
    const result = await service.createSecretBinding({
      organizationId: uuid(c.req.param("organization")),
      actorUserId: c.get("user").id,
      ...body,
    });
    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(result, result.replayed ? 200 : 201);
  });
  app.post(`${root}/secret-bindings/:binding/rotate`, async (c) => {
    c.header("Cache-Control", "no-store");
    const body = parse(Rotation, await c.req.json().catch(() => ({})));
    const result = await service.rotateSecretBinding({
      id: uuid(c.req.param("binding")),
      organizationId: uuid(c.req.param("organization")),
      actorUserId: c.get("user").id,
      expectedVersion: body.expectedVersion,
      value: body.value,
    });
    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(result);
  });
  app.delete(`${root}/secret-bindings/:binding`, async (c) => {
    c.header("Cache-Control", "no-store");
    const result = await service.revokeSecretBinding({
      id: uuid(c.req.param("binding")),
      organizationId: uuid(c.req.param("organization")),
      actorUserId: c.get("user").id,
      expectedVersion: expectedVersion(c.req.query("expectedVersion")),
    });
    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(result);
  });

  app.get(`${root}/provider-connections`, async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(
      await service.listProviderConnections({
        organizationId: uuid(c.req.param("organization")),
        actorUserId: c.get("user").id,
      }),
    );
  });
  app.post(`${root}/provider-connections`, async (c) => {
    c.header("Cache-Control", "no-store");
    const body = parse(ProviderConnectionCreate, await c.req.json().catch(() => ({})));
    const result = await service.createProviderConnection({
      organizationId: uuid(c.req.param("organization")),
      actorUserId: c.get("user").id,
      ...body,
    });
    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(result, result.replayed ? 200 : 201);
  });
  app.post(`${root}/provider-connections/:connection/rotate`, async (c) => {
    c.header("Cache-Control", "no-store");
    const body = parse(ProviderRotation, await c.req.json().catch(() => ({})));
    const result = await service.rotateProviderConnection({
      id: uuid(c.req.param("connection")),
      organizationId: uuid(c.req.param("organization")),
      actorUserId: c.get("user").id,
      ...body,
    });
    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(result);
  });
  app.delete(`${root}/provider-connections/:connection`, async (c) => {
    c.header("Cache-Control", "no-store");
    const result = await service.revokeProviderConnection({
      id: uuid(c.req.param("connection")),
      organizationId: uuid(c.req.param("organization")),
      actorUserId: c.get("user").id,
      expectedVersion: expectedVersion(c.req.query("expectedVersion")),
    });
    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(result);
  });

  app.get(`${workspaceRoot}/management`, async (c) =>
    c.json(
      await service.workspaceOverview({
        organizationId: uuid(c.req.param("organization")),
        workspaceId: uuid(c.req.param("workspace")),
        actorUserId: c.get("user").id,
      }),
    ),
  );
  app.post(`${workspaceRoot}/management/checkpoints`, async (c) => {
    const result = await service.requestCheckpoint({
      organizationId: uuid(c.req.param("organization")),
      workspaceId: uuid(c.req.param("workspace")),
      actorUserId: c.get("user").id,
      idempotencyKey: idempotency(c.req.header("Idempotency-Key")),
    });
    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(result, result.replayed ? 200 : 202);
  });
  app.patch(`${workspaceRoot}/management/retention`, async (c) => {
    const body = parse(Retention, await c.req.json().catch(() => ({})));
    const result = await service.updateRetention({
      organizationId: uuid(c.req.param("organization")),
      workspaceId: uuid(c.req.param("workspace")),
      actorUserId: c.get("user").id,
      ...body,
    });
    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(result);
  });

  return app;
}
