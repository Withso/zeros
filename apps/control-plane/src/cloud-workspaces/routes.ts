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
const RevisionSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !/[\0\r\n]/.test(value), "Invalid repository revision");

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

const LifecycleOperationSchema = z.enum([
  "stop",
  "wake",
  "archive",
  "delete",
]);
type LifecycleOperation = z.infer<typeof LifecycleOperationSchema>;

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

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
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

function assertIdempotencyMatch(
  existing: IntentRow,
  expectedWorkspaceId: string | null,
  digest: Buffer,
): void {
  if (
    (expectedWorkspaceId !== null && existing.workspace_id !== expectedWorkspaceId) ||
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

function decodeCursor(raw: string | undefined): { createdAt: string; id: string } | null {
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
  options: { workosEnabled?: boolean } = {},
): Hono {
  const app = new Hono();
  const base = "/v1/organizations/:organization/cloud-workspaces";

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
        [body.repository.githubInstallationId, orgId, user.id],
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
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider
         ) VALUES ($1, 1, $2, $3)`,
        [workspaceId, orgId, config.provider],
      );
      const insertedIntent = await tx.query<IntentRow>(
        `INSERT INTO cloud_workspace_lifecycle_intents (
           id, workspace_id, org_id, requested_by, operation,
           idempotency_key, request_sha256
         ) VALUES ($1, $2, $3, $4, 'create', $5, $6)
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

  const lifecycle = async (
    c: Context,
    operation: LifecycleOperation,
  ) => {
    const user = c.get("user");
    const orgId = uuidParam(c.req.param("organization"));
    const workspaceId = uuidParam(c.req.param("workspace"));
    const key = idempotencyKey(c.req.header("Idempotency-Key"));
    const digest = requestDigest({ operation, organizationId: orgId, workspaceId });

    const result = await withSystemTx(pool, async (tx) => {
      await requireOrganizationRole(tx, orgId, user.id, "admin");
      const organization = await lockCloudOrganization(tx, orgId);
      const workspace = await loadWorkspace(tx, orgId, workspaceId, user.id, {
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
         WHERE workspace_id = $1 AND state = 'queued'`,
        [workspaceId],
      );

      if (!alreadySatisfied) {
        if (["stop", "archive", "delete"].includes(operation)) {
          await tx.query(
            `UPDATE cloud_workspace_endpoint_grants
             SET revoked_at = coalesce(revoked_at, now())
             WHERE workspace_id = $1
               AND ($2 = 'delete' OR purpose = 'engine-connect')`,
            [workspaceId, operation],
          );
        }
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
           id, workspace_id, org_id, requested_by, operation,
           idempotency_key, request_sha256, state, completed_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8::cloud_workspace_intent_state,
           CASE WHEN $8 = 'succeeded' THEN now() ELSE NULL END
         )
         RETURNING id, workspace_id, operation, request_sha256, state,
                   attempt_count, created_at, updated_at`,
        [
          intentId,
          workspaceId,
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
        { workspaceId, intentId, alreadySatisfied },
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
