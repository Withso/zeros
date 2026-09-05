import { createHash, timingSafeEqual } from "node:crypto";

import type { Tx } from "../db.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEARTBEAT_TOKEN_PATTERN = /^zwh_[A-Za-z0-9_-]{43}$/;

export class CloudWorkspaceEngineAuthorityError extends Error {
  constructor() {
    super("Cloud workspace engine authority is not current");
    this.name = "CloudWorkspaceEngineAuthorityError";
  }
}

export type CurrentCloudEngineAuthority = {
  workspaceId: string;
  organizationId: string;
  generation: number;
  authorityEpoch: number;
  accountUserId: string;
  engineInstanceId: string;
};

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function equalHash(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function validIdentityInput(input: {
  workspaceId: string;
  organizationId: string;
  generation: number;
  engineInstanceId: string;
  heartbeatToken: string;
}): boolean {
  return (
    UUID_PATTERN.test(input.workspaceId) &&
    UUID_PATTERN.test(input.organizationId) &&
    UUID_PATTERN.test(input.engineInstanceId) &&
    Number.isSafeInteger(input.generation) &&
    input.generation > 0 &&
    HEARTBEAT_TOKEN_PATTERN.test(input.heartbeatToken)
  );
}

/** Authenticate the exact engine identity without asserting that it remains
 * live. This is intentionally suitable only for returning an already-committed
 * idempotent response after a final checkpoint fenced that engine. */
export async function assertCloudEngineIdentityForIdempotentReplay(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    engineInstanceId: string;
    heartbeatToken: string;
  },
): Promise<void> {
  if (!validIdentityInput(input)) {
    throw new CloudWorkspaceEngineAuthorityError();
  }
  await tx.query(
    `SELECT id FROM cloud_workspaces
     WHERE id = $1 AND org_id = $2
     FOR UPDATE`,
    [input.workspaceId, input.organizationId],
  );
  const engine = await tx.query<{ heartbeat_token_hash: Buffer }>(
    `SELECT heartbeat_token_hash
     FROM cloud_workspace_engine_instances
     WHERE id = $1 AND workspace_id = $2 AND org_id = $3 AND generation = $4
     FOR UPDATE`,
    [
      input.engineInstanceId,
      input.workspaceId,
      input.organizationId,
      input.generation,
    ],
  );
  const hash = engine.rows[0]?.heartbeat_token_hash;
  if (!hash || !equalHash(hash, tokenHash(input.heartbeatToken))) {
    throw new CloudWorkspaceEngineAuthorityError();
  }
}

/** Caller must use a system transaction. Workspace-first locking preserves the
 * global revocation/engine lock order established by migration 0025. */
export async function assertCurrentCloudEngineAuthority(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    engineInstanceId: string;
    heartbeatToken: string;
    workosEnabled: boolean;
  },
): Promise<CurrentCloudEngineAuthority> {
  if (!validIdentityInput(input)) {
    throw new CloudWorkspaceEngineAuthorityError();
  }
  const workspace = await tx.query<{
    current_generation: number;
    authority_epoch: string | number;
    desired_state: string;
    status: string;
  }>(
    `SELECT current_generation, authority_epoch, desired_state, status
     FROM cloud_workspaces
     WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
       AND cloud_workspace_generation_policy_current(id, $3, org_id)
     FOR UPDATE`,
    [input.workspaceId, input.organizationId, input.generation],
  );
  const current = workspace.rows[0];
  if (
    !current ||
    current.current_generation !== input.generation ||
    current.desired_state !== "running" ||
    !["setting_up", "ready", "busy"].includes(current.status)
  ) {
    throw new CloudWorkspaceEngineAuthorityError();
  }
  const engine = await tx.query<{
    account_user_id: string;
    heartbeat_token_hash: Buffer;
  }>(
    `SELECT engine.account_user_id, engine.heartbeat_token_hash
     FROM cloud_workspace_engine_instances engine
     WHERE engine.id = $1
       AND engine.workspace_id = $2
       AND engine.org_id = $3
       AND engine.generation = $4
       AND engine.state = 'ready'
       AND engine.lease_expires_at > now()
       AND cloud_workspace_runtime_authority_live(
         engine.workspace_id, engine.generation, engine.account_user_id, $5
       )
     FOR UPDATE`,
    [
      input.engineInstanceId,
      input.workspaceId,
      input.organizationId,
      input.generation,
      input.workosEnabled,
    ],
  );
  const row = engine.rows[0];
  if (
    !row?.heartbeat_token_hash ||
    !equalHash(row.heartbeat_token_hash, tokenHash(input.heartbeatToken))
  ) {
    throw new CloudWorkspaceEngineAuthorityError();
  }
  const completedFinalCheckpoint = await tx.query(
    `SELECT 1
     FROM workspace_checkpoint_requests checkpoint_request
     JOIN cloud_workspace_lifecycle_intents intent
       ON intent.id = checkpoint_request.lifecycle_intent_id
     WHERE checkpoint_request.workspace_id = $1
       AND checkpoint_request.org_id = $2
       AND checkpoint_request.generation = $3
       AND checkpoint_request.state = 'succeeded'
       AND intent.state IN ('queued', 'observing', 'dispatching')
       AND intent.operation IN ('stop', 'archive', 'delete')
     LIMIT 1`,
    [input.workspaceId, input.organizationId, input.generation],
  );
  if ((completedFinalCheckpoint.rowCount ?? 0) !== 0) {
    throw new CloudWorkspaceEngineAuthorityError();
  }
  const authorityEpoch = Number(current.authority_epoch);
  if (!Number.isSafeInteger(authorityEpoch) || authorityEpoch < 1) {
    throw new CloudWorkspaceEngineAuthorityError();
  }
  return {
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    generation: input.generation,
    authorityEpoch,
    accountUserId: row.account_user_id,
    engineInstanceId: input.engineInstanceId,
  };
}
