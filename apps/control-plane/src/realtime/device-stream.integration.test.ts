import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { ensureUser } from "../auth.js";
import { HttpError } from "../authz.js";
import { withSystemTx } from "../db.js";
import { cloudWorkspaceDeviceProofMessage } from "../cloud-workspaces/replicas.js";
import { readCatalogVersion } from "../cloud-workspaces/routes.js";
import { seedReadyCloudWorkspace } from "../cloud-workspaces/test-fixtures.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { DEVICE_SESSION_PROOF_ACTION, DEVICE_SESSIONS_PATH, createDeviceSessionRoutes } from "./device-session-routes.js";
import { DatabaseDeviceSessionAuthority, issueDeviceSession } from "./device-sessions.js";
import { DatabaseDeviceStreamCatalogSource } from "./device-stream-catalog.js";
import { DEVICE_STREAM_CATALOG_CHANNEL, startDeviceStreamNotifications } from "./device-stream-notifications.js";
import { DEVICE_STREAM_PATH } from "./device-stream-protocol.js";
import { DeviceStreamServer } from "./device-stream-server.js";

vi.setConfig({ testTimeout: 30_000 });

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("device stream database paths", () => {
  let pool: pg.Pool;
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let user: Awaited<ReturnType<typeof ensureUser>>;
  let deviceId: string;
  let pair: ReturnType<typeof generateKeyPairSync>;
  let flagOn: boolean;

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    flagOn = true;
    user = await ensureUser(pool, { provider: "workos", providerSubject: `workos|${fixture.userId}`, email: `stream-${fixture.userId}@example.test`,
      displayName: "Owner", session: { id: `session_${randomUUID()}`, clientKind: "desktop", authTime: Math.floor(Date.now() / 1000),
        tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600 } });
    await pool.query(`INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at)
      VALUES($1,$2,$3,'desktop',now()+interval '1 hour')`, [user.authentication.sessionId, user.identity.subject, user.id]);
    pair = generateKeyPairSync("ed25519");
    const publicKey = Buffer.from(pair.publicKey.export({ format: "jwk" }).x!, "base64url");
    deviceId = (await pool.query<{ id: string }>(
      "INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint) VALUES($1,'Stream','macos',$2,$3) RETURNING id",
      [user.id, publicKey, createHash("sha256").update(publicKey).digest()])).rows[0]!.id;
  });

  function routes() {
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", user); await next(); });
    app.route("/", createDeviceSessionRoutes(pool, {
      flags: { enabled: () => flagOn, anyEnabled: () => flagOn },
      streamUrl: `wss://realtime.example.test${DEVICE_STREAM_PATH}`, workosEnabled: true,
    }));
    app.onError((error, c) => error instanceof HttpError
      ? c.json({ error: { code: error.code } }, error.status)
      : c.json({ error: { code: "internal" } }, 500));
    return app;
  }
  function post(body: Record<string, unknown>, proofDeviceSessionId: string | null = (body.deviceSessionId as string | undefined) ?? null) {
    const fields = { deviceId, keyVersion: 1, timestampMs: Date.now(), nonce: randomBytes(24).toString("base64url") };
    const signature = sign(null, cloudWorkspaceDeviceProofMessage({ ...fields, accountUserId: user.id, action: DEVICE_SESSION_PROOF_ACTION,
      payload: { deviceSessionId: proofDeviceSessionId } }), pair.privateKey).toString("base64url");
    return routes().request(DEVICE_SESSIONS_PATH, { method: "POST", headers: { "content-type": "application/json",
      "x-zeros-device-id": deviceId, "x-zeros-device-key-version": "1", "x-zeros-device-timestamp": String(fields.timestampMs),
      "x-zeros-device-nonce": fields.nonce, "x-zeros-device-signature": signature }, body: JSON.stringify(body) });
  }
  const client = { platform: "macos", appVersion: "1.2.3", contract: { min: 1, max: 1 } };
  const digest = (ticket: string) => createHash("sha256").update(ticket).digest();

  it("issues a no-store single-use ticket, keeps the device session on reconnect and is 404 while the flag is off", async () => {
    const response = await post({ deviceId, client });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { deviceSessionId: string; stream: { url: string; ticket: string; ticketExpiresAt: string }; contract: number; heartbeatIntervalMs: number };
    expect(body).toMatchObject({ contract: 1, heartbeatIntervalMs: 20_000, stream: { url: `wss://realtime.example.test${DEVICE_STREAM_PATH}` } });
    expect(body.stream.ticket).toMatch(/^zds_[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(body.stream.ticketExpiresAt) - Date.now()).toBeLessThanOrEqual(60_000);
    const row = (await pool.query("SELECT user_id, device_id, provider_session_id, ticket_hash FROM cloud_device_sessions WHERE id=$1", [body.deviceSessionId])).rows[0];
    expect(row).toEqual({ user_id: user.id, device_id: deviceId, provider_session_id: user.authentication.sessionId, ticket_hash: digest(body.stream.ticket) });

    const again = await post({ deviceId, deviceSessionId: body.deviceSessionId, client });
    expect(again.status).toBe(201);
    const reused = await again.json() as typeof body;
    expect(reused.deviceSessionId).toBe(body.deviceSessionId);
    expect(reused.stream.ticket).not.toBe(body.stream.ticket);
    const authority = new DatabaseDeviceSessionAuthority(pool);
    await expect(authority.consume(body.stream.ticket)).resolves.toBeNull();
    await expect(authority.consume(reused.stream.ticket)).resolves.toMatchObject({ deviceSessionId: body.deviceSessionId, accountUserId: user.id, deviceId });

    // An unknown device session id starts a new one; the client cannot resume.
    const fresh = await post({ deviceId, deviceSessionId: randomUUID(), client });
    expect((await fresh.json() as typeof body).deviceSessionId).not.toBe(body.deviceSessionId);
    // The proof binds the requested device session id.
    expect((await post({ deviceId, deviceSessionId: body.deviceSessionId, client }, null)).status).toBe(403);
    expect((await post({ deviceId, client: { ...client, contract: { min: 2, max: 3 } } })).status).toBe(409);
    expect((await post({ deviceId: randomUUID(), client })).status).toBe(422);
    flagOn = false;
    const off = await post({ deviceId, client });
    expect(off.status).toBe(404);
    expect(off.headers.get("cache-control")).toBe("no-store");
  });

  async function issue(reuseId: string | null = null) {
    return withSystemTx(pool, tx => issueDeviceSession(tx, { accountUserId: user.id, deviceId,
      providerSessionId: user.authentication.sessionId, reuseId }));
  }

  it("consumes a ticket exactly once across realtime instances", async () => {
    const pools = [new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 }), new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 })];
    try {
      const [a, b] = pools.map(value => new DatabaseDeviceSessionAuthority(value)) as [DatabaseDeviceSessionAuthority, DatabaseDeviceSessionAuthority];
      for (let round = 0; round < 5; round++) {
        const { ticket } = await issue();
        const results = await Promise.all([a.consume(ticket), b.consume(ticket), a.consume(ticket), b.consume(ticket)]);
        expect(results.filter(Boolean)).toHaveLength(1);
        await expect(a.consume(ticket)).resolves.toBeNull();
      }
    } finally { await Promise.all(pools.map(value => value.end())); }
  });

  it("rejects expired tickets and reports why a device session stopped being live", async () => {
    const authority = new DatabaseDeviceSessionAuthority(pool);
    const expired = await issue();
    await pool.query("UPDATE cloud_device_sessions SET ticket_expires_at=clock_timestamp() - interval '1 second', created_at=created_at - interval '1 minute' WHERE id=$1",
      [expired.deviceSessionId]);
    await expect(authority.consume(expired.ticket)).resolves.toBeNull();
    await expect(authority.consume("zds_short")).resolves.toBeNull();
    const live = await issue();
    expect(await authority.check([live.deviceSessionId, randomUUID(), "not-a-uuid"])).toEqual(new Map([
      [live.deviceSessionId, "live"], [expect.any(String), "expired"], ["not-a-uuid", "expired"]]));
    await pool.query("UPDATE auth_sessions SET status='revoked', revoked_at=now() WHERE provider_session_id=$1", [user.authentication.sessionId]);
    expect((await authority.check([live.deviceSessionId])).get(live.deviceSessionId)).toBe("session");
    await pool.query("UPDATE devices SET trust_state='revoked', revoked_at=now() WHERE id=$1", [deviceId]);
    expect((await authority.check([live.deviceSessionId])).get(live.deviceSessionId)).toBe("device");
    const next = await issue(live.deviceSessionId);
    await expect(authority.consume(next.ticket)).resolves.toBeNull();
  });

  it("hides device sessions from the runtime role outside system context", async () => {
    const { deviceSessionId } = await issue();
    const probe = await pool.connect();
    try {
      await probe.query("BEGIN");
      await probe.query("SET LOCAL ROLE zeros_app");
      await probe.query("SELECT set_config('app.user_id', $1, true)", [user.id]);
      expect((await probe.query("SELECT id FROM cloud_device_sessions WHERE id=$1", [deviceSessionId])).rows).toEqual([]);
      await expect(probe.query(`INSERT INTO cloud_device_sessions(user_id, device_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
        [user.id, deviceId])).rejects.toThrow(/row-level security/);
      await probe.query("ROLLBACK");
    } finally { probe.release(); }
  });

  it("notifies the catalog channel with a monotonic catalog version on each document version change only", async () => {
    const listener = await pool.connect();
    const payloads: string[] = [];
    listener.on("notification", notice => { if (notice.channel === DEVICE_STREAM_CATALOG_CHANNEL) payloads.push(notice.payload ?? ""); });
    try {
      await listener.query(`LISTEN ${DEVICE_STREAM_CATALOG_CHANNEL}`);
      const before = await withSystemTx(pool, tx => readCatalogVersion(tx));
      await pool.query("UPDATE cloud_workspaces SET version=version+1 WHERE id=$1", [fixture.workspaceId]);
      await pool.query("UPDATE cloud_workspaces SET display_name=display_name WHERE id=$1", [fixture.workspaceId]);
      await pool.query("UPDATE cloud_workspaces SET version=version+1 WHERE id=$1", [fixture.workspaceId]);
      for (let i = 0; i < 100 && payloads.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(payloads).toEqual([`${fixture.workspaceId}:${before + 1}`, `${fixture.workspaceId}:${before + 2}`]);
      await expect(withSystemTx(pool, tx => readCatalogVersion(tx))).resolves.toBe(before + 2);
    } finally { await listener.query("UNLISTEN *").catch(() => {}); listener.release(); }
  });

  it("re-reads the catalog access set and the accounts that may have gained access", async () => {
    const source = new DatabaseDeviceStreamCatalogSource(pool, null);
    const stranger = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Stranger')", [stranger, `${stranger}@example.test`]);
    const owner = await source.read(fixture.userId, null);
    expect(owner.complete).toBe(true);
    expect(owner.workspaces).toEqual([expect.objectContaining({ id: fixture.workspaceId, organizationId: fixture.organizationId,
      document: expect.objectContaining({ id: fixture.workspaceId, placement: "cloud" }) })]);
    await expect(source.read(fixture.userId, [randomUUID()])).resolves.toMatchObject({ workspaces: [] });
    await expect(source.read(stranger, null)).resolves.toMatchObject({ workspaces: [] });
    await expect(source.candidates([fixture.workspaceId], [fixture.userId, stranger])).resolves.toEqual(new Set([fixture.userId]));
    await expect(source.organizationAccounts(fixture.organizationId, [fixture.userId, stranger])).resolves.toEqual(new Set([fixture.userId]));
  });

  describe("end to end", () => {
    let http: Server;
    let server: DeviceStreamServer;
    let listenerPool: pg.Pool;
    let stop: () => Promise<void>;
    afterEach(async () => {
      server?.close();
      await stop?.();
      await listenerPool?.end();
      await new Promise(resolve => http?.close(resolve));
    });

    it("pushes catalog.changed for a committed workspace update to the owner's device session", async () => {
      listenerPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
      server = new DeviceStreamServer({
        authority: new DatabaseDeviceSessionAuthority(pool),
        catalog: new DatabaseDeviceStreamCatalogSource(pool, null),
        flags: { enabled: () => true, anyEnabled: () => true },
        refreshDelayMs: 5,
      });
      stop = startDeviceStreamNotifications(listenerPool, server, { warn: () => {} });
      http = createServer((_req, res) => res.end());
      http.on("upgrade", (req, socket, head) => { if (!server.handleUpgrade(req, socket, head)) socket.destroy(); });
      await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
      // The owner's device session (fixture user), not the route's separate account.
      const ownerDevice = randomBytes(32);
      const ownerDeviceId = (await pool.query<{ id: string }>(
        "INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint) VALUES($1,'Owner','linux',$2,$3) RETURNING id",
        [fixture.userId, ownerDevice, createHash("sha256").update(ownerDevice).digest()])).rows[0]!.id;
      const issued = await withSystemTx(pool, tx => issueDeviceSession(tx, { accountUserId: fixture.userId, deviceId: ownerDeviceId,
        providerSessionId: null, reuseId: null }));
      const ws = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}${DEVICE_STREAM_PATH}`, { perMessageDeflate: false });
      const frames: { t: string; d: Record<string, unknown> }[] = [];
      ws.on("message", data => frames.push(JSON.parse(String(data))));
      await new Promise(resolve => ws.once("open", resolve));
      ws.send(JSON.stringify({ t: "hello", d: { contract: { min: 1, max: 1 }, ticket: issued.ticket } }));
      const wait = async (predicate: () => boolean) => { for (let i = 0; i < 300 && !predicate(); i++) await new Promise(r => setTimeout(r, 10)); };
      await wait(() => frames.some(frame => frame.t === "ready"));
      expect(frames[0]).toMatchObject({ t: "ready", d: { deviceSessionId: issued.deviceSessionId, resumed: false } });
      // Let the listener come up before the change commits.
      await new Promise(resolve => setTimeout(resolve, 200));
      const version = Number((await pool.query<{ version: string }>(
        "UPDATE cloud_workspaces SET version=version+1 WHERE id=$1 RETURNING version", [fixture.workspaceId])).rows[0]!.version);
      await wait(() => frames.some(frame => frame.t === "catalog.changed"));
      expect(frames.find(frame => frame.t === "catalog.changed")).toMatchObject({ d: { workspaceId: fixture.workspaceId, version, op: "upsert",
        workspace: { id: fixture.workspaceId, version } } });
      ws.terminate();
    });
  });
});
