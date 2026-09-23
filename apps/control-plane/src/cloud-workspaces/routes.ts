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
import type {
  CloudWorkspaceBackendConfig,
  CloudWorkspaceProvisioningProfile,
} from "../config.js";
import { withSystemTx, withUserTx, type Tx } from "../db.js";
import { rateLimit } from "../ratelimit.js";
import type {
  CloudWorkspaceAccessService,
  CloudWorkspaceClientAccessKind,
} from "./access.js";
import {
  authorizeCloudWorkspaceOperation,
  authorizeCloudWorkspaceDataAccess,
  type CloudWorkspaceAuthorization,
} from "./authorization.js";
import { cancelCloudWorkspaceGenerationTransition } from "./generation-transitions.js";
import { enqueueWorkspaceCheckpointRequest } from "./checkpoint-requests.js";
import { MAX_WORKSPACE_FILE_BYTES } from "./content-record.js";
import {
  CloudWorkspaceEngineClientAdmissionError,
  type DatabaseCloudWorkspaceEngineClientAdmissionService,
} from "./engine-client-admission.js";
import {
  forkErrorToHttp,
  type DatabaseCloudWorkspaceForkService,
  WorkspaceForkError,
} from "./forks.js";
import {
  replicaErrorToHttp,
  type CloudWorkspaceDeviceProof,
  type DatabaseCloudWorkspaceReplicaService,
  WorkspaceReplicaError,
} from "./replicas.js";
import type {
  CloudWorkspaceRepositoryIdentity,
  CloudWorkspaceRepositoryResolver,
} from "./github-repositories.js";
import { createCloudWorkspaceManagementRoutes } from "./management-routes.js";
import { DatabaseManagedComputeCreditLedger } from "./compute-credits.js";
import {DatabaseComputeUserFunding} from "./compute-funding.js";
import { authorizeCloudWorkspaceCleanup, authorizeCloudWorkspaceActor, DatabaseCloudWorkspaceCollaborationService } from "./actors.js";
import type { CloudWorkspaceProviderName } from "./provider.js";
import type { DaytonaProviderConnectionQualifier } from "./provider-qualification.js";
import {
  ensureHostedCloudProviderConnection,
  loadGenerationCloudProviderConnection,
  selectCloudProviderConnectionForNewGeneration,
} from "./provider-connections.js";
import {
  configuredCloudWorkspaceProviders,
  cloudWorkspaceProvisioningProfile,
} from "./provisioning-profile.js";
import { refreshCloudWorkspaceBillingEpoch } from "./paid-authority.js";
import {
  retireCloudWorkspaceRuntimeAccess,
  type RetiredCloudWorkspaceRuntimeAccess,
} from "./runtime-access.js";
import {
  cloneDatabaseCloudWorkspaceSettingsForRollback,
  persistCloudWorkspaceSetupSecrets,
  persistDatabaseCloudWorkspaceSettings,
  resolveDatabaseCloudWorkspaceSettings,
} from "./settings.js";

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

const CreateWorkspaceSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    teamId: UuidSchema.optional(),
    providerConnectionId: UuidSchema.optional(),
    repository: z
      .object({
        forge: z.literal("github.com"),
        owner: GithubNameSchema,
        name: GithubNameSchema,
        revision: RevisionSchema,
        githubInstallationId: UuidSchema,
      })
      .strict(),
    forkFromLocal: z
      .object({
        sourceWorkspaceId: UuidSchema,
        targetWorkspaceId: UuidSchema,
        sourceRevision: z.number().int().nonnegative(),
        sourceSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
        sourceGitBaseCommit: z.string().regex(FullCommitPattern),
        sourceGitHeadRef: RevisionSchema.nullable(),
        includeChats: z.boolean().default(true),
        includeSettings: z.boolean().default(true),
      })
      .strict()
      .optional(),
  })
  .strict();

const GenerationTransitionSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("upgrade") }).strict(),
  z.object({ operation: z.literal("recover"), sourceGeneration: z.number().int().positive(), checkpointId: z.string().uuid() }).strict(),
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
    remotePort: z.number().int().min(1_024).max(65_535),
    deviceId: UuidSchema,
    requestedLocalPort: z.number().int().min(1_024).max(65_535).optional(),
    runtimeGeneration: z.number().int().safe().positive().optional(),
    expiresInMinutes: AccessTtlSchema,
  })
  .strict();
const TunnelActivationSchema = z
  .object({
    deviceId: UuidSchema,
    observedLocalPort: z.number().int().min(1_024).max(65_535),
  })
  .strict();
const PreviewAccessSchema = z
  .object({
    port: z.number().int().min(1).max(65_535),
    expiresInMinutes: AccessTtlSchema,
  })
  .strict();
const EngineClientAdmissionSchema = z.object({actorProtocolVersion:z.literal(2).optional()}).strict();
const ForkEntrySchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("upsert"),
      path: z.string().min(1).max(4_096),
      entryType: z.enum(["file", "symlink"]),
      mode: z.union([z.literal(33188), z.literal(33261), z.literal(40960)]),
      blobId: UuidSchema,
      contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
      sizeBytes: z.number().int().min(0).max(MAX_WORKSPACE_FILE_BYTES),
    })
    .strict(),
  z
    .object({
      operation: z.literal("delete"),
      path: z.string().min(1).max(4_096),
    })
    .strict(),
]);
const ForkEntriesSchema = z
  .object({ entries: z.array(ForkEntrySchema).min(1).max(1_000) })
  .strict();
const ForkRecordSchema = z
  .object({
    ordinal: z.number().int().nonnegative(),
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
    schemaVersion: z.number().int().min(1).max(65_535),
    document: z.record(z.unknown()).nullable(),
    occurredAt: z.string().datetime(),
  })
  .strict();
const ForkRecordsSchema = z
  .object({ records: z.array(ForkRecordSchema).min(1).max(20) })
  .strict();
const CloudToLocalForkSchema = z
  .object({
    targetLocalWorkspaceId: UuidSchema,
    includeChats: z.boolean().default(true),
  })
  .strict();
const DeviceRegistrationSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    platform: z.enum(["macos", "windows", "linux", "ios", "ipados", "android", "web"]),
    publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
const DeviceRotationSchema = z
  .object({ newPublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
const ReplicaCreateSchema = z
  .object({
    pathLabel: z.string().trim().min(1).max(120).nullable().default(null),
    ignorePolicySha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const ReplicaResumeSchema = z
  .object({ replaceDiverged: z.boolean().default(false) })
  .strict();
const ReplicaReceiptSchema = z
  .object({
    fromRevision: z.number().int().nonnegative(),
    toRevision: z.number().int().nonnegative(),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    outcome: z.enum(["applied", "diverged", "failed"]),
    errorCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]{2,127}$/)
      .nullable(),
  })
  .strict();

type LifecycleOperation = "stop" | "wake" | "archive" | "delete";
const DeleteWorkspaceSchema = z.object({
  discardUncheckpointed: z.boolean().default(false),
}).strict();

async function ensureWorkspaceDeletionJob(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    requestedBy: string;
    lifecycleIntentId: string;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO workspace_deletion_jobs (
       workspace_id, org_id, requested_by, idempotency_key
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, org_id) DO UPDATE
     SET requested_by = excluded.requested_by,
         state = CASE
           WHEN workspace_deletion_jobs.state = 'failed'
             THEN 'waiting_for_provider'
           ELSE workspace_deletion_jobs.state
         END,
         attempt_count = CASE
           WHEN workspace_deletion_jobs.state = 'failed' THEN 0
           ELSE workspace_deletion_jobs.attempt_count
         END,
         error_code = CASE
           WHEN workspace_deletion_jobs.state = 'failed' THEN NULL
           ELSE workspace_deletion_jobs.error_code
         END,
         completed_at = CASE
           WHEN workspace_deletion_jobs.state = 'failed' THEN NULL
           ELSE workspace_deletion_jobs.completed_at
         END,
         next_attempt_at = CASE
           WHEN workspace_deletion_jobs.state = 'failed' THEN now()
           ELSE workspace_deletion_jobs.next_attempt_at
         END,
         updated_at = now()`,
    [
      input.workspaceId,
      input.organizationId,
      input.requestedBy,
      `lifecycle.${input.lifecycleIntentId}`,
    ],
  );
}

type WorkspaceRow = {
  id: string;
  org_id: string;
  team_id: string;
  created_by: string;
  owner_user_id: string;
  sharing_mode: "private" | "organization";
  access_revision: string | number;
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
  provider_connection_id: string;
  repository_id: string;
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
  requested_by: string | null;
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
  operation: "upgrade" | "rollback" | "recover";
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

type ForkIntentRow = {
  id: string;
  operation: "local_to_cloud" | "cloud_to_local";
  source_local_workspace_id: string | null;
  source_cloud_workspace_id: string | null;
  target_local_workspace_id: string | null;
  target_cloud_workspace_id: string | null;
  state: string;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
};

const WORKSPACE_SELECT = `
  SELECT cw.id, cw.org_id, cw.team_id, cw.created_by, cw.owner_user_id,
         cw.display_name,
         cw.repository_forge, cw.repository_owner, cw.repository_name,
         cw.repository_revision, cw.status, cw.desired_state,
         cw.current_generation, cw.version, cw.last_error_code,
         cw.last_error_message, cw.last_observed_at, cw.created_at,
         cw.updated_at, cw.deleted_at, cw.repository_id, cw.sharing_mode, cw.access_revision,
         g.provider, g.provider_connection_id, g.image_ref,
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
    ownerUserId: row.owner_user_id,
    sharingMode: row.sharing_mode,
    accessRevision: Number(row.access_revision),
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

function forkDocument(row: ForkIntentRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    operation: row.operation,
    sourceLocalWorkspaceId: row.source_local_workspace_id,
    sourceCloudWorkspaceId: row.source_cloud_workspace_id,
    targetLocalWorkspaceId: row.target_local_workspace_id,
    targetCloudWorkspaceId: row.target_cloud_workspace_id,
    state: row.state,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: iso(row.completed_at),
  };
}

async function loadForkForTarget(
  tx: Tx,
  organizationId: string,
  workspaceId: string,
): Promise<ForkIntentRow | null> {
  return (
    (
      await tx.query<ForkIntentRow>(
        `SELECT id, operation, source_local_workspace_id,
              source_cloud_workspace_id, target_local_workspace_id,
              target_cloud_workspace_id, state, created_at, updated_at,
              completed_at
       FROM workspace_fork_intents
       WHERE org_id = $1 AND target_cloud_workspace_id = $2
       ORDER BY created_at DESC, id DESC LIMIT 1`,
        [organizationId, workspaceId],
      )
    ).rows[0] ?? null
  );
}

function requestDigest(value: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}

function sameDigest(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

async function loadWorkspaceRow(tx:Tx,orgId:string,workspaceId:string,lock=false):Promise<WorkspaceRow>{
  const result = await tx.query<WorkspaceRow>(
    `${WORKSPACE_SELECT}
     WHERE cw.org_id = $1 AND cw.id = $2
     ${lock ? "FOR UPDATE OF cw" : ""}`,
    [orgId, workspaceId],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, "not_found", "Cloud workspace not found");
  return row;
}

async function loadWorkspace(
  tx: Tx,
  orgId: string,
  workspaceId: string,
  userId: string,
  options: { lock?: boolean; ownerOnly?: boolean } = {},
): Promise<WorkspaceRow> {
  const row=await loadWorkspaceRow(tx,orgId,workspaceId,options.lock);
  if (row.owner_user_id===userId) {
    await authorizeCloudWorkspaceDataAccess(tx,{organizationId:orgId,teamId:row.team_id,
      actorUserId:userId,ownerUserId:row.owner_user_id,requireWorkspaceOwner:true});
  } else {
    if(options.ownerOnly)throw new HttpError(404,"not_found","Cloud workspace not found");
    try { await authorizeCloudWorkspaceActor(tx,{workspaceId,organizationId:orgId,actorUserId:userId,capability:"read"}); }
    catch(error) { if(error instanceof HttpError)throw new HttpError(404,"not_found","Cloud workspace not found");throw error; }
  }
  return row;
}

async function loadIntentByKey(
  tx: Tx,
  orgId: string,
  key: string,
): Promise<IntentRow | null> {
  const result = await tx.query<IntentRow>(
    `SELECT id, workspace_id, requested_by, operation, request_sha256, state,
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
  actorUserId: string,
): void {
  if(existing.requested_by!==actorUserId)throw new HttpError(404,"not_found","Cloud workspace request not found");
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

type AuthorizedGithubInstallation = {
  id: string;
  githubInstallationId: number;
};

function safeGithubInstallationId(value: string | number): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new HttpError(
      409,
      "github_installation_invalid",
      "GitHub installation identity is invalid",
    );
  }
  return normalized;
}

async function resolveAuthorizedTeam(
  tx: Tx,
  input: {
    organizationId: string;
    actorUserId: string;
    requestedTeamId: string | null;
  },
): Promise<string> {
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
    [input.organizationId, input.actorUserId, input.requestedTeamId],
  );
  const teamId = team.rows[0]?.id;
  if (!teamId) {
    throw new HttpError(
      404,
      "team_not_found",
      "Authorized cloud workspace team not found",
    );
  }
  return teamId;
}

async function resolveAuthorizedGithubInstallation(
  tx: Tx,
  input: {
    installationRecordId: string;
    organizationId: string;
    actorUserId: string;
    repositoryOwner: string;
  },
): Promise<AuthorizedGithubInstallation> {
  const result = await tx.query<{
    id: string;
    github_installation_id: string | number;
  }>(
    `SELECT gi.id, gi.github_installation_id
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
      input.installationRecordId,
      input.organizationId,
      input.actorUserId,
      input.repositoryOwner,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new HttpError(
      404,
      "github_installation_not_found",
      "Authorized GitHub installation not found",
    );
  }
  return {
    id: row.id,
    githubInstallationId: safeGithubInstallationId(row.github_installation_id),
  };
}

async function upsertCanonicalRepository(
  tx: Tx,
  input: {
    organizationId: string;
    actorUserId: string;
    installationRecordId: string;
    repository: CloudWorkspaceRepositoryIdentity;
  },
): Promise<string> {
  const result = await tx.query<{ id: string }>(
    `INSERT INTO repositories (
       org_id, forge, forge_repository_id, identity_state, owner_name,
       repository_name, clone_url, web_url, default_branch, visibility,
       github_installation_id, created_by
     ) VALUES (
       $1, $2, $3, 'verified', $4, $5, $6, $7, $8, $9, $10, $11
     )
     ON CONFLICT (org_id, forge, forge_repository_id)
       WHERE deleted_at IS NULL
     DO UPDATE SET
       identity_state = 'verified',
       owner_name = EXCLUDED.owner_name,
       repository_name = EXCLUDED.repository_name,
       clone_url = EXCLUDED.clone_url,
       web_url = EXCLUDED.web_url,
       default_branch = EXCLUDED.default_branch,
       visibility = EXCLUDED.visibility,
       github_installation_id = EXCLUDED.github_installation_id,
       metadata_version = repositories.metadata_version + 1,
       updated_at = now()
     RETURNING id`,
    [
      input.organizationId,
      input.repository.forge,
      input.repository.forgeRepositoryId,
      input.repository.owner,
      input.repository.name,
      input.repository.cloneUrl,
      input.repository.webUrl,
      input.repository.defaultBranch,
      input.repository.visibility,
      input.installationRecordId,
      input.actorUserId,
    ],
  );
  return result.rows[0]!.id;
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
  // A candidate reserves its full shape before provider allocation. Any known
  // provider resource retains disk allocation until deletion is verified.
  const result = await tx.query<UsageRow>(
    `WITH workspace_usage AS (
       SELECT count(*) AS workspaces,
              count(*) FILTER (WHERE desired_state = 'running') AS running
       FROM cloud_workspaces
       WHERE org_id = $1 AND status <> 'deleted'
     ), generation_allocation AS (
       SELECT generation.cpu_millicores, generation.memory_mib,
              generation.storage_mib, workspace.desired_state,
              (
                workspace.status <> 'deleted'
                AND generation.generation = workspace.current_generation
              ) AS current_reserved,
              (
                workspace.status <> 'deleted'
                AND generation.generation <> workspace.current_generation
                AND generation.retired_at IS NULL
                AND transition.id IS NOT NULL
              ) AS candidate_reserved,
              (
                binding.provider_resource_id IS NOT NULL
                AND binding.deletion_verified_at IS NULL
              ) AS provider_storage_allocated
       FROM cloud_workspaces workspace
       JOIN cloud_workspace_generations generation
         ON generation.workspace_id = workspace.id
        AND generation.org_id = workspace.org_id
       LEFT JOIN cloud_workspace_provider_bindings binding
         ON binding.workspace_id = generation.workspace_id
        AND binding.generation = generation.generation
        AND binding.org_id = generation.org_id
       LEFT JOIN cloud_workspace_generation_transitions transition
         ON transition.workspace_id = generation.workspace_id
        AND transition.org_id = generation.org_id
        AND transition.candidate_generation = generation.generation
        AND transition.state IN (
          'draining', 'provisioning', 'setting_up', 'rolling_back'
        )
       WHERE workspace.org_id = $1
     ), generation_usage AS (
       SELECT coalesce(sum(cpu_millicores) FILTER (
                WHERE (current_reserved AND desired_state = 'running')
                   OR candidate_reserved
              ), 0) AS cpu_millicores,
              coalesce(sum(memory_mib) FILTER (
                WHERE (current_reserved AND desired_state = 'running')
                   OR candidate_reserved
              ), 0) AS memory_mib,
              coalesce(sum(storage_mib) FILTER (
                WHERE current_reserved OR candidate_reserved
                   OR provider_storage_allocated
              ), 0) AS storage_mib
       FROM generation_allocation
     )
     SELECT workspace_usage.workspaces, workspace_usage.running,
            generation_usage.cpu_millicores, generation_usage.memory_mib,
            generation_usage.storage_mib
     FROM workspace_usage CROSS JOIN generation_usage`,
    [orgId],
  );
  return result.rows[0]!;
}

function assertCreateQuota(
  quota: QuotaRow,
  usage: UsageRow,
  config: Pick<
    CloudWorkspaceProvisioningProfile,
    "cpuMillicores" | "memoryMiB" | "storageMiB"
  >,
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

function decodePathCursor(raw: string | undefined): string | null {
  if (!raw) return null;
  if (raw.length > 8_192 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new HttpError(422, "invalid_cursor", "Invalid cursor");
  }
  const value = Buffer.from(raw, "base64url").toString("utf8");
  if (
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    value !== value.normalize("NFC") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    Buffer.from(value, "utf8").toString("base64url") !== raw
  ) {
    throw new HttpError(422, "invalid_cursor", "Invalid cursor");
  }
  return value;
}

function deviceProof(c: Context): CloudWorkspaceDeviceProof {
  const deviceId = c.req.header("x-zeros-device-id") ?? "";
  const rawVersion = c.req.header("x-zeros-device-key-version") ?? "";
  const rawTimestamp = c.req.header("x-zeros-device-timestamp") ?? "";
  const nonce = c.req.header("x-zeros-device-nonce") ?? "";
  const signature = c.req.header("x-zeros-device-signature") ?? "";
  if (
    !UuidSchema.safeParse(deviceId).success ||
    !/^[1-9][0-9]{0,15}$/.test(rawVersion) ||
    !/^(?:0|[1-9][0-9]{0,15})$/.test(rawTimestamp) ||
    Number(rawVersion) > Number.MAX_SAFE_INTEGER ||
    Number(rawTimestamp) > Number.MAX_SAFE_INTEGER ||
    !/^[A-Za-z0-9_-]{32}$/.test(nonce) ||
    !/^[A-Za-z0-9_-]{86}$/.test(signature)
  ) {
    throw new HttpError(
      403,
      "workspace_replica_device_proof_rejected",
      "A current device proof is required",
    );
  }
  return {
    deviceId,
    keyVersion: Number(rawVersion),
    timestampMs: Number(rawTimestamp),
    nonce,
    signature,
  };
}

export function createCloudWorkspaceRoutes(
  pool: pg.Pool,
  config: CloudWorkspaceBackendConfig | null,
  options: {
    accessService?: CloudWorkspaceAccessService | null;
    repositoryResolver?: CloudWorkspaceRepositoryResolver | null;
    forkService?: DatabaseCloudWorkspaceForkService | null;
    replicaService?: DatabaseCloudWorkspaceReplicaService | null;
    engineClientAdmissionService?: DatabaseCloudWorkspaceEngineClientAdmissionService | null;
    workosEnabled?: boolean;
    setupSecretKeyV1?: string | null;
    providerQualifier?: DaytonaProviderConnectionQualifier;
  } = {},
): Hono {
  const app = new Hono();
  const accessService = options.accessService ?? null;
  const repositoryResolver = options.repositoryResolver ?? null;
  const forkService = options.forkService ?? null;
  const replicaService = options.replicaService ?? null;
  const engineClientAdmissionService =
    options.engineClientAdmissionService ?? null;
  const base = "/v1/organizations/:organization/cloud-workspaces";
  app.get('/v1/cloud-compute-credits',async c=>{
    c.header('Cache-Control','no-store');
    return c.json({currency:'USD',unit:'micro_usd',scope:'user',periods:await new DatabaseComputeUserFunding(pool).balanceForUser(c.get('user').id)});
  });
  app.get('/v1/organizations/:organization/cloud-compute-credits',async c=>{
    if(!config)throw new HttpError(503,'cloud_workspaces_not_configured','Cloud workspaces are not configured');
    c.header('Cache-Control','no-store');
    const periods=await new DatabaseManagedComputeCreditLedger({pool,workosEnabled:options.workosEnabled===true}).balanceForUser({
      organizationId:uuidParam(c.req.param('organization')),userId:c.get('user').id});
    return c.json({currency:'USD',unit:'micro_usd',periods});
  });

  app.use(
    `${base}/:workspace/access/*`,
    rateLimit("cloud-workspace-access", 60, 60_000),
  );
  app.use(
    `${base}/:workspace/runtime/*`,
    rateLimit("cloud-workspace-runtime", 30, 60_000),
  );
  const deviceRateLimit = rateLimit("cloud-workspace-devices", 60, 60_000);
  app.use("/v1/devices", deviceRateLimit);
  app.use("/v1/devices/*", deviceRateLimit);
  app.use(
    `${base}/:workspace/replicas/*`,
    rateLimit("cloud-workspace-replicas", 180, 60_000),
  );
  app.use(
    `${base}/:workspace/forks/:fork/export/*`,
    rateLimit("cloud-workspace-exports", 180, 60_000),
  );
  if (config) {
    app.route(
      "/",
      createCloudWorkspaceManagementRoutes(pool, config, {
        workosEnabled: options.workosEnabled === true,
        ...(options.providerQualifier
          ? { qualifier: options.providerQualifier }
          : {}),
      }),
    );
  }

  const requireReplicaService = (): DatabaseCloudWorkspaceReplicaService => {
    if (!replicaService) {
      throw new HttpError(
        503,
        "cloud_workspace_durability_not_configured",
        "Cloud workspace durable storage is not configured",
      );
    }
    return replicaService;
  };
  const replicaCall = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof WorkspaceReplicaError) {
        throw replicaErrorToHttp(error);
      }
      throw error;
    }
  };

  app.post("/v1/devices", async (c) => {
    const service = requireReplicaService();
    const body = parse(
      DeviceRegistrationSchema,
      await c.req.json().catch(() => ({})),
    );
    const result = await replicaCall(() =>
      service.registerDevice({
        accountUserId: c.get("user").id,
        ...body,
        idempotencyKey: idempotencyKey(c.req.header("Idempotency-Key")),
      }),
    );
    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(result, result.replayed ? 200 : 201);
  });

  app.patch("/v1/devices/:device/key", async (c) => {
    const service = requireReplicaService();
    const proof = deviceProof(c);
    if (proof.deviceId !== uuidParam(c.req.param("device"))) {
      throw new HttpError(
        403,
        "workspace_replica_device_proof_rejected",
        "Device proof does not match this device",
      );
    }
    const body = parse(
      DeviceRotationSchema,
      await c.req.json().catch(() => ({})),
    );
    return c.json(
      await replicaCall(() =>
        service.rotateDeviceKey({
          accountUserId: c.get("user").id,
          newPublicKey: body.newPublicKey,
          idempotencyKey: idempotencyKey(c.req.header("Idempotency-Key")),
          proof,
        }),
      ),
    );
  });

  app.delete("/v1/devices/:device", async (c) => {
    const service = requireReplicaService();
    return c.json(
      await replicaCall(() =>
        service.revokeDevice({
          accountUserId: c.get("user").id,
          deviceId: uuidParam(c.req.param("device")),
        }),
      ),
    );
  });

  const listWorkspaces = async (c: Context, orgId: string | null) => {
    const user = c.get("user");
    c.header("Cache-Control","no-store");
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

    const rows = await withSystemTx(pool, async (tx) => {
      if(orgId!==null)await requireOrganizationMembership(tx, orgId, user.id);
      const parameters: unknown[] = [orgId, user.id, limit + 1];
      let cursorSql = "";
      if (cursor) {
        parameters.push(cursor.createdAt, cursor.id);
        cursorSql = "AND (cw.created_at, cw.id) < ($4::timestamptz, $5::uuid)";
      }
      return (
        await tx.query<WorkspaceRow>(
          `${WORKSPACE_SELECT}
           WHERE ($1::uuid IS NULL OR cw.org_id = $1)
             AND (cw.owner_user_id=$2 OR cw.org_id IN (SELECT org_id FROM organization_members WHERE user_id=$2)
               OR cw.id IN (SELECT workspace_id FROM cloud_workspace_guest_grants WHERE user_id=$2 AND revoked_at IS NULL AND expires_at>now()))
             AND (cloud_workspace_actor_role(cw.id,$2) IS NOT NULL OR (
               cw.owner_user_id=$2
               AND EXISTS (SELECT 1 FROM organizations org JOIN organization_members member ON member.org_id=org.id
                 JOIN users account ON account.id=member.user_id
                 WHERE org.id=cw.org_id AND member.user_id=$2 AND org.deleted_at IS NULL AND NOT org.is_personal
                   AND account.auth_status='active' AND account.deleted_at IS NULL)
               AND EXISTS (SELECT 1 FROM teams team JOIN team_members member ON member.team_id=team.id AND member.org_id=team.org_id
                 WHERE team.id=cw.team_id AND team.org_id=cw.org_id AND team.deleted_at IS NULL AND member.user_id=$2)))
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
  };
  app.get(base,c=>listWorkspaces(c,uuidParam(c.req.param("organization"))));
  app.get("/v1/cloud-workspaces",c=>listWorkspaces(c,null));
  app.get("/v1/cloud-workspaces/:workspace",async c=>{
    c.header("Cache-Control","no-store");
    const workspaceId=uuidParam(c.req.param("workspace")),userId=c.get("user").id;
    const result=await withSystemTx(pool,async tx=>{
      const scope=(await tx.query<{org_id:string}>("SELECT org_id FROM cloud_workspaces WHERE id=$1",[workspaceId])).rows[0];
      if(!scope)throw new HttpError(404,"not_found","Cloud workspace not found");
      const row=await loadWorkspace(tx,scope.org_id,workspaceId,userId);
      const live=(await tx.query<{role:string|null}>("SELECT cloud_workspace_actor_role($1,$2) AS role",[workspaceId,userId])).rows[0]!;
      return {workspace:workspaceDocument(row),access:{role:live.role??"owner",computeEligible:live.role!==null},path:`/workspace/${workspaceId}`};
    });
    return c.json(result);
  });

  app.get(`${base}/:workspace`, async (c) => {
    const user = c.get("user");
    const orgId = uuidParam(c.req.param("organization"));
    const workspaceId = uuidParam(c.req.param("workspace"));
    c.header("Cache-Control","no-store");
    const row = await withSystemTx(pool, (tx) =>
      loadWorkspace(tx, orgId, workspaceId, user.id),
    );
    return c.json({ workspace: workspaceDocument(row) });
  });

  app.post(`${base}/:workspace/runtime/admission`, async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    if (!engineClientAdmissionService) {
      throw new HttpError(
        503,
        "cloud_workspace_runtime_not_configured",
        "Cloud workspace runtime admission is not configured",
      );
    }
    const body = parse(EngineClientAdmissionSchema, await c.req.json().catch(() => ({})));
    try {
      const input={
          organizationId: uuidParam(c.req.param("organization")),
          workspaceId: uuidParam(c.req.param("workspace")),
          actorUserId: c.get("user").id,
          ...(c.req.header("x-zeros-device-id") ? { proof: deviceProof(c) } : {}),
      };
      const admission=body.actorProtocolVersion===2
        ?await engineClientAdmissionService.issueActor({...input,authenticatedUser:c.get("user")})
        :await engineClientAdmissionService.issue(input);
      return c.json(admission,201);
    } catch (error) {
      if (!(error instanceof CloudWorkspaceEngineClientAdmissionError)) {
        throw error;
      }
      throw new HttpError(
        error.code === "engine_client_admission_invalid" ? 422 : 409,
        error.code,
        error.message,
      );
    }
  });

  app.delete(`${base}/:workspace/runtime/admission`,async c=>{
    c.header("Cache-Control","no-store");
    if(!engineClientAdmissionService)throw new HttpError(503,"cloud_workspace_runtime_not_configured","Cloud workspace runtime admission is not configured");
    await engineClientAdmissionService.revokeActor({organizationId:uuidParam(c.req.param("organization")),workspaceId:uuidParam(c.req.param("workspace")),
      actorUserId:c.get("user").id,token:c.req.header("x-zeros-runtime-admission")??""});
    return c.body(null,204);
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
    const runtimeGeneration =
      kind === "tunnel"
        ? (body as z.infer<typeof TunnelAccessSchema>).runtimeGeneration
        : undefined;
    const tunnelScope =
      kind === "tunnel"
        ? (body as z.infer<typeof TunnelAccessSchema>)
        : undefined;
    const document = await accessService.issue({
      organizationId,
      workspaceId,
      accountUserId: user.id,
      kind,
      ...(runtimeGeneration === undefined
        ? {}
        : {
            purpose: "engine-runtime" as const,
            expectedGeneration: runtimeGeneration,
          }),
      ...(remotePort === undefined ? {} : { remotePort }),
      ...(tunnelScope
        ? {
            deviceId: tunnelScope.deviceId,
            ...(tunnelScope.requestedLocalPort === undefined
              ? {}
              : { requestedLocalPort: tunnelScope.requestedLocalPort }),
          }
        : {}),
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
  app.patch(`${base}/:workspace/access/tunnels/:session`, async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    if (!config || !accessService) {
      throw new HttpError(
        503,
        "cloud_workspace_access_not_configured",
        "Cloud workspace client access is not configured",
      );
    }
    const body = parse(
      TunnelActivationSchema,
      await c.req.json().catch(() => ({})),
    );
    return c.json(
      await accessService.activateTunnel({
        organizationId: uuidParam(c.req.param("organization")),
        workspaceId: uuidParam(c.req.param("workspace")),
        accountUserId: c.get("user").id,
        sessionId: uuidParam(c.req.param("session")),
        deviceId: body.deviceId,
        observedLocalPort: body.observedLocalPort,
      }),
    );
  });
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

  const requireForkService = (): DatabaseCloudWorkspaceForkService => {
    if (!forkService) {
      throw new HttpError(
        503,
        "cloud_workspace_durability_not_configured",
        "Cloud workspace durable storage is not configured",
      );
    }
    return forkService;
  };
  const forkCall = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof WorkspaceForkError) throw forkErrorToHttp(error);
      throw error;
    }
  };

  // Local-to-cloud is an immutable copy into the newly created cloud
  // workspace. The local source id remains independent and is never retired.
  app.post(`${base}/:workspace/forks/:fork/import/blobs`, async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    if (
      c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/octet-stream"
    ) {
      throw new HttpError(
        415,
        "invalid_content_type",
        "Fork blobs require application/octet-stream",
      );
    }
    const service = requireForkService();
    const user = c.get("user");
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const document = await forkCall(() =>
      service.uploadImportBlob({
        organizationId: uuidParam(c.req.param("organization")),
        workspaceId: uuidParam(c.req.param("workspace")),
        forkIntentId: uuidParam(c.req.param("fork")),
        accountUserId: user.id,
        bytes,
      }),
    );
    return c.json({ blob: document }, document.reused ? 200 : 201);
  });

  app.put(`${base}/:workspace/forks/:fork/import/entries`, async (c) => {
    const service = requireForkService();
    const user = c.get("user");
    const body = parse(ForkEntriesSchema, await c.req.json().catch(() => ({})));
    const document = await forkCall(() =>
      service.stageImportEntries({
        organizationId: uuidParam(c.req.param("organization")),
        workspaceId: uuidParam(c.req.param("workspace")),
        forkIntentId: uuidParam(c.req.param("fork")),
        accountUserId: user.id,
        entries: body.entries,
      }),
    );
    return c.json(document);
  });

  app.put(`${base}/:workspace/forks/:fork/import/records`, async (c) => {
    const service = requireForkService();
    const user = c.get("user");
    const body = parse(ForkRecordsSchema, await c.req.json().catch(() => ({})));
    const document = await forkCall(() =>
      service.stageImportRecords({
        organizationId: uuidParam(c.req.param("organization")),
        workspaceId: uuidParam(c.req.param("workspace")),
        forkIntentId: uuidParam(c.req.param("fork")),
        accountUserId: user.id,
        records: body.records,
      }),
    );
    return c.json(document);
  });

  app.post(`${base}/:workspace/forks/:fork/import/finalize`, async (c) => {
    const service = requireForkService();
    const user = c.get("user");
    const document = await forkCall(() =>
      service.finalizeLocalImport({
        organizationId: uuidParam(c.req.param("organization")),
        workspaceId: uuidParam(c.req.param("workspace")),
        forkIntentId: uuidParam(c.req.param("fork")),
        accountUserId: user.id,
        idempotencyKey: idempotencyKey(c.req.header("Idempotency-Key")),
      }),
    );
    if (document.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(document, document.replayed ? 200 : 201);
  });

  // Cloud-to-local also creates a new identity. The source cloud workspace
  // keeps running; a checkpoint is requested only to freeze the copied view.
  app.post(`${base}/:workspace/forks/cloud-to-local`, async (c) => {
    const service = requireForkService();
    const user = c.get("user");
    const body = parse(
      CloudToLocalForkSchema,
      await c.req.json().catch(() => ({})),
    );
    const document = await forkCall(() =>
      service.requestCloudToLocal({
        organizationId: uuidParam(c.req.param("organization")),
        workspaceId: uuidParam(c.req.param("workspace")),
        targetLocalWorkspaceId: body.targetLocalWorkspaceId,
        accountUserId: user.id,
        idempotencyKey: idempotencyKey(c.req.header("Idempotency-Key")),
        includeChats: body.includeChats,
      }),
    );
    if (document.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(document, document.replayed ? 200 : 202);
  });

  app.post(`${base}/:workspace/forks/:fork/export/grant`, async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    const service = requireForkService();
    return c.json(
      await forkCall(() =>
        service.issueExportGrant({
          organizationId: uuidParam(c.req.param("organization")),
          workspaceId: uuidParam(c.req.param("workspace")),
          forkIntentId: uuidParam(c.req.param("fork")),
          accountUserId: c.get("user").id,
          proof: deviceProof(c),
        }),
      ),
      201,
    );
  });

  app.get(`${base}/:workspace/forks/:fork/export/manifest`, async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    const service = requireForkService();
    const rawLimit = c.req.query("limit") ?? "500";
    if (!/^[1-9][0-9]{0,3}$/.test(rawLimit) || Number(rawLimit) > 1_000) {
      throw new HttpError(422, "invalid_input", "Invalid export page size");
    }
    const user = c.get("user");
    return c.json(
      await forkCall(() =>
        service.readExportManifest({
          organizationId: uuidParam(c.req.param("organization")),
          workspaceId: uuidParam(c.req.param("workspace")),
          forkIntentId: uuidParam(c.req.param("fork")),
          accountUserId: user.id,
          grantToken: c.req.header("x-zeros-export-grant") ?? "",
          afterPath: decodePathCursor(c.req.query("after")),
          limit: Number(rawLimit),
          proof: deviceProof(c),
        }),
      ),
    );
  });

  app.get(`${base}/:workspace/forks/:fork/export/records`, async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    const service = requireForkService();
    const rawRevision = c.req.query("afterRevision") ?? "0";
    const rawLimit = c.req.query("limit") ?? "100";
    if (
      !/^(?:0|[1-9][0-9]{0,15})$/.test(rawRevision) ||
      !/^[1-9][0-9]{0,2}$/.test(rawLimit) ||
      Number(rawRevision) > Number.MAX_SAFE_INTEGER ||
      Number(rawLimit) > 20
    ) {
      throw new HttpError(422, "invalid_input", "Invalid export cursor");
    }
    const user = c.get("user");
    return c.json(
      await forkCall(() =>
        service.readExportRecords({
          organizationId: uuidParam(c.req.param("organization")),
          workspaceId: uuidParam(c.req.param("workspace")),
          forkIntentId: uuidParam(c.req.param("fork")),
          accountUserId: user.id,
          grantToken: c.req.header("x-zeros-export-grant") ?? "",
          afterRevision: Number(rawRevision),
          limit: Number(rawLimit),
          proof: deviceProof(c),
        }),
      ),
    );
  });

  app.get(`${base}/:workspace/forks/:fork/export/blobs/:blob`, async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    const service = requireForkService();
    const user = c.get("user");
    const bytes = await forkCall(() =>
      service.readExportBlob({
        organizationId: uuidParam(c.req.param("organization")),
        workspaceId: uuidParam(c.req.param("workspace")),
        forkIntentId: uuidParam(c.req.param("fork")),
        accountUserId: user.id,
        grantToken: c.req.header("x-zeros-export-grant") ?? "",
        blobId: uuidParam(c.req.param("blob")),
        proof: deviceProof(c),
      }),
    );
    return new Response(bytes, {
      headers: {
        "cache-control": "no-store",
        "content-length": String(bytes.length),
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
      },
    });
  });

  app.post(`${base}/:workspace/replicas`, async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    const service = requireReplicaService();
    const body = parse(
      ReplicaCreateSchema,
      await c.req.json().catch(() => ({})),
    );
    const result = await replicaCall(() =>
      service.createReplica({
        organizationId: uuidParam(c.req.param("organization")),
        workspaceId: uuidParam(c.req.param("workspace")),
        accountUserId: c.get("user").id,
        pathLabel: body.pathLabel,
        ignorePolicySha256: body.ignorePolicySha256,
        idempotencyKey: idempotencyKey(c.req.header("Idempotency-Key")),
        proof: deviceProof(c),
      }),
    );
    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(result, result.replayed ? 200 : 201);
  });

  const changeReplicaState = async (
    c: Context,
    operation: "pause" | "resume" | "remove",
  ) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    const service = requireReplicaService();
    const resume =
      operation === "resume"
        ? parse(ReplicaResumeSchema, await c.req.json().catch(() => ({})))
        : { replaceDiverged: false };
    return c.json(
      await replicaCall(() =>
        service.changeReplicaState({
          organizationId: uuidParam(c.req.param("organization")),
          workspaceId: uuidParam(c.req.param("workspace")),
          replicaId: uuidParam(c.req.param("replica")),
          accountUserId: c.get("user").id,
          operation,
          replaceDiverged: resume.replaceDiverged,
          idempotencyKey: idempotencyKey(c.req.header("Idempotency-Key")),
          proof: deviceProof(c),
        }),
      ),
    );
  };
  app.post(`${base}/:workspace/replicas/:replica/pause`, (c) =>
    changeReplicaState(c, "pause"),
  );
  app.post(`${base}/:workspace/replicas/:replica/resume`, (c) =>
    changeReplicaState(c, "resume"),
  );
  app.post(`${base}/:workspace/replicas/:replica/remove`, (c) =>
    changeReplicaState(c, "remove"),
  );

  app.post(`${base}/:workspace/replicas/:replica/grants`, async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    const service = requireReplicaService();
    return c.json(
      await replicaCall(() =>
        service.renewGrant({
          organizationId: uuidParam(c.req.param("organization")),
          workspaceId: uuidParam(c.req.param("workspace")),
          replicaId: uuidParam(c.req.param("replica")),
          accountUserId: c.get("user").id,
          proof: deviceProof(c),
        }),
      ),
      201,
    );
  });

  app.post(`${base}/:workspace/replicas/:replica/snapshot`, async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    const service = requireReplicaService();
    return c.json(
      await replicaCall(() =>
        service.refreshSnapshot({
          organizationId: uuidParam(c.req.param("organization")),
          workspaceId: uuidParam(c.req.param("workspace")),
          replicaId: uuidParam(c.req.param("replica")),
          accountUserId: c.get("user").id,
          proof: deviceProof(c),
        }),
      ),
      201,
    );
  });

  app.get(`${base}/:workspace/replicas/:replica/bootstrap`, async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    const rawLimit = c.req.query("limit") ?? "500";
    if (!/^[1-9][0-9]{0,3}$/.test(rawLimit) || Number(rawLimit) > 1_000) {
      throw new HttpError(422, "invalid_input", "Invalid bootstrap page size");
    }
    const service = requireReplicaService();
    return c.json(
      await replicaCall(() =>
        service.readBootstrap({
          organizationId: uuidParam(c.req.param("organization")),
          workspaceId: uuidParam(c.req.param("workspace")),
          replicaId: uuidParam(c.req.param("replica")),
          accountUserId: c.get("user").id,
          grantToken: c.req.header("x-zeros-replica-grant") ?? "",
          afterPath: decodePathCursor(c.req.query("after")),
          limit: Number(rawLimit),
          proof: deviceProof(c),
        }),
      ),
    );
  });

  app.get(`${base}/:workspace/replicas/:replica/events`, async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    const rawRevision = c.req.query("afterRevision") ?? "0";
    const rawLimit = c.req.query("limit") ?? "100";
    if (
      !/^(?:0|[1-9][0-9]{0,15})$/.test(rawRevision) ||
      !/^[1-9][0-9]{0,2}$/.test(rawLimit) ||
      Number(rawRevision) > Number.MAX_SAFE_INTEGER ||
      Number(rawLimit) > 200
    ) {
      throw new HttpError(422, "invalid_input", "Invalid replica cursor");
    }
    const service = requireReplicaService();
    return c.json(
      await replicaCall(() =>
        service.readEvents({
          organizationId: uuidParam(c.req.param("organization")),
          workspaceId: uuidParam(c.req.param("workspace")),
          replicaId: uuidParam(c.req.param("replica")),
          accountUserId: c.get("user").id,
          grantToken: c.req.header("x-zeros-replica-grant") ?? "",
          afterRevision: Number(rawRevision),
          limit: Number(rawLimit),
          proof: deviceProof(c),
        }),
      ),
    );
  });

  app.get(`${base}/:workspace/replicas/:replica/blobs/:blob`, async (c) => {
    const service = requireReplicaService();
    const bytes = await replicaCall(() =>
      service.readBlob({
        organizationId: uuidParam(c.req.param("organization")),
        workspaceId: uuidParam(c.req.param("workspace")),
        replicaId: uuidParam(c.req.param("replica")),
        accountUserId: c.get("user").id,
        grantToken: c.req.header("x-zeros-replica-grant") ?? "",
        blobId: uuidParam(c.req.param("blob")),
        proof: deviceProof(c),
      }),
    );
    return new Response(bytes, {
      headers: {
        "cache-control": "no-store",
        "content-length": String(bytes.length),
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
      },
    });
  });

  app.post(`${base}/:workspace/replicas/:replica/receipts`, async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    const body = parse(
      ReplicaReceiptSchema,
      await c.req.json().catch(() => ({})),
    );
    if (
      (body.outcome === "applied") !== (body.errorCode === null) ||
      body.toRevision < body.fromRevision
    ) {
      throw new HttpError(422, "invalid_input", "Invalid replica receipt");
    }
    const service = requireReplicaService();
    return c.json(
      await replicaCall(() =>
        service.recordReceipt({
          organizationId: uuidParam(c.req.param("organization")),
          workspaceId: uuidParam(c.req.param("workspace")),
          replicaId: uuidParam(c.req.param("replica")),
          accountUserId: c.get("user").id,
          grantToken: c.req.header("x-zeros-replica-grant") ?? "",
          idempotencyKey: idempotencyKey(c.req.header("Idempotency-Key")),
          ...body,
          proof: deviceProof(c),
        }),
      ),
    );
  });

  app.post(base, async (c) => {
    if (!config || !repositoryResolver) {
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
    if (
      body.forkFromLocal &&
      body.forkFromLocal.sourceGitBaseCommit !== body.repository.revision
    ) {
      throw new HttpError(
        422,
        "invalid_input",
        "A local fork must clone the exact Git base used by its overlay",
      );
    }
    if (
      body.forkFromLocal &&
      body.forkFromLocal.sourceWorkspaceId ===
        body.forkFromLocal.targetWorkspaceId
    ) {
      throw new HttpError(
        422,
        "invalid_input",
        "A cloud copy must have a new workspace identity",
      );
    }
    const normalize = (profile: CloudWorkspaceProvisioningProfile) => ({
      operation: "create" as const,
      organizationId: orgId,
      name: body.name ?? body.repository.name,
      teamId: body.teamId ?? null,
      repository: body.repository,
      provider: profile.provider,
      imageRef: profile.imageRef,
      ...(profile.sandboxClass?{sandboxClass:profile.sandboxClass}:{}),
      architecture: profile.architecture,
      resources: {
        cpuMillicores: profile.cpuMillicores,
        memoryMiB: profile.memoryMiB,
        storageMiB: profile.storageMiB,
      },
      providerConnectionId: body.providerConnectionId ?? null,
      forkFromLocal: body.forkFromLocal ?? null,
    });
    const assertCreateReplay = async (tx: Tx, existing: IntentRow) => {
      // Preserve the original request digest format, using its accepted immutable
      // generation rather than today's deployment defaults.
      const accepted = await tx.query<CloudWorkspaceProvisioningProfile>(
        `SELECT g.provider, g.image_ref AS "imageRef", g.sandbox_class AS "sandboxClass", g.architecture,
                g.cpu_millicores AS "cpuMillicores", g.memory_mib AS "memoryMiB",
                g.storage_mib AS "storageMiB", g.source_commit AS "sourceCommit"
         FROM cloud_workspace_lifecycle_intents intent
         JOIN cloud_workspace_generations g
           ON g.workspace_id = intent.workspace_id
          AND g.generation = intent.generation AND g.org_id = intent.org_id
         WHERE intent.id = $1 AND intent.org_id = $2 AND intent.operation = 'create'`,
        [existing.id, orgId],
      );
      const profile = accepted.rows[0];
      if (!profile) {
        throw new HttpError(
          409,
          "idempotency_key_reused",
          "Idempotency-Key was already used with different parameters",
        );
      }
      assertIdempotencyMatch(existing, null, requestDigest(normalize(profile)),user.id);
    };

    // Resolve current Zeros authority and the provider-owned installation id
    // before making a network request. The GitHub call intentionally runs
    // outside a database transaction; the final transaction rechecks every
    // mutable fact before it writes or consumes quota.
    const preflight = await withSystemTx(pool, async (tx) => {
      await requireOrganizationRole(tx, orgId, user.id, "admin");
      const existing = await loadIntentByKey(tx, orgId, key);
      if (existing) {
        await assertCreateReplay(tx, existing);
        const workspace = await loadWorkspace(
          tx,
          orgId,
          existing.workspace_id,
          user.id,
        );
        await authorizeCloudWorkspaceDataAccess(tx, {
          organizationId: orgId,
          teamId: workspace.team_id,
          actorUserId: user.id,
          ownerUserId: workspace.owner_user_id,
          requireWorkspaceOwner: true,
        });
        return {
          workspace,
          intent: existing,
          fork: await loadForkForTarget(tx, orgId, existing.workspace_id),
          replayed: true as const,
        };
      }
      const teamId = await resolveAuthorizedTeam(tx, {
        organizationId: orgId,
        actorUserId: user.id,
        requestedTeamId: body.teamId ?? null,
      });
      const authorization = await authorizeCloudWorkspaceOperation(tx, {
        organizationId: orgId,
        teamId,
        actorUserId: user.id,
        billingOwnerUserId: user.id,
        workosEnabled: options.workosEnabled === true,
        requireWorkspaceOwner: true,
      });
      const providerConnection = body.providerConnectionId
        ? await selectCloudProviderConnectionForNewGeneration(tx, {
            connectionId: body.providerConnectionId,
            organizationId: orgId,
            ownerUserId: authorization.billingOwnerUserId,
            isPersonal: authorization.isPersonal,
            providers: configuredCloudWorkspaceProviders(config),
          })
        : null;
      if (body.providerConnectionId && !providerConnection) {
        throw new HttpError(
          404,
          "cloud_provider_connection_not_found",
          "Cloud provider connection not found",
        );
      }
      const profile = cloudWorkspaceProvisioningProfile(
        config,
        providerConnection?.provider ?? config.provider,
      );
      if (body.forkFromLocal) {
        const collision = await tx.query(
          `SELECT 1 FROM cloud_workspaces WHERE id = $1`,
          [body.forkFromLocal.targetWorkspaceId],
        );
        if ((collision.rowCount ?? 0) !== 0) {
          throw new HttpError(
            409,
            "cloud_workspace_identity_conflict",
            "Cloud workspace identity is already in use",
          );
        }
      }
      const installation = await resolveAuthorizedGithubInstallation(tx, {
        installationRecordId: body.repository.githubInstallationId,
        organizationId: orgId,
        actorUserId: user.id,
        repositoryOwner: body.repository.owner,
      });
      return {
        replayed: false as const,
        teamId,
        installation,
        profile,
        providerConnection,
      };
    });

    if (preflight.replayed) {
      c.header("Idempotency-Replayed", "true");
      return c.json(
        {
          workspace: workspaceDocument(preflight.workspace),
          intent: intentDocument(preflight.intent),
          fork: forkDocument(preflight.fork),
          replayed: true,
        },
        200,
      );
    }

    const profile = preflight.profile;
    const normalized = normalize(profile);
    const digest = requestDigest(normalized);
    let resolvedRepository: CloudWorkspaceRepositoryIdentity;
    try {
      resolvedRepository = await repositoryResolver.resolve({
        installationId: preflight.installation.githubInstallationId,
        owner: body.repository.owner,
        repository: body.repository.name,
      });
    } catch {
      throw new HttpError(
        503,
        "github_repository_verification_unavailable",
        "GitHub repository verification is temporarily unavailable",
      );
    }

    const result = await withSystemTx(pool, async (tx) => {
      await requireOrganizationRole(tx, orgId, user.id, "admin");
      // This parent lock serializes duplicate idempotency keys and quota
      // consumption. Authorization below reads current WorkOS/plan/seat state.
      await lockCloudOrganization(tx, orgId);
      const existing = await loadIntentByKey(tx, orgId, key);
      if (existing) {
        await assertCreateReplay(tx, existing);
        const workspace = await loadWorkspace(
          tx,
          orgId,
          existing.workspace_id,
          user.id,
        );
        await authorizeCloudWorkspaceDataAccess(tx, {
          organizationId: orgId,
          teamId: workspace.team_id,
          actorUserId: user.id,
          ownerUserId: workspace.owner_user_id,
          requireWorkspaceOwner: true,
        });
        return {
          workspace,
          intent: existing,
          fork: await loadForkForTarget(tx, orgId, existing.workspace_id),
          replayed: true,
        };
      }
      const teamId = await resolveAuthorizedTeam(tx, {
        organizationId: orgId,
        actorUserId: user.id,
        requestedTeamId: body.teamId ?? null,
      });
      const authorization: CloudWorkspaceAuthorization =
        await authorizeCloudWorkspaceOperation(tx, {
          organizationId: orgId,
          teamId,
          actorUserId: user.id,
          billingOwnerUserId: user.id,
          workosEnabled: options.workosEnabled === true,
          requireWorkspaceOwner: true,
        });
      const installation = await resolveAuthorizedGithubInstallation(tx, {
        installationRecordId: body.repository.githubInstallationId,
        organizationId: orgId,
        actorUserId: user.id,
        repositoryOwner: body.repository.owner,
      });
      if (
        installation.githubInstallationId !==
        preflight.installation.githubInstallationId
      ) {
        throw new HttpError(
          409,
          "github_installation_changed",
          "GitHub installation changed during repository verification",
        );
      }

      const quota = await loadQuota(tx, orgId);
      assertCreateQuota(quota, await loadUsage(tx, orgId), profile);

      const repositoryId = await upsertCanonicalRepository(tx, {
        organizationId: orgId,
        actorUserId: user.id,
        installationRecordId: installation.id,
        repository: resolvedRepository,
      });

      const workspaceId = body.forkFromLocal?.targetWorkspaceId ?? randomUUID();
      if (body.forkFromLocal) {
        const collision = await tx.query(
          `SELECT 1 FROM cloud_workspaces WHERE id = $1`,
          [workspaceId],
        );
        if ((collision.rowCount ?? 0) !== 0) {
          throw new HttpError(
            409,
            "cloud_workspace_identity_conflict",
            "Cloud workspace identity is already in use",
          );
        }
      }
      const intentId = randomUUID();
      await tx.query(
        `INSERT INTO cloud_workspaces (
           id, org_id, team_id, created_by, display_name,
           repository_forge, repository_owner, repository_name,
           repository_revision, github_installation_id, repository_id,
           owner_user_id, assignee_user_id, sharing_mode, single_member_mode
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $4, $4, 'organization', false
         )`,
        [
          workspaceId,
          orgId,
          teamId,
          user.id,
          normalized.name,
          resolvedRepository.forge,
          resolvedRepository.owner,
          resolvedRepository.name,
          body.repository.revision,
          body.repository.githubInstallationId,
          repositoryId,
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_members (
           workspace_id, org_id, user_id, role
         ) VALUES ($1, $2, $3, 'owner')`,
        [workspaceId, orgId, user.id],
      );
      await tx.query(
        `INSERT INTO workspace_retention_policies (workspace_id, org_id)
         VALUES ($1, $2)`,
        [workspaceId, orgId],
      );
      await tx.query(
        `INSERT INTO workspace_billing_epochs (
           workspace_id, billing_epoch, org_id, billing_owner_user_id,
           entitlement_scope, entitlement_plan, entitlement_revision,
           created_by
         ) VALUES ($1, 1, $2, $3, $4, $5, $6, $3)`,
        [
          workspaceId,
          orgId,
          authorization.billingOwnerUserId,
          authorization.entitlementScope,
          authorization.plan,
          authorization.entitlementRevision,
        ],
      );
      const providerConnection = body.providerConnectionId
        ? await selectCloudProviderConnectionForNewGeneration(tx, {
            connectionId: body.providerConnectionId,
            organizationId: orgId,
            ownerUserId: authorization.billingOwnerUserId,
            isPersonal: authorization.isPersonal,
            providers: configuredCloudWorkspaceProviders(config),
          })
        : await ensureHostedCloudProviderConnection(tx, {
            organizationId: orgId,
            ownerUserId: authorization.billingOwnerUserId,
            isPersonal: authorization.isPersonal,
            provider: profile.provider,
            actorUserId: user.id,
          });
      if (
        !providerConnection ||
        providerConnection.provider !== profile.provider ||
        (preflight.providerConnection !== null &&
          (providerConnection.id !== preflight.providerConnection.id ||
            providerConnection.credentialVersion !==
              preflight.providerConnection.credentialVersion))
      ) {
        throw new HttpError(
          409,
          "cloud_provider_connection_changed",
          "Cloud provider connection changed during repository verification",
        );
      }
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by, provider_connection_id, sandbox_class
         ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          workspaceId,
          orgId,
          profile.provider,
          profile.imageRef,
          profile.architecture,
          profile.cpuMillicores,
          profile.memoryMiB,
          profile.storageMiB,
          profile.sourceCommit,
          user.id,
          providerConnection.id,
          profile.sandboxClass??null,
        ],
      );
      const resolvedSettings = await resolveDatabaseCloudWorkspaceSettings(tx, {
        organizationId: orgId,
        repositoryId,
        workspaceId,
        generation: 1,
        actorUserId: user.id,
        isPersonal: authorization.isPersonal,
        secretEncryptionKeys:
          options.setupSecretKeyV1 !== undefined
            ? options.setupSecretKeyV1
              ? { 1: options.setupSecretKeyV1 }
              : {}
            : config.settingsSecretEncryptionKeys,
        currentSecretEncryptionKeyVersion:
          options.setupSecretKeyV1 !== undefined
            ? options.setupSecretKeyV1
              ? 1
              : null
            : config.currentSettingsSecretEncryptionKeyVersion,
      });
      const settings = await persistDatabaseCloudWorkspaceSettings(tx, {
        workspaceId,
        organizationId: orgId,
        generation: 1,
        actorUserId: user.id,
        settings: resolvedSettings,
      });
      await tx.query(
        `INSERT INTO cloud_workspace_setup_specs (
           workspace_id, generation, org_id, repository_forge,
           repository_owner, repository_name, repository_revision,
           github_installation_id, settings_snapshot,
           settings_snapshot_sha256, workspace_settings_version_id
         ) VALUES (
           $1, 1, $2, $3, $4, $5, $6, $7, $8::jsonb,
           digest($8::jsonb::text, 'sha256'), $9
         )`,
        [
          workspaceId,
          orgId,
          resolvedRepository.forge,
          resolvedRepository.owner,
          resolvedRepository.name,
          body.repository.revision,
          body.repository.githubInstallationId,
          settings.document,
          settings.id,
        ],
      );
      await persistCloudWorkspaceSetupSecrets(tx, {
        workspaceId,
        organizationId: orgId,
        generation: 1,
        secrets: resolvedSettings.setupSecrets,
      });
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider
         ) VALUES ($1, 1, $2, $3)`,
        [workspaceId, orgId, profile.provider],
      );
      await tx.query(
        `INSERT INTO workspace_executions (
           workspace_id, org_id, generation, authority_epoch, placement, state
         ) VALUES ($1, $2, 1, 1, 'cloud', 'provisioning')`,
        [workspaceId, orgId],
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
      let fork: ForkIntentRow | null = null;
      if (body.forkFromLocal) {
        const forkId = randomUUID();
        await tx.query(
          `INSERT INTO workspace_fork_intents (
             id, org_id, requested_by, operation, source_local_workspace_id,
             target_cloud_workspace_id, source_revision, include_chats,
             include_settings, idempotency_key, request_sha256,
             source_snapshot_sha256, source_git_base_commit,
             source_git_head_ref
           ) VALUES (
             $1, $2, $3, 'local_to_cloud', $4, $5, $6, $7, $8, $9, $10,
             $11, $12, $13
           )`,
          [
            forkId,
            orgId,
            user.id,
            body.forkFromLocal.sourceWorkspaceId,
            workspaceId,
            body.forkFromLocal.sourceRevision,
            body.forkFromLocal.includeChats,
            body.forkFromLocal.includeSettings,
            key,
            digest,
            Buffer.from(body.forkFromLocal.sourceSnapshotSha256, "hex"),
            body.forkFromLocal.sourceGitBaseCommit,
            body.forkFromLocal.sourceGitHeadRef,
          ],
        );
        fork = await loadForkForTarget(tx, orgId, workspaceId);
      }
      await tx.query(
        `INSERT INTO cloud_workspace_outbox (
           org_id, workspace_id, event_type, aggregate_key,
           aggregate_revision, idempotency_key, payload
         ) VALUES (
           $1, $2, 'cloud_workspace.create_requested', $3, 1, $4,
           $5::jsonb
         )`,
        [
          orgId,
          workspaceId,
          `workspace:${workspaceId}`,
          `workspace:${workspaceId}:created:1`,
          JSON.stringify({
            workspaceId,
            teamId,
            repositoryId,
            providerConnectionId: providerConnection.id,
            settingsVersionId: settings.id,
            generation: 1,
            authorityEpoch: 1,
            billingEpoch: 1,
            forkIntentId: fork?.id ?? null,
            sourceLocalWorkspaceId:
              body.forkFromLocal?.sourceWorkspaceId ?? null,
          }),
        ],
      );
      await audit(tx, orgId, user.id, "cloud_workspace.create_requested", {
        workspaceId,
        intentId,
        teamId,
        repository: {
          forge: resolvedRepository.forge,
          forgeRepositoryId: resolvedRepository.forgeRepositoryId,
          owner: resolvedRepository.owner,
          name: resolvedRepository.name,
        },
        generation: 1,
        forkIntentId: fork?.id ?? null,
      });
      const workspace = await loadWorkspace(tx, orgId, workspaceId, user.id);
      return {
        workspace,
        intent: insertedIntent.rows[0]!,
        fork,
        replayed: false,
      };
    });

    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(
      {
        workspace: workspaceDocument(result.workspace),
        intent: intentDocument(result.intent),
        fork: forkDocument(result.fork),
        replayed: result.replayed,
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
    const normalize = (profile: CloudWorkspaceProvisioningProfile | null) => ({
      operation: "replace-generation" as const,
      transitionOperation: body.operation,
      organizationId: orgId,
      workspaceId,
      templateGeneration:
        body.operation === "rollback" ? body.sourceGeneration : null,
      upgradeTarget: body.operation !== "rollback" && profile ? {
        provider: profile.provider,
        ...(profile.sandboxClass ? {sandboxClass: profile.sandboxClass} : {}),
        imageRef: profile.imageRef,
        architecture: profile.architecture,
        cpuMillicores: profile.cpuMillicores,
        memoryMiB: profile.memoryMiB,
        storageMiB: profile.storageMiB,
        sourceCommit: profile.sourceCommit,
      } : null,
      ...(body.operation === "recover" ? { recoveryCheckpointId: body.checkpointId, sourceGeneration: body.sourceGeneration } : {}),
    });

    const result = await withSystemTx(pool, async (tx) => {
      await requireOrganizationMembership(tx, orgId, user.id);
      await lockCloudOrganization(tx, orgId);
      const workspace = await loadWorkspaceRow(tx, orgId, workspaceId, true);
      await authorizeCloudWorkspaceCleanup(tx,{organizationId:orgId,workspaceId,actorUserId:user.id});
      const existing = await loadIntentByKey(tx, orgId, key);
      if (existing) {
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
        // Replays use the accepted immutable target, even after deployment
        // configuration or the managed default has changed.
        const accepted = await tx.query<CloudWorkspaceProvisioningProfile>(
          `SELECT provider, image_ref AS "imageRef", architecture,
                  cpu_millicores AS "cpuMillicores", memory_mib AS "memoryMiB",
                  storage_mib AS "storageMiB", source_commit AS "sourceCommit",
                  sandbox_class AS "sandboxClass"
           FROM cloud_workspace_generations
           WHERE workspace_id = $1 AND org_id = $2 AND generation = $3`,
          [workspaceId, orgId, transition.candidate_generation],
        );
        const profile = accepted.rows[0];
        if (!profile) {
          throw new HttpError(
            409,
            "idempotency_key_reused",
            "Accepted generation is unavailable",
          );
        }
        assertIdempotencyMatch(
          existing,
          workspaceId,
          requestDigest(normalize(profile)),
          user.id,
        );
        return { workspace, intent: existing, transition, replayed: true };
      }

      await authorizeCloudWorkspaceActor(tx,{organizationId:orgId,workspaceId,actorUserId:user.id,capability:"manage"});
      const authorization = await authorizeCloudWorkspaceOperation(tx, {
        organizationId: orgId,
        teamId: workspace.team_id,
        actorUserId: workspace.owner_user_id,
        billingOwnerUserId: workspace.owner_user_id,
        workosEnabled: options.workosEnabled === true,
        requireWorkspaceOwner: true,
      });
      await refreshCloudWorkspaceBillingEpoch(tx, {
        workspaceId,
        organizationId: orgId,
        authorization,
      });
      const recovering = body.operation === "recover";
      let expiredEngine = false;
      if (recovering && ["ready", "busy"].includes(workspace.status)) {
        // A crashed process can leave its last published status behind. The
        // workspace lock orders this check with heartbeat and registration;
        // a live replacement instance still prevents recovery from old state.
        const leases = await tx.query<{ expired: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM cloud_workspace_engine_instances
             WHERE workspace_id = $1 AND org_id = $2 AND generation = $3
               AND lease_expires_at <= now()
           ) AND NOT EXISTS (
             SELECT 1 FROM cloud_workspace_engine_instances
             WHERE workspace_id = $1 AND org_id = $2 AND generation = $3
               AND state IN ('starting', 'ready') AND revoked_at IS NULL
               AND lease_expires_at > now()
           ) AS expired`,
          [workspaceId, orgId, workspace.current_generation],
        );
        expiredEngine = leases.rows[0]?.expired === true;
      }
      if (workspace.deleted_at !== null || workspace.desired_state === "deleted" ||
        (recovering ? !expiredEngine && !["failed", "stopped", "archived"].includes(workspace.status) :
          workspace.desired_state !== "running" || workspace.status !== "ready")) {
        throw new HttpError(
          409,
          "cloud_workspace_not_stable",
          recovering ? "Recovery requires a failed or stopped workspace, or an expired engine lease" : "Cloud workspace must be ready before replacing its generation",
        );
      }
      let recoveryCheckpointId: string | null = null;
      if (body.operation === "recover") {
        if (workspace.current_generation !== body.sourceGeneration) {
          throw new HttpError(409, "cloud_generation_changed", "Cloud workspace generation changed before recovery");
        }
        const checkpoint = await tx.query<{ id: string }>(
          `SELECT checkpoint.id FROM workspace_checkpoints checkpoint
           JOIN workspace_content_heads head ON head.workspace_id = checkpoint.workspace_id
             AND head.org_id = checkpoint.org_id AND head.current_checkpoint_id = checkpoint.id
           WHERE checkpoint.id = $1 AND checkpoint.workspace_id = $2 AND checkpoint.org_id = $3
             AND checkpoint.state = 'durable' FOR SHARE OF checkpoint`,
          [body.checkpointId, workspaceId, orgId],
        );
        if (!checkpoint.rows[0]) throw new HttpError(404, "cloud_recovery_checkpoint_unavailable", "The current durable checkpoint is unavailable");
        recoveryCheckpointId = checkpoint.rows[0].id;
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
        provider: CloudWorkspaceProviderName;
        image_ref: string;
        sandbox_class: "container" | "linux-vm" | null;
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
        `SELECT g.provider, g.image_ref, g.sandbox_class, g.architecture, g.cpu_millicores,
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
      if (body.operation === "rollback") {
        const policy = await tx.query<{ current: boolean }>(
          `SELECT cloud_workspace_generation_policy_current(
             $1, $2, $3
           ) AS current`,
          [workspaceId, templateGeneration, orgId],
        );
        if (policy.rows[0]?.current !== true) {
          throw new HttpError(
            409,
            "cloud_managed_policy_rebuild_required",
            "This rollback snapshot predates the current managed policy; create an upgrade generation instead",
          );
        }
      }
      const candidate: CloudWorkspaceProvisioningProfile =
        body.operation !== "rollback"
          ? cloudWorkspaceProvisioningProfile(config, source.provider)
          : {
              provider: source.provider,
              imageRef: source.image_ref,
              ...(source.sandbox_class?{sandboxClass:source.sandbox_class}:{}),
              architecture: source.architecture,
              cpuMillicores: source.cpu_millicores,
              memoryMiB: source.memory_mib,
              storageMiB: source.storage_mib,
              sourceCommit: source.source_commit,
            };
      const digest = requestDigest(normalize(candidate));
      assertGenerationReplacementQuota(
        await loadQuota(tx, orgId),
        await loadUsage(tx, orgId),
        candidate,
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

      const providerConnection = await loadGenerationCloudProviderConnection(
        tx,
        {
          workspaceId,
          organizationId: orgId,
          generation: workspace.current_generation,
        },
      );
      if (
        !providerConnection ||
        providerConnection.provider !== candidate.provider
      ) {
        throw new HttpError(
          409,
          "cloud_provider_connection_unavailable",
          "The cloud provider connection is not available",
        );
      }

      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by, provider_connection_id, sandbox_class
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
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
          providerConnection.id,
          candidate.sandboxClass??null,
        ],
      );
      const resolvedSettings =
        body.operation === "rollback"
          ? await cloneDatabaseCloudWorkspaceSettingsForRollback(tx, {
              workspaceId,
              organizationId: orgId,
              sourceGeneration: templateGeneration,
              targetGeneration: candidateGeneration,
              secretEncryptionKeys:
                options.setupSecretKeyV1 !== undefined
                  ? options.setupSecretKeyV1
                    ? { 1: options.setupSecretKeyV1 }
                    : {}
                  : config.settingsSecretEncryptionKeys,
              currentSecretEncryptionKeyVersion:
                options.setupSecretKeyV1 !== undefined
                  ? options.setupSecretKeyV1
                    ? 1
                    : null
                  : config.currentSettingsSecretEncryptionKeyVersion,
            })
          : await resolveDatabaseCloudWorkspaceSettings(tx, {
              organizationId: orgId,
              repositoryId: workspace.repository_id,
              workspaceId,
              generation: candidateGeneration,
              actorUserId: workspace.owner_user_id,
              isPersonal: authorization.isPersonal,
              secretEncryptionKeys:
                options.setupSecretKeyV1 !== undefined
                  ? options.setupSecretKeyV1
                    ? { 1: options.setupSecretKeyV1 }
                    : {}
                  : config.settingsSecretEncryptionKeys,
              currentSecretEncryptionKeyVersion:
                options.setupSecretKeyV1 !== undefined
                  ? options.setupSecretKeyV1
                    ? 1
                    : null
                  : config.currentSettingsSecretEncryptionKeyVersion,
            });
      const settings = await persistDatabaseCloudWorkspaceSettings(tx, {
        workspaceId,
        organizationId: orgId,
        generation: candidateGeneration,
        actorUserId: user.id,
        settings: resolvedSettings,
      });
      await tx.query(
        `INSERT INTO cloud_workspace_setup_specs (
           workspace_id, generation, org_id, spec_version,
           repository_forge, repository_owner, repository_name,
           repository_revision, github_installation_id, settings_snapshot,
           settings_snapshot_sha256, workspace_settings_version_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
           digest($10::jsonb::text, 'sha256'), $11
         )`,
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
          settings.document,
          settings.id,
        ],
      );
      await persistCloudWorkspaceSetupSecrets(tx, {
        workspaceId,
        organizationId: orgId,
        generation: candidateGeneration,
        secrets: resolvedSettings.setupSecrets,
      });
      if (recoveryCheckpointId) {
        await tx.query(`UPDATE cloud_workspace_generations SET recovery_checkpoint_id = $4
          WHERE workspace_id = $1 AND org_id = $2 AND generation = $3`,
        [workspaceId, orgId, candidateGeneration, recoveryCheckpointId]);
        await retireCloudWorkspaceRuntimeAccess(tx, { workspaceId, organizationId: orgId, generation: workspace.current_generation, reason: "generation_replacement_requested" });
        await tx.query(`UPDATE cloud_workspaces SET desired_state = 'running', status = 'stopping',
          authority_epoch = authority_epoch + 1, version = version + 1, updated_at = now(), last_error_code = NULL, last_error_message = NULL
          WHERE id = $1 AND org_id = $2`, [workspaceId, orgId]);
      }
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
      const checkpointRequest = recoveryCheckpointId ? null : await enqueueWorkspaceCheckpointRequest(tx, {
        workspaceId,
        organizationId: orgId,
        generation: workspace.current_generation,
        requestedBy: user.id,
        lifecycleIntentId: intentId,
        reason: "before_rebuild",
        idempotencyKey: `generation.${transitionId}`,
      });
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
          checkpointRequestId: checkpointRequest?.id ?? null,
          checkpointDeadlineAt: checkpointRequest?.deadlineAt.toISOString() ?? null,
          ...(recoveryCheckpointId ? { recoveryCheckpointId } : {}),
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
    let discardUncheckpointed = false;
    if (operation === "delete") {
      const source = await c.req.text();
      let body: unknown = {};
      try {
        if (Buffer.byteLength(source, "utf8") > 4_096) throw new Error("oversized");
        if (source.trim()) body = JSON.parse(source);
      } catch {
        throw new HttpError(422, "invalid_input", "Invalid workspace deletion options");
      }
      discardUncheckpointed = parse(DeleteWorkspaceSchema, body).discardUncheckpointed;
    }
    const digest = requestDigest({
      operation,
      organizationId: orgId,
      workspaceId,
      // Retain the historical digest for ordinary empty-body DELETE retries.
      ...(discardUncheckpointed ? { discardUncheckpointed: true } : {}),
    });

    const result = await withSystemTx(pool, async (tx) => {
      await requireOrganizationMembership(tx, orgId, user.id);
      await lockCloudOrganization(tx, orgId);
      let workspace = await loadWorkspaceRow(tx, orgId, workspaceId, true);
      await authorizeCloudWorkspaceCleanup(tx,{organizationId:orgId,workspaceId,actorUserId:user.id});
      const existing = await loadIntentByKey(tx, orgId, key);
      if (existing) {
        assertIdempotencyMatch(existing, workspaceId, digest,user.id);
        if (operation === "delete") {
          await ensureWorkspaceDeletionJob(tx, {
            workspaceId,
            organizationId: orgId,
            requestedBy: user.id,
            lifecycleIntentId: existing.id,
          });
        }
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
        await authorizeCloudWorkspaceActor(tx,{organizationId:orgId,workspaceId,actorUserId:user.id,capability:"manage"});
        const closedAllocation = await tx.query(
          `SELECT 1 FROM cloud_workspace_provider_operations
           WHERE workspace_id=$1 AND generation=$2 AND org_id=$3
             AND (create_closed_at IS NOT NULL OR lost_at IS NOT NULL)`,
          [workspaceId, workspace.current_generation, orgId],
        );
        if (closedAllocation.rowCount) {
          throw new HttpError(
            409,
            "cloud_workspace_recreate_required",
            "Create a new cloud workspace to retry, or recover this workspace from a saved checkpoint",
          );
        }
        const authorization = await authorizeCloudWorkspaceOperation(tx, {
          organizationId: orgId,
          teamId: workspace.team_id,
          actorUserId: workspace.owner_user_id,
          billingOwnerUserId: workspace.owner_user_id,
          workosEnabled: options.workosEnabled === true,
          requireWorkspaceOwner: true,
        });
        await refreshCloudWorkspaceBillingEpoch(tx, {
          workspaceId,
          organizationId: orgId,
          authorization,
        });
        await assertWakeQuota(tx, orgId, workspace);
        const policy = await tx.query<{ current: boolean }>(
          `SELECT cloud_workspace_generation_policy_current(
             $1, $2, $3
           ) AS current`,
          [workspaceId, workspace.current_generation, orgId],
        );
        if (policy.rows[0]?.current !== true) {
          throw new HttpError(
            409,
            "cloud_managed_policy_rebuild_required",
            "The cloud workspace must be rebuilt with the current managed policy before it can wake",
          );
        }
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
          workspace = await loadWorkspaceRow(tx, orgId, workspaceId, true);
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
      await tx.query(
        `UPDATE workspace_checkpoint_requests request
         SET state = 'cancelled', completed_at = now(),
             error_code = 'superseded_by_newer_intent'
         FROM cloud_workspace_lifecycle_intents intent
         WHERE request.lifecycle_intent_id = intent.id
           AND intent.workspace_id = $1
           AND intent.state = 'superseded'
           AND request.state IN ('queued', 'delivered')`,
        [workspaceId],
      );

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
      if (operation === "delete") {
        await ensureWorkspaceDeletionJob(tx, {
          workspaceId,
          organizationId: orgId,
          requestedBy: user.id,
          lifecycleIntentId: intentId,
        });
      }

      const requiresFinalCheckpoint =
        !alreadySatisfied &&
        !discardUncheckpointed &&
        operation !== "wake" &&
        ["ready", "busy"].includes(workspace.status);
      const checkpointRequest = requiresFinalCheckpoint
        ? await enqueueWorkspaceCheckpointRequest(tx, {
            workspaceId,
            organizationId: orgId,
            generation: workspace.current_generation,
            requestedBy: user.id,
            lifecycleIntentId: intentId,
            reason:
              operation === "stop"
                ? "before_stop"
                : operation === "archive"
                  ? "before_archive"
                  : "before_delete",
            idempotencyKey: `lifecycle.${intentId}`,
          })
        : null;

      let retired: RetiredCloudWorkspaceRuntimeAccess = {
        revokedGrantCount: 0,
        revocationPendingClientAccessCount: 0,
        cancelledSetupRunCount: 0,
        revokedEngineInstanceCount: 0,
      };
      if (operation !== "wake" && !requiresFinalCheckpoint) {
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

      if (!alreadySatisfied && !requiresFinalCheckpoint) {
        await tx.query(
          `UPDATE cloud_workspaces
           SET desired_state = $2, status = $3, version = version + 1,
               authority_epoch = authority_epoch + 1,
               updated_at = now(), last_error_code = NULL,
               last_error_message = NULL
           WHERE id = $1`,
          [workspaceId, desiredState, transitionStatus],
        );
      }

      await audit(
        tx,
        orgId,
        user.id,
        `cloud_workspace.${operation}_requested`,
        {
          workspaceId,
          intentId,
          alreadySatisfied,
          ...(discardUncheckpointed ? { discardUncheckpointed: true } : {}),
          checkpointRequestId: checkpointRequest?.id ?? null,
          checkpointDeadlineAt:
            checkpointRequest?.deadlineAt.toISOString() ?? null,
          revokedGrantCount: retired.revokedGrantCount,
          revocationPendingClientAccessCount:
            retired.revocationPendingClientAccessCount,
          cancelledSetupRunCount: retired.cancelledSetupRunCount,
          revokedEngineInstanceCount: retired.revokedEngineInstanceCount,
        },
      );
      return {
        workspace: await loadWorkspaceRow(tx, orgId, workspaceId),
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
