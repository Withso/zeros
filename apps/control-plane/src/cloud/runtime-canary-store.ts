import { createHash } from "node:crypto";
import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
import { RuntimeCanaryStatusSchema, refuseRuntimeCanary, type RuntimeCanaryAdmission, type RuntimeCanaryPolicy, type RuntimeCanaryStatus } from "./runtime-canary.js";
import type { CloudV2Runtime } from "./runtime.js";
import type { CloudV2Workspace } from "./store.js";
import { CLOUD_V2_LIVE_ACCESS } from "./workspace-access.js";

export async function consumeRuntimeCanary(tx: Tx, workspace: CloudV2Workspace, grant: RuntimeCanaryAdmission,
  repositoryId: string | undefined, createKey: string | undefined): Promise<void> {
  if (workspace.creatorUserId !== grant.creatorUserId || workspace.organizationId !== grant.organizationId ||
      repositoryId !== grant.repositoryId || createKey !== grant.createKey) throw refuseRuntimeCanary();
  const { rowCount } = await tx.query(`INSERT INTO cloud_v2_runtime_canaries
    (grant_id,workspace_id,creator_user_id,org_id,repository_id,runtime_sha256,source_sha,grant_sha256,create_key_sha256,run_id,run_attempt,issued_at,expires_at)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12),to_timestamp($13)
    WHERE to_timestamp($12) <= clock_timestamp() + interval '30 seconds' AND to_timestamp($13) > clock_timestamp()
      AND to_timestamp($13) <= clock_timestamp() + interval '15 minutes'
    ON CONFLICT (grant_id) DO NOTHING RETURNING grant_id`,
  [grant.jti, workspace.id, grant.creatorUserId, grant.organizationId, grant.repositoryId, grant.runtimeSha256,
    grant.sourceSha, grant.grantHash, createHash("sha256").update(grant.createKey).digest("hex"), grant.runId, grant.runAttempt, grant.iat, grant.exp]);
  if (!rowCount) throw refuseRuntimeCanary();
  // A uniqueness wait can outlive the pre-insert admission check.
  const { rows } = await tx.query<{ valid: boolean }>("SELECT clock_timestamp() < to_timestamp($1) AS valid", [grant.exp]);
  if (rows[0]?.valid !== true) throw refuseRuntimeCanary();
}

export async function readRuntimeCanary(pool: pg.Pool, policy: RuntimeCanaryPolicy, userId: string, grantId: string): Promise<RuntimeCanaryStatus | null> {
  const fixture = policy.fixture;
  if (userId !== fixture.creatorUserId) return null;
  const row = await withSystemTx(pool, async tx => (await tx.query(
    `SELECT p.grant_id AS "grantId",w.id AS "workspaceId",p.creator_user_id AS "creatorUserId",p.org_id AS "organizationId",
      p.repository_id::text AS "repositoryId",p.run_id AS "runId",p.run_attempt AS "runAttempt",p.runtime_sha256 AS "runtimeSha256",
      p.source_sha AS "sourceSha",p.grant_sha256 AS "grantSha256",p.create_key_sha256 AS "createKeySha256",w.state
     FROM cloud_v2_runtime_canaries p
     JOIN cloud_v2_workspaces w ON w.id=p.workspace_id AND w.creator_user_id=p.creator_user_id AND w.org_id=p.org_id
     WHERE p.grant_id=$1 AND p.creator_user_id=$2 AND p.org_id=$3 AND p.repository_id=$4 AND ${CLOUD_V2_LIVE_ACCESS}`,
    [grantId, fixture.creatorUserId, fixture.organizationId, fixture.repositoryId])).rows[0], { consistentRead: true });
  // A missing or inaccessible row is not proof that its VM was deleted.
  return row ? RuntimeCanaryStatusSchema.parse({ version: 1, ...row, deleted: row.state === "deleted" }) : null;
}

export function workspaceRuntimeResolver(pool: pg.Pool, runtime: CloudV2Runtime, policy?: RuntimeCanaryPolicy) {
  return async (workspace: CloudV2Workspace): Promise<CloudV2Runtime> => {
    const fixture = policy?.fixture;
    const pin = await withSystemTx(pool, async tx => (await tx.query<{
      runtime_sha256: string; creator_user_id: string | null; org_id: string | null; repository_id: string; bound: boolean;
    }>(`SELECT p.runtime_sha256,p.creator_user_id,p.org_id,p.repository_id::text,
         (w.creator_user_id=p.creator_user_id AND w.org_id=p.org_id AND w.state <> 'deleted'
          AND s.repository_id=p.repository_id) IS TRUE AS bound
       FROM cloud_v2_runtime_canaries p
       LEFT JOIN cloud_v2_workspaces w ON w.id=p.workspace_id
       LEFT JOIN cloud_v2_github_sources s ON s.workspace_id=w.id AND s.source_repository=lower(w.repository)
       WHERE p.workspace_id=$1`, [workspace.id])).rows[0], { consistentRead: true });
    if (!pin) return runtime;
    if (!fixture || !pin.bound || pin.creator_user_id !== workspace.creatorUserId || pin.org_id !== workspace.organizationId ||
        pin.creator_user_id !== fixture.creatorUserId || pin.org_id !== fixture.organizationId || pin.repository_id !== fixture.repositoryId) throw refuseRuntimeCanary();
    // An admitted candidate is immutable for this workspace, even after its
    // admission token expires or the ordinary channel pin advances.
    return { sha256: pin.runtime_sha256, url: () => runtime.url(pin.runtime_sha256) };
  };
}
