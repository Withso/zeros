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

/** Only after assertCurrentCloudEngineAuthority has locked this engine and its
 * parents in the same transaction. Later credential locks can consume the
 * remaining lease time even though those authority rows cannot change. */
export async function assertCloudEngineAuthorityDeadline(
  tx: Tx,
  engineInstanceId: string,
  workosEnabled: boolean,
): Promise<void> {
  const live = await tx.query(`SELECT 1 FROM cloud_workspace_engine_instances
    WHERE id=$1 AND lease_expires_at>clock_timestamp()
      AND cloud_workspace_runtime_authority_live(workspace_id,generation,account_user_id,$2)`,
  [engineInstanceId,workosEnabled]);
  if (live.rowCount !== 1) throw new CloudWorkspaceEngineAuthorityError();
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
  await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [input.organizationId]);
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

/** Caller must use a system transaction. Parent scope precedes workspace and
 * engine locks, including implicit foreign-key locks during publication. */
export async function assertCurrentCloudEngineAuthority(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    engineInstanceId: string;
    heartbeatToken: string;
    workosEnabled: boolean;
    /** Pure reads share the same revocation fence without serializing readers.
     * Mutations retain exclusive workspace/engine locks by default. */
    lock?: "share" | "update";
  },
): Promise<CurrentCloudEngineAuthority> {
  if (!validIdentityInput(input)) {
    throw new CloudWorkspaceEngineAuthorityError();
  }
  // One round trip: every engine request holds these locks until it commits.
  const authority = await tx.query<{
    authority_epoch: string;
    account_user_id: string;
    heartbeat_token_hash: Buffer;
    live: boolean;
    fenced: boolean;
  }>(
    `SELECT authority_epoch, account_user_id, heartbeat_token_hash, live, fenced
     FROM cloud_workspace_engine_authority_current($1, $2, $3, $4, $5, $6)`,
    [
      input.workspaceId,
      input.organizationId,
      input.generation,
      input.engineInstanceId,
      input.workosEnabled,
      input.lock !== "share",
    ],
  );
  const row = authority.rows[0];
  if (
    !row?.heartbeat_token_hash ||
    !equalHash(row.heartbeat_token_hash, tokenHash(input.heartbeatToken)) ||
    row.live !== true ||
    row.fenced !== false
  ) {
    throw new CloudWorkspaceEngineAuthorityError();
  }
  const authorityEpoch = Number(row.authority_epoch);
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
