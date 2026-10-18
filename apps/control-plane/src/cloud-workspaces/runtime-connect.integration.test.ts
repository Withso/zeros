import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { jwtVerify } from "jose";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureUser, type AuthedUser } from "../auth.js";
import { HttpError } from "../authz.js";
import { withSystemTx } from "../db.js";
import { issueDeviceSession } from "../realtime/device-sessions.js";
import type { RolloutFlagName } from "../rollout-flags.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { CapabilityClaimsSchema } from "./capability-contract.js";
import type { CloudAgentBootScope } from "./agent-boot-contract.js";
import type { CapabilitySigningKeyStore } from "./capability-keys.js";
import { cloudWorkspaceDeviceProofMessage } from "./replicas.js";
import {
  CLOUD_RUNTIME_CAPABILITIES_PATH,
  CLOUD_RUNTIME_CONNECT_PATH,
  RUNTIME_CAPABILITIES_PROOF_ACTION,
  RUNTIME_CONNECT_PROOF_ACTION,
  createCloudRuntimeConnectRoutes,
  type CloudRuntimeConnectOptions,
} from "./runtime-connect-routes.js";
import { seedReadyCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";

vi.setConfig({ testTimeout: 30_000 });

const ISSUER = "https://cp.example.test";
const RELAY_URL = "wss://realtime.example.test/v1/relay";
const DIRECT_ENDPOINT = "https://verified-sandbox-39393.on.boat.dev/";
const DIRECT_URL = "wss://verified-sandbox-39393.on.boat.dev/ws";
const signing = generateKeyPairSync("ed25519");
const keyStore = { signer: () => ({ kid: "cap-test-a", key: signing.privateKey }) } as unknown as CapabilitySigningKeyStore;
const throwingPool = { connect: () => { throw new Error("database used"); }, query: () => { throw new Error("database used"); } } as unknown as pg.Pool;
const CONNECT = CLOUD_RUNTIME_CONNECT_PATH, RENEW = CLOUD_RUNTIME_CAPABILITIES_PATH;

type Grant = { token: string; expiresAt: string };
type ConnectBody = {
  workspaceId: string; generation: number; engineInstanceId: string;
  capabilities: { engine: Grant; realtime: Grant };
  routes: { kind: "direct" | "relay"; url: string; priority: number }[];
  renewAt: string; relayHedgeMs: number;
  runtimeBinding?: { authorityEpoch: number; bootScope: CloudAgentBootScope; acceptedWorkVersion?: 1 };
};
type Ids = { organizationId: string; workspaceId: string };
type Actor = { user: AuthedUser; deviceId: string; privateKey: KeyObject };
type ProofOptions = { action?: string; payload?: unknown; ids?: Ids; actor?: Actor; timestampMs?: number; keyVersion?: number };

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("runtime connect and capability renewal with PostgreSQL", () => {
  let pool: pg.Pool;
  let fixture: ReadyCloudWorkspaceFixture;
  let user: AuthedUser;
  let authSessionId: string;
  let deviceId: string;
  let devicePublicKey: Buffer;
  let privateKey: KeyObject;
  let deviceSessionId: string;
  /** Flags on for the fixture organization only. */
  let on: Set<RolloutFlagName>;

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  afterAll(async () => { await pool.end(); });

  /** A WorkOS account with its recorded CP session. */
  async function account(subject: string, email: string, displayName: string) {
    const created = await ensureUser(pool, { provider: "workos", providerSubject: subject, email, displayName,
      session: { id: `session_${randomUUID()}`, clientKind: "desktop", authTime: Math.floor(Date.now() / 1000),
        tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600 } });
    const sessionRow = (await pool.query<{ id: string }>(`INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at)
      VALUES($1,$2,$3,'desktop',now()+interval '1 hour') RETURNING id`, [created.authentication.sessionId, created.identity.subject, created.id])).rows[0]!.id;
    return { user: created, authSessionId: sessionRow };
  }

  /** A trusted device of `owner` with a live device session on its CP session. */
  async function device(owner: AuthedUser) {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = Buffer.from(keys.publicKey.export({ format: "jwk" }).x!, "base64url");
    const id = (await pool.query<{ id: string }>(
      "INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint) VALUES($1,'Connect','macos',$2,$3) RETURNING id",
      [owner.id, publicKey, createHash("sha256").update(publicKey).digest()])).rows[0]!.id;
    const session = await withSystemTx(pool, tx => issueDeviceSession(tx, { accountUserId: owner.id, deviceId: id,
      providerSessionId: owner.authentication.sessionId, reuseId: null }));
    return { deviceId: id, privateKey: keys.privateKey, publicKey, deviceSessionId: session.deviceSessionId };
  }

  async function seed(options: Parameters<typeof seedReadyCloudWorkspace>[1] = {}) {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool, options);
    // WorkOS deployments also require the organization's active WorkOS link.
    await pool.query("INSERT INTO workos_organization_links(organization_id,workos_organization_id,external_id,state) VALUES($1::uuid,$2,$1::text,'active')",
      [fixture.organizationId, `org_${randomUUID()}`]);
    on = new Set<RolloutFlagName>(["capabilities", "runtime_connect", "relay_over_uplink"]);
    ({ user, authSessionId } = await account(`workos|${fixture.userId}`, `connect-${fixture.userId}@example.test`, "Owner"));
    ({ deviceId, privateKey, publicKey: devicePublicKey, deviceSessionId } = await device(user));
  }
  beforeEach(() => seed());

  const capabilities = (): CloudRuntimeConnectOptions["capabilities"] => ({ pool, keyStore, issuer: ISSUER, workosEnabled: true,
    flags: { enabled: (orgId, flag) => orgId === fixture.organizationId && on.has(flag), anyEnabled: flag => on.has(flag) } });

  function routes(overrides: Partial<CloudRuntimeConnectOptions> = {}, extra: { without?: ("direct" | "relayUrl")[]; as?: AuthedUser } = {}) {
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", extra.as ?? user); await next(); });
    const options: CloudRuntimeConnectOptions = {
      capabilities: capabilities(), cloudWorkspaces: null,
      direct: { enginePort: 39393, endpoint: async () => ({ url: DIRECT_ENDPOINT }) },
      relayUrl: RELAY_URL, ...overrides,
    };
    for (const key of extra.without ?? []) delete options[key];
    app.route("/", createCloudRuntimeConnectRoutes(options));
    // As in production (app.ts): framework responses such as bodyLimit's 413 pass through.
    app.onError((error, c) => error instanceof HTTPException ? error.getResponse()
      : error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status)
      : c.json({ error: { code: "internal" } }, 500));
    return app;
  }

  const target = (template: string, ids: Ids = fixture) =>
    template.replace(":organization", ids.organizationId).replace(":workspace", ids.workspaceId);

  /** Device proof headers over the path ids plus the body, as clients sign them. */
  function proofHeaders(template: string, body: Record<string, unknown>, options: ProofOptions = {}): Record<string, string> {
    const ids = options.ids ?? fixture;
    const actor = options.actor ?? { user, deviceId, privateKey };
    const fields = { deviceId: actor.deviceId, keyVersion: options.keyVersion ?? 1, timestampMs: options.timestampMs ?? Date.now(),
      nonce: randomBytes(24).toString("base64url") };
    const action = options.action ?? (template === CLOUD_RUNTIME_CONNECT_PATH ? RUNTIME_CONNECT_PROOF_ACTION : RUNTIME_CAPABILITIES_PROOF_ACTION);
    const payload = options.payload ?? { organizationId: ids.organizationId.toLowerCase(), workspaceId: ids.workspaceId.toLowerCase(), ...body };
    const signature = sign(null, cloudWorkspaceDeviceProofMessage({ ...fields, accountUserId: actor.user.id, action, payload }), actor.privateKey)
      .toString("base64url");
    return { "x-zeros-device-id": fields.deviceId, "x-zeros-device-key-version": String(fields.keyVersion),
      "x-zeros-device-timestamp": String(fields.timestampMs), "x-zeros-device-nonce": fields.nonce, "x-zeros-device-signature": signature };
  }

  function send(template: string, headers: Record<string, string>, body: unknown, options: { app?: Hono; ids?: Ids; raw?: string | undefined } = {}) {
    return (options.app ?? routes()).request(target(template, options.ids ?? fixture), { method: "POST",
      headers: { "content-type": "application/json", ...headers }, body: options.raw ?? JSON.stringify(body) });
  }

  function post(template: string, body: Record<string, unknown>, options: ProofOptions & { app?: Hono } = {}) {
    return send(template, proofHeaders(template, body, options), body, options);
  }

  const renewBody = () => ({ deviceSessionId, clientSessionId: randomUUID() });
  async function failure(response: Response) {
    return (await response.json() as { error: Record<string, unknown> }).error;
  }

  const connectBody = (routesRequested: ("direct" | "relay")[] = ["direct", "relay"]) =>
    ({ deviceSessionId, clientSessionId: randomUUID(), routes: routesRequested });

  async function claims(token: string) {
    const { payload, protectedHeader } = await jwtVerify(token, signing.publicKey, { algorithms: ["EdDSA"], issuer: ISSUER });
    expect(protectedHeader.kid).toBe("cap-test-a");
    return CapabilityClaimsSchema.parse(payload);
  }

  async function bindActiveBoot(): Promise<CloudAgentBootScope> {
    const bootId = (await pool.query<{ id: string }>(
      "SELECT runtime_boot_id AS id FROM cloud_workspace_engine_instances WHERE id=$1", [fixture.engineInstanceId])).rows[0]!.id;
    const writerEpoch = randomUUID(), id = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_local_command_writers
      (workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch)
      VALUES($1,$2,1,$3,$4,$5,$6,1)`,
    [fixture.workspaceId, fixture.organizationId, fixture.engineInstanceId, bootId, writerEpoch, fixture.userId]);
    await pool.query(`INSERT INTO cloud_agent_boot_bindings
      (id,workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch,
       credentials_initialized,initial_adoptions) VALUES($1,$2,$3,1,$4,$5,$6,$7,1,true,$8)`,
    [id, fixture.workspaceId, fixture.organizationId, fixture.engineInstanceId, bootId, writerEpoch, fixture.userId,
      JSON.stringify(["claude", "codex", "cursor"].map(provider => ({ provider, status: "missing" })))]);
    await pool.query("UPDATE cloud_workspace_local_command_writers SET state='active',activated_at=now() WHERE writer_epoch=$1", [writerEpoch]);
    await pool.query("UPDATE cloud_workspaces SET agent_command_mode='boot-owner-v1',agent_boot_id=$2 WHERE id=$1", [fixture.workspaceId, id]);
    return { organizationId: fixture.organizationId, workspaceId: fixture.workspaceId, generation: 1,
      engineInstanceId: fixture.engineInstanceId, bootId, writerEpoch, fundingOwnerUserId: fixture.userId, fundingOwnerEpoch: 1 };
  }

  it("runtime_connect_returns_exact_active_boot_binding", async () => {
    const bootScope = await bindActiveBoot();
    const response = await post(CONNECT, connectBody());
    expect(response.status).toBe(201);
    const body = await response.json() as ConnectBody;
    const engine = await claims(body.capabilities.engine.token), realtime = await claims(body.capabilities.realtime.token);
    expect(body.runtimeBinding).toEqual({ authorityEpoch: engine.ep.wa, bootScope });
    expect(body.runtimeBinding?.authorityEpoch).toBe(realtime.ep.wa);
    expect(body).not.toHaveProperty("runtimeId");
    expect(body).not.toHaveProperty("connectionSequence");
  });

  it("advertises accepted work only for the supported exact boot and every required flag", async () => {
    await bindActiveBoot();
    for (const flag of ["realtime_uplink", "credential_push", "turn_journal", "detached_turns"] as const) on.add(flag);
    expect((await (await post(CONNECT, connectBody())).json()).runtimeBinding).not.toHaveProperty("acceptedWorkVersion");
    await pool.query("UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=1,accepted_work_version=1 WHERE id=$1", [fixture.engineInstanceId]);
    const current = await post(CONNECT, connectBody()); expect(current.status).toBe(201);
    expect((await current.json()).runtimeBinding.acceptedWorkVersion).toBe(1);
    on.delete("detached_turns");
    expect((await (await post(CONNECT, connectBody())).json()).runtimeBinding).not.toHaveProperty("acceptedWorkVersion");
  });

  it.each(["manager", "developer"])("keeps %s clients outside the funding owner on legacy command admission", async role => {
    await bindActiveBoot();
    for (const flag of ["realtime_uplink", "credential_push", "turn_journal", "detached_turns"] as const) on.add(flag);
    await pool.query("UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=1,accepted_work_version=1 WHERE id=$1", [fixture.engineInstanceId]);
    const peer = await account(`workos|${randomUUID()}`, `peer-${randomUUID()}@example.test`, "Peer");
    await pool.query("UPDATE users SET staff_role='developer' WHERE id=$1", [peer.user.id]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,$3)", [fixture.organizationId, peer.user.id, role === "manager" ? "admin" : "member"]);
    await pool.query("INSERT INTO organization_seat_assignments(org_id,user_id,state) VALUES($1,$2,'active')", [fixture.organizationId, peer.user.id]);
    await pool.query("UPDATE cloud_workspaces SET sharing_mode='organization',single_member_mode=false WHERE id=$1", [fixture.workspaceId]);
    const peerDevice = await device(peer.user), body = { ...connectBody(), deviceSessionId: peerDevice.deviceSessionId };
    const response = await post(CONNECT, body, { actor: { user: peer.user, ...peerDevice }, app: routes({}, { as: peer.user }) });
    expect(response.status, response.status === 201 ? undefined : JSON.stringify(await failure(response))).toBe(201);
    const connected = await response.json() as ConnectBody;
    expect((await claims(connected.capabilities.engine.token)).role).toBe(role);
    expect(connected.runtimeBinding).toBeDefined();
    expect(connected.runtimeBinding).not.toHaveProperty("acceptedWorkVersion");
  });

  it.each(["authority", "boot", "writer", "device", "session"] as const)("boot_or_authority_changes_during_direct_lookup_refuse_old_admission: %s", async change => {
    const boot = await bindActiveBoot();
    let changed = false;
    const endpoint = vi.fn(async () => {
      // This write must finish while the provider lookup is pending: endpoint
      // I/O cannot hold the workspace/engine locks needed to retire a boot.
      if (change === "authority") await pool.query("UPDATE cloud_workspaces SET authority_epoch=authority_epoch+1 WHERE id=$1", [fixture.workspaceId]);
      // Boot identity is immutable; retiring its engine invalidates that boot.
      if (change === "boot") await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1", [fixture.engineInstanceId]);
      if (change === "writer") await pool.query("UPDATE cloud_workspace_local_command_writers SET state='retired',retired_at=now() WHERE writer_epoch=$1", [boot.writerEpoch]);
      if (change === "device") await pool.query("UPDATE devices SET trust_state='revoked',revoked_at=now() WHERE id=$1", [deviceId]);
      if (change === "session") await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE id=$1", [authSessionId]);
      changed = true;
      return { url: DIRECT_ENDPOINT };
    });
    const response = await post(CONNECT, connectBody(), { app: routes({ direct: { enginePort: 39393, endpoint } }) });
    expect(endpoint).toHaveBeenCalledOnce();
    expect(changed).toBe(true);
    expect(response.status).toBe(503);
    expect(await failure(response)).toMatchObject({ code: "cloud_workspace_unavailable", retryable: true });
  });

  it("omits runtimeBinding only for an explicitly legacy boot", async () => {
    const response = await post(CONNECT, connectBody());
    expect(response.status).toBe(201);
    expect(await response.json()).not.toHaveProperty("runtimeBinding");
    const boot = await bindActiveBoot();
    await pool.query("UPDATE cloud_workspace_local_command_writers SET state='retired',retired_at=now() WHERE writer_epoch=$1", [boot.writerEpoch]);
    const inactive = await post(CONNECT, connectBody());
    expect(inactive.status).not.toBe(201);
    expect(await inactive.json()).not.toHaveProperty("capabilities");
  });

  it("refuses a lease that expires while the final writer lock is pending", async () => {
    const boot = await bindActiveBoot();
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    const endpoint = async () => {
      await pool.query("UPDATE cloud_workspace_engine_instances SET lease_expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1", [fixture.engineInstanceId]);
      await blocker.query("SELECT writer_epoch FROM cloud_workspace_local_command_writers WHERE writer_epoch=$1 FOR UPDATE", [boot.writerEpoch]);
      return { url: DIRECT_ENDPOINT };
    };
    const pending = post(CONNECT, connectBody(), { app: routes({ direct: { enginePort: 39393, endpoint } }) });
    try {
      // Wait for the actual lock boundary, not an assumed scheduling delay.
      await vi.waitFor(async () => {
        const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND query LIKE 'SELECT writer.writer_epoch%'
            AND wait_event_type='Lock'`);
        expect(waiting.rowCount).toBe(1);
      }, { timeout: 1_500, interval: 10 });
      await pool.query("SELECT pg_sleep(2.1)");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await failure(response)).toMatchObject({ code: "cloud_workspace_unavailable", retryable: true });
  });

  it("issues engine and realtime capabilities for the running engine with direct and relay routes", async () => {
    const response = await post(CLOUD_RUNTIME_CONNECT_PATH, connectBody());
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    const body = await response.json() as ConnectBody;
    expect(body).toMatchObject({
      workspaceId: fixture.workspaceId, generation: 1, engineInstanceId: fixture.engineInstanceId, relayHedgeMs: 400,
      routes: [{ kind: "direct", url: DIRECT_URL, priority: 0 }, { kind: "relay", url: RELAY_URL, priority: 1 }],
    });
    const engine = await claims(body.capabilities.engine.token), realtime = await claims(body.capabilities.realtime.token);
    const shared = {
      iss: ISSUER, knd: "client", sub: `user:${user.id}`, org: fixture.organizationId, wsp: fixture.workspaceId, gen: 1,
      ein: fixture.engineInstanceId, role: "owner", sid: authSessionId, did: deviceId,
      cnf: { jwk: { kty: "OKP", crv: "Ed25519", x: devicePublicKey.toString("base64url") } },
    };
    expect(engine).toMatchObject({ ...shared, aud: "zeros:engine" });
    expect(realtime).toMatchObject({ ...shared, aud: "zeros:realtime" });
    expect(engine.jti).not.toBe(realtime.jti);
    expect(body.capabilities.engine.expiresAt).toBe(new Date(engine.exp * 1000).toISOString());
    expect(body.capabilities.realtime.expiresAt).toBe(new Date(realtime.exp * 1000).toISOString());
    expect(Date.parse(body.renewAt)).toBeLessThan(Math.min(engine.exp, realtime.exp) * 1000);
  });

  it("renews both capabilities for the same engine", async () => {
    const response = await post(CLOUD_RUNTIME_CAPABILITIES_PATH, renewBody());
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as Pick<ConnectBody, "capabilities" | "renewAt">;
    expect(Object.keys(body).sort()).toEqual(["capabilities", "renewAt"]);
    expect(await claims(body.capabilities.engine.token)).toMatchObject({ aud: "zeros:engine", ein: fixture.engineInstanceId, did: deviceId });
    expect(await claims(body.capabilities.realtime.token)).toMatchObject({ aud: "zeros:realtime", ein: fixture.engineInstanceId, did: deviceId });
  });

  describe("gate", () => {
    it("answers the router's 404 without a limit or a database read while the flag is off", async () => {
      on.delete("runtime_connect");
      const app = routes({ capabilities: { ...capabilities(), pool: throwingPool } });
      for (let i = 0; i < 70; i++) {
        const response = await send(CONNECT, {}, {}, { app });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
        expect(response.headers.get("cache-control")).toBeNull();
      }
      const renewal = await send(RENEW, {}, {}, { app });
      expect(renewal.status).toBe(404);
      expect(await renewal.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
      expect(renewal.headers.get("cache-control")).toBeNull();
      on.add("runtime_connect");
      const response = await send(CONNECT, {}, {}, { app });
      expect(response.status).toBe(403);
      expect((await failure(response)).code).toBe("workspace_replica_device_proof_rejected");
    });

    it("answers 404 for path ids that are not UUIDs", async () => {
      const notUuid = await send(CONNECT, {}, {}, { ids: { organizationId: "not-a-uuid", workspaceId: fixture.workspaceId } });
      const shortWorkspace = await send(CONNECT, {}, {}, { ids: { organizationId: fixture.organizationId, workspaceId: "1234" } });
      for (const response of [notUuid, shortWorkspace]) {
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
      }
    });

    it("serves uppercase path ids as their lowercase form", async () => {
      const upper = { organizationId: fixture.organizationId.toUpperCase(), workspaceId: fixture.workspaceId.toUpperCase() };
      const response = await post(CONNECT, connectBody(), { ids: upper });
      expect(response.status).toBe(201);
      expect((await response.json() as ConnectBody).workspaceId).toBe(fixture.workspaceId);
      expect((await post(RENEW, renewBody(), { ids: upper })).status).toBe(201);
    });

    it("limits connect to 60 and renewal to 120 requests a minute per account", async () => {
      for (let i = 0; i < 60; i++) expect((await send(CONNECT, {}, {})).status).toBe(403);
      const limited = await send(CONNECT, {}, {});
      expect(limited.status).toBe(429);
      expect((await failure(limited)).code).toBe("rate_limited");
      expect(limited.headers.get("retry-after")).toMatch(/^[1-9][0-9]*$/);
      for (let i = 0; i < 120; i++) expect((await send(RENEW, {}, {})).status).toBe(403);
      expect((await send(RENEW, {}, {})).status).toBe(429);
    });
  });

  describe("device proof", () => {
    it.each<[string, (headers: Record<string, string>) => Record<string, string>]>([
      ["no proof headers", () => ({})],
      ["a short nonce", headers => ({ ...headers, "x-zeros-device-nonce": headers["x-zeros-device-nonce"]!.slice(0, 31) })],
      ["a short signature", headers => ({ ...headers, "x-zeros-device-signature": headers["x-zeros-device-signature"]!.slice(0, 85) })],
      ["key version 0", headers => ({ ...headers, "x-zeros-device-key-version": "0" })],
      ["a device id that is not a UUID", headers => ({ ...headers, "x-zeros-device-id": "device" })],
    ])("rejects %s with 403", async (_name, mutate) => {
      const body = connectBody();
      const response = await send(CONNECT, mutate(proofHeaders(CONNECT, body)), body);
      expect(response.status).toBe(403);
      expect((await failure(response)).code).toBe("workspace_replica_device_proof_rejected");
    });

    it.each<[string, () => Response | Promise<Response>]>([
      ["the renewal action", () => post(CONNECT, connectBody(), { action: RUNTIME_CAPABILITIES_PROOF_ACTION })],
      ["the connect action", () => post(RENEW, renewBody(), { action: RUNTIME_CONNECT_PROOF_ACTION })],
      ["another workspace", () => {
        const body = connectBody();
        return post(CONNECT, body, { payload: { organizationId: fixture.organizationId, workspaceId: randomUUID(), ...body } });
      }],
      ["another route order", () => {
        const body = connectBody(["relay", "direct"]);
        return post(CONNECT, body, { payload: { organizationId: fixture.organizationId, workspaceId: fixture.workspaceId, ...body, routes: ["direct", "relay"] } });
      }],
      ["the body alone", () => {
        const body = connectBody();
        return post(CONNECT, body, { payload: body });
      }],
    ])("rejects a proof signed for %s with 403", async (_name, request) => {
      const response = await request();
      expect(response.status).toBe(403);
      expect((await failure(response)).code).toBe("workspace_replica_device_proof_rejected");
    });

    it("rejects a stale proof and one for another key version with 403", async () => {
      const stale = await post(CONNECT, connectBody(), { timestampMs: Date.now() - 6 * 60_000 });
      expect(stale.status).toBe(403);
      expect((await failure(stale)).code).toBe("workspace_replica_device_proof_rejected");
      const otherVersion = await post(CONNECT, connectBody(), { keyVersion: 2 });
      expect(otherVersion.status).toBe(403);
      expect((await failure(otherVersion)).code).toBe("workspace_replica_device_proof_rejected");
    });

    it("accepts each proof once", async () => {
      const body = connectBody(), headers = proofHeaders(CONNECT, body);
      expect((await send(CONNECT, headers, body)).status).toBe(201);
      const replay = await send(CONNECT, headers, body);
      expect(replay.status).toBe(409);
      expect((await failure(replay)).code).toBe("workspace_replica_device_proof_replayed");
      const renewal = renewBody(), renewalHeaders = proofHeaders(RENEW, renewal);
      expect((await send(RENEW, renewalHeaders, renewal)).status).toBe(201);
      const renewalReplay = await send(RENEW, renewalHeaders, renewal);
      expect(renewalReplay.status).toBe(409);
      expect((await failure(renewalReplay)).code).toBe("workspace_replica_device_proof_replayed");
    });
  });

  describe("body", () => {
    it.each<[string, () => Record<string, unknown>, string?]>([
      ["no JSON", () => ({}), "not json"],
      ["no fields", () => ({})],
      ["no routes", () => ({ ...connectBody(), routes: [] })],
      ["a repeated route", () => connectBody(["direct", "direct"])],
      ["three routes", () => ({ ...connectBody(), routes: ["direct", "relay", "relay"] })],
      ["an unknown route", () => ({ ...connectBody(), routes: ["ssh"] })],
      ["an uppercase device session id", () => ({ ...connectBody(), deviceSessionId: deviceSessionId.toUpperCase() })],
      ["no client session id", () => ({ deviceSessionId, routes: ["direct"] })],
      ["an unknown field", () => ({ ...connectBody(), engineInstanceId: fixture.engineInstanceId })],
    ])("rejects a connect body with %s with 422", async (_name, makeBody, raw) => {
      const body = makeBody(), headers = proofHeaders(CONNECT, body);
      const response = await send(CONNECT, headers, body, { raw });
      expect(response.status).toBe(422);
      expect(await failure(response)).toMatchObject({ code: "invalid_input" });
      expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("rejects a renewal body with routes or without a client session id with 422", async () => {
      for (const body of [{ ...renewBody(), routes: ["direct"] }, { deviceSessionId }]) {
        const response = await send(RENEW, proofHeaders(RENEW, body), body);
        expect(response.status).toBe(422);
        expect((await failure(response)).code).toBe("invalid_input");
      }
    });

    it("refuses a body over 4 KiB with 413", async () => {
      const response = await post(CONNECT, { ...connectBody(), clientSessionId: "x".repeat(5000) });
      expect(response.status).toBe(413);
    });
  });

  describe("refusals", () => {
    it.each<[string, ("direct" | "relay")[], () => Hono, () => void]>([
      ["relay without a relay URL", ["relay"], () => routes({}, { without: ["relayUrl"] }), () => {}],
      ["relay with relay_over_uplink off", ["relay"], () => { on.delete("relay_over_uplink"); return routes(); }, () => { on.add("relay_over_uplink"); }],
      ["direct without a direct route", ["direct"], () => routes({}, { without: ["direct"] }), () => {}],
    ])("answers 503 runtime_not_configured for %s without using the proof", async (_name, requested, refusing, restore) => {
      const body = connectBody(requested), headers = proofHeaders(CONNECT, body);
      const response = await send(CONNECT, headers, body, { app: refusing() });
      expect(response.status).toBe(503);
      expect(await failure(response)).toMatchObject({ code: "cloud_workspace_runtime_not_configured", retryable: false });
      restore();
      expect((await send(CONNECT, headers, body)).status).toBe(201);
    });

    it("answers 409 not_running with wakeable false when no engine is ready", async () => {
      await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1", [fixture.engineInstanceId]);
      for (const response of [await post(CONNECT, connectBody()), await post(RENEW, renewBody())]) {
        expect(response.status).toBe(409);
        expect(await failure(response)).toMatchObject({ code: "cloud_workspace_not_running", wakeable: false });
      }
    });

    it("answers 404 cloud_workspace_not_found for a deleted or unknown workspace", async () => {
      const unknown = await post(CONNECT, connectBody(), { ids: { organizationId: fixture.organizationId, workspaceId: randomUUID() } });
      expect(unknown.status).toBe(404);
      expect(await failure(unknown)).toMatchObject({ code: "cloud_workspace_not_found" });
      await pool.query("UPDATE cloud_workspaces SET status='deleted',desired_state='deleted',deleted_at=now() WHERE id=$1", [fixture.workspaceId]);
      for (const response of [await post(CONNECT, connectBody()), await post(RENEW, renewBody())]) {
        expect(response.status).toBe(404);
        expect(await failure(response)).toMatchObject({ code: "cloud_workspace_not_found" });
      }
    });

    it("answers 403 workspace_role_required to an account without a role", async () => {
      const stranger = await account(`workos|${randomUUID()}`, `stranger-${randomUUID()}@example.test`, "Stranger");
      const theirs = await device(stranger.user);
      const response = await post(CONNECT, { ...connectBody(), deviceSessionId: theirs.deviceSessionId },
        { app: routes({}, { as: stranger.user }), actor: { user: stranger.user, deviceId: theirs.deviceId, privateKey: theirs.privateKey } });
      expect(response.status).toBe(403);
      expect((await failure(response)).code).toBe("workspace_role_required");
    });

    it("answers 409 cloud_workspace_v2_required for an unsupported generation", async () => {
      await seed({ supportedGeneration: false });
      const response = await post(CONNECT, connectBody());
      expect(response.status).toBe(409);
      expect((await failure(response)).code).toBe("cloud_workspace_v2_required");
    });

    it.each<[string, () => Promise<Record<string, unknown>>]>([
      ["an unknown device session", async () => ({ ...connectBody(), deviceSessionId: randomUUID() })],
      ["another device's session", async () => {
        const other = await device(user);
        return { ...connectBody(), deviceSessionId: other.deviceSessionId };
      }],
      ["an expired device session", async () => {
        await pool.query("UPDATE cloud_device_sessions SET expires_at=clock_timestamp() - interval '1 second', ticket_expires_at=clock_timestamp() - interval '2 seconds', created_at=created_at - interval '1 minute' WHERE id=$1", [deviceSessionId]);
        return connectBody();
      }],
      ["a revoked device", async () => {
        await pool.query("UPDATE devices SET trust_state='revoked', revoked_at=now() WHERE id=$1", [deviceId]);
        return connectBody();
      }],
      ["a revoked CP session", async () => {
        await pool.query("UPDATE auth_sessions SET status='revoked', revoked_at=now() WHERE id=$1", [authSessionId]);
        return connectBody();
      }],
    ])("answers 409 device_session_expired for %s", async (_name, setup) => {
      const response = await post(CONNECT, await setup());
      expect(response.status).toBe(409);
      expect((await failure(response)).code).toBe("device_session_expired");
    });

    it("answers 403 capability_revoked when the bearer's CP session is not recorded", async () => {
      const ghost = { ...user, authentication: { ...user.authentication, sessionId: `session_${randomUUID()}` } } as AuthedUser;
      const response = await post(CONNECT, connectBody(), { app: routes({}, { as: ghost }), actor: { user: ghost, deviceId, privateKey } });
      expect(response.status).toBe(403);
      expect((await failure(response)).code).toBe("capability_revoked");
    });

    it("answers 503 capability_issuer_unavailable without using the proof", async () => {
      const body = connectBody(), headers = proofHeaders(CONNECT, body);
      const app = routes({ capabilities: { ...capabilities(), keyStore: { signer: () => null } as unknown as CapabilitySigningKeyStore } });
      const response = await send(CONNECT, headers, body, { app });
      expect(response.status).toBe(503);
      expect(await failure(response)).toMatchObject({ code: "capability_issuer_unavailable", retryable: true });
      expect((await send(CONNECT, headers, body)).status).toBe(201);
    });
  });

  describe("routes", () => {
    it.each<[("direct" | "relay")[], ConnectBody["routes"]]>([
      [["direct"], [{ kind: "direct", url: DIRECT_URL, priority: 0 }]],
      [["relay"], [{ kind: "relay", url: RELAY_URL, priority: 1 }]],
      [["relay", "direct"], [{ kind: "direct", url: DIRECT_URL, priority: 0 }, { kind: "relay", url: RELAY_URL, priority: 1 }]],
    ])("offers %j as the requested routes, direct first", async (requested, expected) => {
      const response = await post(CONNECT, connectBody(requested));
      expect(response.status).toBe(201);
      expect((await response.json() as ConnectBody).routes).toEqual(expected);
    });

    it("omits relay while relay_over_uplink is off", async () => {
      on.delete("relay_over_uplink");
      const response = await post(CONNECT, connectBody());
      expect(response.status).toBe(201);
      expect((await response.json() as ConnectBody).routes).toEqual([{ kind: "direct", url: DIRECT_URL, priority: 0 }]);
    });

    it("falls back to relay when the direct lookup fails, without logging provider detail", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const app = routes({ direct: { enginePort: 39393, endpoint: async () => { throw new Error("provider-secret-detail"); } } });
        const response = await post(CONNECT, connectBody(), { app });
        expect(response.status).toBe(201);
        expect((await response.json() as ConnectBody).routes).toEqual([{ kind: "relay", url: RELAY_URL, priority: 1 }]);
        const logged = JSON.stringify(warn.mock.calls);
        expect(logged).toContain("[cloud-runtime] direct route unavailable");
        expect(logged).not.toContain("provider-secret-detail");
      } finally {
        warn.mockRestore();
      }
    });

    it.each<[string, { url: string; headerName?: string; headerValue?: string }]>([
      ["over http", { url: "http://verified-sandbox-39393.on.boat.dev/" }],
      ["that needs a header", { url: DIRECT_ENDPOINT, headerName: "x-auth", headerValue: "v" }],
    ])("drops a direct endpoint %s", async (_name, endpoint) => {
      const response = await post(CONNECT, connectBody(), { app: routes({ direct: { enginePort: 39393, endpoint: async () => endpoint } }) });
      expect(response.status).toBe(201);
      expect((await response.json() as ConnectBody).routes).toEqual([{ kind: "relay", url: RELAY_URL, priority: 1 }]);
    });

    it("answers 503 cloud_workspace_unavailable when the only requested route is unavailable", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const app = routes({ direct: { enginePort: 39393, endpoint: async () => { throw new Error("provider-secret-detail"); } } });
        const response = await post(CONNECT, connectBody(["direct"]), { app });
        expect(response.status).toBe(503);
        expect(await failure(response)).toMatchObject({ code: "cloud_workspace_unavailable", retryable: true });
      } finally {
        warn.mockRestore();
      }
    });

    it("gives up on the direct lookup after 5 seconds", async () => {
      const app = routes({ direct: { enginePort: 39393, endpoint: () => new Promise<never>(() => {}) } });
      const started = Date.now();
      const response = await post(CONNECT, connectBody(), { app });
      const elapsed = Date.now() - started;
      expect(response.status).toBe(201);
      expect((await response.json() as ConnectBody).routes).toEqual([{ kind: "relay", url: RELAY_URL, priority: 1 }]);
      expect(elapsed).toBeGreaterThanOrEqual(4_900);
      expect(elapsed).toBeLessThan(15_000);
    });

    it.each<[number, number]>([[100, 300], [900, 500], [450.4, 450], [Number.NaN, 400]])("serves relayHedgeMs %s as %s", async (input, expected) => {
      const response = await post(CONNECT, connectBody(), { app: routes({ relayHedgeMs: input }) });
      expect(response.status).toBe(201);
      expect((await response.json() as ConnectBody).relayHedgeMs).toBe(expected);
    });
  });
});
