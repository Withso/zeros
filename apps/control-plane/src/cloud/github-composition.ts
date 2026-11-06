import type pg from "pg";
import type { GithubBackendConfig } from "../config.js";
import type { CloudAgentCredentialKeys } from "../agent-credentials/agent-credential-envelope.js";
import { HttpError } from "../authz.js";
import { isGithubAccessRevoked } from "../github-availability.js";
import { CloudGithubConnections } from "./github-connections.js";
import { CloudGithubConnectionStore } from "./github-connections-store.js";
import { CloudGithubSourceIdentities } from "./github-source-identities.js";
import { CloudV2SourceAuthority, type CloudSourceProof } from "./source-authority.js";
import { PostgresGithubVerificationStore } from "./github-verification-store.js";
import { CloudGithubPrStore } from "./github-pr-store.js";
import { CloudGithubPrService } from "./github-pr-service.js";
import { CloudGithubActions } from "./github-actions.js";
import { createSelectedCloudGithubTokens } from "./github-selected-tokens.js";
import type { CloudV2Store, CloudV2Workspace } from "./store.js";
import type { CloudV2ComputerSourceResolver } from "./computer-provenance.js";
import type { CloudV2Computers } from "./computer.js";
import { z } from "zod";
import { setupSelectionUnavailable, workspaceSetupBuild } from "./setup-selection.js";
import { withSystemTx } from "../db.js";
import { cloudGithubRequestContext } from "./github-request-context.js";
import { createCloudGithubCatalog } from "./github-catalog.js";

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
    actions = new CloudGithubActions(pool),
    verifications = new PostgresGithubVerificationStore(pool);
  const source = new CloudV2SourceAuthority(
    pool,
    connections,
    Date.now,
    (workspace, sources) => identities.targets(workspace, sources),
    verifications,
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
    const original = await workspaceSetupBuild(pool, workspace);
    if (!original?.setupBuildId) return null;
    const recipe = await computers.recipeForRepositoryId(
      workspace.organizationId,
      original.setupBuildId,
      target.repositoryId,
    );
    if (recipe.setupScript && original.setupLegacy) throw setupSelectionUnavailable();
    if (recipe.setup === undefined && recipe.setupScript === undefined) return null;
    return { ...(recipe.setup !== undefined ? { setup: recipe.setup } : {}), ...(recipe.setupScript ? { setupScript: recipe.setupScript } : {}) };
  };
  const retireRevoked = async (workspace: CloudV2Workspace, error: unknown) => {
    if (isGithubAccessRevoked(error)) await workspaces.transition(workspace.id, ["running"], "stopping");
  };
  const authorizeSource = async (workspace: CloudV2Workspace) => {
    try {
      await source.workspace(workspace);
    } catch (error) {
      await retireRevoked(workspace, error);
      throw error;
    }
  };
  const observedRefreshes = new WeakSet<Promise<void>>();
  const refreshVerifiedBinding = async (workspace: CloudV2Workspace) => {
    const scope = { organizationId: workspace.organizationId, userId: workspace.creatorUserId };
    const target = await identities.primary(workspace);
    const fingerprint = await connections.fingerprintFor(scope);
    const verified = await verifications.read({ ...scope, repositoryId: target.repositoryId, fingerprint });
    if (!verified?.canonicalRepository || !verified.observedAt || verified.failure) return;
    const saved = await metadata.context(workspace.id, workspace.creatorUserId);
    await metadata.repository(saved, { repositoryId: target.repositoryId, repository: verified.canonicalRepository }, {
      at: verified.observedAt, assertCurrent: tx => connections.store.lockCurrent(tx, scope, fingerprint),
    });
  };
  const continueSource = async (workspace: CloudV2Workspace, proof?: CloudSourceProof) => {
    try {
      const lease = await source.continueWorkspace(workspace, proof);
      if (lease.refresh && !observedRefreshes.has(lease.refresh)) {
        observedRefreshes.add(lease.refresh);
        void lease.refresh.then(
          () => refreshVerifiedBinding(workspace),
          error => retireRevoked(workspace, error),
        ).catch(() => {});
      }
      return lease;
    } catch (error) {
      await retireRevoked(workspace, error);
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
  const open = cloudGithubRequestContext({ pool, connections, metadata, actions, verifications,
    authorize: async (id, userId) => authorizeSource(await workspaces.get(id, userId)), fetch: fetchImpl });
  const service = new CloudGithubPrService({
    open,
    repository: async (value, identity, access) => {
      if (value.repositoryBound && value.repositoryId === identity.repositoryId && value.repository === identity.repository) return;
      await withSystemTx(pool, async tx => {
        await access.assertCurrent(tx);
        await metadata.repository(value, identity, undefined, tx);
        await access.assertCurrent(tx);
      });
    },
    recordPr: async (value, pr, access) => {
      await withSystemTx(pool, async tx => {
        await access.assertCurrent(tx);
        await metadata.recordPr(value, pr, access.generation, tx);
        await access.assertCurrent(tx);
      });
      await access.assertCurrent();
    },
    mutate: async (id, userId, action) => {
      await context(id, userId);
      return actions.run(id, action);
    },
  });
  const documents = createCloudGithubCatalog({ pool, connections: connections.store, metadata, verifications,
    authorizeSource, continueSource, retireRevoked });
  const binding = async (workspace: CloudV2Workspace, mode: "admission" | "continuation" = "admission", pending?: ReturnType<CloudGithubConnections["access"]>) => {
    const target = await identities.primary(workspace);
    if (mode === "continuation") {
      // Configuration refresh must still apply provider removals during an
      // outage. The canonical binding was verified on admission and cannot be
      // reconstructed from a possibly reused name; require the original ID.
      // Successful source checks already resolved the immutable ID. Reuse
      // that result to discover transfers, with no extra provider request.
      await refreshVerifiedBinding(workspace);
      const saved = await metadata.context(workspace.id, workspace.creatorUserId);
      if (saved.repositoryId && saved.repositoryId !== target.repositoryId)
        throw new HttpError(409, "github_repository_changed", "The saved GitHub repository identity changed.");
      if (saved.repositoryId) return { repositoryId: saved.repositoryId, repository: saved.repository,
        previousRepositories: await metadata.aliases(workspace) };
    }
    const grant = await (pending ?? connections.access({
        organizationId: workspace.organizationId,
        userId: workspace.creatorUserId,
      }));
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
  const workerIdentity = async (workspace: CloudV2Workspace, mode: "admission" | "continuation") => {
    const scope = { organizationId: workspace.organizationId, userId: workspace.creatorUserId };
    const access = connections.access(scope);
    const [repositoryBinding, gitIdentity] = await Promise.all([binding(workspace, mode, access), connections.gitIdentity(scope, access)]);
    return { repositoryBinding, gitIdentity };
  };
  const workspaceToken = async (
    workspace: CloudV2Workspace,
    access: "read" | "write" | "user" = "read",
    purpose: "git" | "gh" = "git",
    failedTokenSha256?: string,
  ) => {
    if (!failedTokenSha256) {
      const { context: value, access: grant } = await open(workspace.id, workspace.creatorUserId, { checkout: false });
      return token({ organizationId: value.organizationId, userId: value.creatorUserId },
        { repository: value.repository, repositoryId: value.repositoryId }, access, purpose, () => grant.assertCurrent(), undefined, grant);
    }
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
      failedTokenSha256,
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
        `/repositories/${identity.repositoryId}/branches/${encodeURIComponent(branch)}`,
        z.object({ commit: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }) }),
      );
      await access.assertCurrent();
      return result.commit.sha;
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
    continueSource,
    binding,
    workerIdentity,
    token,
    workspaceToken,
    resolveRepository,
    workspaceSetup,
    remoteHead,
  };
}
