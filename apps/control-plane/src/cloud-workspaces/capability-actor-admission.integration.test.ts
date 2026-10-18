import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureUser, type AuthedUser } from "../auth.js";
import { withSystemTx } from "../db.js";
import type { RolloutFlagName } from "../rollout-flags.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import {
  CLOUD_ACTOR_ADMISSION_AUDIENCE,
  CLOUD_CAPABILITY_ACTOR_ADMISSION_PATH,
  DatabaseCloudWorkspaceActorSessionService,
  assertCloudActorSession,
} from "./actor-sessions.js";
import { issueClientCapabilities } from "./capability-issuer.js";
import type { CapabilitySigningKeyStore } from "./capability-keys.js";
import { createEngineClientCapabilityGate } from "./capability-service-verifier.js";
import { capabilityProofMessage, type CapabilityRoute } from "./capability-verifier.js";
import { testEd25519Key, testSigningJwk } from "./capability-verifier-test-utils.js";
import { createCloudWorkspaceInternalRoutes, type CloudWorkspaceInternalSetupService } from "./internal-routes.js";
import { seedReadyCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";

vi.setConfig({ testTimeout: 30_000 });

const ISSUER = "https://cp.example.test";
const KID = "cap-2026-10-actor";
const issuerKey = testEd25519Key(KID);
const keyStore = {
  signer: () => ({ kid: KID, key: issuerKey.privateKey }),
  publicKeySet: () => PUBLISHED,
} as unknown as CapabilitySigningKeyStore;
const PUBLISHED = Object.freeze([testSigningJwk(KID)]);
const RESPONSE_KEYS = ["accountUserId", "actorSessionId", "admitted", "audience", "authorityEpoch", "deviceId",
  "fingerprint", "renewalToken", "role", "version"];

type Proof = { timestampMs: number; nonce: string; signature: string };
type Body = { workspaceId: string; organizationId: string; generation: number; engineInstanceId: string;
  capability: string; proof: Proof; route: CapabilityRoute };

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("capability-backed actor admission with PostgreSQL", () => {
  let pool: pg.Pool;
  let fixture: ReadyCloudWorkspaceFixture;
  let user: AuthedUser;
  let authSessionId: string;
  let deviceId: string;
  let privateKey: KeyObject;
  let actors: DatabaseCloudWorkspaceActorSessionService;
  /** Flags on for the fixture organization only. */
  let on: Set<RolloutFlagName>;

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  afterAll(async () => { await pool.end(); });

  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    await pool.query("INSERT INTO workos_organization_links(organization_id,workos_organization_id,external_id,state) VALUES($1::uuid,$2,$1::text,'active')",
      [fixture.organizationId, `org_${randomUUID()}`]);
    await pool.query("UPDATE cloud_workspace_engine_instances SET actor_protocol_version=2 WHERE id=$1", [fixture.engineInstanceId]);
    on = new Set<RolloutFlagName>(["capabilities"]);
    user = await ensureUser(pool, { provider: "workos", providerSubject: `workos|${fixture.userId}`, email: `actor-${fixture.userId}@example.test`,
      displayName: "Owner", session: { id: `session_${randomUUID()}`, clientKind: "desktop", authTime: Math.floor(Date.now() / 1000),
        tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600 } });
    authSessionId = (await pool.query<{ id: string }>(`INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at)
      VALUES($1,$2,$3,'desktop',now()+interval '1 hour') RETURNING id`, [user.authentication.sessionId, user.identity.subject, user.id])).rows[0]!.id;
    const keys = generateKeyPairSync("ed25519");
    privateKey = keys.privateKey;
    const publicKey = Buffer.from(keys.publicKey.export({ format: "jwk" }).x!, "base64url");
    deviceId = (await pool.query<{ id: string }>(
      "INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint) VALUES($1,'Actor','macos',$2,$3) RETURNING id",
      [user.id, publicKey, createHash("sha256").update(publicKey).digest()])).rows[0]!.id;
    actors = new DatabaseCloudWorkspaceActorSessionService({ pool, enginePort: 39393,
      bridgeUrl: "wss://api.example.test/v1/cloud-workspaces/bridge", workosEnabled: true });
  });

  const engine = () => ({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1,
    engineInstanceId: fixture.engineInstanceId, heartbeatToken: fixture.heartbeatToken });

  function routes() {
    const service = { admitCapabilityActor: (input: Parameters<DatabaseCloudWorkspaceActorSessionService["admitCapability"]>[0]) =>
      actors.admitCapability(input) } as unknown as CloudWorkspaceInternalSetupService;
    return createCloudWorkspaceInternalRoutes(service, { clientCapabilities: createEngineClientCapabilityGate({ pool, keyStore,
      issuer: ISSUER, workosEnabled: true,
      flags: { enabled: (orgId, flag) => orgId === fixture.organizationId && on.has(flag), anyEnabled: flag => on.has(flag) } }) });
  }

  async function engineCapability(): Promise<string> {
    const issued = await withSystemTx(pool, tx => issueClientCapabilities(tx, keyStore, ISSUER, { organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId, actorUserId: user.id, deviceId, sessionId: authSessionId }, ["zeros:engine"]));
    return issued.capabilities["zeros:engine"].token;
  }

  function proof(capability: string, route: CapabilityRoute, key: KeyObject = privateKey): Proof {
    const claims = JSON.parse(Buffer.from(capability.split(".")[1]!, "base64url").toString("utf8")) as { aud: string; wsp: string; jti: string };
    const timestampMs = Date.now(), nonce = randomBytes(16).toString("base64url");
    const signature = sign(null, capabilityProofMessage({ aud: claims.aud, wsp: claims.wsp, jti: claims.jti, timestampMs, nonce, route }), key)
      .toString("base64url");
    return { timestampMs, nonce, signature };
  }

  async function body(overrides: Partial<Body> = {}): Promise<Body> {
    const capability = overrides.capability ?? await engineCapability();
    const route = overrides.route ?? "direct";
    const { heartbeatToken: _heartbeat, ...scope } = engine();
    return { ...scope, capability, proof: proof(capability, route), route, ...overrides };
  }

  function post(value: unknown, options: { heartbeatToken?: string | null; app?: ReturnType<typeof routes> } = {}) {
    const heartbeatToken = options.heartbeatToken === undefined ? fixture.heartbeatToken : options.heartbeatToken;
    return (options.app ?? routes()).request(CLOUD_CAPABILITY_ACTOR_ADMISSION_PATH, { method: "POST",
      headers: { "content-type": "application/json", ...(heartbeatToken ? { authorization: `Bearer ${heartbeatToken}` } : {}) },
      body: JSON.stringify(value) });
  }

  async function errorCode(response: Response): Promise<unknown> {
    return ((await response.json()) as { error?: { code?: unknown } }).error?.code;
  }

  async function sessionCount(): Promise<number> {
    return Number((await pool.query<{ count: string }>("SELECT count(*) FROM cloud_workspace_actor_sessions WHERE workspace_id=$1",
      [fixture.workspaceId])).rows[0]!.count);
  }

  async function expectRejected(response: Response, status: number, code: string): Promise<void> {
    expect(response.status).toBe(status);
    expect(await errorCode(response)).toBe(code);
    expect(await sessionCount()).toBe(0);
  }

  it("admits a verified client as a consumed actor session the engine renews like a grant", async () => {
    const request = await body();
    const response = await post(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const admitted = await response.json() as Record<string, unknown> & { actorSessionId: string; renewalToken: string };
    expect(Object.keys(admitted).sort()).toEqual(RESPONSE_KEYS);
    const epoch = Number((await pool.query<{ authority_epoch: string }>("SELECT authority_epoch FROM cloud_workspaces WHERE id=$1",
      [fixture.workspaceId])).rows[0]!.authority_epoch);
    expect(admitted).toMatchObject({ version: 2, audience: CLOUD_ACTOR_ADMISSION_AUDIENCE, admitted: true, authorityEpoch: epoch,
      accountUserId: user.id, deviceId, role: "owner" });
    expect(admitted.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(admitted.renewalToken).toMatch(/^zwa_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(admitted)).not.toContain(request.capability);
    const row = (await pool.query(`SELECT generation,engine_instance_id,actor_user_id,device_id,device_key_version,actor_role,token_hash,
        consumed_at IS NOT NULL AS consumed,last_renewed_at IS NOT NULL AS renewed,revoked_at,auth_provider,auth_subject,auth_session_id,
        session_expires_at>clock_timestamp()+interval '23 hours' AS day_long
      FROM cloud_workspace_actor_sessions WHERE id=$1`, [admitted.actorSessionId])).rows[0];
    expect(row).toMatchObject({ generation: 1, engine_instance_id: fixture.engineInstanceId, actor_user_id: user.id, device_id: deviceId,
      device_key_version: "1", actor_role: "owner", consumed: true, renewed: true, revoked_at: null, auth_provider: "workos",
      auth_subject: user.identity.subject, auth_session_id: user.authentication.sessionId, day_long: true });
    expect(Buffer.compare(row.token_hash, createHash("sha256").update(admitted.renewalToken).digest())).toBe(0);
    await expect(actors.consume({ ...engine(), token: admitted.renewalToken, renew: true }))
      .resolves.toMatchObject({ actorSessionId: admitted.actorSessionId, accountUserId: user.id, deviceId, role: "owner" });
    const { heartbeatToken: _heartbeat, ...scope } = engine();
    await expect(withSystemTx(pool, tx => assertCloudActorSession(tx, scope, admitted.actorSessionId, "read")))
      .resolves.toMatchObject({ sessionId: admitted.actorSessionId, role: "owner", deviceId });
  });

  it("never lets the session be redeemed as a grant or open a relay", async () => {
    const admitted = await (await post(await body())).json() as { renewalToken: string };
    await expect(actors.consume({ ...engine(), token: admitted.renewalToken })).rejects.toMatchObject({ status: 401 });
    expect(await actors.authorizeRelay(admitted.renewalToken)).toBeNull();
  });

  it("admits on the relay route with a proof signed for it", async () => {
    expect((await post(await body({ route: "relay" }))).status).toBe(200);
  });

  it("refuses a proof replayed, signed for another route or by another key", async () => {
    const request = await body();
    const app = routes();
    expect((await post(request, { app })).status).toBe(200);
    const replayed = await post(request, { app });
    expect(replayed.status).toBe(401);
    expect(await errorCode(replayed)).toBe("capability_proof_invalid");
    expect(await sessionCount()).toBe(1);
    const capability = await engineCapability();
    const otherRoute = await post({ ...(await body({ capability })), proof: proof(capability, "relay"), route: "direct" });
    expect(await errorCode(otherRoute)).toBe("capability_proof_invalid");
    const stranger = await post({ ...(await body({ capability })), proof: proof(capability, "direct", generateKeyPairSync("ed25519").privateKey) });
    expect(await errorCode(stranger)).toBe("capability_proof_invalid");
    expect(await sessionCount()).toBe(1);
  });

  it("refuses a token not signed by the issuer and one for another audience", async () => {
    const capability = await engineCapability();
    const [header, payload] = capability.split(".");
    const forged = `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), generateKeyPairSync("ed25519").privateKey).toString("base64url")}`;
    await expectRejected(await post(await body({ capability: forged })), 401, "capability_signature_invalid");
    const realtime = (await withSystemTx(pool, tx => issueClientCapabilities(tx, keyStore, ISSUER, { organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId, actorUserId: user.id, deviceId, sessionId: authSessionId }, ["zeros:realtime"]))).capabilities["zeros:realtime"].token;
    await expectRejected(await post(await body({ capability: realtime })), 401, "capability_audience_mismatch");
  });

  it("answers an organization with the flag off like a rejected admission", async () => {
    const request = await body();
    on.delete("capabilities");
    await expectRejected(await post(request), 401, "cloud_actor_admission_rejected");
  });

  it("requires this engine's current heartbeat credential", async () => {
    const request = await body();
    await expectRejected(await post(request, { heartbeatToken: null }), 401, "invalid_capability");
    await expectRejected(await post(await body(), { heartbeatToken: `zwh_${randomBytes(32).toString("base64url")}` }), 401,
      "cloud_actor_admission_rejected");
    await pool.query("UPDATE cloud_workspace_engine_instances SET lease_expires_at=clock_timestamp() WHERE id=$1", [fixture.engineInstanceId]);
    expect((await post(await body())).status).toBe(401);
    expect(await sessionCount()).toBe(0);
  });

  it("refuses a request for another generation than the token's", async () => {
    await expectRejected(await post({ ...(await body()), generation: 2 }), 401, "cloud_actor_admission_rejected");
  });

  it("rejects a body with unknown or missing members", async () => {
    const request = await body();
    await expectRejected(await post({ ...request, renew: true }), 422, "invalid_request");
    const { route: _route, ...withoutRoute } = request;
    await expectRejected(await post(withoutRoute), 422, "invalid_request");
    await expectRejected(await post({ ...request, proof: { ...request.proof, extra: 1 } }), 422, "invalid_request");
  });

  it.each([
    ["the workspace authority epoch", "UPDATE cloud_workspaces SET authority_epoch=authority_epoch+1 WHERE id=$1", "workspace"],
    ["the workspace access revision", "UPDATE cloud_workspaces SET access_revision=access_revision+1 WHERE id=$1", "workspace"],
    ["the member epoch", `INSERT INTO cloud_capability_member_epochs(org_id,user_id,epoch) VALUES($1,$2,2)
      ON CONFLICT(org_id,user_id) DO UPDATE SET epoch=cloud_capability_member_epochs.epoch+1`, "member"],
    ["the account auth revision", "UPDATE users SET auth_revision=auth_revision+1 WHERE id=$1", "user"],
    ["the device key version", "UPDATE devices SET key_version=key_version+1 WHERE id=$1", "device"],
    ["the device trust", "UPDATE devices SET trust_state='revoked',revoked_at=now() WHERE id=$1", "device"],
    ["the source session", "UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE id=$1", "session"],
  ] as const)("refuses a token issued before a change of %s", async (_name, statement, target) => {
    const request = await body();
    const parameters = target === "workspace" ? [fixture.workspaceId] : target === "member" ? [fixture.organizationId, user.id]
      : target === "user" ? [user.id] : target === "device" ? [deviceId] : [authSessionId];
    await pool.query(statement, parameters);
    await expectRejected(await post(request), 401, "cloud_actor_admission_rejected");
  });

  it("keeps the workspace's limit of 100 live connections", async () => {
    const first = await (await post(await body())).json() as { actorSessionId: string };
    await pool.query(`INSERT INTO cloud_workspace_actor_sessions
        (id,workspace_id,org_id,generation,engine_instance_id,actor_user_id,device_id,device_key_version,authority_epoch,actor_fingerprint,
         actor_role,token_hash,admission_expires_at,session_expires_at,consumed_at,last_renewed_at,auth_provider,auth_subject,auth_session_id,
         auth_session_created_at)
      SELECT gen_random_uuid(),workspace_id,org_id,generation,engine_instance_id,actor_user_id,device_id,device_key_version,authority_epoch,
        actor_fingerprint,actor_role,sha256(convert_to(gen_random_uuid()::text,'UTF8')),admission_expires_at,session_expires_at,consumed_at,
        last_renewed_at,auth_provider,auth_subject,auth_session_id,auth_session_created_at
      FROM cloud_workspace_actor_sessions, generate_series(1,99) WHERE id=$1`, [first.actorSessionId]);
    const limited = await post(await body());
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe("cloud_actor_session_limit");
    expect(await sessionCount()).toBe(100);
    await pool.query("UPDATE cloud_workspace_actor_sessions SET last_renewed_at=clock_timestamp()-interval '31 seconds' WHERE workspace_id=$1",
      [fixture.workspaceId]);
    expect((await post(await body())).status).toBe(200);
  });
});
