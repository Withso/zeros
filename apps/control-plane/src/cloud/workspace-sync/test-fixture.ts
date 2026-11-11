import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Hono } from "hono";
import type pg from "pg";
import { expect, vi } from "vitest";
import type { Config } from "../../config.js";
import { HttpError } from "../../authz.js";
import { createCloudV2 } from "../composition.js";
import { createCloudV2Routes } from "../routes.js";
import { createCloudV2WorkerRoutes } from "../worker-routes.js";
import { sealPortToken } from "../worker-port-token.js";
import { localCommandsFixture } from "../local-commands/test-fixture.js";

export async function syncFixture(pool: pg.Pool) {
  const f = await localCommandsFixture(pool), signing = generateKeyPairSync("ed25519");
  const keys = { currentKeyVersion: 1, keys: { 1: Buffer.alloc(32, 7).toString("base64url") } };
  const fetcher = vi.fn<typeof fetch>(async value => {
    const url = new URL(String(value));
    if (url.hostname !== "api.github.com") throw new Error("Unexpected provider");
    if (url.pathname === "/user") return Response.json({ id: 12, login: "fixture", name: "Fixture", email: "fixture@example.test" });
    if (url.pathname === "/user/emails") return Response.json([{ email: "fixture@example.test", primary: true, verified: true, visibility: null }]);
    if (url.pathname === "/repositories/42") return Response.json({ id: 42, name: "project", owner: { login: "example" },
      default_branch: "main", private: true, archived: false, permissions: { pull: true, push: true } });
    if (url.pathname === "/repositories/42/branches/main") return Response.json({ commit: { sha: "c".repeat(40) } });
    if (url.pathname.endsWith("/branches")) return Response.json([]);
    throw new Error(`Unexpected GitHub fixture path: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const config = { github: null, deploymentChannel: "alpha", inviteLinkBase: "https://app.example.test/invite",
    cloudAgentCredentials: { settingsSecretKeyV1: keys.keys[1] },
    cloudV2: { boat: { apiKey: "synthetic-boat-credential" }, apiUrl: "https://api.example.test", realtimeUrl: "https://rt.example.test", promptOutbox: true,
      workerSigningKey: signing.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      runtime: { sha256: "b".repeat(64), store: { endpoint: "https://store.example.test", bucket: "fixture", accessKeyId: "fixture", secretAccessKey: "fixture" } } },
  } as Config;
  const cp = createCloudV2(config, pool, { relay: false, lifecycle: false })!;
  const scope = { organizationId: f.organizationId, userId: f.owner.id }, connections = cp.routes.githubConnections!;
  await connections.store.save(scope, await connections.store.fingerprint(scope), { id: "12", login: "fixture" },
    { method: "pat", accessToken: "synthetic-pat", expiresAt: null });
  await pool.query("INSERT INTO cloud_v2_github_sources(workspace_id,source_repository,repository_id) VALUES($1,'example/project',42)", [f.workspaceId]);
  await cp.store.requestLifecycle(f.workspaceId, f.owner.id, "start");
  await pool.query("UPDATE cloud_v2_workspaces SET boat_sandbox_id='bx_syncfixture' WHERE id=$1", [f.workspaceId]);
  const token = await cp.store.rotateWorkerToken(f.workspaceId), boot = randomUUID(), portAuth = "synthetic-sync-port-credential";
  await cp.store.setWorkerRoute(f.workspaceId, "bx_syncfixture", "https://worker.example.test/", sealPortToken(portAuth, f.workspaceId, keys));
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("user", c.req.header("x-test-actor") === f.other.id ? f.other : f.owner); await next(); });
  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: { code: error.code } }, error.status);
    throw error;
  });
  app.route("/", createCloudV2Routes(cp.routes));
  app.route("/", createCloudV2WorkerRoutes(cp.workers));
  const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => app.request(path, {
    method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const hello = (features = "sync-v1", bootId = boot, handoff?: string, runtimeSha256 = "b".repeat(64)) => call("/v2/cloud/worker/hello", "POST",
    { protocol: 2, bootId, runtimeSha256 }, { authorization: `Bearer ${token}`,
      "x-zeros-worker-features": `prompt-outbox-v1,workspace-environment-v1,repository-setup-v1,runtime-update-v1,${features}`,
      ...(handoff ? { "x-zeros-runtime-handoff": handoff } : {}) });
  expect((await hello()).status).toBe(200);
  const path = `/v1/cloud-v2/workspaces/${f.workspaceId}`;
  const grant = (headers: Record<string, string>, body?: unknown) => call(`${path}/sync/grant`, "POST", body, headers);
  const close = async () => {
    cp.runtimeUpdates.close(); await cp.api.credentials.close(); await cp.loginChanges?.stop(); await cp.promptChanges?.stop();
    await cp.localCommandSignals.close(); await f.signals.close();
  };
  return { ...f, cp, app, call, hello, token, boot, keys, portAuth, path, grant, fetcher, close,
    publicKey: signing.publicKey.export({ type: "spki", format: "pem" }).toString() };
}
export type SyncFixture = Awaited<ReturnType<typeof syncFixture>>;
