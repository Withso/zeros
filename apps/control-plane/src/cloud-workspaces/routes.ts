import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import type pg from "pg";
import { z } from "zod";

import { audit } from "../audit.js";
import {
  HttpError,
  requireOrganizationMembership,
  requireOrganizationRole,
} from "../authz.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx, withUserTx, type Tx } from "../db.js";
import { rateLimit } from "../ratelimit.js";
import type {
  CloudWorkspaceAccessService,
  CloudWorkspaceClientAccessKind,
} from "./access.js";
import { cancelCloudWorkspaceGenerationTransition } from "./generation-transitions.js";
import {
  retireCloudWorkspaceRuntimeAccess,
  type RetiredCloudWorkspaceRuntimeAccess,
} from "./runtime-access.js";

const UuidSchema = z.string().uuid();
const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const GithubNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/);
const FullCommitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
function validGitRevision(value: string): boolean {
  if (FullCommitPattern.test(value)) return true;
  if (
    value === "@" ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(character);
    })
  ) {
    return false;
  }
  return value
    .split("/")
    .every(
      (component) =>
        component.length > 0 &&
        !component.startsWith(".") &&
        !component.endsWith(".lock"),
    );
}
const RevisionSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(validGitRevision, "Invalid repository revision");

// Phase 1 will resolve placement-aware settings before generation creation.
// Until then, bind an explicit immutable empty snapshot rather than letting a
// worker read mutable settings after provisioning has begun.
const EMPTY_CLOUD_WORKSPACE_SETTINGS_SNAPSHOT = JSON.stringify({
  schemaVersion: 1,
  values: {},
});

const CreateWorkspaceSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    teamId: UuidSchema.optional(),
    repository: z
      .object({
        forge: z.literal("github.com"),
        owner: GithubNameSchema,
        name: GithubNameSchema,
        revision: RevisionSchema,
        githubInstallationId: UuidSchema,
      })
      .strict(),
  })
  .strict();

const GenerationTransitionSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("upgrade") }).strict(),
  z
    .object({
      operation: z.literal("rollback"),
      sourceGeneration: z.number().int().positive(),
    })
    .strict(),
]);
const AccessTtlSchema = z.number().int().min(5).max(60).default(15);
const SshAccessSchema = z
  .object({ expiresInMinutes: AccessTtlSchema })
  .strict();
const TunnelAccessSchema = z
  .object({
    remotePort: z.number().int().min(1).max(65_535),
    expiresInMinutes: AccessTtlSchema,
  })
  .strict();
const PreviewAccessSchema = z
  .object({
    port: z.number().int().min(1).max(65_535),
    expiresInMinutes: AccessTtlSchema,
  })
  .strict();

type LifecycleOperation = "stop" | "wake" | "archive" | "delete";

type WorkspaceRow = {
  id: string;
  org_id: string;
  team_id: string;
  created_by: string;
  display_name: string;
  repository_forge: string;
  repository_owner: string;
  repository_name: string;
  repository_revision: string;
  status: string;
  desired_state: string;
  current_generation: number;
  version: string | number;
  last_error_code: string | null;
  last_error_message: string | null;
  last_observed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
  provider: string;
  image_ref: string;
  architecture: string;
  cpu_millicores: number;
  memory_mib: number;
  storage_mib: number;
  source_commit: string | null;
  observed_state: string;
  provider_target: string | null;
  provider_last_observed_at: Date | string | null;
};

type IntentRow = {
  id: string;
  workspace_id: string;
  operation: "create" | LifecycleOperation;
  request_sha256: Buffer;
  state: string;
  attempt_count: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type GenerationTransitionRow = {
  id: string;
  operation: "upgrade" | "rollback";
  source_generation: number;
  template_generation: number;
  candidate_generation: number;
  state:
    | "draining"
    | "provisioning"
    | "setting_up"
    | "rolling_back"
    | "succeeded"
    | "rolled_back"
    | "rollback_failed"
    | "cancelled";
  error_code: string | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
};

const WORKSPACE_SELECT = `
  SELECT cw.id, cw.org_id, cw.team_id, cw.created_by, cw.display_name,
         cw.repository_forge, cw.repository_owner, cw.repository_name,
         cw.repository_revision, cw.status, cw.desired_state,
         cw.current_generation, cw.version, cw.last_error_code,
         cw.last_error_message, cw.last_observed_at, cw.created_at,
         cw.updated_at, cw.deleted_at, g.provider, g.image_ref,
         g.architecture, g.cpu_millicores, g.memory_mib, g.storage_mib,
         g.source_commit, pb.observed_state, pb.provider_target,
         pb.last_observed_at AS provider_last_observed_at
  FROM cloud_workspaces cw
  JOIN cloud_workspace_generations g
    ON g.workspace_id = cw.id AND g.generation = cw.current_generation
  JOIN cloud_workspace_provider_bindings pb
    ON pb.workspace_id = g.workspace_id AND pb.generation = g.generation`;

function parse<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(
      422,
      "invalid_input",
      result.error.issues[0]?.message ?? "Invalid input",
    );
  }
  return result.data;
}

function uuidParam(value: string | undefined): string {
  const result = UuidSchema.safeParse(value);
  if (!result.success) throw new HttpError(404, "not_found", "Not found");
  return result.data;
}

function idempotencyKey(raw: string | undefined): string {
  const result = IdempotencyKeySchema.safeParse(raw);
  if (!result.success) {
    throw new HttpError(
      422,
      "idempotency_key_required",
      "Idempotency-Key must contain 8-128 safe ASCII characters",
    );
  }
  return result.data;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const timestamp = value instanceof Date ? value : new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function workspaceDocument(row: WorkspaceRow) {
  return {
    id: row.id,
    organizationId: row.org_id,
    teamId: row.team_id,
    createdBy: row.created_by,
    name: row.display_name,
    placement: "cloud" as const,
    status: row.status,
    desiredState: row.desired_state,
    repository: {
      forge: row.repository_forge,
      owner: row.repository_owner,
      name: row.repository_name,
      revision: row.repository_revision,
    },
    generation: {
      number: row.current_generation,
      provider: row.provider,
      imageRef: row.image_ref,
      architecture: row.architecture,
      resources: {
        cpuMillicores: row.cpu_millicores,
        memoryMiB: row.memory_mib,
        storageMiB: row.storage_mib,
      },
      sourceCommit: row.source_commit,
      observedState: row.observed_state,
      providerTarget: row.provider_target,
      lastObservedAt: iso(row.provider_last_observed_at),
    },
    version: Number(row.version),
    error:
      row.last_error_code === null
        ? null
        : {
            code: row.last_error_code,
            message: row.last_error_message,
          },
    lastObservedAt: iso(row.last_observed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: iso(row.deleted_at),
  };
}

function intentDocument(row: IntentRow) {
  return {
    id: row.id,
    operation: row.operation,
    state: row.state,
    attemptCount: row.attempt_count,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function transitionDocument(row: GenerationTransitionRow) {
  return {
    id: row.id,
    operation: row.operation,
    sourceGeneration: row.source_generation,
    templateGeneration: row.template_generation,
    candidateGeneration: row.candidate_generation,
    state: row.state,
    error:
      row.error_code === null
        ? null
        : { code: row.error_code, message: row.error_message },
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: iso(row.completed_at),
  };
}

function requestDigest(value: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}

function sameDigest(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

async function loadWorkspace(
  tx: Tx,
  orgId: string,
  workspaceId: string,
  userId: string,
  options: { lock?: boolean } = {},
): Promise<WorkspaceRow> {
  await requireOrganizationMembership(tx, orgId, userId);
  const result = await tx.query<WorkspaceRow>(
    `${WORKSPACE_SELECT}
     JOIN team_members actor_team
       ON actor_team.team_id = cw.team_id
      AND actor_team.org_id = cw.org_id
      AND actor_team.user_id = $3
     WHERE cw.org_id = $1 AND cw.id = $2
     ${options.lock ? "FOR UPDATE OF cw" : ""}`,
    [orgId, workspaceId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, "not_found", "Cloud workspace not found");
  return row;
}

async function loadIntentByKey(
  tx: Tx,
  orgId: string,
  key: string,
): Promise<IntentRow | null> {
  const result = await tx.query<IntentRow>(
    `SELECT id, workspace_id, operation, request_sha256, state,
            attempt_count, created_at, updated_at
     FROM cloud_workspace_lifecycle_intents
     WHERE org_id = $1 AND idempotency_key = $2`,
    [orgId, key],
  );
  return result.rows[0] ?? null;
}

async function loadTransitionByRequestIntent(
  tx: Tx,
  orgId: string,
  workspaceId: string,
  intentId: string,
): Promise<GenerationTransitionRow | null> {
  const result = await tx.query<GenerationTransitionRow>(
    `SELECT id, operation, source_generation, template_generation,
            candidate_generation, state, error_code, error_message,
            created_at, updated_at, completed_at
     FROM cloud_workspace_generation_transitions
     WHERE org_id = $1 AND workspace_id = $2
       AND (drain_intent_id = $3 OR provision_intent_id = $3)`,
    [orgId, workspaceId, intentId],
  );
  return result.rows[0] ?? null;
}

function assertIdempotencyMatch(
  existing: IntentRow,
  expectedWorkspaceId: string | null,
  digest: Buffer,
): void {
  if (
    (expectedWorkspaceId !== null &&
      existing.workspace_id !== expectedWorkspaceId) ||
    !sameDigest(existing.request_sha256, digest)
  ) {
    throw new HttpError(
      409,
      "idempotency_key_reused",
      "Idempotency-Key was already used with different parameters",
    );
  }
}

async function lockCloudOrganization(
  tx: Tx,
  orgId: string,
): Promise<{
  is_personal: boolean;
  cloud_workspaces_allowed: boolean;
  workos_sync_state: string | null;
  workos_organization_id: string | null;
}> {
  const result = await tx.query<{
    is_personal: boolean;
    cloud_workspaces_allowed: boolean;
    workos_sync_state: string | null;
    workos_organization_id: string | null;
  }>(
    `SELECT o.is_personal, o.cloud_workspaces_allowed,
            wol.state::text AS workos_sync_state,
            wol.workos_organization_id
     FROM organizations o
     LEFT JOIN workos_organization_links wol ON wol.organization_id = o.id
     WHERE o.id = $1 AND o.deleted_at IS NULL
     FOR UPDATE OF o`,
    [orgId],
  );
  const organization = result.rows[0];
  if (!organization) {
    throw new HttpError(404, "not_found", "Organization not found");
  }
  return organization;
}

function assertCloudPlacementAllowed(organization: {
  is_personal: boolean;
  cloud_workspaces_allowed: boolean;
  workos_sync_state: string | null;
  workos_organization_id: string | null;
}, workosEnabled = false): void {
  if (organization.is_personal) {
    throw new HttpError(
      409,
      "personal_organization",
      "Personal workspaces are local-only",
    );
  }
  if (!organization.cloud_workspaces_allowed) {
    throw new HttpError(
      403,
      "cloud_workspaces_not_allowed",
      "Cloud workspaces are not allowed for this organization",
    );
  }
  if (
    workosEnabled &&
    (organization.workos_sync_state !== "active" ||
      !organization.workos_organization_id)
  ) {
    throw new HttpError(
      409,
      "organization_identity_not_ready",
      "Organization identity provisioning is not complete",
    );
  }
}

type QuotaRow = {
  max_workspaces: number;
  max_running_workspaces: number;
  max_cpu_millicores: number;
  max_memory_mib: number;
  max_storage_mib: number;
};

async function loadQuota(tx: Tx, orgId: string): Promise<QuotaRow> {
  const result = await tx.query<QuotaRow>(
    `SELECT max_workspaces, max_running_workspaces, max_cpu_millicores,
            max_memory_mib, max_storage_mib
     FROM cloud_workspace_quotas WHERE org_id = $1`,
    [orgId],
  );
  const quota = result.rows[0];
  if (!quota) {
    throw new HttpError(
      409,
      "cloud_quota_not_configured",
      "Cloud workspace quota is not configured for this organization",
    );
  }
  return quota;
}

type UsageRow = {
  workspaces: string | number;
  running: string | number;
  cpu_millicores: string | number;
  memory_mib: string | number;
  storage_mib: string | number;
};

async function loadUsage(tx: Tx, orgId: string): Promise<UsageRow> {
  const result = await tx.query<UsageRow>(
    `SELECT count(*) AS workspaces,
            count(*) FILTER (WHERE cw.desired_state = 'running') AS running,
            coalesce(sum(g.cpu_millicores) FILTER (
              WHERE cw.desired_state = 'running'
            ), 0) AS cpu_millicores,
            coalesce(sum(g.memory_mib) FILTER (
              WHERE cw.desired_state = 'running'
            ), 0) AS memory_mib,
            coalesce(sum(g.storage_mib), 0) AS storage_mib
     FROM cloud_workspaces cw
     JOIN cloud_workspace_generations g
       ON g.workspace_id = cw.id AND g.generation = cw.current_generation
     WHERE cw.org_id = $1 AND cw.status <> 'deleted'`,
    [orgId],
  );
  return result.rows[0]!;
}

function assertCreateQuota(
  quota: QuotaRow,
  usage: UsageRow,
  config: CloudWorkspaceBackendConfig,
): void {
  const exceeded =
    Number(usage.workspaces) + 1 > quota.max_workspaces ||
    Number(usage.running) + 1 > quota.max_running_workspaces ||
    Number(usage.cpu_millicores) + config.cpuMillicores >
      quota.max_cpu_millicores ||
    Number(usage.memory_mib) + config.memoryMiB > quota.max_memory_mib ||
    Number(usage.storage_mib) + config.storageMiB > quota.max_storage_mib;
  if (exceeded) {
    throw new HttpError(
      409,
      "cloud_quota_exceeded",
      "Cloud workspace quota would be exceeded",
    );
  }
}

function assertGenerationReplacementQuota(
  quota: QuotaRow,
  usage: UsageRow,
  resources: {
    cpuMillicores: number;
    memoryMiB: number;
    storageMiB: number;
  },
): void {
  const exceeded =
    Number(usage.cpu_millicores) + resources.cpuMillicores >
      quota.max_cpu_millicores ||
    Number(usage.memory_mib) + resources.memoryMiB > quota.max_memory_mib ||
    Number(usage.storage_mib) + resources.storageMiB > quota.max_storage_mib;
  if (exceeded) {
    throw new HttpError(
      409,
      "cloud_replacement_headroom_exceeded",
      "Cloud workspace quota does not have safe replacement headroom",
    );
  }
}

async function assertWakeQuota(
  tx: Tx,
  orgId: string,
  row: WorkspaceRow,
): Promise<void> {
  if (row.desired_state === "running") return;
  const quota = await loadQuota(tx, orgId);
  const usage = await loadUsage(tx, orgId);
  const exceeded =
    Number(usage.running) + 1 > quota.max_running_workspaces ||
    Number(usage.cpu_millicores) + row.cpu_millicores >
      quota.max_cpu_millicores ||
    Number(usage.memory_mib) + row.memory_mib > quota.max_memory_mib;
  if (exceeded) {
    throw new HttpError(
      409,
      "cloud_quota_exceeded",
      "Cloud workspace running quota would be exceeded",
    );
  }
}

function encodeCursor(row: WorkspaceRow): string {
  return Buffer.from(
    JSON.stringify({ createdAt: iso(row.created_at), id: row.id }),
  ).toString("base64url");
}

function decodeCursor(
  raw: string | undefined,
): { createdAt: string; id: string } | null {
  if (!raw) return null;
  if (raw.length > 512) {
    throw new HttpError(422, "invalid_cursor", "Invalid cursor");
  }
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const parsed = z
      .object({ createdAt: z.string().datetime(), id: UuidSchema })
      .strict()
      .parse(value);
    return parsed;
  } catch {
    throw new HttpError(422, "invalid_cursor", "Invalid cursor");
  }
}

export function createCloudWorkspaceRoutes(
  pool: pg.Pool,
  config: CloudWorkspaceBackendConfig | null,
  options: {
    accessService?: CloudWorkspaceAccessService | null;
    workosEnabled?: boolean;
  } = {},
): Hono {
  const app = new Hono();
  const accessService = options.accessService ?? null;
  const base = "/v1/organizations/:organization/cloud-workspaces";

  app.use(
    `${base}/:workspace/access/*`,
    rateLimit("cloud-workspace-access", 60, 60_000),
  );

  app.get(base, async (c) => {
    const user = c.get("user");
    const orgId = uuidParam(c.req.param("organization"));
    const cursor = decodeCursor(c.req.query("cursor"));
    const limitRaw = c.req.query("limit") ?? "50";
    if (!/^[1-9][0-9]{0,2}$/.test(limitRaw)) {
      throw new HttpError(422, "invalid_input", "Invalid limit");
    }
    const limit = Number(limitRaw);
    if (limit > 100) {
      throw new HttpError(422, "invalid_input", "Limit cannot exceed 100");
    }
    const includeDeleted = c.req.query("includeDeleted") === "true";

    const rows = await withUserTx(pool, user.id, async (tx) => {
      await requireOrganizationMembership(tx, orgId, user.id);
      const parameters: unknown[] = [orgId, user.id, limit + 1];
      let cursorSql = "";
      if (cursor) {
        parameters.push(cursor.createdAt, cursor.id);
        cursorSql = "AND (cw.created_at, cw.id) < ($4::timestamptz, $5::uuid)";
      }
      return (
        await tx.query<WorkspaceRow>(
          `${WORKSPACE_SELECT}
           JOIN team_members actor_team
             ON actor_team.team_id = cw.team_id
            AND actor_team.org_id = cw.org_id
            AND actor_team.user_id = $2
           WHERE cw.org_id = $1
             ${includeDeleted ? "" : "AND cw.status <> 'deleted'"}
             ${cursorSql}
           ORDER BY cw.created_at DESC, cw.id DESC
           LIMIT $3`,
          parameters,
        )
      ).rows;
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return c.json({
      workspaces: page.map(workspaceDocument),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]!) : null,
    });
  });

  app.get(`${base}/:workspace`, async (c) => {
    const user = c.get("user");
    const orgId = uuidParam(c.req.param("organization"));
    const workspaceId = uuidParam(c.req.param("workspace"));
    const row = await withUserTx(pool, user.id, (tx) =>
      loadWorkspace(tx, orgId, workspaceId, user.id),
    );
    return c.json({ workspace: workspaceDocument(row) });
  });

  const issueAccess = async (
    c: Context,
    kind: CloudWorkspaceClientAccessKind,
  ) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    if (!config || !accessService) {
      throw new HttpError(
        503,
        "cloud_workspace_access_not_configured",
        "Cloud workspace client access is not configured",
      );
    }
    const user = c.get("user");
    const organizationId = uuidParam(c.req.param("organization"));
    const workspaceId = uuidParam(c.req.param("workspace"));
    const key = idempotencyKey(c.req.header("Idempotency-Key"));
    const raw = await c.req.json().catch(() => ({}));
    const body =
      kind === "ssh"
        ? parse(SshAccessSchema, raw)
        : kind === "tunnel"
          ? parse(TunnelAccessSchema, raw)
          : parse(PreviewAccessSchema, raw);
    const remotePort =
      kind === "tunnel"
        ? (body as z.infer<typeof TunnelAccessSchema>).remotePort
        : kind === "preview"
          ? (body as z.infer<typeof PreviewAccessSchema>).port
          : undefined;
    const document = await accessService.issue({
      organizationId,
      workspaceId,
      accountUserId: user.id,
      kind,
      ...(remotePort === undefined ? {} : { remotePort }),
      expiresInMinutes: body.expiresInMinutes,
      idempotencyKey: key,
    });
    return c.json(document, 201);
  };

  app.post(`${base}/:workspace/access/ssh`, (c) => issueAccess(c, "ssh"));
  app.post(`${base}/:workspace/access/tunnels`, (c) =>
    issueAccess(c, "tunnel"),
  );
  app.post(`${base}/:workspace/access/previews`, (c) =>
    issueAccess(c, "preview"),
  );
  app.delete(`${base}/:workspace/access/:grant`, async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    if (!config || !accessService) {
      throw new HttpError(
        503,
        "cloud_workspace_access_not_configured",
        "Cloud workspace client access is not configured",
      );
    }
    const credential = c.req.header("X-Zeros-Access-Credential") ?? "";
    if (
      credential.length < 16 ||
      credential.length > 4_096 ||
      /[\u0000-\u0020\u007f]/.test(credential)
    ) {
      throw new HttpError(
        422,
        "cloud_access_credential_required",
        "An exact access credential is required for revocation",
      );
    }
    const user = c.get("user");
    await accessService.revoke({
      organizationId: uuidParam(c.req.param("organization")),
      workspaceId: uuidParam(c.req.param("workspace")),
      accountUserId: user.id,
      grantId: uuidParam(c.req.param("grant")),
      credential,
    });
    return c.body(null, 204);
  });

  app.post(base, async (c) => {
    if (!config) {
      throw new HttpError(
        503,
        "cloud_workspaces_not_configured",
        "Cloud workspace provisioning is not configured",
      );
    }
    const user = c.get("user");
    const orgId = uuidParam(c.req.param("organization"));
    const key = idempotencyKey(c.req.header("Idempotency-Key"));
    const body = parse(
      CreateWorkspaceSchema,
      await c.req.json().catch(() => ({})),
    );
    const normalized = {
      operation: "create" as const,
      organizationId: orgId,
      name: body.name ?? body.repository.name,
      teamId: body.teamId ?? null,
      repository: body.repository,
      provider: config.provider,
      imageRef: config.imageRef,
      architecture: config.architecture,
      resources: {
        cpuMillicores: config.cpuMillicores,
        memoryMiB: config.memoryMiB,
        storageMiB: config.storageMiB,
      },
    };
    const digest = requestDigest(normalized);

    const result = await withSystemTx(pool, async (tx) => {
      await requireOrganizationRole(tx, orgId, user.id, "admin");
      const organization = await lockCloudOrganization(tx, orgId);

      const existing = await loadIntentByKey(tx, orgId, key);
      if (existing) {
        assertIdempotencyMatch(existing, null, digest);
        const workspace = await loadWorkspace(
          tx,
          orgId,
          existing.workspace_id,
          user.id,
        );
        return { workspace, intent: existing, replayed: true };
      }
      assertCloudPlacementAllowed(
        organization,
        options.workosEnabled === true,
      );

      const team = await tx.query<{ id: string }>(
        `SELECT t.id
         FROM teams t
         JOIN team_members tm
           ON tm.team_id = t.id AND tm.org_id = t.org_id
          AND tm.user_id = $2 AND tm.role = 'maintainer'
         WHERE t.org_id = $1 AND t.deleted_at IS NULL
           AND t.id = coalesce($3::uuid, (
             SELECT dt.id FROM teams dt
             WHERE dt.org_id = $1 AND dt.is_default AND dt.deleted_at IS NULL
             ORDER BY dt.id LIMIT 1
           ))`,
        [orgId, user.id, body.teamId ?? null],
      );
      const teamId = team.rows[0]?.id;
      if (!teamId) {
        throw new HttpError(
          404,
          "team_not_found",
          "Authorized cloud workspace team not found",
        );
      }

      const installation = await tx.query(
        `SELECT 1
         FROM github_installations gi
         WHERE gi.id = $1 AND gi.suspended_at IS NULL
           AND lower(gi.account_login) = lower($4)
           AND (
             gi.org_id = $2
             OR (
               gi.owner_user_id = $3
               AND EXISTS (
                 SELECT 1 FROM github_authorizations ga
                 WHERE ga.owner_user_id = $3
                   AND ga.app_variant = gi.app_variant
               )
             )
           )`,
        [
          body.repository.githubInstallationId,
          orgId,
          user.id,
          body.repository.owner,
        ],
      );
      if ((installation.rowCount ?? 0) !== 1) {
        throw new HttpError(
          404,
          "github_installation_not_found",
          "Authorized GitHub installation not found",
        );
      }

      const quota = await loadQuota(tx, orgId);
      assertCreateQuota(quota, await loadUsage(tx, orgId), config);

      const workspaceId = randomUUID();
      const intentId = randomUUID();
      await tx.query(
        `INSERT INTO cloud_workspaces (
           id, org_id, team_id, created_by, display_name,
           repository_forge, repository_owner, repository_name,
           repository_revision, github_installation_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          workspaceId,
          orgId,
          teamId,
          user.id,
          normalized.name,
          body.repository.forge,
          body.repository.owner,
          body.repository.name,
          body.repository.revision,
          body.repository.githubInstallationId,
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by
         ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          workspaceId,
          orgId,
          config.provider,
          config.imageRef,
          config.architecture,
          config.cpuMillicores,
          config.memoryMiB,
          config.storageMiB,
          config.sourceCommit,
          user.id,
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_setup_specs (
           workspace_id, generation, org_id, repository_forge,
           repository_owner, repository_name, repository_revision,
           github_installation_id, settings_snapshot,
           settings_snapshot_sha256
         ) VALUES (
           $1, 1, $2, $3, $4, $5, $6, $7, $8::jsonb,
           digest($8::jsonb::text, 'sha256')
         )`,
        [
          workspaceId,
          orgId,
          body.repository.forge,
          body.repository.owner,
          body.repository.name,
          body.repository.revision,
          body.repository.githubInstallationId,
          EMPTY_CLOUD_WORKSPACE_SETTINGS_SNAPSHOT,
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider
         ) VALUES ($1, 1, $2, $3)`,
        [workspaceId, orgId, config.provider],
      );
      const insertedIntent = await tx.query<IntentRow>(
        `INSERT INTO cloud_workspace_lifecycle_intents (
           id, workspace_id, generation, org_id, requested_by, operation,
           idempotency_key, request_sha256
         ) VALUES ($1, $2, 1, $3, $4, 'create', $5, $6)
         RETURNING id, workspace_id, operation, request_sha256, state,
                   attempt_count, created_at, updated_at`,
        [intentId, workspaceId, orgId, user.id, key, digest],
      );
      await audit(tx, orgId, user.id, "cloud_workspace.create_requested", {
        workspaceId,
        intentId,
        teamId,
        repository: {
          forge: body.repository.forge,
          owner: body.repository.owner,
          name: body.repository.name,
        },
        generation: 1,
      });
      const workspace = await loadWorkspace(tx, orgId, workspaceId, user.id);
      return {
        workspace,
        intent: insertedIntent.rows[0]!,
        replayed: false,
      };
    });

    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(
      {
        workspace: workspaceDocument(result.workspace),
        intent: intentDocument(result.intent),
      },
      result.replayed ? 200 : 202,
    );
  });

  app.post(`${base}/:workspace/generations`, async (c) => {
    if (!config) {
      throw new HttpError(
        503,
        "cloud_workspaces_not_configured",
        "Cloud workspace provisioning is not configured",
      );
    }
    const user = c.get("user");
    const orgId = uuidParam(c.req.param("organization"));
    const workspaceId = uuidParam(c.req.param("workspace"));
    const key = idempotencyKey(c.req.header("Idempotency-Key"));
    const body = parse(
      GenerationTransitionSchema,
      await c.req.json().catch(() => ({})),
    );
    const normalized = {
      operation: "replace-generation" as const,
      transitionOperation: body.operation,
      organizationId: orgId,
      workspaceId,
      templateGeneration:
        body.operation === "rollback" ? body.sourceGeneration : null,
      upgradeTarget:
        body.operation === "upgrade"
          ? {
              provider: config.provider,
              imageRef: config.imageRef,
              architecture: config.architecture,
              cpuMillicores: config.cpuMillicores,
              memoryMiB: config.memoryMiB,
              storageMiB: config.storageMiB,
              sourceCommit: config.sourceCommit,
            }
          : null,
    };
    const digest = requestDigest(normalized);

    const result = await withSystemTx(pool, async (tx) => {
      await requireOrganizationRole(tx, orgId, user.id, "admin");
      const organization = await lockCloudOrganization(tx, orgId);
      const workspace = await loadWorkspace(tx, orgId, workspaceId, user.id, {
        lock: true,
      });
      const existing = await loadIntentByKey(tx, orgId, key);
      if (existing) {
        assertIdempotencyMatch(existing, workspaceId, digest);
        const transition = await loadTransitionByRequestIntent(
          tx,
          orgId,
          workspaceId,
          existing.id,
        );
        if (!transition) {
          throw new HttpError(
            409,
            "idempotency_key_reused",
            "Idempotency-Key was already used for another operation",
          );
        }
        return { workspace, intent: existing, transition, replayed: true };
      }

      assertCloudPlacementAllowed(organization);
      if (
        workspace.desired_state !== "running" ||
        workspace.status !== "ready" ||
        workspace.deleted_at !== null
      ) {
        throw new HttpError(
          409,
          "cloud_workspace_not_stable",
          "Cloud workspace must be ready before replacing its generation",
        );
      }
      const active = await tx.query(
        `SELECT 1
         FROM cloud_workspace_generation_transitions
         WHERE workspace_id = $1 AND org_id = $2
           AND state IN ('draining', 'provisioning', 'setting_up', 'rolling_back')`,
        [workspaceId, orgId],
      );
      if ((active.rowCount ?? 0) !== 0) {
        throw new HttpError(
          409,
          "cloud_generation_transition_active",
          "A cloud workspace generation transition is already active",
        );
      }
      const lifecycle = await tx.query(
        `SELECT 1 FROM cloud_workspace_lifecycle_intents
         WHERE workspace_id = $1 AND affects_workspace
           AND state IN ('queued', 'dispatching', 'observing')`,
        [workspaceId],
      );
      if ((lifecycle.rowCount ?? 0) !== 0) {
        throw new HttpError(
          409,
          "cloud_workspace_lifecycle_active",
          "Cloud workspace lifecycle work must finish before rebuilding",
        );
      }

      const templateGeneration =
        body.operation === "rollback"
          ? body.sourceGeneration
          : workspace.current_generation;
      if (
        body.operation === "rollback" &&
        templateGeneration >= workspace.current_generation
      ) {
        throw new HttpError(
          422,
          "invalid_rollback_generation",
          "Rollback must select an older qualified generation",
        );
      }
      const template = await tx.query<{
        provider: string;
        image_ref: string;
        architecture: "linux/amd64" | "linux/arm64";
        cpu_millicores: number;
        memory_mib: number;
        storage_mib: number;
        source_commit: string | null;
        repository_forge: string;
        repository_owner: string;
        repository_name: string;
        repository_revision: string;
        github_installation_id: string | null;
        spec_version: number;
        settings_snapshot: unknown;
        settings_snapshot_sha256: Buffer;
      }>(
        `SELECT g.provider, g.image_ref, g.architecture, g.cpu_millicores,
                g.memory_mib, g.storage_mib, g.source_commit,
                ss.repository_forge, ss.repository_owner, ss.repository_name,
                ss.repository_revision, ss.github_installation_id,
                ss.spec_version, ss.settings_snapshot,
                ss.settings_snapshot_sha256
         FROM cloud_workspace_generations g
         JOIN cloud_workspace_setup_specs ss
           ON ss.workspace_id = g.workspace_id
          AND ss.generation = g.generation AND ss.org_id = g.org_id
         WHERE g.workspace_id = $1 AND g.org_id = $2 AND g.generation = $3
           AND (
             $4::boolean = false
             OR EXISTS (
               SELECT 1 FROM cloud_workspace_setup_attestations sa
               WHERE sa.workspace_id = g.workspace_id
                 AND sa.generation = g.generation AND sa.org_id = g.org_id
             )
           )`,
        [workspaceId, orgId, templateGeneration, body.operation === "rollback"],
      );
      const source = template.rows[0];
      if (!source) {
        throw new HttpError(
          404,
          "cloud_generation_not_qualified",
          "Qualified cloud workspace generation not found",
        );
      }
      const secretCount = await tx.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM cloud_workspace_setup_secrets
         WHERE workspace_id = $1 AND org_id = $2 AND generation = $3`,
        [workspaceId, orgId, templateGeneration],
      );
      if (secretCount.rows[0]!.count !== 0) {
        // Secret ciphertext is bound to its original generation through AEAD
        // associated data. Copying rows would make undecryptable or replayable
        // material; a future settings resolver must explicitly re-seal them.
        throw new HttpError(
          409,
          "cloud_generation_secret_rebind_required",
          "Cloud workspace secrets must be rebound before rebuilding",
        );
      }

      const generationResources =
        body.operation === "upgrade"
          ? {
              cpuMillicores: config.cpuMillicores,
              memoryMiB: config.memoryMiB,
              storageMiB: config.storageMiB,
            }
          : {
              cpuMillicores: source.cpu_millicores,
              memoryMiB: source.memory_mib,
              storageMiB: source.storage_mib,
            };
      assertGenerationReplacementQuota(
        await loadQuota(tx, orgId),
        await loadUsage(tx, orgId),
        generationResources,
      );

      const nextGeneration = await tx.query<{ generation: number }>(
        `SELECT coalesce(max(generation), 0)::integer + 1 AS generation
         FROM cloud_workspace_generations
         WHERE workspace_id = $1`,
        [workspaceId],
      );
      const candidateGeneration = nextGeneration.rows[0]!.generation;
      const transitionId = randomUUID();
      const intentId = randomUUID();
      const candidate =
        body.operation === "upgrade"
          ? {
              provider: config.provider,
              imageRef: config.imageRef,
              architecture: config.architecture,
              cpuMillicores: config.cpuMillicores,
              memoryMiB: config.memoryMiB,
              storageMiB: config.storageMiB,
              sourceCommit: config.sourceCommit,
            }
          : {
              provider: source.provider,
              imageRef: source.image_ref,
              architecture: source.architecture,
              cpuMillicores: source.cpu_millicores,
              memoryMiB: source.memory_mib,
              storageMiB: source.storage_mib,
              sourceCommit: source.source_commit,
            };

      await retireCloudWorkspaceRuntimeAccess(tx, {
        workspaceId,
        organizationId: orgId,
        generation: workspace.current_generation,
        reason: "generation_replacement_requested",
      });
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          workspaceId,
          candidateGeneration,
          orgId,
          candidate.provider,
          candidate.imageRef,
          candidate.architecture,
          candidate.cpuMillicores,
          candidate.memoryMiB,
          candidate.storageMiB,
          candidate.sourceCommit,
          user.id,
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_setup_specs (
           workspace_id, generation, org_id, spec_version,
           repository_forge, repository_owner, repository_name,
           repository_revision, github_installation_id, settings_snapshot,
           settings_snapshot_sha256
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          workspaceId,
          candidateGeneration,
          orgId,
          source.spec_version,
          source.repository_forge,
          source.repository_owner,
          source.repository_name,
          source.repository_revision,
          source.github_installation_id,
          source.settings_snapshot,
          source.settings_snapshot_sha256,
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider
         ) VALUES ($1, $2, $3, $4)`,
        [workspaceId, candidateGeneration, orgId, candidate.provider],
      );
      const insertedIntent = await tx.query<IntentRow>(
        `INSERT INTO cloud_workspace_lifecycle_intents (
           id, workspace_id, generation, org_id, requested_by, operation,
           idempotency_key, request_sha256, affects_workspace
         ) VALUES ($1, $2, $3, $4, $5, 'stop', $6, $7, false)
         RETURNING id, workspace_id, operation, request_sha256, state,
                   attempt_count, created_at, updated_at`,
        [
          intentId,
          workspaceId,
          workspace.current_generation,
          orgId,
          user.id,
          key,
          digest,
        ],
      );
      const insertedTransition = await tx.query<GenerationTransitionRow>(
        `INSERT INTO cloud_workspace_generation_transitions (
           id, workspace_id, org_id, requested_by, operation,
           source_generation, template_generation, candidate_generation,
           state, drain_intent_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draining', $9)
         RETURNING id, operation, source_generation, template_generation,
                   candidate_generation, state, error_code, error_message,
                   created_at, updated_at, completed_at`,
        [
          transitionId,
          workspaceId,
          orgId,
          user.id,
          body.operation,
          workspace.current_generation,
          templateGeneration,
          candidateGeneration,
          intentId,
        ],
      );
      await tx.query(
        `UPDATE cloud_workspace_lifecycle_intents
         SET generation_transition_id = $2
         WHERE id = $1`,
        [intentId, transitionId],
      );
      await tx.query(
        `UPDATE cloud_workspaces
         SET current_generation = $2, status = 'provisioning',
             version = version + 1, last_error_code = NULL,
             last_error_message = NULL, updated_at = now()
         WHERE id = $1`,
        [workspaceId, candidateGeneration],
      );
      await audit(
        tx,
        orgId,
        user.id,
        `cloud_workspace.generation_${body.operation}_requested`,
        {
          workspaceId,
          transitionId,
          drainIntentId: intentId,
          sourceGeneration: workspace.current_generation,
          templateGeneration,
          candidateGeneration,
        },
      );
      return {
        workspace: await loadWorkspace(tx, orgId, workspaceId, user.id),
        intent: insertedIntent.rows[0]!,
        transition: insertedTransition.rows[0]!,
        replayed: false,
      };
    });

    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(
      {
        workspace: workspaceDocument(result.workspace),
        transition: transitionDocument(result.transition),
        intent: intentDocument(result.intent),
      },
      result.replayed ? 200 : 202,
    );
  });

  const lifecycle = async (c: Context, operation: LifecycleOperation) => {
    const user = c.get("user");
    const orgId = uuidParam(c.req.param("organization"));
    const workspaceId = uuidParam(c.req.param("workspace"));
    const key = idempotencyKey(c.req.header("Idempotency-Key"));
    const digest = requestDigest({
      operation,
      organizationId: orgId,
      workspaceId,
    });

    const result = await withSystemTx(pool, async (tx) => {
      await requireOrganizationRole(tx, orgId, user.id, "admin");
      const organization = await lockCloudOrganization(tx, orgId);
      let workspace = await loadWorkspace(tx, orgId, workspaceId, user.id, {
        lock: true,
      });
      const existing = await loadIntentByKey(tx, orgId, key);
      if (existing) {
        assertIdempotencyMatch(existing, workspaceId, digest);
        return { workspace, intent: existing, replayed: true };
      }
      if (operation === "wake" && !config) {
        throw new HttpError(
          503,
          "cloud_workspaces_not_configured",
          "Cloud workspace provisioning is not configured",
        );
      }
      if (operation === "wake") {
        assertCloudPlacementAllowed(
          organization,
          options.workosEnabled === true,
        );
        await assertWakeQuota(tx, orgId, workspace);
        const activeTransition = await tx.query(
          `SELECT 1 FROM cloud_workspace_generation_transitions
           WHERE workspace_id = $1 AND org_id = $2
             AND state IN ('draining', 'provisioning', 'setting_up', 'rolling_back')`,
          [workspaceId, orgId],
        );
        if ((activeTransition.rowCount ?? 0) !== 0) {
          throw new HttpError(
            409,
            "cloud_generation_transition_active",
            "Cloud workspace generation transition is already running",
          );
        }
      } else {
        const reason =
          operation === "stop"
            ? "workspace_stop_requested"
            : operation === "archive"
              ? "workspace_archive_requested"
              : "workspace_delete_requested";
        const restoredGeneration =
          await cancelCloudWorkspaceGenerationTransition(tx, {
            workspaceId,
            organizationId: orgId,
            reason,
          });
        if (restoredGeneration !== null) {
          workspace = await loadWorkspace(tx, orgId, workspaceId, user.id, {
            lock: true,
          });
        }
      }

      const alreadySatisfied =
        (operation === "stop" && workspace.status === "stopped") ||
        (operation === "wake" &&
          workspace.desired_state === "running" &&
          ["provisioning", "setting_up", "ready", "busy"].includes(
            workspace.status,
          )) ||
        (operation === "archive" && workspace.status === "archived") ||
        (operation === "delete" && workspace.status === "deleted");
      const desiredState =
        operation === "wake"
          ? "running"
          : operation === "stop"
            ? "stopped"
            : operation === "archive"
              ? "archived"
              : "deleted";
      const transitionStatus =
        operation === "wake"
          ? "waking"
          : operation === "stop"
            ? "stopping"
            : operation === "archive"
              ? "archiving"
              : "deleting";

      await tx.query(
        `UPDATE cloud_workspace_lifecycle_intents
         SET state = 'superseded', completed_at = now(), updated_at = now(),
             error_code = 'superseded_by_newer_intent',
             error_message = 'A newer lifecycle intent replaced this request'
         WHERE workspace_id = $1 AND affects_workspace
           AND state IN ('queued', 'observing')`,
        [workspaceId],
      );

      let retired: RetiredCloudWorkspaceRuntimeAccess = {
        revokedGrantCount: 0,
        revocationPendingClientAccessCount: 0,
        cancelledSetupRunCount: 0,
        revokedEngineInstanceCount: 0,
      };
      if (operation !== "wake") {
        retired = await retireCloudWorkspaceRuntimeAccess(tx, {
          workspaceId,
          organizationId: orgId,
          reason:
            operation === "stop"
              ? "workspace_stop_requested"
              : operation === "archive"
                ? "workspace_archive_requested"
                : "workspace_delete_requested",
        });
      }

      if (!alreadySatisfied) {
        await tx.query(
          `UPDATE cloud_workspaces
           SET desired_state = $2, status = $3, version = version + 1,
               updated_at = now(), last_error_code = NULL,
               last_error_message = NULL
           WHERE id = $1`,
          [workspaceId, desiredState, transitionStatus],
        );
      }

      const intentId = randomUUID();
      const inserted = await tx.query<IntentRow>(
        `INSERT INTO cloud_workspace_lifecycle_intents (
           id, workspace_id, generation, org_id, requested_by, operation,
           idempotency_key, request_sha256, state, completed_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9::cloud_workspace_intent_state,
           CASE WHEN $9 = 'succeeded' THEN now() ELSE NULL END
         )
         RETURNING id, workspace_id, operation, request_sha256, state,
                   attempt_count, created_at, updated_at`,
        [
          intentId,
          workspaceId,
          workspace.current_generation,
          orgId,
          user.id,
          operation,
          key,
          digest,
          alreadySatisfied ? "succeeded" : "queued",
        ],
      );
      await audit(
        tx,
        orgId,
        user.id,
        `cloud_workspace.${operation}_requested`,
        {
          workspaceId,
          intentId,
          alreadySatisfied,
          revokedGrantCount: retired.revokedGrantCount,
          revocationPendingClientAccessCount:
            retired.revocationPendingClientAccessCount,
          cancelledSetupRunCount: retired.cancelledSetupRunCount,
          revokedEngineInstanceCount: retired.revokedEngineInstanceCount,
        },
      );
      return {
        workspace: await loadWorkspace(tx, orgId, workspaceId, user.id),
        intent: inserted.rows[0]!,
        replayed: false,
      };
    });

    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(
      {
        workspace: workspaceDocument(result.workspace),
        intent: intentDocument(result.intent),
      },
      result.replayed ? 200 : 202,
    );
  };

  for (const operation of ["stop", "wake", "archive"] as const) {
    app.post(`${base}/:workspace/${operation}`, (c) => lifecycle(c, operation));
  }
  app.delete(`${base}/:workspace`, (c) => lifecycle(c, "delete"));

  return app;
}
