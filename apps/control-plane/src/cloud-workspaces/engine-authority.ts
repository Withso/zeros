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

/** Recheck wall-clock expiry after reading or locking authority in the same
 * transaction. A coherent reader must also retain its original observation
 * deadline: this check does not advance its snapshot or replace a mutation fence. */
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

/** A versioned authority observation for short-lived reads. The caller uses a
 * consistent snapshot and never treats this as a mutation fence. Its deadline
 * starts at BEGIN, not after a slow query or a later response. Mutators retain
 * assertCurrentCloudEngineAuthority and its existing parent/engine locks. */
export async function readCurrentCloudEngineAuthority(
  tx: Tx,
  input: {
    workspaceId: string; organizationId: string; generation: number;
    engineInstanceId: string; heartbeatToken: string; workosEnabled: boolean;
  },
): Promise<CurrentCloudEngineAuthority & { version: 1; confirmedUntilMs: number }> {
  if (!validIdentityInput(input)) throw new CloudWorkspaceEngineAuthorityError();
  const row = (await tx.query<{
    authority_epoch: string; account_user_id: string; heartbeat_token_hash: Buffer; confirmed_until: Date;
  }>(`SELECT workspace.authority_epoch,engine.account_user_id,engine.heartbeat_token_hash,
      least(transaction_timestamp()+interval '10 seconds',engine.lease_expires_at) AS confirmed_until
    FROM cloud_workspace_engine_instances engine
    JOIN cloud_workspaces workspace ON workspace.id=engine.workspace_id AND workspace.org_id=engine.org_id
    WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.current_generation=$3 AND engine.id=$4 AND engine.generation=$3
      AND workspace.deleted_at IS NULL AND workspace.desired_state='running' AND workspace.status IN ('setting_up','ready','busy')
      AND cloud_workspace_generation_policy_current(workspace.id,$3,workspace.org_id)
      AND engine.state='ready' AND engine.revoked_at IS NULL AND engine.final_checkpoint_at IS NULL
      AND engine.lease_expires_at>clock_timestamp()
      AND cloud_workspace_runtime_authority_live(workspace.id,$3,engine.account_user_id,$5)
      AND (engine.setup_run_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM cloud_workspace_runtime_enrollments enrollment
        JOIN cloud_workspace_runtime_transitions runtime ON runtime.transition_id=enrollment.transition_id
        WHERE enrollment.id=engine.runtime_transition_enrollment_id AND enrollment.consumed_at IS NOT NULL
          AND enrollment.revoked_at IS NULL AND enrollment.sequence=runtime.enrollment_sequence
          AND runtime.phase IN ('healthy','rolled_back')))`,
  [input.workspaceId,input.organizationId,input.generation,input.engineInstanceId,input.workosEnabled])).rows[0];
  const authorityEpoch = Number(row?.authority_epoch), confirmedUntilMs = row?.confirmed_until.getTime();
  if (!row || !row.heartbeat_token_hash || !equalHash(row.heartbeat_token_hash,tokenHash(input.heartbeatToken)) ||
      !Number.isSafeInteger(authorityEpoch) || authorityEpoch < 1 || confirmedUntilMs === undefined ||
      !Number.isSafeInteger(confirmedUntilMs) || confirmedUntilMs <= Date.now()) throw new CloudWorkspaceEngineAuthorityError();
  return { version: 1, workspaceId: input.workspaceId, organizationId: input.organizationId, generation: input.generation,
    authorityEpoch, accountUserId: row.account_user_id, engineInstanceId: input.engineInstanceId, confirmedUntilMs };
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
    /** Reads share the same revocation fence without serializing readers. A
     * mutation may share it only when its own row locks order it against
     * concurrent peers, including creating a missing row, and no peer skips a
     * row it locks (event appends, device admission renewals, approval
     * rechecks). Other mutations retain exclusive workspace/engine locks. */
    lock?: "share" | "update";
    /** Only durable record synchronization may run before transfer health. */
    transitionRecordSync?: boolean;
  },
): Promise<CurrentCloudEngineAuthority> {
  if (!validIdentityInput(input)) {
    throw new CloudWorkspaceEngineAuthorityError();
  }
  // Setup engines retain the original one-round-trip authority path. Every
  // engine request holds these locks until it commits.
  const authority = await tx.query<{
    authority_epoch: string;
    account_user_id: string;
    heartbeat_token_hash: Buffer;
    live: boolean;
    fenced: boolean;
    setup_enrolled: boolean;
  }>(
    `SELECT authority_epoch, account_user_id, heartbeat_token_hash, live, fenced,
       EXISTS(SELECT 1 FROM cloud_workspace_engine_instances engine
         WHERE engine.id=$4 AND engine.workspace_id=$1 AND engine.org_id=$2 AND engine.generation=$3
           AND engine.setup_run_id IS NOT NULL) AS setup_enrolled
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
  // The enrollment-kind CHECK makes setup_run_id NULL exclusive to retained
  // runtime enrollments. Source setup engines are revoked atomically at
  // activation; only a freshly enrolled engine needs this additional fence.
  // Do not reference the new journal on the legacy recovery/schema path.
  if (!row.setup_enrolled && input.transitionRecordSync !== true) {
    const ready = await tx.query(`SELECT 1 FROM cloud_workspace_engine_instances engine
      JOIN cloud_workspace_runtime_enrollments enrollment ON enrollment.id=engine.runtime_transition_enrollment_id
      JOIN cloud_workspace_runtime_transitions runtime ON runtime.transition_id=enrollment.transition_id
      WHERE engine.id=$4 AND engine.workspace_id=$1 AND engine.org_id=$2 AND engine.generation=$3
        AND engine.state='ready' AND engine.lease_expires_at>clock_timestamp()
        AND enrollment.consumed_at IS NOT NULL AND enrollment.revoked_at IS NULL
        AND enrollment.sequence=runtime.enrollment_sequence AND runtime.phase IN ('healthy','rolled_back')`,
    [input.workspaceId, input.organizationId, input.generation, input.engineInstanceId]);
    if (!ready.rowCount) throw new CloudWorkspaceEngineAuthorityError();
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
