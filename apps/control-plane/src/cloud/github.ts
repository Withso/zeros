// Short-lived GitHub credentials for a cloud v2 worker's git and gh. Like
// Conductor's broker, the worker asks for a token per network command and
// never stores one; each token is limited to the workspace's own repository.
import type pg from "pg";
import type { GithubBackendConfig } from "../config.js";
import { withSystemTx } from "../db.js";
import { HttpError } from "../authz.js";
import { mintGithubInstallationToken } from "../github.js";
import type { CloudV2Workspace } from "./store.js";

export function createCloudV2GithubTokens(pool: pg.Pool, config: GithubBackendConfig, fetchImpl: typeof fetch = fetch) {
  const forRepository = createCloudV2RepositoryTokens(pool, config, fetchImpl);
  return (workspace: CloudV2Workspace) => forRepository(workspace.organizationId, workspace.creatorUserId, workspace.repository);
}

/** A token for one repository through the user's own connection in the organization. */
export function createCloudV2RepositoryTokens(pool: pg.Pool, config: GithubBackendConfig, fetchImpl: typeof fetch = fetch) {
  return async (organizationId: string, userId: string, repository: string): Promise<{ token: string; expiresAt: number }> => {
    const [owner, name] = repository.split("/");
    if (!owner || !name) throw new HttpError(409, "github_repository_invalid", "The workspace repository is invalid");
    // The creator's own GitHub App connection for this organization and repository owner.
    const { rows } = await withSystemTx(pool, tx => tx.query<{ github_installation_id: string }>(
      `SELECT i.github_installation_id FROM cloud_github_connections c
       JOIN github_installations i ON i.id = c.installation_id
       WHERE c.org_id = $1 AND c.owner_user_id = $2 AND i.suspended_at IS NULL AND lower(i.account_login) = lower($3)
       ORDER BY c.verified_at DESC LIMIT 1`,
      [organizationId, userId, owner],
    ));
    const installationId = Number(rows[0]?.github_installation_id);
    if (!Number.isSafeInteger(installationId) || installationId < 1)
      throw new HttpError(409, "github_connection_required", "Connect GitHub for this repository first");
    const minted = await mintGithubInstallationToken(fetchImpl, config, { installationId, repositories: [name], nowMs: Date.now() });
    return { token: minted.token, expiresAt: minted.expiresAtMs };
  };
}
