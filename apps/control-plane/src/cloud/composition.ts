// Assembles cloud workspace v2 from configuration: one store, Boat, the relay
// (realtime role), the lifecycle loop (worker role), the HTTP routes and the
// model proxy (API role). index.ts only starts and stops what this returns.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Config } from "../config.js";
import { HttpError } from "../authz.js";
import { BoatApiClient } from "../cloud-workspaces/boat-client.js";
import { cloudAgentCredentialKeys } from "../cloud-workspaces/agent-credentials.js";
import { createCloudV2AgentLogins, type CloudV2AgentLogins } from "./agent-logins.js";
import { BoatCloudV2Compute } from "./boat.js";
import type { CloudV2ControlFrame } from "./contract.js";
import { createCloudV2GithubTokens } from "./github.js";
import { CloudV2Lifecycle } from "./lifecycle.js";
import { CLOUD_V2_PROXY_PREFIX, type CloudV2ProxyDeps } from "./proxy.js";
import { CloudV2Relay } from "./relay.js";
import type { CloudV2RouteDeps } from "./routes.js";
import { CloudV2Store, type CloudV2Workspace } from "./store.js";

const PROXY_TOKEN_TTL_MS = 24 * 60 * 60_000;
export const CLOUD_V2_HOME = "/home/zeros";

type ConfigFrame = Extract<CloudV2ControlFrame, { t: "config" }>;

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
  const keys = cloudAgentCredentialKeys(config.cloudAgentCredentials ?? config.cloudWorkspaces);
  const logins: CloudV2AgentLogins = keys ? createCloudV2AgentLogins(pool, keys) : async () => null;
  const githubToken = config.github ? createCloudV2GithubTokens(pool, config.github) : async () => {
    throw new HttpError(409, "github_unavailable", "GitHub is not configured");
  };
  const proxyBase = `${v2.apiUrl}${CLOUD_V2_PROXY_PREFIX}`;

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
    const agents: ConfigFrame["agents"] = {};
    if (codex) agents.codex = { baseUrl: `${proxyBase}/openai`, ...(await proxy()) };
    if (claude) agents.claude = { baseUrl: `${proxyBase}/anthropic`, ...(await proxy()) };
    if (cursor?.kind === "cursor-api-key") agents.cursor = { apiKey: cursor.apiKey };
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
    installedRepositories: organizationId => store.installedRepositories(organizationId),
    bridgeBaseUrl: v2.realtimeUrl,
  };
  const proxy: CloudV2ProxyDeps = { store, logins };
  const relay = roles.relay ? new CloudV2Relay({
    store,
    config: workerConfig,
    githubToken,
    wake: async workspace => { await store.transition(workspace.id, ["stopped"], "starting"); },
    answerOffline: (workspace, frame) => answerCloudV2Offline(store, workspace, frame),
    logger: console,
  }) : null;
  const lifecycle = roles.lifecycle ? new CloudV2Lifecycle({
    store,
    compute,
    bootEnv: workspace => ({ ZEROS_WORKER_URL: `${v2.realtimeUrl}/v2/cloud/worker`, ZEROS_WORKSPACE_ID: workspace.id }),
    sandboxName: workspace => `zeros-${config.deploymentChannel}-ws-${workspace.id.slice(0, 8)}`,
    logger: console,
  }) : null;
  return { store, compute, routes, proxy, relay, lifecycle };
}
