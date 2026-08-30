import { createHash, randomBytes } from "node:crypto";

import { audit } from "../audit.js";
import type { Tx } from "../db.js";

export type CloudWorkspaceGrantPurpose =
  | "engine-connect"
  | "repository-read"
  | "repository-write"
  | "setup";

export type CloudWorkspaceSetupGrantBinding = {
  setupRunId: string;
  executionFence: number;
};

type NonSetupGrantPurpose = Exclude<CloudWorkspaceGrantPurpose, "setup">;

type CloudWorkspaceGrantPurposeInput =
  | {
      purpose: "setup";
      setup: CloudWorkspaceSetupGrantBinding;
    }
  | {
      purpose: NonSetupGrantPurpose;
      setup?: never;
    };

export type IssuedCloudWorkspaceGrant = {
  id: string;
  token: string;
  workspaceId: string;
  generation: number;
  organizationId: string;
  accountUserId: string;
  purpose: CloudWorkspaceGrantPurpose;
  audience: string;
  expiresAt: Date;
  setupRunId: string | null;
  executionFence: number | null;
};

export type ConsumedCloudWorkspaceGrant = Omit<
  IssuedCloudWorkspaceGrant,
  "token"
> & { consumedAt: Date };

export class CloudWorkspaceGrantError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CloudWorkspaceGrantError";
  }
}

const TOKEN_PREFIX = "zws_";
const TOKEN_PATTERN = /^zws_[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function assertSystemTransaction(tx: Tx): Promise<void> {
  const result = await tx.query<{ allowed: boolean }>(
    "SELECT app_is_system() AS allowed",
  );
  if (result.rows[0]?.allowed !== true) {
    throw new CloudWorkspaceGrantError(
      "grant_system_context_required",
      "Cloud workspace grants require system authority",
    );
  }
}

function assertUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new CloudWorkspaceGrantError(
      "grant_input_invalid",
      `${field} must be a UUID`,
    );
  }
}

function setupBinding(
  input: CloudWorkspaceGrantPurposeInput,
): CloudWorkspaceSetupGrantBinding | null {
  if (input.purpose !== "setup") return null;
  assertUuid(input.setup.setupRunId, "setupRunId");
  if (
    !Number.isSafeInteger(input.setup.executionFence) ||
    input.setup.executionFence < 1
  ) {
    throw new CloudWorkspaceGrantError(
      "grant_input_invalid",
      "executionFence must be a positive integer",
    );
  }
  return input.setup;
}

function databaseFence(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CloudWorkspaceGrantError(
      "grant_record_invalid",
      "Stored setup grant fence is invalid",
    );
  }
  return parsed;
}

export function normalizeCloudWorkspaceGrantAudience(raw: string): string {
  if (raw.length > 512) {
    throw new CloudWorkspaceGrantError(
      "grant_audience_invalid",
      "Grant audience is too long",
    );
  }
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new CloudWorkspaceGrantError(
      "grant_audience_invalid",
      "Grant audience must be an absolute HTTPS URL",
    );
  }
  if (
    value.protocol !== "https:" ||
    value.username ||
    value.password ||
    value.search ||
    value.hash
  ) {
    throw new CloudWorkspaceGrantError(
      "grant_audience_invalid",
      "Grant audience must be a credential-free HTTPS URL without query or fragment",
    );
  }
  return value.toString();
}

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function purposeAllowsStatus(
  purpose: CloudWorkspaceGrantPurpose,
  status: string,
): boolean {
  switch (purpose) {
    case "engine-connect":
      return status === "ready" || status === "busy";
    case "setup":
      return status === "setting_up";
    case "repository-read":
    case "repository-write":
      return ["setting_up", "ready", "busy"].includes(status);
  }
}

export async function issueCloudWorkspaceGrant(
  tx: Tx,
  input: {
    workspaceId: string;
    generation: number;
    organizationId: string;
    accountUserId: string;
    audience: string;
    ttlSeconds: number;
    issuedBy: string | null;
  } & CloudWorkspaceGrantPurposeInput,
): Promise<IssuedCloudWorkspaceGrant> {
  await assertSystemTransaction(tx);
  assertUuid(input.workspaceId, "workspaceId");
  assertUuid(input.organizationId, "organizationId");
  assertUuid(input.accountUserId, "accountUserId");
  if (input.issuedBy !== null) assertUuid(input.issuedBy, "issuedBy");
  const binding = setupBinding(input);
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new CloudWorkspaceGrantError(
      "grant_input_invalid",
      "generation must be a positive integer",
    );
  }
  const maximumTtlSeconds = input.purpose === "setup" ? 7_200 : 900;
  if (
    !Number.isSafeInteger(input.ttlSeconds) ||
    input.ttlSeconds < 15 ||
    input.ttlSeconds > maximumTtlSeconds
  ) {
    throw new CloudWorkspaceGrantError(
      "grant_ttl_invalid",
      `Grant TTL must be between 15 and ${maximumTtlSeconds} seconds`,
    );
  }

  const audience = normalizeCloudWorkspaceGrantAudience(input.audience);

  const authorized = await tx.query<{
    status: string;
    desired_state: string;
    account_revision: string | number;
    authorization_revision: string | number;
  }>(
    `SELECT cw.status, cw.desired_state, u.auth_revision AS account_revision,
            om.authorization_revision
     FROM cloud_workspaces cw
     JOIN cloud_workspace_generations g
       ON g.workspace_id = cw.id
      AND g.org_id = cw.org_id
      AND g.generation = $2
     JOIN organizations organization
       ON organization.id = cw.org_id AND organization.deleted_at IS NULL
     JOIN teams team
       ON team.id = cw.team_id AND team.org_id = cw.org_id
      AND team.deleted_at IS NULL
     JOIN organization_members om
       ON om.org_id = cw.org_id AND om.user_id = $4
     JOIN users u
       ON u.id = om.user_id AND u.deleted_at IS NULL
      AND u.auth_status = 'active'
     JOIN team_members tm
       ON tm.team_id = cw.team_id
      AND tm.org_id = cw.org_id
      AND tm.user_id = $4
     JOIN users account
       ON account.id = $4 AND account.deleted_at IS NULL
     WHERE cw.id = $1 AND cw.org_id = $3
       AND cw.current_generation = $2
       AND cw.deleted_at IS NULL
     FOR UPDATE OF cw`,
    [
      input.workspaceId,
      input.generation,
      input.organizationId,
      input.accountUserId,
    ],
  );
  const workspace = authorized.rows[0];
  if (
    !workspace ||
    workspace.desired_state !== "running" ||
    !purposeAllowsStatus(input.purpose, workspace.status)
  ) {
    throw new CloudWorkspaceGrantError(
      "grant_subject_not_authorized",
      "Workspace, generation, account, or lifecycle state is not eligible for this grant",
    );
  }

  // Preserve the global workspace → setup-run lock order used by lifecycle
  // routes and the setup worker. A grant issuer must never invert that order.
  if (binding) {
    const setup = await tx.query(
      `SELECT 1
       FROM cloud_workspace_setup_runs
       WHERE id = $1 AND workspace_id = $2 AND generation = $3 AND org_id = $4
         AND execution_fence = $5 AND state = 'running'
         AND lease_expires_at > now()
       FOR UPDATE`,
      [
        binding.setupRunId,
        input.workspaceId,
        input.generation,
        input.organizationId,
        binding.executionFence,
      ],
    );
    if ((setup.rowCount ?? 0) !== 1) {
      throw new CloudWorkspaceGrantError(
        "grant_subject_not_authorized",
        "Setup execution is not eligible for this grant",
      );
    }
  }

  // Keep at most one unconsumed grant for the same account and purpose. The
  // workspace row lock serializes concurrent issuers across replicas.
  await tx.query(
    `UPDATE cloud_workspace_endpoint_grants
     SET revoked_at = coalesce(revoked_at, now())
     WHERE workspace_id = $1 AND generation = $2 AND org_id = $3
       AND account_user_id = $4 AND purpose = $5
       AND revoked_at IS NULL AND consumed_at IS NULL`,
    [
      input.workspaceId,
      input.generation,
      input.organizationId,
      input.accountUserId,
      input.purpose,
    ],
  );

  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const inserted = await tx.query<{
    id: string;
    expires_at: Date;
    setup_run_id: string | null;
    setup_execution_fence: string | number | null;
  }>(
    `INSERT INTO cloud_workspace_endpoint_grants (
       workspace_id, generation, org_id, account_user_id, purpose,
       audience, token_hash, account_revision, authorization_revision,
       expires_at, setup_run_id, setup_execution_fence
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       now() + ($10::integer * interval '1 second'), $11, $12
     ) RETURNING id, expires_at, setup_run_id, setup_execution_fence`,
    [
      input.workspaceId,
      input.generation,
      input.organizationId,
      input.accountUserId,
      input.purpose,
      audience,
      tokenHash(token),
      Number(workspace.account_revision),
      Number(workspace.authorization_revision),
      input.ttlSeconds,
      binding?.setupRunId ?? null,
      binding?.executionFence ?? null,
    ],
  );
  const row = inserted.rows[0]!;
  await audit(
    tx,
    input.organizationId,
    input.issuedBy,
    "cloud_workspace.grant_issued",
    {
      grantId: row.id,
      workspaceId: input.workspaceId,
      generation: input.generation,
      accountUserId: input.accountUserId,
      purpose: input.purpose,
      ...(binding
        ? {
            setupRunId: binding.setupRunId,
            executionFence: binding.executionFence,
          }
        : {}),
      audience,
      expiresAt: row.expires_at.toISOString(),
    },
  );
  return {
    id: row.id,
    token,
    workspaceId: input.workspaceId,
    generation: input.generation,
    organizationId: input.organizationId,
    accountUserId: input.accountUserId,
    purpose: input.purpose,
    audience,
    expiresAt: row.expires_at,
    setupRunId: row.setup_run_id,
    executionFence: databaseFence(row.setup_execution_fence),
  };
}

export async function consumeCloudWorkspaceGrant(
  tx: Tx,
  input: {
    token: string;
    workspaceId: string;
    generation: number;
    organizationId: string;
    accountUserId: string;
    audience: string;
  } & CloudWorkspaceGrantPurposeInput,
): Promise<ConsumedCloudWorkspaceGrant | null> {
  await assertSystemTransaction(tx);
  if (!TOKEN_PATTERN.test(input.token)) return null;
  assertUuid(input.workspaceId, "workspaceId");
  assertUuid(input.organizationId, "organizationId");
  assertUuid(input.accountUserId, "accountUserId");
  let binding: CloudWorkspaceSetupGrantBinding | null;
  try {
    binding = setupBinding(input);
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    return null;
  }
  const audience = normalizeCloudWorkspaceGrantAudience(input.audience);
  const consumed = await tx.query<{
    id: string;
    expires_at: Date;
    consumed_at: Date;
    setup_run_id: string | null;
    setup_execution_fence: string | number | null;
  }>(
    `WITH eligible AS (
       SELECT eg.id
       FROM cloud_workspace_endpoint_grants eg
       JOIN cloud_workspaces cw
         ON cw.id = eg.workspace_id AND cw.org_id = eg.org_id
       JOIN organizations organization
         ON organization.id = cw.org_id
        AND organization.deleted_at IS NULL
       JOIN teams team
         ON team.id = cw.team_id AND team.org_id = cw.org_id
        AND team.deleted_at IS NULL
       JOIN organization_members om
         ON om.org_id = cw.org_id AND om.user_id = eg.account_user_id
        AND om.authorization_revision = eg.authorization_revision
       JOIN users u
         ON u.id = eg.account_user_id AND u.deleted_at IS NULL
        AND u.auth_status = 'active'
        AND u.auth_revision = eg.account_revision
       JOIN team_members tm
         ON tm.team_id = cw.team_id
        AND tm.org_id = cw.org_id
        AND tm.user_id = eg.account_user_id
       JOIN users account
         ON account.id = eg.account_user_id AND account.deleted_at IS NULL
       WHERE eg.token_hash = $1
         AND eg.workspace_id = $2 AND eg.generation = $3
         AND eg.org_id = $4 AND eg.account_user_id = $5
         AND eg.purpose = $6 AND eg.audience = $7
         AND (
           (
             $6 <> 'setup'
             AND eg.setup_run_id IS NULL
             AND eg.setup_execution_fence IS NULL
           )
           OR (
             $6 = 'setup'
             AND eg.setup_run_id = $8::uuid
             AND eg.setup_execution_fence = $9::bigint
             AND EXISTS (
               SELECT 1 FROM cloud_workspace_setup_runs sr
               WHERE sr.id = eg.setup_run_id
                 AND sr.workspace_id = eg.workspace_id
                 AND sr.generation = eg.generation
                 AND sr.org_id = eg.org_id
                 AND sr.execution_fence = eg.setup_execution_fence
                 AND sr.state = 'running'
                 AND sr.lease_expires_at > now()
             )
           )
         )
         AND eg.revoked_at IS NULL AND eg.consumed_at IS NULL
         AND eg.expires_at > now() AND cw.deleted_at IS NULL
         AND cw.current_generation = eg.generation
         AND cw.desired_state = 'running'
         AND (
           (eg.purpose = 'engine-connect' AND cw.status IN ('ready', 'busy'))
           OR (eg.purpose = 'setup' AND cw.status = 'setting_up')
           OR (eg.purpose IN ('repository-read', 'repository-write')
               AND cw.status IN ('setting_up', 'ready', 'busy'))
         )
       FOR UPDATE OF eg
     )
     UPDATE cloud_workspace_endpoint_grants eg
     SET consumed_at = now()
     FROM eligible
     WHERE eg.id = eligible.id
     RETURNING eg.id, eg.expires_at, eg.consumed_at,
               eg.setup_run_id, eg.setup_execution_fence`,
    [
      tokenHash(input.token),
      input.workspaceId,
      input.generation,
      input.organizationId,
      input.accountUserId,
      input.purpose,
      audience,
      binding?.setupRunId ?? null,
      binding?.executionFence ?? null,
    ],
  );
  const row = consumed.rows[0];
  if (!row) return null;
  await audit(
    tx,
    input.organizationId,
    input.accountUserId,
    "cloud_workspace.grant_consumed",
    {
      grantId: row.id,
      workspaceId: input.workspaceId,
      generation: input.generation,
      purpose: input.purpose,
      ...(binding
        ? {
            setupRunId: binding.setupRunId,
            executionFence: binding.executionFence,
          }
        : {}),
      audience,
    },
  );
  return {
    id: row.id,
    workspaceId: input.workspaceId,
    generation: input.generation,
    organizationId: input.organizationId,
    accountUserId: input.accountUserId,
    purpose: input.purpose,
    audience,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    setupRunId: row.setup_run_id,
    executionFence: databaseFence(row.setup_execution_fence),
  };
}
