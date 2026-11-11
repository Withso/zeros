import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthedUser } from "../../auth.js";
import { HttpError } from "../../authz.js";
import { withSystemTx, withUserTx } from "../../db.js";
import { resetMigratedTestDatabase } from "../../test-database.js";
import { grantTestPro } from "../../test-pro.js";
import { CloudV2Store } from "../store.js";
import { CloudV2Computers } from "../computer.js";
import { createCloudV2Routes } from "../routes.js";
import { CloudLocalDevices } from "./devices.js";
import { CloudLocalCommandSignals } from "./signals.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("local command devices through the router and PostgreSQL", () => {
  let pool: pg.Pool, store: CloudV2Store, app: Hono;
  let devices: CloudLocalDevices, signals: CloudLocalCommandSignals;
  let owner: AuthedUser, other: AuthedUser, organizationId: string, workspaceId: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6, statement_timeout: 3000 }); });
  afterAll(() => pool.end());
  afterEach(() => signals?.close());
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    store = new CloudV2Store(pool);
    devices = new CloudLocalDevices(pool); signals = new CloudLocalCommandSignals(pool);
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
    owner = await actor(); other = await actor(); organizationId = randomUUID();
    await pool.query(`INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed)
      VALUES($1,$2,'Fixture',$3,false,true)`, [organizationId, `org-${organizationId}`, owner.id]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [organizationId, owner.id, other.id]);
    const workspace = await store.createWorkspace({ id: randomUUID(), organizationId, creatorUserId: owner.id, name: "Fixture",
      repository: "example/project", branch: "work", baseBranch: "main", computerBuildId: null });
    workspaceId = workspace.id;
    await store.transition(workspaceId, ["creating"], "stopped");
    app = new Hono();
    app.use("*", async (c, next) => { c.set("user", c.req.header("x-test-actor") === other.id ? other : owner); await next(); });
    app.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: { code: "internal" } }, 500));
    app.route("/", createCloudV2Routes({ store, computers: new CloudV2Computers(pool), promptOutbox: true,
      localDevices: { devices, signals }, remoteHead: async () => null,
      bridgeBaseUrl: "wss://api.example.test", installedRepositories: async () => [] }));
  });

  const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => app.request(path, {
    method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function register(deviceId = randomUUID(), actor = owner, requestId = randomUUID()) {
    const input = { requestId, name: "Fixture Mac", capabilities: ["local-commands-v1"] };
    const response = await call(`/v1/cloud-v2/devices/${deviceId}`, "PUT", input, { "x-test-actor": actor.id });
    expect(response.status).toBe(200);
    const result = await response.json();
    const headers = { "x-test-actor": actor.id, "x-zeros-device-id": deviceId,
      "x-zeros-device-registration": result.device.registrationId, "x-zeros-device-instance": result.device.instanceId };
    return { ...result, headers, input };
  }

  it("registers server-issued session-bound IDs and replays registration without rotating them", async () => {
    const first = await register();
    expect(first.device).toMatchObject({ name: "Fixture Mac", capabilities: ["local-commands-v1"] });
    expect(first.device.registrationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.device.instanceId).not.toBe(first.input.requestId);
    const replay = await call(`/v1/cloud-v2/devices/${first.device.deviceId}`, "PUT", first.input);
    expect((await replay.json()).device).toEqual(first.device);
  });

  it("does not let expired sessions consume the active-device limit for a later sign-in",async () => {
    for (let i = 0; i < 20; i++) await register();
    await pool.query("UPDATE auth_sessions SET provider_session_expires_at=now()-interval '1 second' WHERE provider_session_id=$1",[owner.authentication.sessionId]);
    const next = `session_${randomUUID()}`;
    await pool.query(`INSERT INTO auth_sessions(provider,provider_session_id,provider_sub,user_id,client_kind,status,provider_session_expires_at)
      VALUES('workos',$1,$2,$3,'desktop','active',now()+interval '1 day')`,[next,owner.identity.subject,owner.id]);
    owner.authentication.sessionId = next;
    const current = await register();
    const listed = await call(`/v1/cloud-v2/workspaces/${workspaceId}/macs`);
    expect((await listed.json()).macs.map((mac: { deviceId: string }) => mac.deviceId)).toEqual([current.device.deviceId]);
  });

  it("still applies the active-device cap when an expired registration is reused",async () => {
    const old = await register();
    await pool.query("UPDATE auth_sessions SET provider_session_expires_at=now()-interval '1 second' WHERE provider_session_id=$1",[owner.authentication.sessionId]);
    const next = `session_${randomUUID()}`;
    await pool.query(`INSERT INTO auth_sessions(provider,provider_session_id,provider_sub,user_id,client_kind,status,provider_session_expires_at)
      VALUES('workos',$1,$2,$3,'desktop','active',now()+interval '1 day')`,[next,owner.identity.subject,owner.id]);
    owner.authentication.sessionId = next;
    for (let i = 0; i < 20; i++) await register();
    const response = await call(`/v1/cloud-v2/devices/${old.device.deviceId}`,"PUT",{ ...old.input,requestId: randomUUID() });
    expect(response.status).toBe(429); expect((await response.json()).error.code).toBe("local_commands_limited");
  });

  it("connects only from that Mac, keeps a stopped VM asleep, and hides another user's devices", async () => {
    const mine = await register(), theirs = await register(randomUUID(), other);
    expect((await call(`/v1/cloud-v2/workspaces/${workspaceId}/macs/${theirs.device.deviceId}/connect`, "POST", undefined, mine.headers)).status).toBe(409);
    const connected = await call(`/v1/cloud-v2/workspaces/${workspaceId}/macs/${mine.device.deviceId}/connect`, "POST", undefined, mine.headers);
    expect(connected.status).toBe(200);
    expect((await connected.json()).mac).toMatchObject({ connected: true, active: false, reachable: true });
    expect((await (await call(`/v1/cloud-v2/workspaces/${workspaceId}/macs`)).json()).macs.map((mac: {deviceId:string}) => mac.deviceId)).toEqual([mine.device.deviceId]);
    expect((await call(`/v1/cloud-v2/workspaces/${workspaceId}/macs`, "GET", undefined, theirs.headers)).status).toBe(404);
    expect((await store.get(workspaceId, owner.id))?.state).toBe("stopped");
  });

  it("performs no lease write for an unconnected device and does not renew the 12-hour connection clock", async () => {
    const device = await register(), path = `/v1/cloud-v2/devices/${device.device.deviceId}/heartbeat`;
    const before = (await pool.query("SELECT xmin::text,reachable_until FROM local_command_devices WHERE user_id=$1 AND device_id=$2", [owner.id, device.device.deviceId])).rows[0];
    expect((await (await call(path, "POST", undefined, device.headers)).json()).presenceRequired).toBe(false);
    expect((await pool.query("SELECT xmin::text,reachable_until FROM local_command_devices WHERE user_id=$1 AND device_id=$2", [owner.id, device.device.deviceId])).rows[0]).toEqual(before);
    await call(`/v1/cloud-v2/workspaces/${workspaceId}/macs/${device.device.deviceId}/connect`, "POST", undefined, device.headers);
    const connection = (await pool.query("SELECT connected_at,last_used_at FROM cloud_v2_connected_macs WHERE workspace_id=$1", [workspaceId])).rows[0];
    expect((await (await call(path, "POST", undefined, device.headers)).json()).presenceRequired).toBe(true);
    expect((await pool.query("SELECT connected_at,last_used_at FROM cloud_v2_connected_macs WHERE workspace_id=$1", [workspaceId])).rows[0]).toEqual(connection);
  });

  it("separates the same install id between accounts and retires an old app instance", async () => {
    const id = randomUUID(), first = await register(id), foreign = await register(id, other);
    expect(foreign.device.registrationId).not.toBe(first.device.registrationId);
    expect((await call(`/v1/cloud-v2/devices/${id}/heartbeat`, "POST", undefined, { ...first.headers, "x-test-actor": other.id })).status).toBe(409);
    const next = await register(id);
    expect(next.device.registrationId).toBe(first.device.registrationId);
    expect(next.device.instanceId).not.toBe(first.device.instanceId);
    expect((await call(`/v1/cloud-v2/devices/${id}/heartbeat`, "POST", undefined, first.headers)).status).toBe(409);
    await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE provider_session_id=$1", [owner.authentication.sessionId]);
    expect((await call(`/v1/cloud-v2/devices/${id}/heartbeat`, "POST", undefined, next.headers)).status).toBe(401);
    expect((await pool.query("SELECT revoked_at FROM local_command_devices WHERE user_id=$1 AND device_id=$2", [owner.id, id])).rows[0].revoked_at).not.toBeNull();
    expect((await call(`/v1/cloud-v2/devices/${id}/heartbeat`, "POST", undefined, foreign.headers)).status).toBe(200);
  });

  it("expires manual connections after 12 hours, retains the latest sender, and lets Disconnect suppress it", async () => {
    const first = await register(), second = await register();
    for (const device of [first,second]) await call(`/v1/cloud-v2/workspaces/${workspaceId}/macs/${device.device.deviceId}/connect`, "POST", undefined, device.headers);
    await pool.query("UPDATE cloud_v2_connected_macs SET connected_at=now()-interval '13 hours',last_used_at=now()-interval '13 hours',is_latest_sender=(device_id=$2) WHERE workspace_id=$1", [workspaceId, first.device.deviceId]);
    const list = (await (await call(`/v1/cloud-v2/workspaces/${workspaceId}/macs`)).json()).macs;
    expect(list.find((row: {deviceId:string}) => row.deviceId === first.device.deviceId)).toMatchObject({ active: true, connected: true, expiresAt: null });
    expect(list.find((row: {deviceId:string}) => row.deviceId === second.device.deviceId)).toMatchObject({ active: false, connected: false });
    expect((await (await call(`/v1/cloud-v2/devices/${second.device.deviceId}/heartbeat`, "POST", undefined, second.headers)).json()).presenceRequired).toBe(false);
    const result = await call(`/v1/cloud-v2/workspaces/${workspaceId}/macs/${first.device.deviceId}/disconnect`, "POST", undefined, second.headers);
    expect(result.status).toBe(200);
    expect((await result.json()).mac).toMatchObject({ connected: false, active: false, reachable: false });
  });

  it("streams cross-replica presence without an open workspace and closes on sign-out", async () => {
    const registered = await register(), controller = new AbortController();
    const response = await app.request(`/v1/cloud-v2/devices/${registered.device.deviceId}/events`, { headers: registered.headers, signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let buffered = "";
    const event = async (name: string) => {
      for (;;) {
        const end = buffered.indexOf("\n\n");
        if (end >= 0) {
          const frame = buffered.slice(0,end); buffered = buffered.slice(end+2);
          if (frame.includes(`event: ${name}\n`)) return JSON.parse(frame.split("data: ")[1]!);
        } else {
          const value = await reader.read();
          if (value.done) throw new Error("channel ended before expected event");
          buffered += decoder.decode(value.value, { stream: true });
        }
      }
    };
    try {
      expect(await event("ready")).toMatchObject({ deviceId: registered.device.deviceId, registrationId: registered.device.registrationId,
        instanceId: registered.device.instanceId, presence: { presenceRequired: false } });
      const replica = new CloudLocalDevices(pool);
      await replica.connect(owner, workspaceId, registered.device.deviceId, registered.device);
      expect(await event("presence")).toMatchObject({ presenceRequired: true });
      await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE provider_session_id=$1", [owner.authentication.sessionId]);
      expect(await event("revoked")).toEqual({ code: "session_revoked" });
    } finally { controller.abort(); await reader.cancel(); }
  });

  // Escaped on Alpha: the stream told a signed-in Mac "session_revoked" when its
  // five-minute access token ran out; the app stopped for good and showed offline.
  it("ends the channel without revoking when only the access token expires", async () => {
    const registered = await register(), controller = new AbortController();
    owner.authentication.tokenExpiresAt = Math.floor(Date.now()/1000)+4;
    const response = await app.request(`/v1/cloud-v2/devices/${registered.device.deviceId}/events`, { headers: registered.headers, signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let text = "";
    try {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value, { stream: true }); }
    } finally { controller.abort(); }
    expect(text).toContain("event: ready\n");
    expect(text).not.toContain("event: revoked");
    expect(Date.now()/1000).toBeLessThan(owner.authentication.tokenExpiresAt);
    // The same session reconnects with a fresh token.
    owner.authentication.tokenExpiresAt = Math.floor(Date.now()/1000)+3600;
    expect((await call(`/v1/cloud-v2/devices/${registered.device.deviceId}/heartbeat`, "POST", undefined, registered.headers)).status).toBe(200);
  }, 15_000);

  it("keeps passive reads lock-free while another transaction holds the workspace and device", async () => {
    const registered = await register(), tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [workspaceId]);
      await tx.query("SELECT device_id FROM local_command_devices WHERE user_id=$1 FOR UPDATE", [owner.id]);
      expect((await call(`/v1/cloud-v2/workspaces/${workspaceId}/macs`)).status).toBe(200);
      expect(await devices.snapshot(owner, registered.device)).toMatchObject({ presence: { presenceRequired: false } });
    } finally { await tx.query("ROLLBACK"); tx.release(); }
  });

  it("keeps released session, prompt, workspace and organization writes valid as zeros_app", async () => {
    const registered = await register();
    await withSystemTx(pool, async tx => {
      const identity = (await tx.query("SELECT current_user,app_is_system() AS system")).rows[0];
      expect(identity).toEqual({ current_user: "zeros_app", system: true });
      await tx.query(`INSERT INTO auth_sessions(provider,provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at)
        VALUES('workos',$1,$2,$3,'desktop',now()+interval '1 hour') ON CONFLICT(provider,provider_session_id) DO NOTHING`,
      [`session_${randomUUID()}`, owner.identity.subject, owner.id]);
      await tx.query("UPDATE auth_sessions SET last_token_expires_at=now()+interval '2 hours',last_seen_at=now() WHERE provider_session_id=$1", [owner.authentication.sessionId]);
      await tx.query("INSERT INTO cloud_v2_prompt_chats(workspace_id,chat_id) VALUES($1,'legacy-chat')", [workspaceId]);
      await tx.query("UPDATE cloud_v2_prompt_chats SET next_sequence=next_sequence+1,epoch=epoch+1 WHERE workspace_id=$1", [workspaceId]);
      await tx.query("UPDATE cloud_v2_workspaces SET state='starting',attempts=0,updated_at=clock_timestamp() WHERE id=$1", [workspaceId]);
      await tx.query("UPDATE cloud_v2_workspaces SET state='stopping',stop_generation=stop_generation+1 WHERE id=$1", [workspaceId]);
      await tx.query("UPDATE organizations SET name='Updated fixture' WHERE id=$1", [organizationId]);
      await tx.query("UPDATE auth_sessions SET status='revoked',revoked_at=now(),revocation_reason='account_deletion_scheduled' WHERE user_id=$1 AND status='active'", [owner.id]);
      expect((await tx.query("SELECT revoked_at FROM local_command_devices WHERE user_id=$1 AND device_id=$2", [owner.id, registered.device.deviceId])).rows[0].revoked_at).not.toBeNull();
      await tx.query("DELETE FROM auth_sessions WHERE user_id=$1", [owner.id]);
    });
    expect((await withUserTx(pool, owner.id, tx => tx.query("SELECT * FROM local_command_devices"))).rowCount).toBe(0);
    expect((await withUserTx(pool, owner.id, tx => tx.query("UPDATE auth_sessions SET status='revoked' WHERE user_id=$1", [other.id]))).rowCount).toBe(0);
  });

  it("rechecks session revocation even when RLS filters the invoker trigger's device update", async () => {
    const registered = await register(), tx = await pool.connect();
    try {
      // No current non-system caller can write auth_sessions. This temporary
      // session-only policy proves a future such writer cannot bypass checks.
      await tx.query("BEGIN");
      await tx.query("CREATE POLICY local_test_session_writer ON auth_sessions USING (true) WITH CHECK (true)");
      await tx.query("SET LOCAL ROLE zeros_app");
      await tx.query("SELECT set_config('app.user_id',$1,true)", [owner.id]);
      const result = await tx.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE provider_session_id=$1", [owner.authentication.sessionId]);
      expect(result.rowCount).toBe(1);
      await tx.query("SELECT set_config('app.system','on',true)");
      expect((await tx.query("SELECT revoked_at FROM local_command_devices WHERE user_id=$1", [owner.id])).rows[0].revoked_at).toBeNull();
      await expect(devices.verify(tx, owner, registered.device)).rejects.toMatchObject({ code: "session_revoked" });
    } finally { await tx.query("ROLLBACK"); tx.release(); }
  });

  it("records the empty-case cost of the hot-table triggers", async () => {
    await withSystemTx(pool, async tx => {
      await tx.query("INSERT INTO cloud_v2_prompt_chats(workspace_id,chat_id) VALUES($1,'empty-chat')", [workspaceId]);
      for (const [sql, values] of [
        ["UPDATE cloud_v2_prompt_chats SET next_sequence=1 WHERE workspace_id=$1 AND chat_id='empty-chat'", [workspaceId]],
        ["UPDATE cloud_v2_workspaces SET state='stopping',stop_generation=stop_generation+1 WHERE id=$1", [workspaceId]],
        ["UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE provider_session_id=$1", [owner.authentication.sessionId]],
      ] as const) {
        const plan = (await tx.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, [...values])).rows[0]["QUERY PLAN"][0];
        const triggers = plan.Triggers.filter((row: {"Trigger Name":string}) => row["Trigger Name"].startsWith("local_command_"));
        expect(triggers).toHaveLength(1);
        console.info("[local-command empty trigger]", JSON.stringify(triggers));
      }
      expect((await tx.query("SELECT count(*)::int AS count FROM local_command_requests")).rows[0].count).toBe(0);
    });
  });
});
