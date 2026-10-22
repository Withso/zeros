import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import WebSocket from "ws";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { HttpError } from "../authz.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedCredentialOwner } from "../agent-credentials/test-fixtures.js";
import { DatabaseCloudAgentCredentialService } from "../agent-credentials/agent-credentials.js";
import { createCloudAgentCredentialRoutes } from "../agent-credentials/agent-credential-routes.js";
import { createCloudV2 } from "./composition.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const key = Buffer.alloc(32, 7).toString("base64url");
const token = (name: string) => `synthetic-setup-token-${name}`;
suite("Settings changes reach connected cloud workers", () => {
  let pool: pg.Pool, listener: pg.Pool, runtime: NonNullable<ReturnType<typeof createCloudV2>>;
  let server: Server, worker: WebSocket, settings: Hono, owner: Awaited<ReturnType<typeof seedCredentialOwner>>;
  let workspaceId: string;
  let frames: { t: string; agents?: { claude?: { oauthToken: string } } }[];
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
    listener = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
  });
  afterAll(async () => { await listener.end(); await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    owner = await seedCredentialOwner(pool);
    const service = new DatabaseCloudAgentCredentialService(pool, { currentKeyVersion: 1, keys: { 1: key } });
    settings = new Hono();
    settings.use("*", async (c, next) => { c.set("user", { id: owner.userId } as never); await next(); });
    settings.onError((error, c) => error instanceof HttpError ? c.json({ error: error.code }, error.status) : c.json({ error: "internal" }, 500));
    settings.route("/", createCloudAgentCredentialRoutes(service));
    runtime = createCloudV2({ deploymentChannel: "alpha", cloudAgentCredentials: { settingsSecretKeyV1: key }, cloudV2: {
      boat: { apiKey: "synthetic-boat-key-never-used" }, apiUrl: "https://example.test", realtimeUrl: "wss://example.test",
      runtime: { sha256: "b".repeat(64), store: { endpoint: "https://storage.example.test", bucket: "test", accessKeyId: "fixture", secretAccessKey: "fixture" } },
    } } as Config, pool, { relay: true, lifecycle: false }, undefined, listener)!;
    await runtime.loginChanges?.start();
    const workspace = await runtime.store.createWorkspace({ id: randomUUID(), creatorUserId: owner.userId, organizationId: owner.organizationId,
      repository: "example/project", branch: "zeros/test", baseBranch: "main", name: "Test", computerBuildId: null });
    workspaceId = workspace.id;
    const workerToken = await runtime.store.rotateWorkerToken(workspace.id);
    server = createServer();
    server.on("upgrade", (req, socket, head) => runtime.relay!.handleUpgrade(req, socket, head));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    frames = [];
    worker = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/v2/cloud/worker`, { headers: { authorization: `Bearer ${workerToken}` } });
    worker.on("message", raw => frames.push(JSON.parse(String(raw))));
    await new Promise<void>((resolve, reject) => { worker.once("open", resolve); worker.once("error", reject); });
    worker.send(JSON.stringify({ t: "hello", protocol: 1, workerVersion: "fixture", capabilities: {
      design: false, browser: false, simulators: false, files: true, git: true, terminal: true, agents: ["claude"],
    } }));
    await vi.waitFor(() => expect(frames).toHaveLength(1));
  });
  afterEach(async () => {
    worker?.terminate(); runtime?.relay?.close(); await runtime?.loginChanges?.stop();
    if (server) await new Promise(resolve => server.close(resolve));
  });
  async function put(id: string, revision = 0, name = "first") {
    const response = await settings.request(`/v1/cloud-agent-credentials/${id}`, { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId: randomUUID(), expectedRevision: revision, displayName: "Fixture", organizationId: owner.organizationId,
        material: { kind: "claude-setup-token", accessToken: token(name) } }) });
    expect(response.status).toBe(200);
  }
  async function select(id: string | null, revision = 0) {
    const response = await settings.request(`/v1/organizations/${owner.organizationId}/agent-connections/claude`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: revision, credentialId: id,
        ...(id ? { credentialRevision: 1, models: ["claude-haiku-4-5"], consent: "zeros-managed" } : {}) }),
    });
    expect(response.status).toBe(200);
  }
  const latest = () => frames.filter(frame => frame.t === "config").at(-1)?.agents;

  it("pushes selection and replacement from the Settings routes without reconnecting", async () => {
    const id = randomUUID(); await put(id); await select(id);
    await vi.waitFor(() => expect(latest()).toEqual({ claude: { oauthToken: token("first") } }));
    await put(id, 1, "replacement");
    await vi.waitFor(() => expect(latest()).toEqual({ claude: { oauthToken: token("replacement") } }));
    expect(worker.readyState).toBe(WebSocket.OPEN);
  });

  it.each(["disconnect", "revoke", "organization removal", "removal protocol"])("pushes a full replacement without Claude after %s", async action => {
    const id = randomUUID(); await put(id); await select(id);
    await vi.waitFor(() => expect(latest()?.claude).toBeDefined());
    if (action === "disconnect") await select(null, 1);
    else if (action === "removal protocol") {
      const response = await settings.request("/v1/cloud-agent-credentials/removals/prepare", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, operationId: randomUUID(), target: { kind: "revoke-credential", credentialId: id, expectedCredentialRevision: 1 } }) });
      expect(response.status).toBe(200); expect((await response.json()).state).toBe("removed");
    }
    else {
      const path = action === "revoke" ? `/v1/cloud-agent-credentials/${id}` : `/v1/organizations/${owner.organizationId}/agent-connections/accounts/${id}`;
      expect((await settings.request(path, { method: "DELETE" })).status).toBe(200);
    }
    await vi.waitFor(() => expect(latest()).toEqual({}));
    expect(worker.readyState).toBe(WebSocket.OPEN);
  });

  it("invalidates only the owning creator's matching organization", async () => {
    const otherOrg = await seedCredentialOwner(pool, { ownerUserId: owner.userId });
    const otherOwner = await seedCredentialOwner(pool);
    const ids: string[] = [];
    for (const fixture of [otherOrg, otherOwner]) {
      const workspace = await runtime.store.createWorkspace({ id: randomUUID(), creatorUserId: fixture.userId, organizationId: fixture.organizationId,
        repository: "example/project", branch: "zeros/test", baseBranch: "main", name: "Test", computerBuildId: null });
      ids.push(workspace.id);
    }
    const id = randomUUID(); await put(id); await select(id);
    await vi.waitFor(() => expect(latest()?.claude).toBeDefined());
    expect(await Promise.all(ids.map(id => runtime.store.loginRevision(id)))).toEqual(["0", "0"]);
  });

  it("keeps rolled-back mutations invisible, and repairs a missed notification from durable revision", async () => {
    const id = randomUUID(); await put(id); await select(id);
    await vi.waitFor(() => expect(latest()?.claude).toBeDefined());
    const before = await runtime.store.loginRevision(workspaceId);
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query("UPDATE cloud_agent_organization_connections SET credential_id=NULL,credential_revision=NULL,models='{}',revision=revision+1 WHERE owner_user_id=$1", [owner.userId]);
      await runtime.relay!.refreshLogins();
      expect(latest()?.claude).toBeDefined();
    } finally { await tx.query("ROLLBACK"); tx.release(); }
    expect(await runtime.store.loginRevision(workspaceId)).toBe(before);
    await runtime.loginChanges!.stop();
    await select(null, 1);
    await runtime.relay!.refreshLogins();
    await vi.waitFor(() => expect(latest()).toEqual({}));
  });
});
