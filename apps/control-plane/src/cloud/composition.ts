// Assembles cloud workspace v2 from configuration: one store, Boat, the relay
// (realtime role), the lifecycle loop (worker role), the HTTP routes and the
// model proxy (API role). index.ts only starts and stops what this returns.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Config } from "../config.js";
import { HttpError } from "../authz.js";
import { BoatApiClient } from "../cloud/boat-client.js";
import { cloudAgentCredentialKeys } from "../agent-credentials/agent-credentials.js";
import type { CloudAgentCredentialMaterial } from "../agent-credentials/agent-credential-envelope.js";
import { createCloudV2AgentLogins, createCloudV2CodexRefresh, type CloudV2AgentLogins } from "./agent-logins.js";
import { BoatCloudV2Compute } from "./boat.js";
import type { CloudV2ControlFrame } from "./contract.js";
import { CloudV2ComputerBuilder, CloudV2Computers } from "./computer.js";
import { createCloudV2GithubTokens, createCloudV2RepositoryTokens } from "./github.js";
import { CloudV2Lifecycle } from "./lifecycle.js";
import { CLOUD_V2_PROXY_PREFIX, type CloudV2ProxyDeps } from "./proxy.js";
import { CloudV2Relay } from "./relay.js";
import { cloudV2Runtime } from "./runtime.js";
import type { CloudV2RouteDeps } from "./routes.js";
import { CloudV2Store, type CloudV2Workspace } from "./store.js";

const PROXY_TOKEN_TTL_MS = 24 * 60 * 60_000;
/** Boat stock image home; repositories live at <home>/<owner>/<name>. */
export const CLOUD_V2_HOME = "/home/user";

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
export async function answerCloudV2Offline(store: Pick<CloudV2Store, "listChats" | "windowMessages">,
  workspace: CloudV2Workspace, frame: unknown): Promise<unknown | null> {
  const request = frame as { type?: unknown; id?: unknown; op?: unknown; params?: Record<string, unknown> } | null;
  if (request?.type !== "WORKSPACE_REQUEST" || typeof request.id !== "string" || typeof request.op !== "string") return null;
  let result: unknown;
  if (request.op === "chats.list") result = await store.listChats(workspace.id);
  else if (request.op === "messages.window") {
    const chatId = request.params?.chatId;
    if (typeof chatId !== "string") return null;
    const limit = typeof request.params?.limit === "number" ? request.params.limit : 200;
    result = { messages: await store.windowMessages(workspace.id, chatId, limit) };
  } else return null;
  return { type: "WORKSPACE_RESPONSE", id: randomUUID(), source: "engine", timestamp: Date.now(), requestId: request.id, op: request.op, result };
}

export function createCloudV2(config: Config, pool: pg.Pool, roles: { relay: boolean; lifecycle: boolean }) {
  const v2 = config.cloudV2;
  if (!v2) return null;
  const store = new CloudV2Store(pool);
  const compute = new BoatCloudV2Compute(new BoatApiClient({
    apiKey: v2.boat.apiKey, timeoutMs: 120_000, ...(v2.boat.billingOrg ? { billingOrg: v2.boat.billingOrg } : {}),
  }));
  const keys = cloudAgentCredentialKeys(config.cloudAgentCredentials ?? null);
  const logins: CloudV2AgentLogins = keys ? createCloudV2AgentLogins(pool, keys) : async () => null;
  const githubToken = config.github ? createCloudV2GithubTokens(pool, config.github) : async () => {
    throw new HttpError(409, "github_unavailable", "GitHub is not configured");
  };
  const proxyBase = `${v2.apiUrl}${CLOUD_V2_PROXY_PREFIX}`;
  const computers = new CloudV2Computers(pool);
  const repositoryToken = config.github ? createCloudV2RepositoryTokens(pool, config.github) : null;

  const workerConfig = async (workspace: CloudV2Workspace): Promise<ConfigFrame> => {
    const proxy = async () => {
      const issued = await store.issueToken({ workspaceId: workspace.id, kind: "proxy", userId: null, ttlMs: PROXY_TOKEN_TTL_MS });
      return { token: issued.token, expiresAt: issued.expiresAt.getTime() };
    };
    const [codex, claude, cursor] = await Promise.all([
      logins(workspace.creatorUserId, workspace.organizationId, "codex"),
      logins(workspace.creatorUserId, workspace.organizationId, "claude"),
      logins(workspace.creatorUserId, workspace.organizationId, "cursor"),
    ]);
    const agents = await cloudV2AgentConfig({ codex, claude, cursor }, proxyBase, proxy);
    return {
      t: "config",
      workspace: {
        id: workspace.id, organizationId: workspace.organizationId, repository: workspace.repository,
        checkoutPath: `${CLOUD_V2_HOME}/${workspace.repository}`, branch: workspace.branch, baseBranch: workspace.baseBranch,
      },
      agents,
    };
  };

  const routes: CloudV2RouteDeps = {
    store,
    computers,
    installedRepositories: organizationId => store.installedRepositories(organizationId),
    bridgeBaseUrl: v2.realtimeUrl,
  };
  const proxy: CloudV2ProxyDeps = { store, logins, ...(keys ? { refreshCodex: createCloudV2CodexRefresh(pool, keys) } : {}) };
  const relay = roles.relay ? new CloudV2Relay({
    store,
    config: workerConfig,
    githubToken,
    wake: async workspace => { await store.transition(workspace.id, ["stopped"], "starting"); },
    answerOffline: (workspace, frame) => answerCloudV2Offline(store, workspace, frame),
    logger: console,
  }) : null;
  const runtime = cloudV2Runtime(v2.runtime.sha256, v2.runtime.store);
  const builder = roles.lifecycle && repositoryToken ? new CloudV2ComputerBuilder({
    computers, compute, channel: config.deploymentChannel, runtime,
    cloneToken: async (organizationId, userId, repository) => (await repositoryToken(organizationId, userId, repository)).token,
    logger: console,
  }) : null;
  const lifecycle = roles.lifecycle ? new CloudV2Lifecycle({
    ...(builder ? { builds: builder } : {}),
    store,
    compute,
    runtime,
    bootEnv: workspace => ({ ZEROS_WORKER_URL: `${v2.realtimeUrl}/v2/cloud/worker`, ZEROS_WORKSPACE_ID: workspace.id }),
    sandboxName: workspace => `zeros-${config.deploymentChannel}-ws-${workspace.id.slice(0, 8)}`,
    logger: console,
  }) : null;
  return { store, compute, routes, proxy, relay, lifecycle };
}
