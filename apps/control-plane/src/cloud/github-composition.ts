import type pg from "pg";
import type { GithubBackendConfig } from "../config.js";
import type { CloudAgentCredentialKeys } from "../agent-credentials/agent-credential-envelope.js";
import { HttpError } from "../authz.js";
import { CloudGithubConnections } from "./github-connections.js";
import { CloudGithubConnectionStore } from "./github-connections-store.js";
import { CloudGithubSourceIdentities } from "./github-source-identities.js";
import { CloudV2SourceAuthority } from "./source-authority.js";
import { CloudGithubPrStore } from "./github-pr-store.js";
import { CloudGithubPrService } from "./github-pr-service.js";
import { CloudGithubActions } from "./github-actions.js";
import { createSelectedCloudGithubTokens } from "./github-selected-tokens.js";
import type { CloudV2Store, CloudV2Workspace } from "./store.js";
import type { CloudGithubWorkspaceDocument } from "./routes.js";
import type { CloudGithubUnavailableReason } from "./github-connection-contract.js";
import type { CloudV2ComputerSourceResolver } from "./computer-provenance.js";
import type { CloudV2Computers } from "./computer.js";
import { z } from "zod";

function unavailableReason(error: unknown): CloudGithubUnavailableReason {
  const reasons: Record<string, CloudGithubUnavailableReason> = {
    github_connection_required: "connection-required",
    github_authorization_required: "connection-required",
    github_authorization_expired: "connection-expired",
    github_authorization_changed: "connection-changed",
    github_installation_required: "installation-required",
    github_installation_suspended: "installation-suspended",
    github_cloud_access_denied: "access-denied",
    github_repository_unavailable: "access-denied",
    github_sso_required: "sso-required",
    cloud_source_review_required: "source-review-required",
    github_rate_limited: "rate-limited",
  };
  return error instanceof HttpError
    ? (reasons[error.code] ?? "unavailable")
    : "unavailable";
}

export function createCloudGithubServices(
  pool: pg.Pool,
  config: GithubBackendConfig | null,
  keys: CloudAgentCredentialKeys,
  workspaces: Pick<CloudV2Store, "get" | "transition">,
  fetchImpl: typeof fetch = fetch,
) {
  const connections = new CloudGithubConnections(
    new CloudGithubConnectionStore(pool, keys),
    config,
    fetchImpl,
  );
  const identities = new CloudGithubSourceIdentities(pool),
    metadata = new CloudGithubPrStore(pool),
    actions = new CloudGithubActions(pool);
  const source = new CloudV2SourceAuthority(
    pool,
    connections,
    Date.now,
    (workspace, sources) => identities.targets(workspace, sources),
  );
  const token = createSelectedCloudGithubTokens(pool, connections, fetchImpl);
  const resolveRepository: CloudV2ComputerSourceResolver = async (
    organizationId,
    userId,
    target,
  ) => {
    const access = await connections.access({ organizationId, userId });
    const repository = await access.api.repository(target);
    await access.api.http.json(
      `/repositories/${repository.repositoryId}/branches?per_page=1`,
      z.array(z.unknown()).max(1),
    );
    await access.assertCurrent();
    return {
      repository: repository.repository,
      repositoryId: repository.repositoryId,
    };
  };
  const workspaceSetup = async (
    workspace: CloudV2Workspace,
    computers: Pick<
      CloudV2Computers,
      "buildSourceTargets" | "recipeForRepositoryId"
    >,
  ) => {
    if (!workspace.computerBuildId) return null;
    const target = await identities.primary(workspace);
    const sources = await computers.buildSourceTargets(
      workspace.organizationId,
      workspace.computerBuildId,
    );
    // Restored files keep their original ledger. A newer clean base may have
    // a different recipe; never run a reused name's setup on the old source.
    if (!sources.some((source) => source.repositoryId === target.repositoryId))
      return null;
    const recipe = await computers.recipeForRepositoryId(
      workspace.organizationId,
      workspace.computerBuildId,
      target.repositoryId,
    );
    return recipe.setup ?? null;
  };
  const authorizeSource = async (workspace: CloudV2Workspace) => {
    try {
      await source.workspace(workspace);
    } catch (error) {
      if (
        error instanceof HttpError &&
        ([403, 404].includes(error.status) ||
          [
            "github_connection_required",
            "github_authorization_expired",
            "github_authorization_changed",
          ].includes(error.code))
      )
        await workspaces.transition(workspace.id, ["running"], "stopping");
      throw error;
    }
  };
  const context = async (id: string, userId: string) => {
    const workspace = await workspaces.get(id, userId);
    await authorizeSource(workspace);
    await actions.assertCurrent(id);
    const value = await metadata.context(id, userId),
      primary = await identities.primary(workspace);
    if (value.repositoryId && value.repositoryId !== primary.repositoryId)
      throw new HttpError(
        409,
        "github_repository_changed",
        "The workspace's saved repository identity changed.",
      );
    return { ...value, repositoryId: primary.repositoryId };
  };
  const service = new CloudGithubPrService({
    context,
    access: (value) =>
      connections.access({
        organizationId: value.organizationId,
        userId: value.creatorUserId,
      }),
    repository: async (value, identity, access) => {
      await access.assertCurrent();
      await metadata.repository(value, identity);
      await access.assertCurrent();
    },
    recordPr: async (value, pr, access) => {
      await access.assertCurrent();
      await metadata.recordPr(value, pr, access.generation);
      await access.assertCurrent();
    },
    mutate: async (id, userId, action) => {
      await context(id, userId);
      return actions.run(id, action);
    },
  });
  const documents = async (
    rows: readonly CloudV2Workspace[],
  ): Promise<CloudGithubWorkspaceDocument[]> => {
    // Metadata is safe to retain for its owner. Published PR state/capabilities
    // are released only after the entire original source scope is authorized.
    const allowed = new Map<string, string>();
    const unavailable = new Map<string, CloudGithubUnavailableReason>();
    await Promise.all(
      rows.map(async (row) => {
        const scope = {
          organizationId: row.organizationId,
          userId: row.creatorUserId,
        };
        try {
          const generation = await connections.fingerprintFor(scope);
          await authorizeSource(row);
          await connections.store.assertCurrent(scope, generation);
          allowed.set(row.id, generation);
        } catch (error) {
          unavailable.set(row.id, unavailableReason(error));
        }
      }),
    );
    const enriched = new Map(
      (await metadata.documents(rows, allowed)).map((row) => [row.id, row]),
    );
    return Promise.all(
      rows.map(async (row) => {
        const generation = allowed.get(row.id);
        if (generation)
          try {
            await connections.store.assertCurrent(
              { organizationId: row.organizationId, userId: row.creatorUserId },
              generation,
            );
            return enriched.get(row.id) ?? row;
          } catch (error) {
            unavailable.set(row.id, unavailableReason(error));
          }
        // Keep recovery controls visible, but never publish upstream text or
        // protected PR metadata when source or connection authority is absent.
        // Withdrawing access must not roll the catalog's version back to the
        // older lifecycle timestamp: clients would correctly reject it as stale
        // and retain the protected PR view. Only the timestamp survives here.
        return {
          ...row,
          updatedAt: enriched.get(row.id)?.updatedAt ?? row.updatedAt,
          githubUnavailableReason: unavailable.get(row.id) ?? "unavailable",
        };
      }),
    );
  };
  const binding = async (workspace: CloudV2Workspace) => {
    const target = await identities.primary(workspace),
      grant = await connections.access({
        organizationId: workspace.organizationId,
        userId: workspace.creatorUserId,
      });
    const identity = await grant.api.repository(target),
      previousRepositories = await metadata.aliases(workspace);
    await grant.assertCurrent();
    await metadata.repository(
      await metadata.context(workspace.id, workspace.creatorUserId),
      identity,
    );
    await grant.assertCurrent();
    return {
      repositoryId: identity.repositoryId,
      repository: identity.repository,
      previousRepositories,
    };
  };
  const workspaceToken = async (
    workspace: CloudV2Workspace,
    access: "read" | "write" | "user" = "read",
    purpose: "git" | "gh" = "git",
  ) => {
    await authorizeSource(workspace);
    return token(
      {
        organizationId: workspace.organizationId,
        userId: workspace.creatorUserId,
      },
      await identities.primary(workspace),
      access,
      purpose,
      () => authorizeSource(workspace),
    );
  };
  const remoteHead = async (
    organizationId: string,
    userId: string,
    repository: string,
    branch: string,
    repositoryId?: string,
  ) => {
    const access = await connections.access({ organizationId, userId });
    const identity = await access.api.repository({
      repository,
      ...(repositoryId ? { repositoryId } : {}),
    });
    try {
      const result = await access.api.http.json(
        `/repositories/${identity.repositoryId}/commits/${encodeURIComponent(branch)}`,
        z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }),
      );
      return result.sha;
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404) throw error;
      await access.assertCurrent();
      return null;
    }
  };
  return {
    connections,
    identities,
    metadata,
    service,
    documents,
    source,
    authorizeSource,
    binding,
    token,
    workspaceToken,
    resolveRepository,
    workspaceSetup,
    remoteHead,
  };
}
