import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Hono, type ErrorHandler } from "hono";
import type pg from "pg";
import { vi } from "vitest";
import type { AuthedUser } from "../../auth.js";
import { createApp } from "../../app.js";
import type { Config } from "../../config.js";
import { workosTestAuth } from "../../test-workos-env.js";
import { DatabaseCloudAgentCredentialService } from "../../agent-credentials/agent-credentials.js";
import { cloudAgentModels } from "../../agent-credentials/agent-models.js";
import { createCloudV2 } from "../composition.js";
import { createCloudV2Routes } from "../routes.js";
import { createCloudV2WorkerRoutes } from "../worker-routes.js";
import { createCloudApiRoutes } from "../api/routes.js";
import { CloudV2PromptPullReplySchema } from "../prompt-contract.js";
import { CloudV2BeginActiveReplySchema } from "../contract.js";
import { teamSharingFixture } from "../team-sharing/test-fixture.js";
import { executionIntentAuthority } from "./authority.js";

export async function executionFixture(pool: pg.Pool, options: { lifecycle?: boolean; relay?: boolean } = {}) {
  const seed = await teamSharingFixture(pool);
  const keys = { currentKeyVersion: 1, keys: { 1: Buffer.alloc(32, 27).toString("base64url") } };
  vi.stubGlobal("fetch", seed.fetcher);
  const config = {
    github: null, deploymentChannel: "alpha", inviteLinkBase: "https://app.example.test/invite",
    cloudAgentCredentials: { settingsSecretKeyV1: keys.keys[1] },
    cloudV2: { boat: { apiKey: "synthetic-boat-credential" }, apiUrl: "https://api.example.test", realtimeUrl: "https://rt.example.test", promptOutbox: true,
      workerSigningKey: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      runtime: { sha256: "b".repeat(64), store: { endpoint: "https://store.example.test", bucket: "fixture", accessKeyId: "fixture", secretAccessKey: "fixture" } } },
  } as Config;
  const cp = createCloudV2(config, pool, { relay: options.relay ?? false, lifecycle: options.lifecycle ?? false })!;
  const app = new Hono();
  const assembled = createApp({ ...config, auth: workosTestAuth(), workos: null }, pool, { from: null, apiKey: null } as never);
  app.onError((assembled as unknown as { errorHandler: ErrorHandler }).errorHandler);
  app.route("/", createCloudV2WorkerRoutes(cp.workers));
  app.route("/api/v0", createCloudApiRoutes(cp.api));
  app.use("*", async (c, next) => { c.set("user", seed.actors.get(c.req.header("x-test-actor") ?? "") ?? seed.creator); await next(); });
  app.route("/", createCloudV2Routes(cp.routes));
  const call = (path: string, method = "GET", body?: unknown, user: AuthedUser = seed.creator, headers: Record<string, string> = {}) => app.request(path, {
    method, headers: { "x-test-actor": user.id, ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const features = "prompt-outbox-v1,workspace-environment-v1,repository-setup-v1,mcp-v1,github-pr-v1,git-identity-v1,workspace-api-v1,local-commands-v1,notify-user-v1,acting-user-v1";
  await pool.query("UPDATE cloud_v2_workspaces SET state='starting',boat_sandbox_id='bx_fixture1234' WHERE id=$1", [seed.workspace.id]);
  const token = await cp.store.rotateWorkerToken(seed.workspace.id), boot = randomUUID();
  const worker = (path: string, body?: unknown, options: { features?: string; token?: string; boot?: string; method?: string } = {}) => app.request(`/v2/cloud/worker/${path}`, {
    method: options.method ?? "POST", headers: { authorization: `Bearer ${options.token ?? token}`, "x-zeros-worker-boot": options.boot ?? boot,
      "x-zeros-worker-features": options.features ?? features, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const retirementId = randomUUID();
  const hello = async (capabilities = features) => {
    const response = await worker("hello", { protocol: 2, bootId: boot, runtimeSha256: "b".repeat(64) }, { features: capabilities });
    const result = response.ok ? await response.clone().json() as { config: { actingUser?: 1 } } : null;
    if (result?.config.actingUser) {
      const clean = await worker("execution-leases/boot-clean", { retirementId, processes: 0 });
      if (!clean.ok) throw new Error(`boot cleanup: ${clean.status}`);
    }
    return response;
  };
  const vault = new DatabaseCloudAgentCredentialService(pool, keys);
  const login = async (user = seed.creator, provider: "claude" | "codex" | "cursor" = "claude") => {
    await pool.query("UPDATE user_identities SET email_verified_at=clock_timestamp() WHERE user_id=$1", [user.id]);
    const id = randomUUID(), secret = `synthetic-${provider}-${user.id}`;
    await vault.put({ ownerUserId: user.id, organizationId: seed.organizationId, credentialId: id, operationId: randomUUID(), expectedRevision: 0,
      displayName: "Fixture", material: { kind: `${provider}-api-key`, apiKey: secret } });
    await vault.setOrganizationConnection(user.id, seed.organizationId, provider, { expectedRevision: 0, credentialId: id, credentialRevision: 1,
      models: [cloudAgentModels(provider)[0]], consent: "zeros-managed" });
    return { id, secret };
  };
  const activate = async (user = seed.creator) => {
    await pool.query("UPDATE cloud_v2_workspaces SET execution_mode='active',execution_initiator_user_id=$2,execution_intent_id=$3 WHERE id=$1",
      [seed.workspace.id, user.id, randomUUID()]);
    const proof = await cp.execution.deps.authority.admit(seed.workspace.id, user.id);
    await pool.query("UPDATE cloud_v2_workspaces SET execution_intent_authority=$2 WHERE id=$1", [seed.workspace.id, executionIntentAuthority(proof)]);
  };
  const prompt = (userMessageId = randomUUID(), extra: Record<string, unknown> = {}) => ({ chatId: "chat", userMessageId,
    agentId: "claude", startedAt: 123, prompt: [{ type: "text", text: "A context-bound turn" }], ...extra });
  const send = (input = prompt(), user = seed.creator) => call(`/v1/cloud-v2/workspaces/${seed.workspace.id}/prompts`, "POST", input, user, { "X-Zeros-Team-Sharing": "1" });
  const dispatch = async (input = prompt(), user = seed.creator) => {
    const sent = await send(input, user);
    if (![200, 201].includes(sent.status)) throw new Error(`prompt admission: ${sent.status} ${await sent.text()}`);
    const pulled = await worker("prompts/pull", { waitMs: 0, held: [] });
    const delivery = CloudV2PromptPullReplySchema.parse(await pulled.json()).prompts.find(value => value.payload.userMessageId === input.userMessageId);
    if (!delivery) throw new Error("prompt was not offered");
    const acknowledged = await worker("prompts/ack", { userMessageId: input.userMessageId, deliveryId: delivery.deliveryId });
    if (acknowledged.status !== 200) throw new Error(`prompt inbox: ${acknowledged.status}`);
    const begin = { userMessageId: input.userMessageId, deliveryId: delivery.deliveryId, dispatchId: randomUUID() };
    const response = await worker("prompts/begin", begin);
    if (response.status !== 200) throw new Error(`prompt begin: ${response.status} ${await response.text()}`);
    const begun = CloudV2BeginActiveReplySchema.parse(await response.json());
    return { input, begin, begun, lease: { chatId: input.chatId, userMessageId: input.userMessageId, dispatchId: begin.dispatchId,
      generation: begun.actingUser.generation as string, contextId: begun.contextId as string } };
  };
  const close = async () => {
    cp.connections?.close();
    await cp.lifecycleChanges?.stop();
    cp.runtimeUpdates.close(); await cp.api.credentials.close(); await cp.loginChanges.stop();
    await cp.promptChanges?.stop(); await cp.localCommandSignals.close();
  };
  return { ...seed, cp, app, call, token, boot, features, worker, hello, login, vault, keys, activate, prompt, send, dispatch, close };
}
export type ExecutionFixture = Awaited<ReturnType<typeof executionFixture>>;
