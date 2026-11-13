// Assembles cloud workspace v2 from configuration: one store, Boat, the relay
// (realtime role), the lifecycle loop (worker role), the HTTP routes and the
// model proxy (API role). index.ts only starts and stops what this returns.
import { createPendingSourceResolver } from "./pending-create.js";
import { postgresNotificationSubscription } from "../postgres-notifications.js";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
import { readGithubGitAuthor } from "../github-git-author.js";
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
import { CloudV2ComputerBuilder, CloudV2Computers } from "./computer.js";
import { createCloudGithubServices } from "./github-composition.js";
import { CLOUD_V2_READY_CHANNEL } from "./worker-ready.js";
import { hydrateCloudRepository, type CloudSourceProof, type CloudSourceTarget } from "./source-authority.js";
import { HISTORY_OPS, readCloudV2History } from "./history.js";
import { CLOUD_V2_HOME, CLOUD_V2_LIFECYCLE_CHANNEL, CloudV2Lifecycle, type CloudV2TimingRecord } from "./lifecycle.js";
import { cloudV2CheckpointStorage, openCheckpointKey, sealCheckpointKey } from "./checkpoint.js";
import { runtimeStorageClient } from "./runtime-source.js";
import { activeRuntimeQualification } from "./runtime-capabilities.js";
import { executionCreationRuntime } from "./execution/creation.js";
import { CLOUD_V2_PROXY_PREFIX, type CloudV2ProxyDeps } from "./proxy.js";
import { CloudV2Relay } from "./relay.js";
import { cloudV2Runtime } from "./runtime.js";
import type { CloudV2RouteDeps } from "./routes.js";
import { CloudV2Store, cloudV2WorkspaceFromRow, type CloudV2LifecycleWorkspace, type CloudV2WorkerSession, type CloudV2Workspace } from "./store.js";
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
import { requireWorkspaceCreator } from "./workspace-access.js";

import { CloudExecutionContexts } from "./execution/store.js";
import { lifecycleExecution } from "./execution/lifecycle.js";
import { claimExecutionRestore } from "./execution/restore.js";
import { CloudExecutionActivations, executionActivationRuntime } from "./execution/activation.js";
import { CloudExecutionAuthority } from "./execution/authority.js";
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
export async function answerCloudV2Offline(store: Pick<CloudV2Store, "listChats" | "messageWindow" | "searchMessages">,
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
  const localOwner = config.development && !("generation" in config.development) ? config.development.owner : undefined;
  const keys = cloudAgentCredentialKeys(config.cloudAgentCredentials ?? null);
  if (!keys) throw new Error("Cloud v2 requires the credential encryption keyring");
  const store = new CloudV2Store(pool, keys);
  const runtime = cloudV2Runtime(v2.runtime.sha256, v2.runtime.store);
  const activeCreateRuntime = activeRuntimeQualification(config.deploymentChannel, v2.runtime);
  const runtimeCanary = config.deploymentChannel === "alpha" && v2.runtimeCanary ? new RuntimeCanaryAuthority(v2.runtimeCanary) : undefined;
  const defaultRuntimeForWorkspace = workspaceRuntimeResolver(pool, runtime, runtimeCanary?.policy);
  const runtimeForWorkspace = async (workspace: CloudV2Workspace & { executionTransitionId?: string; executionMode?: CloudV2WorkerSession["executionMode"] }) => {
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
  const githubToken = (workspace: CloudV2Workspace, purpose: "git" | "gh" = "git", failedTokenSha256?: string) => github.workspaceToken(workspace, "user", purpose, failedTokenSha256);
  const proxyBase = `${v2.apiUrl}${CLOUD_V2_PROXY_PREFIX}`;
  const computers = new CloudV2Computers(pool, lockPool, github.resolveRepository, github.resolveRecentRepository);
  const source = github.source;
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
  const runtimeUpdates = new RuntimeAdoption({ handoffs: runtimeHandoffs, store, compute, runtimeForWorkspace, authorizeSource,
    drainActive: () => buildDrainActive(pool), logger: console });
  const continueSource = github.continueSource;
  const workspaceSync = new CloudWorkspaceSync(pool, localDevices, store, keys, signer, continueSource);
  const workspaceGithubReadTokens = new CloudWorkspaceGithubReadTokens(pool, localDevices, github.token);
  const mcp = createMcpServices(pool, config, github.connections.authorizeRepositoryConfiguration.bind(github.connections));
  const storedGitIdentity = async (tx: Tx, scope: { organizationId: string; userId: string }) => {
    const selected = await github.connections.store.selectedIdentity(scope, tx);
    const identity = selected ? await readGithubGitAuthor(tx, scope.userId, selected.identity) : null;
    await selected?.assertCurrent();
    return identity;
  };
  const execution: CloudExecutionContexts = new CloudExecutionContexts(pool, {
    authority: new CloudExecutionAuthority(pool, source, github.connections.store), logins: new CloudExecutionLogins(pool, keys), keys,
    apiUrl: `${v2.apiUrl}/api/v0`, proxyBase, agentConfig: cloudV2AgentConfig,
    githubToken: async (context, check, purpose, failed) => {
      const target = await withSystemTx(pool, async tx => {
        await check(tx);
        const row = (await tx.query<{ repository: string; repositoryId: string }>(`SELECT s.source_repository AS repository,s.repository_id::text AS "repositoryId"
          FROM cloud_v2_github_sources s JOIN cloud_v2_workspaces w ON w.id=s.workspace_id
          WHERE w.id=$1 AND s.source_repository=lower(w.repository)`, [context.workspace_id])).rows[0];
        if (!row) throw new HttpError(409, "actor_changed", "Execution source changed");
        return row;
      });
      await check();
      return github.token({ organizationId: context.org_id, userId: context.user_id! }, target, "user", purpose, () => check(), failed);
    },
    ...(mcp ? { mcpAuthorization: async (context, check, id, force) => {
      const { workspace } = await execution.workspace(context.workspace_id, context.user_id!);
      const target = await github.identities.primary(workspace); await check();
      const result = await mcp.oauth.authorizationForRepository(context.org_id, context.user_id!, workspace.repository, id, force, target);
      await check(); return result;
    } } satisfies Pick<import("./execution/store.js").ExecutionDeps, "mcpAuthorization"> : {}),
    material: async (context, check) => {
      const { workspace, gitIdentity, primary } = await withSystemTx(pool, async tx => {
        const row = (await tx.query<Parameters<typeof cloudV2WorkspaceFromRow>[0]>(
          "SELECT * FROM cloud_v2_workspaces WHERE id=$1", [context.workspace_id])).rows[0];
        if (!row) throw new HttpError(409, "actor_changed", "Execution workspace changed");
        const workspace = cloudV2WorkspaceFromRow(row);
        const gitIdentity = await storedGitIdentity(tx, { organizationId: context.org_id, userId: context.user_id! });
        if (!gitIdentity) throw new HttpError(503, "agent_credentials_unavailable", "Execution credentials are temporarily unavailable");
        const primary = await github.identities.primary(workspace, tx);
        await check(tx);
        return { workspace, gitIdentity, primary };
      });
      const material = await withSystemTx(pool, async tx => {
        const environment = context.kind === "client" ? undefined : await environments.resolveExecution(workspace, context.user_id!, context.id, tx);
        const mcpServers = context.kind === "turn" && mcp ? await mcp.store.resolve(context.org_id, context.user_id!, workspace.repository,
          primary, tx) : undefined;
        await check(tx);
        return { ...(environment ? { environment } : {}), ...(mcpServers ? { mcpServers } : {}) };
      });
      return { ...material, gitIdentity };
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

  const workerConfig = async (workspace: CloudV2Workspace & Partial<Pick<CloudV2WorkerSession, "loginRevision" | "executionMode">>, mode: "admission" | "continuation" = "admission",
    proof?: CloudSourceProof): Promise<ConfigFrame> => {
    if (workspace.executionMode === "active" || workspace.executionMode === undefined && await execution.active(workspace.id)) {
      await execution.deps.logins.refreshAvailability(workspace.id);
      const bootstrapContextId = await execution.bootstrap(workspace.id);
      const [setup, target, baseCommit, presentation, commitIdentity] = await Promise.all([github.workspaceSetup(workspace, computers), github.identities.primary(workspace),
        store.baseCommit(workspace.id), execution.deps.logins.presentation(workspace.id), withSystemTx(pool, async tx => {
          // A relay room can retain its workspace snapshot across Reassign.
          const current = (await tx.query<{ creator_user_id: string | null }>("SELECT creator_user_id FROM cloud_v2_workspaces WHERE id=$1", [workspace.id])).rows[0];
          if (!current) throw new HttpError(409, "actor_changed", "Execution workspace changed");
          const gitIdentity = current.creator_user_id ? await storedGitIdentity(tx, { organizationId: workspace.organizationId, userId: current.creator_user_id })
            .catch(error => {
              // An N-1 membership writer can leave the old Creator until maintenance.
              if (error instanceof HttpError && error.status === 404 && error.code === "not_found") return null;
              throw error;
            }) : null;
          return { gitIdentitySource: current.creator_user_id ? "creator" as const : "actor" as const,
            gitIdentity };
        })]);
      return { t: "config", actingUser: 1, bootstrapContextId, agents: {}, ...presentation, ...commitIdentity, loginRevision: workspace.loginRevision ?? "0",
        promptOutbox: 1, notifyUser: 1, githubPullRequests: 1, githubUserTokens: 1, agentInteractions: 1, runtimeUpdate: 1,
        workspace: { id: workspace.id, organizationId: workspace.organizationId, repository: workspace.repository,
          checkoutPath: `${CLOUD_V2_HOME}/${workspace.repository}`, branch: workspace.branch, baseBranch: workspace.baseBranch,
          github: { ...target, previousRepositories: [workspace.repository] }, ...(setup ?? {}), ...(baseCommit ? { baseCommit } : {}) } };
    }
    requireWorkspaceCreator(workspace);
    const proxy = async () => {
      const issued = await store.issueToken({ workspaceId: workspace.id, kind: "proxy", userId: null, ttlMs: PROXY_TOKEN_TTL_MS });
      return { token: issued.token, expiresAt: issued.expiresAt.getTime() };
    };
    // Every worker hello waits on this. The build's setup is read beside
    // GitHub access. The Git identity stays last: its fence covers every
    // read before it.
    const [access, setup] = await Promise.all([github.workerConfiguration(workspace, mode, proof), github.workspaceSetup(workspace, computers)]);
    const { repositoryBinding } = access;
    const { selectedLogins, baseCommit, environment, mcpServers } = await withSystemTx(pool, async tx => ({
      selectedLogins: await logins.all(workspace.creatorUserId, workspace.organizationId, tx),
      baseCommit: await store.baseCommit(workspace.id, tx),
      environment: await environments.resolve(workspace, tx),
      mcpServers: mcp ? await mcp.store.resolve(workspace.organizationId, workspace.creatorUserId, workspace.repository, repositoryBinding, tx) : undefined,
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
      ...(v2.promptOutbox ? { promptOutbox: 1 as const,notifyUser: 1 as const } : {}),
      loginRevision: access.loginRevision,
      workspace: {
        id: workspace.id, organizationId: workspace.organizationId, repository: workspace.repository,
        checkoutPath: `${CLOUD_V2_HOME}/${workspace.repository}`, branch: workspace.branch, baseBranch: workspace.baseBranch,
        github: repositoryBinding,
        ...(setup ?? {}),
        ...(baseCommit ? { baseCommit } : {}),
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
    actingUserDefault: v2.actingUserDefault === true,
    activeCreateRuntime,
    teamSharing,
    execution,
    store,
    computers,
    ...(v2.asyncCreate !== false ? { asyncCreate: () => Date.now() >= asyncCreateFrom } : {}),
    installedRepositories: organizationId => store.installedRepositories(organizationId),
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
  const connections = roles.relay || roles.lifecycle ? new CloudV2Relay({
    apiConfiguration, execution,
    localCommandsEnabled: id => localCommands.enabled(id),
    retireLocalSender: (id, userId, epoch, sessionId) => store.prompts.retireLocalSender(id, userId, epoch, sessionId),
    store, timing, authorizeSource, continueSource, ...(securityEvents ? { securityEvents } : {}),
    runtimeAdmission: runtimeHandoffs,
    config: async (workspace, mode = "admission", proof) => {
      if (!await execution.active(workspace.id)) { if (mode === "continuation") await continueSource(workspace, proof); else await authorizeSource(workspace); }
      return workerConfig(workspace, mode, proof);
    },
    workerRoute: async id => {
      const route = await store.workerRoute(id);
      if (!route) return null;
      const handoff = await runtimeHandoffs.route(id);
      return { ...route, bootId: handoff.blocked ? null : route.bootId, ...(handoff.stopBootIds ? { stopBootIds: handoff.stopBootIds } : {}),
        token: route.portToken ? openPortToken(route.portToken, id, keys) : null };
    },
    workerActivity: async (binding, idle) => {
      const current = await store.relayActivity(binding, idle);
      if (!current) return null;
      if (!idle && current.state === "running" && current.executionMode !== "active") void continueSource(current, current).catch(() => {});
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
  const workers: CloudV2WorkerRouteDeps = { store, execution, timing, logger: console, authorizeSource, continueSource, config: workerConfig, githubToken, runtimeSha256: v2.runtime.sha256,
    apiConfiguration,
    localCommands: { requests: localCommands, signals: localCommandSignals },
    notifications,
    workspaceSync,
    runtimeUpdates, runtimeHandoffs,
    runtimeSha256ForWorkspace: async workspace => (await runtimeForWorkspace(workspace)).sha256,
    environmentReport: (token, bootId, value) => environments.report(token, bootId, value),
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
    channels: ["zeros_cloud_v2_logins", "zeros_cloud_github_access", "zeros_cloud_v2_execution", CLOUD_V2_READY_CHANNEL],
    onReady: () => { source.invalidate(); relay?.revalidateSources({}); void relay?.refreshLogins(); void executionScope({}).catch(() => {}); void executionSweep().catch(() => {}); },
    onNotification: notice => {
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
        if (/^[a-f0-9-]{36}$/.test(notice.payload ?? "")) connections?.hintReady(notice.payload!);
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
  const loginChanges = { start: () => loginListener.start(), stop: async () => {
    executionClosing = true; await loginListener.stop();
    await Promise.all([...executionHints.values()].map(value => value.flight));
  } };
  void loginChanges?.start().catch(() => {}); // The shared listener retries and re-reads onReady.
  const remoteHeads = github.remoteHead;
  const lifecycleSource = async (workspace: CloudV2LifecycleWorkspace, purpose: "git" | "computer" = "git") => {
    const actor = await lifecycleExecution(execution, workspace);
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
  const builder = roles.lifecycle ? new CloudV2ComputerBuilder({
    computers, compute, channel: config.deploymentChannel, localOwner, runtime, publicKeys: signer.publicKeys,
    cloneToken: async (organizationId, userId, target) => {
      return (await github.token({ organizationId, userId }, target, "read", "computer",
        () => authorizeSourceTargets(organizationId, userId, [target]))).token;
    },
    ...(remoteHeads ? { remoteHead: (org: string, user: string, target: CloudSourceTarget, branch: string) =>
      remoteHeads(org, user, target.repository, branch, target.repositoryId) } : {}),
    logger: console,
  }) : null;
  const lifecycle = roles.lifecycle ? new CloudV2Lifecycle({
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
    store,
    timing,
    compute,
    runtime,
    runtimeForWorkspace,
    authorizeSource: async (workspace, options) => {
      if (!await lifecycleExecution(execution, workspace)) await authorizeSource(workspace, options);
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
      if (!actor) await authorizeSource(workspace);
    },
    prompts: store.prompts, stopIdle: (id, before) => store.stopIdle(id, before),
    pruneEnvironments: () => environments.prune(),
    checkpointRetry: v2.checkpointRetry === true,
    publicKeys: signer.publicKeys, sealPortToken: (token, id) => sealPortToken(token, id, keys),
    stopWorker: workspace => connections!.stopWorkspace(workspace),
    bootEnv: async (workspace, selected) => ({ CLOUD_V2_API_URL: v2.apiUrl,
      CLOUD_V2_RUNTIME_SHA256: (selected ?? await runtimeForWorkspace(workspace)).sha256, ZEROS_WORKSPACE_ID: workspace.id }),
    sandboxName: workspace => cloudV2SandboxName(config.deploymentChannel, "ws", workspace.id, localOwner),
    // Checkpoints share the runtime's bucket, under cloud-v2/checkpoints/.
    checkpoints: {
      storage: cloudV2CheckpointStorage(runtimeStorageClient(v2.runtime.store), v2.runtime.store),
      seal: (key, id, object) => sealCheckpointKey(key, id, object, keys),
      open: (sealed, id, object) => openCheckpointKey(sealed, id, object, keys),
    },
    remoteHead: async workspace => {
      const actor = await lifecycleExecution(execution, workspace);
      const target = await github.identities.primary(workspace); await actor?.check();
      const userId = actor?.userId ?? workspace.creatorUserId;
      if (!userId) throw new HttpError(409,"workspace_creator_required","This workspace has no execution initiator");
      const head = await remoteHeads(workspace.organizationId, userId, workspace.repository, workspace.baseBranch, target.repositoryId);
      await actor?.check(); return head;
    },
    githubToken: async workspace => (await lifecycleSource(workspace,"computer"))?.credential ?? github.workspaceToken(workspace),
    logger: console,
  }) : null;
  // Lifecycle rows notify on change. Reconnecting sweeps once, covering any
  // notice lost meanwhile; the shared LISTEN session carries the channel.
  const lifecycleChanges = lifecycle ? postgresNotificationSubscription(listenerPool, {
    channels: [CLOUD_V2_LIFECYCLE_CHANNEL],
    onReady: () => lifecycle.wake(),
    onNotification: () => lifecycle.wake(),
  }) : null;
  void lifecycleChanges?.start().catch(() => {});
  return { store, execution, compute, routes, proxy, workers, api, relay, connections, lifecycle, runtimeUpdates, loginChanges, promptChanges, lifecycleChanges, promptSignals, localCommandSignals, teamSharing,
    startLocalCommands: () => {
      if (!roles.lifecycle) return async () => {};
      const local = startLocalCommandMaintenance(localCommands,localCommandSignals,console,notifications);
      const acting = execution.maintenance.start(async (id, frames) => { await connections?.revokeContexts(id, frames); });
      return async () => { await Promise.all([local(), acting()]); };
    } };
}
