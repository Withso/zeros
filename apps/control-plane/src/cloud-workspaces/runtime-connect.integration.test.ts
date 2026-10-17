import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { Hono } from "hono";
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

type Grant = { token: string; expiresAt: string };
type ConnectBody = {
  workspaceId: string; generation: number; engineInstanceId: string;
  capabilities: { engine: Grant; realtime: Grant };
  routes: { kind: "direct" | "relay"; url: string; priority: number }[];
  renewAt: string; relayHedgeMs: number;
};

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("runtime connect and capability renewal with PostgreSQL", () => {
  let pool: pg.Pool;
  let fixture: ReadyCloudWorkspaceFixture;
  let user: AuthedUser;
  let authSessionId: string;
  let deviceId: string;
  let devicePublicKey: Buffer;
  let pair: ReturnType<typeof generateKeyPairSync>;
  let deviceSessionId: string;
  /** Flags on for the fixture organization only. */
  let on: Set<RolloutFlagName>;

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    // WorkOS deployments also require the organization's active WorkOS link.
    await pool.query("INSERT INTO workos_organization_links(organization_id,workos_organization_id,external_id,state) VALUES($1::uuid,$2,$1::text,'active')",
      [fixture.organizationId, `org_${randomUUID()}`]);
    on = new Set<RolloutFlagName>(["capabilities", "runtime_connect", "relay_over_uplink"]);
    user = await ensureUser(pool, { provider: "workos", providerSubject: `workos|${fixture.userId}`, email: `connect-${fixture.userId}@example.test`,
      displayName: "Owner", session: { id: `session_${randomUUID()}`, clientKind: "desktop", authTime: Math.floor(Date.now() / 1000),
        tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600 } });
    authSessionId = (await pool.query<{ id: string }>(`INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at)
      VALUES($1,$2,$3,'desktop',now()+interval '1 hour') RETURNING id`, [user.authentication.sessionId, user.identity.subject, user.id])).rows[0]!.id;
    pair = generateKeyPairSync("ed25519");
    devicePublicKey = Buffer.from(pair.publicKey.export({ format: "jwk" }).x!, "base64url");
    deviceId = (await pool.query<{ id: string }>(
      "INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint) VALUES($1,'Connect','macos',$2,$3) RETURNING id",
      [user.id, devicePublicKey, createHash("sha256").update(devicePublicKey).digest()])).rows[0]!.id;
    deviceSessionId = (await withSystemTx(pool, tx => issueDeviceSession(tx, { accountUserId: user.id, deviceId,
      providerSessionId: user.authentication.sessionId, reuseId: null }))).deviceSessionId;
  });

  function routes(overrides: Partial<CloudRuntimeConnectOptions> = {}) {
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", user); await next(); });
    app.route("/", createCloudRuntimeConnectRoutes({
      capabilities: { pool, keyStore, issuer: ISSUER, workosEnabled: true,
        flags: { enabled: (orgId, flag) => orgId === fixture.organizationId && on.has(flag), anyEnabled: flag => on.has(flag) } },
      cloudWorkspaces: null,
      direct: { enginePort: 39393, endpoint: async () => ({ url: DIRECT_ENDPOINT }) },
      relayUrl: RELAY_URL,
      ...overrides,
    }));
    app.onError((error, c) => error instanceof HttpError
      ? c.json({ error: { code: error.code } }, error.status)
      : c.json({ error: { code: "internal" } }, 500));
    return app;
  }

  const target = (template: string, ids: { organizationId: string; workspaceId: string } = fixture) =>
    template.replace(":organization", ids.organizationId).replace(":workspace", ids.workspaceId);

  /** POSTs with a device proof over the path ids plus the body, as clients sign it. */
  function post(template: string, body: Record<string, unknown>, options: {
    app?: Hono; action?: string; payload?: unknown; ids?: { organizationId: string; workspaceId: string };
  } = {}) {
    const ids = options.ids ?? fixture;
    const fields = { deviceId, keyVersion: 1, timestampMs: Date.now(), nonce: randomBytes(24).toString("base64url") };
    const action = options.action ?? (template === CLOUD_RUNTIME_CONNECT_PATH ? RUNTIME_CONNECT_PROOF_ACTION : RUNTIME_CAPABILITIES_PROOF_ACTION);
    const payload = options.payload ?? { organizationId: ids.organizationId.toLowerCase(), workspaceId: ids.workspaceId.toLowerCase(), ...body };
    const signature = sign(null, cloudWorkspaceDeviceProofMessage({ ...fields, accountUserId: user.id, action, payload }), pair.privateKey)
      .toString("base64url");
    return (options.app ?? routes()).request(target(template, ids), { method: "POST", headers: { "content-type": "application/json",
      "x-zeros-device-id": deviceId, "x-zeros-device-key-version": "1", "x-zeros-device-timestamp": String(fields.timestampMs),
      "x-zeros-device-nonce": fields.nonce, "x-zeros-device-signature": signature }, body: JSON.stringify(body) });
  }
  const connectBody = (routesRequested: ("direct" | "relay")[] = ["direct", "relay"]) =>
    ({ deviceSessionId, clientSessionId: randomUUID(), routes: routesRequested });

  async function claims(token: string) {
    const { payload, protectedHeader } = await jwtVerify(token, signing.publicKey, { algorithms: ["EdDSA"], issuer: ISSUER });
    expect(protectedHeader.kid).toBe("cap-test-a");
    return CapabilityClaimsSchema.parse(payload);
  }

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
    const response = await post(CLOUD_RUNTIME_CAPABILITIES_PATH, { deviceSessionId, clientSessionId: randomUUID() });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as Pick<ConnectBody, "capabilities" | "renewAt">;
    expect(Object.keys(body).sort()).toEqual(["capabilities", "renewAt"]);
    expect(await claims(body.capabilities.engine.token)).toMatchObject({ aud: "zeros:engine", ein: fixture.engineInstanceId, did: deviceId });
    expect(await claims(body.capabilities.realtime.token)).toMatchObject({ aud: "zeros:realtime", ein: fixture.engineInstanceId, did: deviceId });
  });
});
