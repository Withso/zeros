import type pg from "pg";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import type { CloudGithubRepository } from "../github-user-access.js";

export interface McpRepository { repository: string; defaultBranch?: string; repositoryId?: string | null }

/** Called only after /v1/github/cloud verified the native user's App token and
 * rechecked the exact account/member fingerprint after GitHub I/O. */
export async function rememberMcpRepositories(tx: Tx, input: {
  organizationId: string; userId: string; installationId: string; fingerprint: string; repositories: readonly CloudGithubRepository[];
}): Promise<void> {
  if (input.repositories.length > 100) throw new Error("Invalid repository page");
  await tx.query("/* lock_purpose='mcp-repository-admission' */ SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`mcp-repositories:${input.organizationId}:${input.userId}`]);
  await tx.query("DELETE FROM organization_mcp_repositories WHERE org_id=$1 AND owner_user_id=$2 AND expires_at<=clock_timestamp()", [input.organizationId, input.userId]);
  await tx.query(`INSERT INTO organization_mcp_repositories(org_id,owner_user_id,installation_id,repository,default_branch,repository_id,actor_fingerprint,expires_at,identity_expires_at)
    SELECT $1,$2,$3,r.repository,r."defaultBranch",r."repositoryId",$4,statement_timestamp()+interval '10 minutes',statement_timestamp()+interval '10 minutes'
    FROM jsonb_to_recordset($5::jsonb) r(repository text,"defaultBranch" text,"repositoryId" bigint)
    ON CONFLICT(org_id,owner_user_id,installation_id,repository) DO UPDATE SET
      default_branch=excluded.default_branch,repository_id=excluded.repository_id,actor_fingerprint=excluded.actor_fingerprint,
      expires_at=excluded.expires_at,identity_expires_at=excluded.identity_expires_at`,
  [input.organizationId, input.userId, input.installationId, input.fingerprint, JSON.stringify(input.repositories.map(repo => ({
    repository: `${repo.owner}/${repo.name}`.toLowerCase(), defaultBranch: repo.defaultBranch, repositoryId: repo.id,
  })))]);
  const count = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM organization_mcp_repositories WHERE org_id=$1 AND owner_user_id=$2", [input.organizationId, input.userId]);
  if (count.rows[0]!.n > 10_000) throw new HttpError(409, "mcp_repository_limit", "Too many repositories in this organization");
}

/** Expiry, membership/authority changes, suspension and explicit disconnect
 * withdraw this proof. Reads do not acquire mutation locks or contact GitHub. */
export function mcpRepositoryCatalog(pool: pg.Pool, appVariant = "github.com") {
  return async (organizationId: string, userId: string, transaction?: Tx): Promise<McpRepository[]> => {
    const query = async (tx: Tx) => (await tx.query<McpRepository>(`SELECT DISTINCT r.repository,r.default_branch AS "defaultBranch",
      CASE WHEN r.identity_expires_at=r.expires_at THEN r.repository_id::text ELSE NULL END AS "repositoryId"
      FROM organization_mcp_repositories r JOIN github_installations i ON i.id=r.installation_id
      WHERE r.org_id=$1 AND r.owner_user_id=$2 AND r.expires_at>clock_timestamp()
        AND i.owner_user_id=$2 AND i.app_variant=$3 AND i.suspended_at IS NULL
        AND r.actor_fingerprint=cloud_github_actor_fingerprint($1,$2)
      ORDER BY r.repository LIMIT 10000`, [organizationId, userId, appVariant])).rows;
    return transaction ? query(transaction) : withSystemTx(pool, query);
  };
}
