import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type pg from "pg";
import { expect } from "vitest";
import type { AuthedUser } from "../../auth.js";
import { HttpError } from "../../authz.js";
import { resetMigratedTestDatabase } from "../../test-database.js";
import { grantTestPro } from "../../test-pro.js";
import { CloudV2Store } from "../store.js";
import { CloudV2Computers } from "../computer.js";
import { createCloudV2Routes } from "../routes.js";
import { CloudLocalDevices } from "./devices.js";
import { CloudLocalCommandSignals } from "./signals.js";
import type { LocalDevice } from "./contract.js";
import { CloudLocalCommands } from "./requests.js";
import { CloudNotifyUser } from "../notify-user/store.js";

export async function localCommandsFixture(pool: pg.Pool) {
  await resetMigratedTestDatabase(pool);
  const store = new CloudV2Store(pool), devices = new CloudLocalDevices(pool), signals = new CloudLocalCommandSignals(pool);
  const requests = new CloudLocalCommands(pool,{ currentKeyVersion: 1, keys: { 1: Buffer.alloc(32,23).toString("base64url") } },devices);
  const notifications = new CloudNotifyUser(pool,devices);
  async function actor(): Promise<AuthedUser> {
    const id = randomUUID(), subject = `user_${id}`, sessionId = `session_${randomUUID()}`;
    const row = (await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture') RETURNING auth_revision", [id, `${id}@example.test`])).rows[0];
    await grantTestPro(pool, id);
    await pool.query("INSERT INTO user_identities(user_id,provider,provider_sub,email_at_link) VALUES($1,'workos',$2,$3)", [id, subject, `${id}@example.test`]);
    await pool.query(`INSERT INTO auth_sessions(provider,provider_session_id,provider_sub,user_id,client_kind,status,provider_session_expires_at)
      VALUES('workos',$1,$2,$3,'desktop','active',now()+interval '1 day')`, [sessionId, subject, id]);
    return { id, identity: { provider: "workos", subject }, email: `${id}@example.test`, displayName: "Fixture", avatarUrl: null,
      accountRevision: Number(row.auth_revision), accountStatus: "active", staffRole: null,
      authentication: { sessionId, clientKind: "desktop", authTime: Math.floor(Date.now()/1000), tokenExpiresAt: Math.floor(Date.now()/1000)+3600 } };
  }
  const owner = await actor(), other = await actor(), organizationId = randomUUID();
  await pool.query(`INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed)
    VALUES($1,$2,'Fixture',$3,false,true)`, [organizationId, `org-${organizationId}`, owner.id]);
  await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [organizationId, owner.id, other.id]);
  const workspace = await store.createWorkspace({ id: randomUUID(), organizationId, creatorUserId: owner.id, name: "Fixture",
    repository: "example/project", branch: "work", baseBranch: "main", computerBuildId: null });
  const workspaceId = workspace.id;
  await store.transition(workspaceId, ["creating"], "stopped");
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("user", c.req.header("x-test-actor") === other.id ? other : owner); await next(); });
  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: { code: error.code } }, error.status);
    throw error;
  });
  app.route("/", createCloudV2Routes({ store, computers: new CloudV2Computers(pool), promptOutbox: true,
    localDevices: { devices, signals, requests, notifications }, remoteHead: async () => null,
    bridgeBaseUrl: "wss://api.example.test", installedRepositories: async () => [] }));
  const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => app.request(path, {
    method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function register(deviceId = randomUUID(), user = owner, requestId = randomUUID(), name = "Fixture Mac") {
    const input = { requestId, name, capabilities: ["local-commands-v1"] };
    const response = await call(`/v1/cloud-v2/devices/${deviceId}`, "PUT", input, { "x-test-actor": user.id });
    expect(response.status).toBe(200);
    const result = await response.json() as { device: LocalDevice };
    const headers = { "x-test-actor": user.id, "x-zeros-device-id": deviceId,
      "x-zeros-device-registration": result.device.registrationId, "x-zeros-device-instance": result.device.instanceId };
    return { ...result, headers, input };
  }
  const prompt = (chatId = "chat", userMessageId = randomUUID()) => ({ chatId, userMessageId, agentId: "codex" as const,
    prompt: [{ type: "text" as const, text: "Fixture prompt" }], startedAt: 1234 });
  const submit = (input = prompt(), headers: Record<string, string> = {}) => call(`/v1/cloud-v2/workspaces/${workspaceId}/prompts`, "POST", input, headers);
  return { pool, store, devices, signals, requests, notifications, owner, other, organizationId, workspaceId, app, call, register, prompt, submit };
}
export type LocalCommandsFixture = Awaited<ReturnType<typeof localCommandsFixture>>;

export async function localDeviceStream(f: LocalCommandsFixture, mac: Awaited<ReturnType<LocalCommandsFixture["register"]>>) {
  const controller = new AbortController();
  const response = await f.app.request(`/v1/cloud-v2/devices/${mac.device.deviceId}/events`, { headers: mac.headers, signal: controller.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let buffered = "";
  return {
    async event(name: string): Promise<any> {
      for (;;) {
        const end = buffered.indexOf("\n\n");
        if (end >= 0) {
          const frame = buffered.slice(0,end); buffered = buffered.slice(end+2);
          if (frame.includes(`event: ${name}\n`)) return JSON.parse(frame.split("data: ")[1]!);
        } else {
          const value = await reader.read();
          if (value.done) throw new Error("channel ended before expected event");
          buffered += decoder.decode(value.value,{ stream: true });
        }
      }
    },
    async close() { controller.abort(); await reader.cancel(); },
  };
}
