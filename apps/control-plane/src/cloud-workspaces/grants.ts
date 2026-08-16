import { createHash, randomBytes } from "node:crypto";

import { audit } from "../audit.js";
import type { Tx } from "../db.js";

export type CloudWorkspaceGrantPurpose =
  | "engine-connect"
  | "repository-read"
  | "repository-write"
  | "setup";

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
};

export type ConsumedCloudWorkspaceGrant = Omit<
  IssuedCloudWorkspaceGrant,
  "token"
> & { consumedAt: Date };

export class CloudWorkspaceGrantError extends Error {
  constructor(public readonly code: string, message: string) {
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
    purpose: CloudWorkspaceGrantPurpose;
    audience: string;
    ttlSeconds: number;
    issuedBy: string | null;
  },
): Promise<IssuedCloudWorkspaceGrant> {
  await assertSystemTransaction(tx);
  assertUuid(input.workspaceId, "workspaceId");
  assertUuid(input.organizationId, "organizationId");
  assertUuid(input.accountUserId, "accountUserId");
  if (input.issuedBy !== null) assertUuid(input.issuedBy, "issuedBy");
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new CloudWorkspaceGrantError(
      "grant_input_invalid",
      "generation must be a positive integer",
    );
  }
  if (
    !Number.isSafeInteger(input.ttlSeconds) ||
    input.ttlSeconds < 15 ||
    input.ttlSeconds > 900
  ) {
    throw new CloudWorkspaceGrantError(
      "grant_ttl_invalid",
      "Grant TTL must be between 15 and 900 seconds",
    );
  }
  const audience = normalizeCloudWorkspaceGrantAudience(input.audience);

  const authorized = await tx.query<{
    status: string;
    desired_state: string;
  }>(
    `SELECT cw.status, cw.desired_state
     FROM cloud_workspaces cw
     JOIN cloud_workspace_generations g
       ON g.workspace_id = cw.id
      AND g.org_id = cw.org_id
      AND g.generation = $2
     JOIN organization_members om
       ON om.org_id = cw.org_id AND om.user_id = $4
     JOIN team_members tm
       ON tm.team_id = cw.team_id
      AND tm.org_id = cw.org_id
      AND tm.user_id = $4
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
  }>(
    `INSERT INTO cloud_workspace_endpoint_grants (
       workspace_id, generation, org_id, account_user_id, purpose,
       audience, token_hash, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       now() + ($8::integer * interval '1 second')
     ) RETURNING id, expires_at`,
    [
      input.workspaceId,
      input.generation,
      input.organizationId,
      input.accountUserId,
      input.purpose,
      audience,
      tokenHash(token),
      input.ttlSeconds,
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
    purpose: CloudWorkspaceGrantPurpose;
    audience: string;
  },
): Promise<ConsumedCloudWorkspaceGrant | null> {
  await assertSystemTransaction(tx);
  if (!TOKEN_PATTERN.test(input.token)) return null;
  assertUuid(input.workspaceId, "workspaceId");
  assertUuid(input.organizationId, "organizationId");
  assertUuid(input.accountUserId, "accountUserId");
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    return null;
  }
  const audience = normalizeCloudWorkspaceGrantAudience(input.audience);
  const consumed = await tx.query<{
    id: string;
    expires_at: Date;
    consumed_at: Date;
  }>(
    `WITH eligible AS (
       SELECT eg.id
       FROM cloud_workspace_endpoint_grants eg
       JOIN cloud_workspaces cw
         ON cw.id = eg.workspace_id AND cw.org_id = eg.org_id
       JOIN organization_members om
         ON om.org_id = cw.org_id AND om.user_id = eg.account_user_id
       JOIN team_members tm
         ON tm.team_id = cw.team_id
        AND tm.org_id = cw.org_id
        AND tm.user_id = eg.account_user_id
       WHERE eg.token_hash = $1
         AND eg.workspace_id = $2 AND eg.generation = $3
         AND eg.org_id = $4 AND eg.account_user_id = $5
         AND eg.purpose = $6 AND eg.audience = $7
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
     RETURNING eg.id, eg.expires_at, eg.consumed_at`,
    [
      tokenHash(input.token),
      input.workspaceId,
      input.generation,
      input.organizationId,
      input.accountUserId,
      input.purpose,
      audience,
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
  };
}
