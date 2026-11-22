import { z } from "zod";
import { otherRepositories, workerRepositories, workspaceTokenSource, type WorkerRepositoryConfig } from "./workspace-repositories.js";
import { repositorySetupReports } from "./workspace-repository-setup.js";
import { resolveWorkspaceMcpServers } from "./workspace-repository-mcp.js";
import type { CloudWorkspaceEnvironment } from "./environment-contract.js";
import { workspaceCheckoutPath } from "./workspace-layout.js";
import { readyCopyRestoreSource } from "./retention-restore-source.js";
import { withExecutionLifetimeRetry } from "./execution/lifetime.js";
// Assembles cloud workspace v2 from configuration: one store, Boat, the relay
// (realtime role), the lifecycle loop (worker role), the HTTP routes and the
// model proxy (API role). index.ts only starts and stops what this returns.
import { createPendingSourceResolver } from "./pending-create.js";
import { postgresNotificationSubscription } from "../postgres-notifications.js";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { workerSourceConfiguration } from "./worker-source.js";
import { withSystemTx, type Tx } from "../db.js";
import type { PostgresSecurityEventBroker } from "../security-events.js";
import type { Config } from "../config.js";
import { HttpError } from "../authz.js";
import { isGithubAccessRevoked } from "../github-availability.js";
import { BoatApiClient } from "../cloud/boat-client.js";
import { cloudAgentCredentialKeys } from "../agent-credentials/agent-credentials.js";
import type { CloudAgentCredentialMaterial } from "../agent-credentials/agent-credential-envelope.js";
import { createCloudV2AgentLogins, createCloudV2CodexRefresh } from "./agent-logins.js";
import { BoatCloudV2Compute } from "./boat.js";
import type { CloudV2ControlFrame } from "./contract.js";
import { CLOUD_V2_AUTOMATIC_BASE_BUDGET, CloudV2ComputerBuilder, CloudV2Computers } from "./computer.js";
import { CloudV2ReadyCopies, CloudV2ReadyCopyBuilder, CloudV2ReadyCopyForks } from "./ready-copies.js";
import { CloudV2ReadyCopySecrets } from "./ready-copy-secrets.js";
import { CloudRepositoryLevels } from "./repository-levels.js";
import { CloudProjects, migrateProjects } from "./projects.js";
import { organizationCloneToken, organizationSubmoduleRepository } from "./organization-github.js";
import { readSubmoduleLevel } from "./submodules.js";
import { CloudGithubHttp, withGithubReadScope } from "./github-http.js";
import { readOnlyToken, resolveWorkspaceSubmodules, withoutReadOnlyToken, workerSubmodules, workspaceRepositoryToken, workspaceSubmoduleSource, type WorkspaceSubmoduleRepositoryInput } from "./workspace-submodules.js";
import { createCloudGithubServices } from "./github-composition.js";
import { CLOUD_V2_READY_CHANNEL, CLOUD_V2_BOOT_CHANNEL, WorkerReadySignals, notifyCloudV2WorkerBoot } from "./worker-ready.js";
import { hydrateCloudRepository, type CloudSourceProof, type CloudSourceTarget } from "./source-authority.js";
import { HISTORY_OPS, readCloudV2History, type HistoryStore } from "./history.js";
import { CLOUD_V2_HOME, CLOUD_V2_LIFECYCLE_CHANNEL, CloudV2Lifecycle, type CloudV2TimingRecord } from "./lifecycle.js";
import { cloudV2CheckpointStorage, openCheckpointKey, sealCheckpointKey } from "./checkpoint.js";
import { runtimeStorageClient } from "./runtime-source.js";
import { activeRuntimeQualification } from "./runtime-capabilities.js";
import { executionCreationRuntime } from "./execution/creation.js";
import { CLOUD_V2_PROXY_PREFIX, type CloudV2ProxyDeps } from "./proxy.js";
import { CloudV2Relay } from "./relay.js";
import { CloudLiveRecovery } from "./live-recovery.js";
import { CloudRecovery } from "./recovery.js";
import { CloudRecoveryStore, RECOVERY_CHANNEL } from "./recovery-store.js";
import { recoveryWorkerReady } from "./recovery-ready.js";
import { LiveRecoverySignals } from "./live-recovery-signals.js";
import { LiveRecoveryStore } from "./live-recovery-store.js";
import { cloudV2Runtime } from "./runtime.js";
import type { CloudV2RouteDeps } from "./routes.js";
import { CloudV2Store, cloudV2WorkspaceFromRow, setCloudV2RetentionDocuments, type CloudV2LifecycleWorkspace, type CloudV2WorkerSession, type CloudV2Workspace } from "./store.js";
import { CloudV2WorkerSigner } from "./worker-auth.js";
import { openPortToken, sealPortToken } from "./worker-port-token.js";
import type { CloudV2WorkerRouteDeps } from "./worker-routes.js";
import { cloudV2SandboxName } from "./resource-names.js";
import { CloudV2PromptSignals } from "./prompt-signals.js";
import { createMcpServices } from "../mcp/composition.js";
import { CloudEnvironments } from "./environment-store.js";
import { RuntimeCanaryAuthority } from "./runtime-canary.js";
import { readRuntimeCanary, workspaceRuntimeResolver } from "./runtime-canary-store.js";
import { RuntimeHandoffStore } from "./runtime-handoff-store.js";
import { buildDrainActive } from "./runtime-build-drain.js";
import { RuntimeAdoption } from "./runtime-adoption.js";
import { CloudApiCredentials } from "./api/credentials.js";
import { CloudWorkspaceApiTokens } from "./api/workspace-tokens.js";
import { CloudApiService } from "./api/service.js";
import { CloudLocalDevices } from "./local-commands/devices.js";
import { CloudLocalCommandSignals } from "./local-commands/signals.js";
import { CloudTeamSharing } from "./team-sharing/store.js";
import { CloudLocalCommands } from "./local-commands/requests.js";
import { startLocalCommandMaintenance } from "./local-commands/maintenance.js";
import { CloudNotifyUser } from "./notify-user/store.js";
import { CloudWorkspaceSync } from "./workspace-sync/store.js";
import { CloudWorkspaceGithubReadTokens } from "./workspace-sync/github-read-token.js";
import { CLOUD_V2_LIVE_ACCESS, requireWorkspaceCreator } from "./workspace-access.js";

import { CloudExecutionContexts, type CachedTokenContext } from "./execution/store.js";
import { ExecutionAuthorizationCache, authorizationHint } from "./execution/authorization-cache.js";
import { ProviderStopCheck } from "./provider-stop.js";
import type { WorkerRoute } from "./worker-connection.js";
import { lifecycleExecution } from "./execution/lifecycle.js";
import { claimExecutionRestore } from "./execution/restore.js";
import { CloudExecutionActivations, executionActivationRuntime } from "./execution/activation.js";
import { CloudExecutionAuthority } from "./execution/authority.js";
import { AuthorityBarrier } from "./execution/authority-barrier.js";
import { AuthorityPull } from "./execution/authority-pull.js";
import { CloudExecutionLogins } from "./execution/logins.js";

const PROXY_TOKEN_TTL_MS = 24 * 60 * 60_000;

type ConfigFrame = Extract<CloudV2ControlFrame, { t: "config" }>;
type Login = CloudAgentCredentialMaterial | null | undefined;

/** As in Conductor: Claude and Cursor run with the organization's own
 * credential on the VM; Codex reaches the model through our proxy, because a
 * ChatGPT login's refresh token must stay with us. */
export async function cloudV2AgentConfig(logins: { codex?: Login; claude?: Login; cursor?: Login }, proxyBase: string,
  proxy: () => Promise<{ token: string; expiresAt: number }>): Promise<ConfigFrame["agents"]> {
  const agents: ConfigFrame["agents"] = {};
  if (logins.codex?.kind === "codex-chatgpt" || logins.codex?.kind === "codex-api-key") agents.codex = { baseUrl: `${proxyBase}/openai`, ...(await proxy()) };
  if (logins.claude?.kind === "claude-setup-token") agents.claude = { oauthToken: logins.claude.accessToken };
  else if (logins.claude?.kind === "claude-api-key") agents.claude = { apiKey: logins.claude.apiKey };
  if (logins.cursor?.kind === "cursor-api-key") agents.cursor = { apiKey: logins.cursor.apiKey };
  return agents;
}

/** Bridge history reads answered from the mirror while the VM is stopped. */
export async function answerCloudV2Offline(store: HistoryStore,
  workspace: CloudV2Workspace, frame: unknown): Promise<unknown | null> {
  const request = frame as { type?: unknown; id?: unknown; op?: unknown; params?: Record<string, unknown> } | null;
  if (request?.type !== "WORKSPACE_REQUEST" || typeof request.id !== "string" || typeof request.op !== "string") return null;
  if (!HISTORY_OPS.some(op => op === request.op)) return null;
  const reply = { id: randomUUID(), source: "engine", timestamp: Date.now(), requestId: request.id, op: request.op };
  try {
    const result = await readCloudV2History(store, workspace.id, { op: request.op, params: request.params ?? {} });
    return { ...reply, type: "WORKSPACE_RESPONSE", result };
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return { ...reply, type: "WORKSPACE_ERROR", code: error.code, message: error.message };
  }
}

/** How long a new replica waits before returning creates early. */
export const CLOUD_V2_ASYNC_CREATE_DELAY_MS = 10 * 60_000;

export function createCloudV2(config: Config, pool: pg.Pool, roles: { relay: boolean; lifecycle: boolean }, securityEvents?: PostgresSecurityEventBroker, listenerPool: pg.Pool = pool, lockPool: pg.Pool = pool) {
  const v2 = config.cloudV2;
  if (!v2) return null;
  // Retention's document fields and Keep routes exist only where retention runs (CLOUD_V2_RETENTION_ENABLED).
  setCloudV2RetentionDocuments(v2.retention === true);
  const localOwner = config.development && !("generation" in config.development) ? config.development.owner : undefined;
  const keys = cloudAgentCredentialKeys(config.cloudAgentCredentials ?? null);
  if (!keys) throw new Error("Cloud v2 requires the credential encryption keyring");
  const store = new CloudV2Store(pool, keys);
  const recoveryStore = new CloudRecoveryStore(pool);
  const runtime = cloudV2Runtime(v2.runtime.sha256, v2.runtime.store);
  const activeCreateRuntime = activeRuntimeQualification(config.deploymentChannel, v2.runtime);
  const runtimeCanary = config.deploymentChannel === "alpha" && v2.runtimeCanary ? new RuntimeCanaryAuthority(v2.runtimeCanary) : undefined;
  const defaultRuntimeForWorkspace = workspaceRuntimeResolver(pool, runtime, runtimeCanary?.policy);
  const runtimeForWorkspace = async (workspace: CloudV2Workspace & { executionTransitionId?: string; recoveryAttemptId?: string; executionMode?: CloudV2WorkerSession["executionMode"] }) => {
    if (workspace.recoveryAttemptId) {
      const sha256 = await recoveryStore.runtime(workspace.id);
      if (!sha256) throw new HttpError(409, "recovery_binding_changed", "Workspace recovery changed.");
      return { sha256, url: () => runtime.url(sha256) };
    }
    const activation = workspace.executionTransitionId ? await executionActivationRuntime(pool, workspace.id, runtime) : null;
    if (activation) return activation;
    const selected = await defaultRuntimeForWorkspace(workspace);
    if (workspace.executionMode && workspace.executionMode !== "active") return selected;
    return await executionCreationRuntime(pool, workspace.id, selected, activeCreateRuntime) ?? selected;
  };
  const compute = new BoatCloudV2Compute(new BoatApiClient({
    apiKey: v2.boat.apiKey, timeoutMs: 120_000, ...(v2.boat.billingOrg ? { billingOrg: v2.boat.billingOrg } : {}),
  }));
  const apiCredentials = new CloudApiCredentials(pool), apiTokens = new CloudWorkspaceApiTokens(pool, keys);
  const localDevices = new CloudLocalDevices(pool), localCommandSignals = new CloudLocalCommandSignals(listenerPool);
  const localCommands = new CloudLocalCommands(pool,keys,localDevices);
  const notifications = new CloudNotifyUser(pool,localDevices);
  const apiConfiguration = async (workspaceId: string) => {
    const token = await apiTokens.token(workspaceId);
    return token ? { url: `${v2.apiUrl}/api/v0`, token } : undefined;
  };
  const signer = new CloudV2WorkerSigner(v2.workerSigningKey, v2.workerSigningKeyPrevious);
  const logins = createCloudV2AgentLogins(pool, keys);
  const github = createCloudGithubServices(pool, config.github, keys, store);
  const environments = new CloudEnvironments(pool, keys, github.connections.authorizeRepositoryConfiguration.bind(github.connections));
  const githubToken = async (workspace: CloudV2Workspace, purpose: "git" | "gh" = "git", failedTokenSha256?: string, repository?: string) => {
    if (!repository || repository.toLowerCase() === workspace.repository.toLowerCase()) return github.workspaceToken(workspace, "user", purpose, failedTokenSha256);
    // Another repository of a workspace of several, checked as its creator, or a submodule it fetches (read-only).
    return workspaceRepositoryToken(pool, github.token, workspace, repository, purpose, () => authorizeSource(workspace), failedTokenSha256);
  };
  const proxyBase = `${v2.apiUrl}${CLOUD_V2_PROXY_PREFIX}`;
  // Whether Boat has the shared base, asked at most once a minute (a base made from it costs no machine).
  const sharedBase = v2.sharedBaseSnapshot;
  let sharedBaseSeen: { at: number; present: boolean } | null = null;
  const sharedBaseAvailable = async () => {
    if (!sharedBase || !compute.snapshotExists) return false;
    if (sharedBaseSeen && Date.now() - sharedBaseSeen.at < 60_000) return sharedBaseSeen.present;
    const present = await compute.snapshotExists(sharedBase).catch(() => false);
    sharedBaseSeen = { at: Date.now(), present };
    return present;
  };
  const computers = new CloudV2Computers(pool, lockPool, github.resolveRepository, github.resolveRecentRepository,
    { readyCopies: v2.readyCopies === true, ...(sharedBase ? { sharedBaseSnapshot: sharedBase } : {}),
      ...(v2.readyCopies === true ? { sharedBaseAvailable, runtimeSha256: runtime.sha256 } : {}),
      ...(v2.automaticBasePerHour || v2.automaticBasePerDay ? { automaticBaseBudget: { perHour: v2.automaticBasePerHour ?? CLOUD_V2_AUTOMATIC_BASE_BUDGET.perHour,
        perDay: v2.automaticBasePerDay ?? CLOUD_V2_AUTOMATIC_BASE_BUDGET.perDay } } : {}) });
  // Ready copies (CLOUD_V2_READY_COPIES_ENABLED): absent while off, so creates and builds run as before.
  const readyCopies = v2.readyCopies === true ? new CloudV2ReadyCopies(pool) : null;
  const readyCopySecrets = readyCopies ? new CloudV2ReadyCopySecrets(pool, keys) : null;
  // Projects and GitHub at two levels ride the same setting.
  const repositoryLevels = readyCopies ? new CloudRepositoryLevels(pool) : null;
  const projects = readyCopies ? new CloudProjects(pool) : null;
  const memberGithub = (organizationId: string, userId: string) => github.connections.access({ organizationId, userId });
  const resolveMemberRepository = async (organizationId: string, userId: string, repository: string) => {
    const identity = await (await memberGithub(organizationId, userId)).api.repository({ repository });
    return { repository: identity.repository.toLowerCase(), repositoryId: identity.repositoryId, defaultBranch: identity.defaultBranch, private: identity.private };
  };
  const InstallationsPage = z.object({ installations: z.array(z.object({ id: z.number().int().positive(), app_id: z.number().int(),
    account: z.object({ login: z.string().max(100) }), suspended_at: z.string().nullable().optional() }).passthrough()).max(100) }).passthrough();
  const InstallationRepositoriesPage = z.object({ repositories: z.array(z.object({ id: z.number().int().positive(), full_name: z.string().max(201),
    default_branch: z.string().max(512), private: z.boolean() }).passthrough()).max(100) }).passthrough();
  const projectRoutes = repositoryLevels && projects ? {
    levels: repositoryLevels,
    projects,
    warm: (organizationId: string, userId: string, targets: readonly CloudSourceTarget[]) => github.source.targets(organizationId, userId, targets, true),
    resolveMemberRepository,
    visibleInstallation: async (organizationId: string, userId: string, installationId: number) => {
      const http = (await memberGithub(organizationId, userId)).api.http;
      for (let page = 1; page <= 10; page++) {
        const rows = (await http.json(`/user/installations?per_page=100&page=${page}`, InstallationsPage)).installations;
        const found = rows.find(row => row.id === installationId && row.app_id === config.github?.appId);
        if (found) return { accountLogin: found.account.login, suspended: !!found.suspended_at };
        if (rows.length < 100) break;
      }
      throw new HttpError(404, "github_installation_not_visible", "Your GitHub sign-in can't see this installation of the Zeros App.");
    },
    visibleInstallations: async (organizationId: string, userId: string) => {
      const http = (await memberGithub(organizationId, userId)).api.http, found: { installationId: number; accountLogin: string; suspended: boolean }[] = [];
      for (let page = 1; page <= 10; page++) {
        const rows = (await http.json(`/user/installations?per_page=100&page=${page}`, InstallationsPage)).installations;
        for (const row of rows) if (row.app_id === config.github?.appId) found.push({ installationId: row.id, accountLogin: row.account.login, suspended: !!row.suspended_at });
        if (rows.length < 100) break;
      }
      return found;
    },
    installationRepositories: async (organizationId: string, userId: string, installationId: number, page: number) => {
      const http = (await memberGithub(organizationId, userId)).api.http;
      const rows = (await http.json(`/user/installations/${installationId}/repositories?per_page=100&page=${page}`, InstallationRepositoriesPage)).repositories;
      return { repositories: rows.map(row => ({ id: String(row.id), repository: row.full_name, defaultBranch: row.default_branch, private: row.private })),
        nextPage: rows.length === 100 && page < 100 ? page + 1 : null };
    },
    ...(readyCopies && readyCopySecrets ? { readyCopies: { copies: readyCopies, secrets: readyCopySecrets,
      changed: async (organizationId: string, projectId: string, change: Parameters<CloudV2ReadyCopyBuilder["reconcile"]>[2]) => {
        // A project's copy needs a base: made sure of first, so it never waits on a button.
        await computers.ensureBase(organizationId).catch(() => undefined);
        await readyCopyBuilder?.reconcile(organizationId, projectId, change);
      },
      base: (organizationId: string) => computers.baseState(organizationId),
      buildNow: async (organizationId: string, projectId: string, userId: string) => {
        if (!readyCopyBuilder) throw new HttpError(503, "ready_copies_unavailable", "Ready copies are not built on this server.");
        return readyCopyBuilder.buildNow(organizationId, projectId, userId);
      },
      retryNow: async (organizationId: string, projectId: string, userId: string) => readyCopyBuilder?.retryNow(organizationId, projectId, userId),
    } } : {}),
  } : null;
  const source = github.source;
  // A create's submodules: read with the creator's own GitHub, each repository's access checked as theirs.
  const projectSubmodules = (organizationId: string, userId: string, projectId: string, repositories: readonly WorkspaceSubmoduleRepositoryInput[]) =>
    withGithubReadScope(async () => {
      const copy = await readyCopies!.forkable(organizationId, projectId, new Date());
      let access: ReturnType<typeof memberGithub> | undefined;
      const member = async () => (await (access ??= memberGithub(organizationId, userId))).api.http;
      const rows = await Promise.all(repositories.map(entry => {
        const built = copy?.result?.[entry.position];
        return resolveWorkspaceSubmodules({ ...entry, copy: built && built.repositoryId === entry.repositoryId
          ? { commit: built.commit, submodules: built.submodules ?? [] } : null }, {
          level: async (repository, commit) => readyCopies!.submoduleLevel(organizationId, repository, commit,
            async () => readSubmoduleLevel(await member(), repository, commit)),
          // The same read says whether GitHub reports it public: then it needs no access of the creator's own.
          resolve: async repository => {
            try {
              const identity = await resolveMemberRepository(organizationId, userId, repository);
              return { repositoryId: identity.repositoryId, public: identity.private === false };
            } catch (error) { if (error instanceof HttpError && [403, 404].includes(error.status)) return null; throw error; }
          },
          readable: target => source.targets(organizationId, userId, [target], false, { parallel: true }),
          // By id with the creator's own GitHub, on every create: a repository that turned private is private.
          visibility: async target => {
            const identity = await (await (access ??= memberGithub(organizationId, userId))).api.repository(target);
            return identity.private === false && identity.repositoryId === target.repositoryId ? "public" : "private";
          },
        });
      }));
      const method = rows.some(entry => entry.some(row => row.status === "fetch"))
        ? await (access ??= memberGithub(organizationId, userId)).then(grant => grant.material.method, () => null) : null;
      return withoutReadOnlyToken(rows.flat(), method === "pat");
    });
  const authorizeRepository = async (org: string, user: string, repository: string) => {
    await source.repository(org, user, repository);
  };
  const authorizeRepositories = async (org: string, user: string, repositories: readonly string[]) => {
    await source.repositories(org, user, repositories);
  };
  const authorizeSourceTargets = async (org: string, user: string, targets: readonly CloudSourceTarget[], options?: { renew?: boolean }) => {
    await source.targets(org, user, targets, options?.renew);
  };
  const authorizeBuildRepository = async (org: string, user: string, buildId: string, repository: string, options?: { fresh?: boolean; renew?: boolean }) => {
    const target = await computers.resolveBuildRepository(org, user, buildId, repository, options?.fresh ? { fresh: true } : undefined);
    await authorizeSourceTargets(org, user, [target], options?.renew ? { renew: true } : undefined);
    return target;
  };
  const authorizeSource = github.authorizeSource;
  const runtimeHandoffs = new RuntimeHandoffStore(pool);
  const runtimeUpdates = new RuntimeAdoption({ handoffs: runtimeHandoffs, store, compute, runtimeForWorkspace,
    drainActive: () => buildDrainActive(pool), logger: console });
  const continueSource = github.continueSource;
  const workspaceSync = new CloudWorkspaceSync(pool, localDevices, store, keys, signer, continueSource);
  const workspaceGithubReadTokens = new CloudWorkspaceGithubReadTokens(pool, localDevices, github.token);
  const mcp = createMcpServices(pool, config, github.connections.authorizeRepositoryConfiguration.bind(github.connections));
  const storedGitIdentity = (tx: Tx, scope: { organizationId: string; userId: string }) => github.connections.store.gitAuthor(scope, tx);
  const execution: CloudExecutionContexts = new CloudExecutionContexts(pool, {
    authority: new CloudExecutionAuthority(pool, source, github.connections.store), logins: new CloudExecutionLogins(pool, keys), keys,
    apiUrl: `${v2.apiUrl}/api/v0`, proxyBase, agentConfig: cloudV2AgentConfig,
    githubToken: async (context, check, purpose, failed, repository) => {
      const target = await withSystemTx(pool, async tx => {
        await check(tx);
        // The workspace's first repository, or the one named, which must be one of its own.
        const row = await workspaceTokenSource(tx, context.workspace_id, repository ?? null);
        if (row) return { ...row, submodule: false };
        // Or a submodule it fetches, read-only and for Git alone.
        const submodule = repository && purpose === "git" ? await workspaceSubmoduleSource(tx, context.workspace_id, repository) : null;
        if (!submodule) throw new HttpError(409, "actor_changed", "Execution source changed");
        return { ...submodule, submodule: true };
      });
      await check();
      const scope = { organizationId: context.org_id, userId: context.user_id! }, { submodule, ...repositoryTarget } = target;
      return submodule ? readOnlyToken(await github.token(scope, repositoryTarget, "read", "sync", () => check(), failed))
        : github.token(scope, repositoryTarget, "user", purpose, () => check(), failed);
    },
    ...(mcp ? { mcpAuthorization: async (context, check, id, force) => {
      const { workspace } = await execution.workspace(context.workspace_id, context.user_id!);
      const target = await github.identities.primary(workspace); await check();
      const result = await mcp.oauth.authorizationForRepository(context.org_id, context.user_id!, workspace.repository, id, force, target);
      await check(); return result;
    } } satisfies Pick<import("./execution/store.js").ExecutionDeps, "mcpAuthorization"> : {}),
    material: (context, check, transaction) => {
      const read = async (tx: Tx) => {
        const row = (await tx.query<Parameters<typeof cloudV2WorkspaceFromRow>[0]>(
          "SELECT * FROM cloud_v2_workspaces WHERE id=$1", [context.workspace_id])).rows[0];
        if (!row) throw new HttpError(409, "actor_changed", "Execution workspace changed");
        const workspace = cloudV2WorkspaceFromRow(row);
        const gitIdentity = await storedGitIdentity(tx, { organizationId: context.org_id, userId: context.user_id! });
        const environment = context.kind === "client" ? undefined : await environments.resolveExecution(workspace, context.user_id!, context.id, tx);
        // A workspace of several repositories: each repository's servers, together.
        const mcpServers = context.kind === "turn" && mcp ? await resolveWorkspaceMcpServers(mcp.store, tx, workspace, context.user_id!,
          await github.identities.primary(workspace, tx), line => console.warn(line)) : undefined;
        await check(tx);
        return { ...(environment ? { environment } : {}), ...(mcpServers ? { mcpServers } : {}), gitIdentity };
      };
      return transaction ? read(transaction) : withSystemTx(pool, read);
    },
  });
  store.prompts.execution = execution;
  store.api.execution = execution;
  apiCredentials.execution = execution;
  localCommands.execution = execution;
  notifications.execution = execution;
  localDevices.execution = execution;
  workspaceSync.execution = execution;
  const timing = (record: CloudV2TimingRecord) => console.log(`[cloud-v2] timing ${JSON.stringify(record)}`);
  const readySignals = new WorkerReadySignals();

  /** Whether the workspace's VM is a fork of its project's ready copy, whose build ran each setup. */
  const forkedFromCopy = async (workspaceId: string) => !!readyCopies && !!(await readyCopies.forkOf(workspaceId))?.sandboxId;
  /** Several repositories: the project folder and each repository, the first with the binding the config already names. */
  const repositoriesConfig = (layout: Awaited<ReturnType<typeof workerRepositories>>, first: WorkerRepositoryConfig["github"] | undefined,
    environments?: ReadonlyMap<string, CloudWorkspaceEnvironment>) =>
    layout.root && layout.repositories ? { root: layout.root, repositories: layout.repositories.map((entry, index) => {
      if (index === 0) return { ...entry, ...(first ? { github: first } : {}), ...(layout.firstSetup ?? {}) };
      const environment = entry.github ? environments?.get(entry.github.repositoryId) : undefined;
      return environment ? { ...entry, environment } : entry;
    }) } : {};
  const workerConfig = async (workspace: CloudV2Workspace & Partial<Pick<CloudV2WorkerSession, "loginRevision" | "executionMode">>, mode: "admission" | "continuation" = "admission",
    proof?: CloudSourceProof): Promise<ConfigFrame> => {
    if (workspace.executionMode === "active" || workspace.executionMode === undefined && await execution.active(workspace.id)) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await withExecutionLifetimeRetry(() => withSystemTx(pool, async tx => {
            const bootstrapContextId = await execution.bootstrap(workspace.id, tx);
            // Presentation refresh requires serializable isolation; keep its
            // bounded retry around the complete database-only configuration.
            const availability = await execution.deps.logins.refreshPresentation(workspace.id, tx);
            // A relay room can retain its workspace snapshot across Reassign.
            const { setup, target, baseCommit, creatorUserId, localCommandsEnabled: commandsAllowed } = await workerSourceConfiguration(tx, workspace);
            const gitIdentity = creatorUserId ? await storedGitIdentity(tx, { organizationId: workspace.organizationId, userId: creatorUserId })
              .catch(error => {
                // An N-1 membership writer can leave the old Creator until maintenance.
                if (error instanceof HttpError && error.status === 404 && error.code === "not_found") return null;
                throw error;
              }) : null;
            const localCommandsEnabled = v2.promptOutbox && commandsAllowed;
            const layout = await workerRepositories(tx, workspace, { forked: await forkedFromCopy(workspace.id) });
            return { t: "config", actingUser: 1, bootstrapContextId, agents: {}, ...availability?.presentation, gitIdentity,
              gitIdentitySource: creatorUserId ? "creator" : "actor",
              loginRevision: availability?.loginRevision ?? workspace.loginRevision ?? "0",
              promptOutbox: 1, pushSignals: 1, notifyUser: 1, githubPullRequests: 1, githubUserTokens: 1, agentInteractions: 1, runtimeUpdate: 1,
              ...(localCommandsEnabled ? { localCommands: 1 } : {}),
              workspace: { id: workspace.id, organizationId: workspace.organizationId, repository: workspace.repository,
                checkoutPath: workspaceCheckoutPath(workspace), branch: workspace.branch, baseBranch: workspace.baseBranch,
                github: { ...target, previousRepositories: [workspace.repository] }, ...(setup ?? layout.firstSetup ?? {}), ...(baseCommit ? { baseCommit } : {}),
                ...repositoriesConfig(layout, { ...target, previousRepositories: [workspace.repository] }), ...workerSubmodules(layout) } } satisfies ConfigFrame;
          }, { serializable: true }));
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "40001") || attempt === 2) throw error;
        }
      }
      throw new HttpError(503, "configuration_changing", "Worker configuration is changing");
    }
    requireWorkspaceCreator(workspace);
    const proxy = async () => {
      const issued = await store.issueToken({ workspaceId: workspace.id, kind: "proxy", userId: null, ttlMs: PROXY_TOKEN_TTL_MS });
      return { token: issued.token, expiresAt: issued.expiresAt.getTime() };
    };
    // The stored Git identity is read last so its final membership and
    // configuration fence also covers login, environment and tool reads.
    const [access, setup] = await Promise.all([github.workerConfiguration(workspace), github.workspaceSetup(workspace, computers)]);
    const { repositoryBinding } = access;
    const forked = await forkedFromCopy(workspace.id);
    const { selectedLogins, baseCommit, environment, mcpServers, layout, repositoryEnvironments } = await withSystemTx(pool, async tx => ({
      layout: await workerRepositories(tx, workspace, { forked }),
      // Creator path: each later repository's own pinned environment.
      repositoryEnvironments: await environments.resolveRepositories(workspace, tx),
      selectedLogins: await logins.all(workspace.creatorUserId, workspace.organizationId, tx),
      baseCommit: await store.baseCommit(workspace.id, tx),
      environment: await environments.resolve(workspace, tx),
      mcpServers: mcp ? await resolveWorkspaceMcpServers(mcp.store, tx, workspace, workspace.creatorUserId, repositoryBinding, line => console.warn(line)) : undefined,
    }), { consistentRead: true });
    const agents = await cloudV2AgentConfig(selectedLogins, proxyBase, proxy);
    const gitIdentity = await access.gitIdentity();
    return {
      t: "config",
      gitIdentity,
      codeReview: { userId: workspace.creatorUserId, ...(gitIdentity?.name ? { userName: gitIdentity.name } : {}) },
      githubPullRequests: 1,
      githubUserTokens: 1,
      agentInteractions: 1,
      runtimeUpdate: 1,
      ...(v2.promptOutbox ? { promptOutbox: 1 as const, pushSignals: 1 as const, notifyUser: 1 as const } : {}),
      loginRevision: access.loginRevision,
      workspace: {
        id: workspace.id, organizationId: workspace.organizationId, repository: workspace.repository,
        checkoutPath: workspaceCheckoutPath(workspace), branch: workspace.branch, baseBranch: workspace.baseBranch,
        github: repositoryBinding,
        ...(setup ?? layout.firstSetup ?? {}),
        ...(baseCommit ? { baseCommit } : {}),
        ...repositoriesConfig(layout, repositoryBinding, repositoryEnvironments),
        ...workerSubmodules(layout),
      },
      agents,
      ...(environment ? { environment } : {}),
      ...(mcpServers ? { mcpServers } : {}),
    };
  };

  // A draining replica would refuse a pending create's row, so a new one waits
  // a lifecycle scan interval before returning creates early, as for #903.
  const asyncCreateFrom = Date.now() + (v2.asyncCreateDelayMs ?? (config.deploymentChannel === "development" ? 0 : CLOUD_V2_ASYNC_CREATE_DELAY_MS));
  const teamSharing = new CloudTeamSharing(pool,store,github,listenerPool,undefined,{ ownership: v2.teamOwnership === true });
  const routes: CloudV2RouteDeps = {
    retention: v2.retention === true,
    actingUserDefault: v2.actingUserDefault === true,
    activeCreateRuntime,
    teamSharing,
    execution,
    store,
    computers,
    ...(v2.asyncCreate !== false ? { asyncCreate: () => Date.now() >= asyncCreateFrom } : {}),
    installedRepositories: organizationId => store.installedRepositories(organizationId),
    ...(projects && projectRoutes ? { projects, resolveMemberRepository, projectRoutes, projectAccess: github.projectAccess } : {}),
    ...(projects && readyCopies ? { projectSubmodules } : {}),
    ...(readyCopies ? { readyCopies: { status: (organizationId: string, viewer?: string | null) => readyCopies.status(organizationId, viewer ?? null),
      failures: (organizationId: string) => readyCopies.failureSummaries(organizationId, new Date()),
      changed: async (organizationId: string, projectId: string, change: "project_created" | "repositories_changed" | "setup_changed" | "submodules_changed" | "branch_changed") => {
        // A project's copy needs a base: made sure of first, so it never waits on a button.
        await computers.ensureBase(organizationId).catch(() => undefined);
        await readyCopyBuilder?.reconcile(organizationId, projectId, change);
      } } } : {}),
    authorizeRepository, authorizeRepositories, authorizeSourceTargets, authorizeBuildRepository, authorizeSource, continueSource,
    remoteHead: (org, user, target, branch) => github.remoteHead(org, user, target.repository, branch, target.repositoryId),
    github: { service: github.service, documents: github.documents },
    githubConnections: github.connections,
    environments,
    ...(runtimeCanary ? { runtimeCanary, runtimeCanaryStatus: (userId: string, grantId: string) => readRuntimeCanary(pool, runtimeCanary.policy, userId, grantId) } : {}),
    bridgeBaseUrl: v2.realtimeUrl,
    promptOutbox: v2.promptOutbox === true,
    localDevices: { devices: localDevices, signals: localCommandSignals, requests: localCommands, notifications },
    workspaceSync,
    workspaceGithubReadTokens,
  };
  const proxy: CloudV2ProxyDeps = { store, execution, logins, authorizeSource, continueSource, ...(keys ? { refreshCodex: createCloudV2CodexRefresh(pool, keys) } : {}) };
  const api = { credentials: apiCredentials,
    service: new CloudApiService({ store, routes, credentials: apiCredentials, appBaseUrl: new URL(config.inviteLinkBase).origin }) };
  const workerRoute = async (id: string) => {
    const route = await store.workerRoute(id);
    if (!route) return null;
    const handoff = await runtimeHandoffs.route(id);
    return { ...route, bootId: handoff.blocked ? null : route.bootId, ...(handoff.stopBootIds ? { stopBootIds: handoff.stopBootIds } : {}),
      token: route.portToken ? openPortToken(route.portToken, id, keys) : null };
  };
  const liveSignals = new LiveRecoverySignals(pool, listenerPool);
  const liveStore = new LiveRecoveryStore(pool);
  const liveRecovery = roles.relay ? new CloudLiveRecovery({ route: workerRoute,
    witness: (binding, until) => liveSignals.watch(binding, until),
    condition: (route, failed) => liveStore.condition(route, failed),
    rebuild: async route => !!await recoveryStore.begin(route),
    recovered: route => recoveryStore.cancel(route.recoveryAttemptId!, route),
    mint: (id, boot) => signer.mint(id, boot), ready: id => connections?.hintReady(id), logger: console }) : null;
  void liveSignals.start().catch(() => {});
  // Boat sometimes archives a resumed VM on its own; finish that stop and wake for waiting messages (provider-stop.ts).
  const providerStop = (v2.providerStopRecovery ?? "off") === "off" ? undefined
    : new ProviderStopCheck({ mode: v2.providerStopRecovery!, compute, store, logger: console });
  const providerStopRoute = (route: WorkerRoute) => {
    if (!providerStop || !route.workspace.boatSandboxId || !route.bootId || !route.workerTokenHash) return;
    void providerStop.check({ workspaceId: route.workspace.id, sandboxId: route.workspace.boatSandboxId, bootId: route.bootId,
      workerTokenHash: route.workerTokenHash, accessEpoch: route.accessEpoch }, "dial").catch(() => {});
  };
  const connections = roles.relay || roles.lifecycle ? new CloudV2Relay({
    apiConfiguration, execution, ...(providerStop ? { providerStop: providerStopRoute } : {}),
    localCommandsEnabled: id => localCommands.enabled(id), historyBatch: true, turnEvents: v2.promptOutbox === true,
    retireLocalSender: (id, userId, epoch, sessionId) => store.prompts.retireLocalSender(id, userId, epoch, sessionId),
    store, timing, authorizeSource, continueSource, ...(securityEvents ? { securityEvents } : {}),
    runtimeAdmission: runtimeHandoffs,
    ...(liveRecovery ? { liveRecovery } : {}),
    config: workerConfig,
    workerRoute,
    waitReady: (workspace, signal, ms) => readySignals.wait(workspace.id, Date.parse(workspace.updatedAt), workspace.state !== "running", signal, ms),
    workerActivity: async (binding, idle) => {
      const current = await store.relayActivity(binding, idle);
      if (!current) return null;
      const loginRevision = current.executionMode === "active" ? await execution.deps.logins.refreshAvailability(current.id) : null;
      return { state: current.state, loginRevision: loginRevision ?? current.loginRevision, prompts: current.promptsPending };
    },
    mintWorkerToken: (id, boot) => signer.mint(id, boot),
    wake: async workspace => { await store.transition(workspace.id, ["stopped"], "starting"); },
    answerOffline: (workspace, frame) => answerCloudV2Offline(store, workspace, frame),
    logger: console,
  }) : null;
  const relay = roles.relay ? connections : null;
  const promptSignals = new CloudV2PromptSignals();
  // Every instance answers worker pulls from its own barrier, so each one runs it (one transaction per 10 s).
  const authorityBarrier = new AuthorityBarrier(pool, Date.now, console);
  const authorityPull = new AuthorityPull(pool, authorityBarrier);
  const workers: CloudV2WorkerRouteDeps = { store, execution, timing, logger: console, authorizeSource, continueSource, config: workerConfig, githubToken, runtimeSha256: v2.runtime.sha256, messageAuthority: v2.messageAuthority !== false, authority: authorityPull, ...(v2.runtime.previousSha256 ? { previousRuntimeSha256: v2.runtime.previousSha256 } : {}),
    helloTransaction: work => withSystemTx(pool, work),
    appliedReady: async (id, boot) => {
      readySignals.applied(id, boot);
      await withSystemTx(pool, tx => notifyCloudV2WorkerBoot(tx, id, boot, "applied"));
    },
    recovery: recoveryStore,
    outboundProof: binding => liveSignals.worker(binding),
    ...(providerStop ? { providerStop } : {}),
    apiConfiguration,
    localCommands: { requests: localCommands, signals: localCommandSignals },
    notifications,
    workspaceSync,
    repositorySetup: repositorySetupReports(pool),
    runtimeUpdates, runtimeHandoffs,
    runtimeSha256ForWorkspace: async workspace => {
      const selected = await runtimeForWorkspace(workspace);
      return { sha256: selected.sha256, channel: selected === runtime };
    },
    environmentReport: (token, bootId, value) => environments.report(token, bootId, value),
    repositoryEnvironmentReport: (token, bootId, repository, value) => environments.reportRepository(token, bootId, repository, value),
    githubCheckout: (token,bootId,value) => github.metadata.checkout(token,bootId,value),
    ...(mcp ? { mcpAuthorization: async (workspace, id, force) => {
      requireWorkspaceCreator(workspace);
      return mcp.oauth.authorizationForRepository(workspace.organizationId, workspace.creatorUserId, workspace.repository, id, force,
        await github.identities.primary(workspace));
    } } : {}),
    promptOutbox: v2.promptOutbox === true, waitForPrompts: (id, ms, signal) => promptSignals.wait(id, ms, signal) };
  const promptChanges = v2.promptOutbox ? postgresNotificationSubscription(listenerPool, {
    channels: ["zeros_cloud_v2_prompts"],
    onReady: () => { promptSignals.wakeAll(); connections?.promptNotifications(true); },
    onDisconnect: () => { connections?.promptNotifications(false); promptSignals.wakeAll(); },
    onNotification: notice => {
      if (!/^[a-f0-9-]{36}$/.test(notice.payload ?? "")) return;
      promptSignals.wake(notice.payload!); connections?.hintPrompts(notice.payload!);
    },
  }) : null;
  void promptChanges?.start().catch(() => {});
  const executionHints = new Map<string, { pending: boolean; flight: Promise<void> }>();
  let executionClosing = false;
  const executionHint = (id: string) => {
    if (executionClosing) return Promise.resolve();
    const previous = executionHints.get(id);
    if (previous) { previous.pending = true; return previous.flight; }
    const entry = { pending: true, flight: Promise.resolve() };
    entry.flight = Promise.resolve().then(async () => {
      do {
        entry.pending = false;
        await execution.maintenance.publish(id, async (workspaceId, frames) => { await connections?.revokeContexts(workspaceId, frames); });
      } while (entry.pending && !executionClosing);
    }).catch(() => {}).finally(() => executionHints.delete(id));
    executionHints.set(id, entry);
    return entry.flight;
  };
  const executionSweep = async () => { for (const id of await execution.maintenance.due()) await executionHint(id); };
  const executionScope = async (scope: { userId?: string; organizationId?: string }) => {
    let after: string | undefined;
    while (!executionClosing) {
      const ids = await execution.maintenance.affected(scope, after);
      for (const id of ids) await executionHint(id);
      if (ids.length < 128) break;
      after = ids.at(-1);
    }
  };
  const loginListener = postgresNotificationSubscription(listenerPool, {
    // The existing shared LISTEN connection carries these hints. No connection
    // or polling loop is added for permission-cache invalidation or readiness.
    channels: ["zeros_cloud_v2_logins", "zeros_cloud_github_access", "zeros_cloud_v2_execution", CLOUD_V2_READY_CHANNEL, CLOUD_V2_BOOT_CHANNEL],
    onReady: () => { source.invalidate(); relay?.revalidateSources({}); void relay?.refreshLogins(); void executionScope({}).catch(() => {}); void executionSweep().catch(() => {}); },
    onNotification: notice => {
      if (notice.channel === CLOUD_V2_BOOT_CHANNEL) { readySignals.notification(notice.payload ?? ""); return; }
      if (notice.channel === "zeros_cloud_v2_execution") {
        try {
          const value = JSON.parse(notice.payload ?? "");
          if (typeof value.workspaceId === "string" && /^[a-f0-9-]{36}$/.test(value.workspaceId)) void executionHint(value.workspaceId);
          else {
            const scope = { ...(typeof value.userId === "string" && /^[a-f0-9-]{36}$/.test(value.userId) ? { userId: value.userId } : {}),
              ...(typeof value.organizationId === "string" && /^[a-f0-9-]{36}$/.test(value.organizationId) ? { organizationId: value.organizationId } : {}) };
            void executionScope(scope).catch(() => {}); void executionSweep().catch(() => {});
          }
        } catch { /* A notification is only a hint; durable leases remain authoritative. */ }
        return;
      }
      if (notice.channel === CLOUD_V2_READY_CHANNEL) {
        if (/^[a-f0-9-]{36}$/.test(notice.payload ?? "")) { readySignals.ready(notice.payload!); connections?.hintReady(notice.payload!); }
        return;
      }
      try {
        const scope = JSON.parse(notice.payload ?? "");
        if ((typeof scope?.ownerUserId === "string" || scope?.ownerUserId === null) && (scope.organizationId === null || typeof scope.organizationId === "string")) {
          const identity = { ...(typeof scope.ownerUserId === "string" ? { ownerUserId: scope.ownerUserId } : {}), ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) };
          if (notice.channel === "zeros_cloud_v2_logins" && scope.availabilityOnly === true) {
            void relay?.refreshLogins(identity);
            return;
          }
          source.invalidate({ ...(identity.ownerUserId ? { userId: identity.ownerUserId } : {}), ...(identity.organizationId ? { organizationId: identity.organizationId } : {}) });
          relay?.revalidateSources(identity);
          if (notice.channel === "zeros_cloud_v2_logins") void relay?.refreshLogins(identity);
        }
      } catch { /* Invalid wake hints carry no authority. */ }
    },
  });
  // Token verdicts in memory, dropped by the commit-time hints of removals, Stop, outcomes and the settings in 0255.
  const authorizationMode = v2.executionAuthCache ?? "off";
  const authorizationListener = authorizationMode === "off" ? undefined : postgresNotificationSubscription(listenerPool, {
    channels: ["zeros_cloud_v2_execution", "zeros_cloud_v2_prompts", "zeros_cloud_v2_authorization"],
    onReady: () => execution.authorizations?.flush(),
    onDisconnect: () => execution.authorizations?.flush(),
    onNotification: notice => {
      const hint = authorizationHint(notice.channel, notice.payload);
      if (hint === "flush") execution.authorizations?.flush();
      else if (hint !== "ignore") execution.authorizations?.invalidate(hint);
    },
  });
  let authorizationReport: NodeJS.Timeout | undefined;
  if (authorizationListener) {
    const authorizations = new ExecutionAuthorizationCache<CachedTokenContext>({ mode: authorizationMode, healthy: () => authorizationListener.healthy() });
    execution.authorizations = authorizations;
    authorizationReport = setInterval(() => {
      const counters = { ...authorizations.counters };
      if (!Object.values(counters).some(Boolean)) return;
      for (const key of Object.keys(authorizations.counters) as (keyof typeof counters)[]) authorizations.counters[key] = 0;
      console.log(`[cloud-v2] authorization-cache ${JSON.stringify({ mode: authorizationMode, entries: authorizations.size, ...counters })}`);
    }, 60_000);
    authorizationReport.unref();
  }
  const loginChanges = { start: async () => { await Promise.all([loginListener.start(), authorizationListener?.start()]); }, stop: async () => {
    executionClosing = true; clearInterval(authorizationReport); await Promise.all([loginListener.stop(), authorizationListener?.stop()]);
    await Promise.all([...executionHints.values()].map(value => value.flight));
  } };
  void loginChanges?.start().catch(() => {}); // The shared listener retries and re-reads onReady.
  const remoteHeads = github.remoteHead;
  /** A token for one of a workspace of several's repositories after the first: as its initiator
   * in shared execution, else as its creator; only ever one of the workspace's own sources. */
  const otherRepositoryToken = async (workspace: CloudV2LifecycleWorkspace, repository: string) => {
    const actor = await lifecycleExecution(execution, workspace);
    if (!actor) return githubToken(workspace, "git", undefined, repository);
    const target = await withSystemTx(pool, tx => workspaceTokenSource(tx, workspace.id, repository));
    if (!target) throw new HttpError(403, "github_repository_access_required", "This repository is not part of this workspace.");
    return github.token({ organizationId: workspace.organizationId, userId: actor.userId }, target, "read", "computer", actor.check);
  };
  const lifecycleSource = async (workspace: CloudV2LifecycleWorkspace, purpose: "git" | "computer" = "git", recoveryId?: string) => {
    const actor = await lifecycleExecution(execution, workspace, recoveryId ? { recoveryId } : undefined);
    if (!actor) return null;
    try {
      const target = await github.identities.primary(workspace); await actor.check();
      const scope = { organizationId: workspace.organizationId, userId: actor.userId };
      const access = await github.connections.access(scope); await actor.check();
      const binding = await access.api.repository(target); await actor.check();
      const credential = await github.token(scope, binding, "read", purpose, actor.check); await actor.check();
      return { ...actor, credential, repository: binding.repository };
    } catch (error) {
      if (purpose === "computer" && workspace.checkpoint && isGithubAccessRevoked(error)) {
        await actor.check();
        throw new HttpError(403, "github_access_required", "The workspace initiator needs access to its repository");
      }
      throw error;
    }
  };
  const checkpoints = {
    storage: cloudV2CheckpointStorage(runtimeStorageClient(v2.runtime.store), v2.runtime.store),
    seal: (key: Buffer, id: string, object: string) => sealCheckpointKey(key, id, object, keys),
    open: (sealed: unknown, id: string, object: string) => openCheckpointKey(sealed, id, object, keys),
  };
  const recovery = roles.lifecycle ? new CloudRecovery({
    store: recoveryStore, compute, runtime, publicKeys: signer.publicKeys, checkpoints,
    authorize: async workspace => {
      if (!workspace.recoveryAttemptId || !await lifecycleExecution(execution, workspace, { recoveryId: workspace.recoveryAttemptId }))
        throw new HttpError(409, "recovery_binding_changed", "Workspace recovery changed.");
    },
    githubToken: async (workspace, repository) => {
      if (!workspace.recoveryAttemptId) throw new HttpError(409, "recovery_binding_changed", "Workspace recovery changed.");
      const actor = await lifecycleSource(workspace, "computer", workspace.recoveryAttemptId);
      if (!actor) throw new HttpError(409, "recovery_binding_changed", "Workspace recovery changed.");
      if (!repository) return actor.credential;
      // A repository after the first: the recovery actor's own token for it, as prepareRepository mints it.
      return github.token({ organizationId: workspace.organizationId, userId: actor.userId },
        { repository: repository.repository.toLowerCase(), repositoryId: repository.repositoryId }, "read", "git", actor.check);
    },
    repositories: workspace => withSystemTx(pool, tx => otherRepositories(tx, workspace)),
    bootEnv: async (workspace, selected) => ({ CLOUD_V2_API_URL: v2.apiUrl, CLOUD_V2_RUNTIME_SHA256: selected.sha256, ZEROS_WORKSPACE_ID: workspace.id }),
    sandboxName: (workspace, attempt) => `${cloudV2SandboxName(config.deploymentChannel, "ws", workspace.id, localOwner)}-r${attempt.slice(0, 8)}`,
    sealToken: (token, id) => sealPortToken(token, id, keys), openToken: (envelope, id) => openPortToken(envelope, id, keys),
    ready: async (workspace, attempt) => {
      const route = await workerRoute(workspace.id);
      return !!route && route.workspace.boatSandboxId === attempt.replacement_sandbox_id &&
        route.bootId === attempt.replacement_boot_id && route.workerTokenHash === attempt.replacement_token_hash?.toString("hex") &&
        route.recoveryAttemptId === attempt.id && await recoveryWorkerReady(route, signer.mint(workspace.id, route.bootId!));
    },
    logger: console,
  }) : null;
  const builder = roles.lifecycle ? new CloudV2ComputerBuilder({
    computers, compute, channel: config.deploymentChannel, localOwner, runtime, publicKeys: signer.publicKeys,
    cloneToken: async (organizationId, userId, target) => {
      return (await github.token({ organizationId, userId }, target, "read", "computer",
        () => authorizeSourceTargets(organizationId, userId, [target]))).token;
    },
    ...(remoteHeads ? { remoteHead: (org: string, user: string, target: CloudSourceTarget, branch: string) =>
      remoteHeads(org, user, target.repository, branch, target.repositoryId) } : {}),
    ...(readyCopies ? { onActivated: async ({ organizationId, reason }: { organizationId: string; reason: string }) => {
      if (readyCopyBuilder) await readyCopyBuilder.baseActivated(organizationId, reason);
      else await readyCopies.markStale(organizationId);
    } } : {}),
    logger: console,
  }) : null;
  const copyCloneToken = async (organizationId: string, userId: string, target: CloudSourceTarget) =>
    (await github.token({ organizationId, userId }, target, "read", "computer",
      () => authorizeSourceTargets(organizationId, userId, [target]))).token;
  // Every role queues generations through it (Build now, Retry now, saves); only the lifecycle role runs its loop.
  const readyCopyBuilder = readyCopies ? new CloudV2ReadyCopyBuilder({
    copies: readyCopies, compute, channel: config.deploymentChannel, localOwner, runtime, publicKeys: signer.publicKeys,
    cloneToken: copyCloneToken,
    ...(repositoryLevels ? { sharedCloneToken: organizationCloneToken({ levels: repositoryLevels, config: config.github ?? null }) } : {}),
    ...(readyCopySecrets ? { secrets: (organizationId: string, projectId: string) => readyCopySecrets.open(organizationId, projectId) } : {}),
    // Submodules (C4): each level read with the token of its own repository, each repository reached as the project's clones are.
    githubHttp: (token: string) => new CloudGithubHttp({ apiBaseUrl: config.github?.apiBaseUrl ?? "https://api.github.com", token, assertCurrent: async () => {} }),
    submoduleRepository: async (organizationId: string, project: { level: "organization" | "personal"; ownerUserId: string | null }, repository: string) => {
      if (project.level === "personal") {
        const identity = await resolveMemberRepository(organizationId, project.ownerUserId!, repository).catch(() => null);
        if (!identity) return null;
        const target = { repository: identity.repository, repositoryId: identity.repositoryId };
        return { repositoryId: identity.repositoryId, token: await copyCloneToken(organizationId, project.ownerUserId!, target) };
      }
      return repositoryLevels ? organizationSubmoduleRepository({ levels: repositoryLevels, config: config.github ?? null })(organizationId, repository) : null;
    },
    logger: console,
  }) : null;
  // A base made inline (the shared one, by ensureBase) queues first copies as one the builder made does.
  if (readyCopies) computers.baseActivated = async (organizationId: string) => {
    if (readyCopyBuilder) await readyCopyBuilder.baseActivated(organizationId, "manual");
  };
  const readyCopyForks = roles.lifecycle && readyCopies ? new CloudV2ReadyCopyForks({
    copies: readyCopies, compute,
    ...(readyCopyBuilder ? { queueFirst: (organizationId: string, projectId: string) => readyCopyBuilder.queueFirst(organizationId, projectId) } : {}),
    githubToken: async (workspace: CloudV2LifecycleWorkspace, repository?: string) => repository ? otherRepositoryToken(workspace, repository)
      : (await lifecycleSource(workspace, "computer"))?.credential ?? github.workspaceToken(workspace),
    logger: console,
  }) : null;
  // Data only and idempotent, so it runs whether or not ready copies are on:
  // projects exist by the time the setting is turned on.
  if (roles.lifecycle) void migrateProjects(pool).catch(() => console.warn("[cloud-v2] projects migration will retry at the next start"));
  const lifecycle = roles.lifecycle ? new CloudV2Lifecycle({
    ...(providerStop ? { providerStop } : {}),
    ...(recovery ? { recovery } : {}),
    executionActivations: new CloudExecutionActivations(pool, execution),
    runtimeUpdates,
    // Always wired: rows created before async creates were disabled still resolve.
    resolvePendingSource: createPendingSourceResolver({
      activeComputer: organizationId => store.activeComputer(organizationId),
      authorizeBuildRepository: (org, user, buildId, repository, options) => authorizeBuildRepository(org, user, buildId, repository, options),
      remoteHead: (org, user, target, branch) => github.remoteHead(org, user, target.repository, branch, target.repositoryId),
      resolve: (id, input) => store.resolvePendingSource(id, input),
    }),
    ...(builder ? { builds: builder } : {}),
    ...(readyCopyForks ? { readyCopies: readyCopyForks } : {}),
    ...(readyCopyBuilder ? { readyCopyBuilds: readyCopyBuilder } : {}),
    store,
    timing,
    compute,
    runtime,
    ...(v2.runtime.previousSha256 ? { previousRuntimeSha256: v2.runtime.previousSha256 } : {}),
    runtimeForWorkspace,
    authorizeWorkspace: async workspace => {
      if (await lifecycleExecution(execution, workspace)) return;
      requireWorkspaceCreator(workspace);
      await store.get(workspace.id, workspace.creatorUserId);
      if (workspace.state === "creating") await authorizeSource(workspace, { renew: true });
    },
    assertExecution: async workspace => { await lifecycleExecution(execution, workspace); },
    claimExecutionRestore: (workspace,sandboxId) => claimExecutionRestore(pool,workspace,sandboxId),
    prepareRepository: async (workspace, sandboxId) => {
      const actor = await lifecycleSource(workspace);
      const credential = actor?.credential ?? await github.workspaceToken(workspace);
      const repository = actor?.repository ?? (await github.binding(workspace)).repository;
      const input = `Authorization: Basic ${Buffer.from(`x-access-token:${credential.token}`).toString("base64")}\n`;
      await actor?.check();
      const result = await compute.execLong(sandboxId, hydrateCloudRepository(workspace, repository), 900, input);
      await actor?.check();
      if (result.exitCode !== 0) throw new HttpError(409, "cloud_source_checkout_failed", "The repository checkout could not be prepared. Existing files were retained.");
      // A workspace of several repositories: each other repository in its folder, with its own token.
      for (const other of await withSystemTx(pool, tx => otherRepositories(tx, workspace))) {
        const target = { repository: other.repository.toLowerCase(), repositoryId: other.repositoryId };
        const token = actor ? await github.token({ organizationId: workspace.organizationId, userId: actor.userId }, target, "read", "git", actor.check)
          : await githubToken(workspace, "git", undefined, other.repository);
        await actor?.check();
        const cloned = await compute.execLong(sandboxId, hydrateCloudRepository({ ...workspace, repository: other.repository, checkoutFolder: other.checkoutFolder },
          other.repository), 900, `Authorization: Basic ${Buffer.from(`x-access-token:${token.token}`).toString("base64")}\n`);
        await actor?.check();
        if (cloned.exitCode !== 0)
          throw new HttpError(409, "cloud_source_checkout_failed", `${other.repository} could not be checked out. Existing files were retained.`);
      }
      if (!actor) await authorizeSource(workspace);
    },
    prompts: store.prompts, stopIdle: (id, before) => store.stopIdle(id, before),
    pruneEnvironments: () => environments.prune(),
    checkpointRetry: v2.checkpointRetry === true,
    // Retention (CLOUD_V2_RETENTION_ENABLED): absent while off, so stops checkpoint and restores create as before.
    ...(v2.retention === true ? { retention: true, ...(v2.backupForksPerHour ? { backupForksPerHour: v2.backupForksPerHour } : {}),
      ...(v2.maintenancePerHour ? { maintenancePerHour: v2.maintenancePerHour } : {}), ...(v2.maintenancePerDay ? { maintenancePerDay: v2.maintenancePerDay } : {}),
      ...(readyCopies ? { restoreSource: readyCopyRestoreSource(readyCopies) } : {}) } : {}),
    publicKeys: signer.publicKeys, sealPortToken: (token, id) => sealPortToken(token, id, keys),
    stopWorker: workspace => connections!.stopWorkspace(workspace),
    bootEnv: async (workspace, selected) => ({ CLOUD_V2_API_URL: v2.apiUrl,
      CLOUD_V2_RUNTIME_SHA256: (selected ?? await runtimeForWorkspace(workspace)).sha256, ZEROS_WORKSPACE_ID: workspace.id }),
    sandboxName: workspace => cloudV2SandboxName(config.deploymentChannel, "ws", workspace.id, localOwner),
    // Checkpoints share the runtime's bucket, under cloud-v2/checkpoints/.
    checkpoints,
    remoteHead: async workspace => {
      const actor = await lifecycleExecution(execution, workspace);
      const target = await github.identities.primary(workspace); await actor?.check();
      const userId = actor?.userId ?? workspace.creatorUserId;
      if (!userId) throw new HttpError(409,"workspace_creator_required","This workspace has no execution initiator");
      const head = await remoteHeads(workspace.organizationId, userId, workspace.repository, workspace.baseBranch, target.repositoryId);
      await actor?.check(); return head;
    },
    githubToken: async (workspace, repository) => repository ? otherRepositoryToken(workspace, repository)
      : (await lifecycleSource(workspace,"computer"))?.credential ?? github.workspaceToken(workspace),
    repositories: workspace => withSystemTx(pool, tx => otherRepositories(tx, workspace)),
    logger: console,
  }) : null;
  // Lifecycle rows notify on change. Reconnecting sweeps once, covering any
  // notice lost meanwhile; the shared LISTEN session carries the channel.
  const lifecycleChanges = lifecycle ? postgresNotificationSubscription(listenerPool, {
    channels: [CLOUD_V2_LIFECYCLE_CHANNEL, RECOVERY_CHANNEL],
    onReady: () => { lifecycle.wake(); recovery?.wake(); },
    onNotification: notice => { if (notice.channel === RECOVERY_CHANNEL) recovery?.wake(); else lifecycle.wake(); },
  }) : null;
  void lifecycleChanges?.start().catch(() => {});
  return { store, execution, authorityBarrier, compute, routes, proxy, workers, api, relay, connections, lifecycle, runtimeUpdates, loginChanges, promptChanges, lifecycleChanges, promptSignals, localCommandSignals, teamSharing,
    stopLiveRecovery: async () => { await liveRecovery?.close(); await liveSignals.stop(); },
    startAuthority: () => { authorityBarrier.start(); return () => authorityBarrier.close(); },
    startLocalCommands: () => {
      if (!roles.lifecycle) return async () => {};
      const local = startLocalCommandMaintenance(localCommands,localCommandSignals,console,notifications);
      const acting = execution.maintenance.start(async (id, frames) => { await connections?.revokeContexts(id, frames); });
      return async () => { await Promise.all([local(), acting()]); };
    } };
}
