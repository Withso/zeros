// Short-lived GitHub credentials for a cloud v2 worker's git and gh. Like
// Conductor's broker, the worker asks for a token per network command and
// never stores one; each token is limited to the workspace's own repository.
import type pg from "pg";
import { z } from "zod";
import type { GithubBackendConfig } from "../config.js";
import { HttpError } from "../authz.js";
import { GithubRepositoryAuthority } from "../github-repository-authority.js";
import { githubHeaders, githubJson, revokeGithubInstallationToken } from "../github-installation-tokens.js";
import { CloudSourceTargetSchema } from "./source-authority.js";
import type { CloudV2ComputerSourceResolver } from "./computer-provenance.js";
import type { CloudV2Workspace } from "./store.js";

export function createCloudV2GithubTokens(pool: pg.Pool, config: GithubBackendConfig, fetchImpl: typeof fetch = fetch) {
  const forRepository = createCloudV2RepositoryTokens(pool, config, fetchImpl);
  return (workspace: CloudV2Workspace) => forRepository(workspace.organizationId, workspace.creatorUserId, workspace.repository, "user");
}

/** A token for one repository through the user's own connection in the organization. */
export function createCloudV2RepositoryTokens(pool: pg.Pool, config: GithubBackendConfig, fetchImpl: typeof fetch = fetch) {
  const authority = new GithubRepositoryAuthority(pool, config, fetchImpl);
  return async (organizationId: string, userId: string, repository: string, access: "read" | "write" | "user" = "read", repositoryId?: string): Promise<{ token: string; expiresAt: number }> => {
    const [owner, name] = repository.split("/");
    if (!owner || !name || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository))
      throw new HttpError(409, "github_repository_invalid", "The workspace repository is invalid");
    const minted = await authority.mint({ organizationId, userId, owner, repositories: [name], access, ...(repositoryId !== undefined ? { repositoryIds: [repositoryId] } : {}) });
    return { token: minted.token, expiresAt: minted.expiresAtMs };
  };
}

/** Default App-backed resolver. Selected cloud App/PAT composition can inject
 * its human-token resolver instead, retaining the same ID/canonical contract.
 * A transfer that this connection cannot verify fails closed. */
export function createCloudV2RepositoryResolver(pool: pg.Pool, config: GithubBackendConfig, fetchImpl: typeof fetch = fetch): CloudV2ComputerSourceResolver {
  const authority = new GithubRepositoryAuthority(pool, config, fetchImpl);
  const token = createCloudV2RepositoryTokens(pool, config, fetchImpl);
  return async (organizationId, userId, target) => {
    const [owner, name] = target.repository.split("/");
    if (!owner || !name || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(target.repository))
      throw new HttpError(409, "github_repository_invalid", "The repository is invalid");
    const scope = { organizationId, userId, owner, repositories: [name!], access: "read" as const,
      ...(target.repositoryId !== undefined ? { repositoryIds: [target.repositoryId] } : {}) };
    const before = await authority.fingerprintFor(scope);
    const credential = await token(organizationId, userId, target.repository, "read", target.repositoryId);
    let resolved;
    try {
      const path = target.repositoryId ? `repositories/${encodeURIComponent(target.repositoryId)}` : `repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}`;
      const body = z.object({ id: z.number().int().safe().positive(), full_name: z.string() }).safeParse(
        await githubJson(fetchImpl, `${config.apiBaseUrl}/${path}`, { headers: githubHeaders(credential.token) }));
      if (!body.success) throw new HttpError(503, "github_repository_invalid", "GitHub returned an incomplete repository identity.");
      const parsed = CloudSourceTargetSchema.safeParse({ repository: body.data.full_name, repositoryId: String(body.data.id) });
      if (!parsed.success || target.repositoryId && parsed.data.repositoryId !== target.repositoryId)
        throw new HttpError(403, "github_cloud_access_denied", "The original repository could not be verified.");
      resolved = parsed.data;
    } finally {
      await revokeGithubInstallationToken(fetchImpl, config, credential.token).catch(() => {});
    }
    const [currentOwner, currentName] = resolved.repository.split("/");
    const verified = await authority.check({ ...scope, owner: currentOwner!, repositories: [currentName!], repositoryIds: [resolved.repositoryId] });
    if (verified !== before) throw new HttpError(409, "github_authorization_changed", "GitHub authorization changed. Try again.");
    return resolved;
  };
}

/** The commit at the tip of one remote branch, read through the same
 * repository-scoped token; null when GitHub does not answer with one. */
export function createCloudV2RemoteHeads(pool: pg.Pool, config: GithubBackendConfig, fetchImpl: typeof fetch = fetch) {
  const forRepository = createCloudV2RepositoryTokens(pool, config, fetchImpl);
  return async (organizationId: string, userId: string, repository: string, branch: string, repositoryId?: string): Promise<string | null> => {
    const [owner, name] = repository.split("/");
    if (!owner || !name) return null;
    const { token } = await forRepository(organizationId, userId, repository, "read", repositoryId);
    const ref = branch.split("/").map(encodeURIComponent).join("/");
    const response = await fetchImpl(`${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${ref}`, {
      headers: { accept: "application/vnd.github.sha", authorization: `Bearer ${token}`, "user-agent": "zeros-control-plane" },
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    const sha = response.ok ? (await response.text()).trim() : (await response.body?.cancel(), "");
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  };
}
