// Assembles cloud workspace v2 from configuration: one store, Boat, the relay
// (realtime role), the lifecycle loop (worker role), the HTTP routes and the
// model proxy (API role). index.ts only starts and stops what this returns.
import { postgresNotificationSubscription } from "../postgres-notifications.js";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { PostgresSecurityEventBroker } from "../security-events.js";
import type { Config } from "../config.js";
import { HttpError } from "../authz.js";
import { BoatApiClient } from "../cloud/boat-client.js";
import { cloudAgentCredentialKeys } from "../agent-credentials/agent-credentials.js";
import type { CloudAgentCredentialMaterial } from "../agent-credentials/agent-credential-envelope.js";
import { createCloudV2AgentLogins, createCloudV2CodexRefresh, type CloudV2AgentLogins } from "./agent-logins.js";
import { BoatCloudV2Compute } from "./boat.js";
import type { CloudV2ControlFrame } from "./contract.js";
import { CloudV2ComputerBuilder, CloudV2Computers } from "./computer.js";
import { createCloudGithubServices } from "./github-composition.js";
import { hydrateCloudRepository, type CloudSourceTarget } from "./source-authority.js";
import { HISTORY_OPS, readCloudV2History } from "./history.js";
import { CLOUD_V2_HOME, CloudV2Lifecycle, type CloudV2TimingRecord } from "./lifecycle.js";
import { cloudV2CheckpointStorage, openCheckpointKey, sealCheckpointKey } from "./checkpoint.js";
import { runtimeStorageClient } from "./runtime-source.js";
import { CLOUD_V2_PROXY_PREFIX, type CloudV2ProxyDeps } from "./proxy.js";
import { CloudV2Relay } from "./relay.js";
import { cloudV2Runtime } from "./runtime.js";
import type { CloudV2RouteDeps } from "./routes.js";
import { CloudV2Store, type CloudV2Workspace } from "./store.js";
import { CloudV2WorkerSigner } from "./worker-auth.js";
import { openPortToken, sealPortToken } from "./worker-port-token.js";
import type { CloudV2WorkerRouteDeps } from "./worker-routes.js";
import { cloudV2SandboxName } from "./resource-names.js";
import { CloudV2PromptSignals } from "./prompt-signals.js";
import { createMcpServices } from "../mcp/composition.js";

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
export async function answerCloudV2Offline(store: Pick<CloudV2Store, "listChats" | "messageWindow">,
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
  const compute = new BoatCloudV2Compute(new BoatApiClient({
    apiKey: v2.boat.apiKey, timeoutMs: 120_000, ...(v2.boat.billingOrg ? { billingOrg: v2.boat.billingOrg } : {}),
  }));
  const keys = cloudAgentCredentialKeys(config.cloudAgentCredentials ?? null);
  if (!keys) throw new Error("Cloud v2 requires the credential encryption keyring");
  const signer = new CloudV2WorkerSigner(v2.workerSigningKey, v2.workerSigningKeyPrevious);
  const logins: CloudV2AgentLogins = keys ? createCloudV2AgentLogins(pool, keys) : async () => null;
  const github = createCloudGithubServices(pool, config.github, keys, store);
  const githubToken = (workspace: CloudV2Workspace, purpose: "git" | "gh" = "git") => github.workspaceToken(workspace, "user", purpose);
  const proxyBase = `${v2.apiUrl}${CLOUD_V2_PROXY_PREFIX}`;
  const computers = new CloudV2Computers(pool, lockPool, github.resolveRepository);
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
  const authorizeBuildRepository = async (org: string, user: string, buildId: string, repository: string) => {
    const target = await computers.resolveBuildRepository(org, user, buildId, repository);
    await authorizeSourceTargets(org, user, [target]);
    return target;
  };
  const authorizeSource = github.authorizeSource;
  const mcp = createMcpServices(pool, config, github.connections.authorizeRepositoryConfiguration.bind(github.connections));
  const timing = (record: CloudV2TimingRecord) => console.log(`[cloud-v2] timing ${JSON.stringify(record)}`);

  const workerConfig = async (workspace: CloudV2Workspace): Promise<ConfigFrame> => {
    await authorizeSource(workspace);
    const proxy = async () => {
      const issued = await store.issueToken({ workspaceId: workspace.id, kind: "proxy", userId: null, ttlMs: PROXY_TOKEN_TTL_MS });
      return { token: issued.token, expiresAt: issued.expiresAt.getTime() };
    };
    const [codex, claude, cursor, setup, baseCommit, repositoryBinding] = await Promise.all([
      logins(workspace.creatorUserId, workspace.organizationId, "codex"),
      logins(workspace.creatorUserId, workspace.organizationId, "claude"),
      logins(workspace.creatorUserId, workspace.organizationId, "cursor"),
      github.workspaceSetup(workspace, computers),
      store.baseCommit(workspace.id),
      github.binding(workspace),
    ]);
    const agents = await cloudV2AgentConfig({ codex, claude, cursor }, proxyBase, proxy);
    return {
      t: "config",
      githubPullRequests: 1,
      ...(v2.promptOutbox ? { promptOutbox: 1 as const } : {}),
      loginRevision: await store.loginRevision(workspace.id) ?? "0",
      workspace: {
        id: workspace.id, organizationId: workspace.organizationId, repository: workspace.repository,
        checkoutPath: `${CLOUD_V2_HOME}/${workspace.repository}`, branch: workspace.branch, baseBranch: workspace.baseBranch,
        github: repositoryBinding,
        ...(setup !== null ? { setup } : {}),
        ...(baseCommit ? { baseCommit } : {}),
      },
      agents,
      ...(mcp ? { mcpServers: await mcp.store.resolve(workspace.organizationId, workspace.creatorUserId, workspace.repository, repositoryBinding) } : {}),
    };
  };

  const routes: CloudV2RouteDeps = {
    store,
    computers,
    installedRepositories: organizationId => store.installedRepositories(organizationId),
    authorizeRepository, authorizeRepositories, authorizeSourceTargets, authorizeBuildRepository, authorizeSource,
    github: { service: github.service, documents: github.documents },
    githubConnections: github.connections,
    bridgeBaseUrl: v2.realtimeUrl,
    promptOutbox: v2.promptOutbox === true,
  };
  const proxy: CloudV2ProxyDeps = { store, logins, authorizeSource, ...(keys ? { refreshCodex: createCloudV2CodexRefresh(pool, keys) } : {}) };
  const connections = roles.relay || roles.lifecycle ? new CloudV2Relay({
    store, timing, authorizeSource, ...(securityEvents ? { securityEvents } : {}),
    config: workerConfig,
    workerRoute: async id => {
      const route = await store.workerRoute(id);
      return route ? { ...route, token: route.portToken ? openPortToken(route.portToken, id, keys) : null } : null;
    },
    mintWorkerToken: (id, boot) => signer.mint(id, boot),
    wake: async workspace => { await store.transition(workspace.id, ["stopped"], "starting"); },
    answerOffline: (workspace, frame) => answerCloudV2Offline(store, workspace, frame),
    logger: console,
  }) : null;
  const relay = roles.relay ? connections : null;
  const promptSignals = new CloudV2PromptSignals();
  const workers: CloudV2WorkerRouteDeps = { store, timing, authorizeSource, config: workerConfig, githubToken, runtimeSha256: v2.runtime.sha256,
    githubCheckout: (token,bootId,value) => github.metadata.checkout(token,bootId,value),
    ...(mcp ? { mcpAuthorization: async (workspace, id, force) =>
      mcp.oauth.authorizationForRepository(workspace.organizationId, workspace.creatorUserId, workspace.repository, id, force,
        await github.identities.primary(workspace)) } : {}),
    promptOutbox: v2.promptOutbox === true, waitForPrompts: (id, ms, signal) => promptSignals.wait(id, ms, signal) };
  const promptChanges = v2.promptOutbox ? postgresNotificationSubscription(listenerPool, {
    channels: ["zeros_cloud_v2_prompts"],
    onReady: () => promptSignals.wakeAll(),
    onNotification: notice => {
      if (!/^[a-f0-9-]{36}$/.test(notice.payload ?? "")) return;
      promptSignals.wake(notice.payload!); connections?.hintPrompts(notice.payload!);
    },
  }) : null;
  void promptChanges?.start().catch(() => {});
  const loginChanges = relay ? postgresNotificationSubscription(listenerPool, {
    channels: ["zeros_cloud_v2_logins"],
    onReady: () => { void relay.refreshLogins(); },
    onNotification: notice => {
      try {
        const scope = JSON.parse(notice.payload ?? "");
        if ((typeof scope?.ownerUserId === "string" || scope?.ownerUserId === null) && (scope.organizationId === null || typeof scope.organizationId === "string"))
          void relay.refreshLogins({ ...(typeof scope.ownerUserId === "string" ? { ownerUserId: scope.ownerUserId } : {}), ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) });
      } catch { /* Invalid wake hints carry no authority. */ }
    },
  }) : null;
  void loginChanges?.start().catch(() => {}); // The shared listener retries and re-reads onReady.
  const runtime = cloudV2Runtime(v2.runtime.sha256, v2.runtime.store);
  const remoteHeads = github.remoteHead;
  const builder = roles.lifecycle ? new CloudV2ComputerBuilder({
    computers, compute, channel: config.deploymentChannel, localOwner, runtime,
    cloneToken: async (organizationId, userId, target) => {
      return (await github.token({ organizationId, userId }, target, "read", "git",
        () => authorizeSourceTargets(organizationId, userId, [target]))).token;
    },
    ...(remoteHeads ? { remoteHead: (org: string, user: string, target: CloudSourceTarget, branch: string) =>
      remoteHeads(org, user, target.repository, branch, target.repositoryId) } : {}),
    logger: console,
  }) : null;
  const lifecycle = roles.lifecycle ? new CloudV2Lifecycle({
    ...(builder ? { builds: builder } : {}),
    store,
    timing,
    compute,
    runtime,
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
    publicKeys: signer.publicKeys, sealPortToken: (token, id) => sealPortToken(token, id, keys),
    stopWorker: workspace => connections!.stopWorkspace(workspace),
    bootEnv: workspace => ({ CLOUD_V2_API_URL: v2.apiUrl, CLOUD_V2_RUNTIME_SHA256: v2.runtime.sha256, ZEROS_WORKSPACE_ID: workspace.id }),
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
  return { store, compute, routes, proxy, workers, relay, connections, lifecycle, loginChanges, promptChanges, promptSignals };
}
