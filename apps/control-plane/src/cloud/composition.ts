// Assembles cloud workspace v2 from configuration: one store, Boat, the relay
// (realtime role), the lifecycle loop (worker role), the HTTP routes and the
// model proxy (API role). index.ts only starts and stops what this returns.
import { postgresNotificationSubscription } from "../postgres-notifications.js";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withSystemTx } from "../db.js";
import type { PostgresSecurityEventBroker } from "../security-events.js";
import type { Config } from "../config.js";
import { HttpError } from "../authz.js";
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
import { CLOUD_V2_PROXY_PREFIX, type CloudV2ProxyDeps } from "./proxy.js";
import { CloudV2Relay } from "./relay.js";
import { cloudV2Runtime } from "./runtime.js";
import type { CloudV2RouteDeps } from "./routes.js";
import { CloudV2Store, type CloudV2WorkerSession, type CloudV2Workspace } from "./store.js";
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

export function createCloudV2(config: Config, pool: pg.Pool, roles: { relay: boolean; lifecycle: boolean }, securityEvents?: PostgresSecurityEventBroker, listenerPool: pg.Pool = pool, lockPool: pg.Pool = pool) {
  const v2 = config.cloudV2;
  if (!v2) return null;
  const localOwner = config.development && !("generation" in config.development) ? config.development.owner : undefined;
  const store = new CloudV2Store(pool);
  const runtime = cloudV2Runtime(v2.runtime.sha256, v2.runtime.store);
  const runtimeCanary = config.deploymentChannel === "alpha" && v2.runtimeCanary ? new RuntimeCanaryAuthority(v2.runtimeCanary) : undefined;
  const runtimeForWorkspace = workspaceRuntimeResolver(pool, runtime, runtimeCanary?.policy);
  const compute = new BoatCloudV2Compute(new BoatApiClient({
    apiKey: v2.boat.apiKey, timeoutMs: 120_000, ...(v2.boat.billingOrg ? { billingOrg: v2.boat.billingOrg } : {}),
  }));
  const keys = cloudAgentCredentialKeys(config.cloudAgentCredentials ?? null);
  if (!keys) throw new Error("Cloud v2 requires the credential encryption keyring");
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
  const authorizeSourceTargets = async (org: string, user: string, targets: readonly CloudSourceTarget[]) => {
    await source.targets(org, user, targets);
  };
  const authorizeBuildRepository = async (org: string, user: string, buildId: string, repository: string, options?: { fresh?: boolean }) => {
    const target = await computers.resolveBuildRepository(org, user, buildId, repository, options);
    await authorizeSourceTargets(org, user, [target]);
    return target;
  };
  const authorizeSource = github.authorizeSource;
  const runtimeHandoffs = new RuntimeHandoffStore(pool);
  const runtimeUpdates = new RuntimeAdoption({ handoffs: runtimeHandoffs, store, compute, runtimeForWorkspace, authorizeSource,
    drainActive: () => buildDrainActive(pool), logger: console });
  const continueSource = github.continueSource;
  const mcp = createMcpServices(pool, config, github.connections.authorizeRepositoryConfiguration.bind(github.connections));
  const timing = (record: CloudV2TimingRecord) => console.log(`[cloud-v2] timing ${JSON.stringify(record)}`);

  const workerConfig = async (workspace: CloudV2Workspace & Partial<Pick<CloudV2WorkerSession, "loginRevision">>, mode: "admission" | "continuation" = "admission",
    proof?: CloudSourceProof): Promise<ConfigFrame> => {
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
      ...(v2.promptOutbox ? { promptOutbox: 1 as const } : {}),
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

  const routes: CloudV2RouteDeps = {
    store,
    computers,
    installedRepositories: organizationId => store.installedRepositories(organizationId),
    authorizeRepository, authorizeRepositories, authorizeSourceTargets, authorizeBuildRepository, authorizeSource, continueSource,
    remoteHead: (org, user, target, branch) => github.remoteHead(org, user, target.repository, branch, target.repositoryId),
    github: { service: github.service, documents: github.documents },
    githubConnections: github.connections,
    environments,
    ...(runtimeCanary ? { runtimeCanary, runtimeCanaryStatus: (userId: string, grantId: string) => readRuntimeCanary(pool, runtimeCanary.policy, userId, grantId) } : {}),
    bridgeBaseUrl: v2.realtimeUrl,
    promptOutbox: v2.promptOutbox === true,
  };
  const proxy: CloudV2ProxyDeps = { store, logins, authorizeSource, continueSource, ...(keys ? { refreshCodex: createCloudV2CodexRefresh(pool, keys) } : {}) };
  const connections = roles.relay || roles.lifecycle ? new CloudV2Relay({
    store, timing, authorizeSource, continueSource, ...(securityEvents ? { securityEvents } : {}),
    runtimeAdmission: runtimeHandoffs,
    config: async (workspace, mode = "admission", proof) => {
      if (mode === "continuation") await continueSource(workspace, proof); else await authorizeSource(workspace);
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
      if (!idle && current.state === "running") void continueSource(current, current).catch(() => {});
      return { state: current.state, loginRevision: current.loginRevision, prompts: current.promptsPending };
    },
    mintWorkerToken: (id, boot) => signer.mint(id, boot),
    wake: async workspace => { await store.transition(workspace.id, ["stopped"], "starting"); },
    answerOffline: (workspace, frame) => answerCloudV2Offline(store, workspace, frame),
    logger: console,
  }) : null;
  const relay = roles.relay ? connections : null;
  const promptSignals = new CloudV2PromptSignals();
  const workers: CloudV2WorkerRouteDeps = { store, timing, logger: console, authorizeSource, continueSource, config: workerConfig, githubToken, runtimeSha256: v2.runtime.sha256,
    runtimeUpdates, runtimeHandoffs,
    runtimeSha256ForWorkspace: async workspace => (await runtimeForWorkspace(workspace)).sha256,
    environmentReport: (token, bootId, value) => environments.report(token, bootId, value),
    githubCheckout: (token,bootId,value) => github.metadata.checkout(token,bootId,value),
    ...(mcp ? { mcpAuthorization: async (workspace, id, force) =>
      mcp.oauth.authorizationForRepository(workspace.organizationId, workspace.creatorUserId, workspace.repository, id, force,
        await github.identities.primary(workspace)) } : {}),
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
  const loginChanges = postgresNotificationSubscription(listenerPool, {
    // The existing shared LISTEN connection carries these hints. No connection
    // or polling loop is added for permission-cache invalidation or readiness.
    channels: ["zeros_cloud_v2_logins", "zeros_cloud_github_access", CLOUD_V2_READY_CHANNEL],
    onReady: () => { source.invalidate(); relay?.revalidateSources({}); void relay?.refreshLogins(); },
    onNotification: notice => {
      if (notice.channel === CLOUD_V2_READY_CHANNEL) {
        if (/^[a-f0-9-]{36}$/.test(notice.payload ?? "")) connections?.hintReady(notice.payload!);
        return;
      }
      try {
        const scope = JSON.parse(notice.payload ?? "");
        if ((typeof scope?.ownerUserId === "string" || scope?.ownerUserId === null) && (scope.organizationId === null || typeof scope.organizationId === "string")) {
          const identity = { ...(typeof scope.ownerUserId === "string" ? { ownerUserId: scope.ownerUserId } : {}), ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) };
          source.invalidate({ ...(identity.ownerUserId ? { userId: identity.ownerUserId } : {}), ...(identity.organizationId ? { organizationId: identity.organizationId } : {}) });
          relay?.revalidateSources(identity);
          if (notice.channel === "zeros_cloud_v2_logins") void relay?.refreshLogins(identity);
        }
      } catch { /* Invalid wake hints carry no authority. */ }
    },
  });
  void loginChanges?.start().catch(() => {}); // The shared listener retries and re-reads onReady.
  const remoteHeads = github.remoteHead;
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
    runtimeUpdates,
    ...(builder ? { builds: builder } : {}),
    store,
    timing,
    compute,
    runtime,
    runtimeForWorkspace,
    authorizeSource,
    prepareRepository: async (workspace, sandboxId) => {
      const credential = await github.workspaceToken(workspace);
      const repositoryBinding = await github.binding(workspace);
      const input = `Authorization: Basic ${Buffer.from(`x-access-token:${credential.token}`).toString("base64")}\n`;
      const result = await compute.execLong(sandboxId, hydrateCloudRepository(workspace, repositoryBinding.repository), 900, input);
      if (result.exitCode !== 0) throw new HttpError(409, "cloud_source_checkout_failed", "The repository checkout could not be prepared. Existing files were retained.");
      await authorizeSource(workspace);
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
    remoteHead: async (workspace: CloudV2Workspace) => remoteHeads(workspace.organizationId, workspace.creatorUserId, workspace.repository,
      workspace.baseBranch,(await github.identities.primary(workspace)).repositoryId),
    githubToken: (workspace: CloudV2Workspace) => github.workspaceToken(workspace),
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
  return { store, compute, routes, proxy, workers, relay, connections, lifecycle, runtimeUpdates, loginChanges, promptChanges, lifecycleChanges, promptSignals };
}
