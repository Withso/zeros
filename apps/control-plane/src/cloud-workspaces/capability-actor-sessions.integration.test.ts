import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureUser, type AuthedUser } from "../auth.js";
import { withSystemTx } from "../db.js";
import type { RolloutFlagName } from "../rollout-flags.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { DatabaseCloudWorkspaceActorSessionService, assertCloudActorSession } from "./actor-sessions.js";
import { issueClientCapabilities } from "./capability-issuer.js";
import type { CapabilitySigningKeyStore } from "./capability-keys.js";
import { createEngineClientCapabilityGate } from "./capability-service-verifier.js";
import { capabilityProofMessage, type CapabilityRoute } from "./capability-verifier.js";
import { testEd25519Key, testSigningJwk } from "./capability-verifier-test-utils.js";
import { createCloudWorkspaceInternalRoutes, type CloudWorkspaceInternalSetupService } from "./internal-routes.js";
import { seedReadyCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";

vi.setConfig({ testTimeout: 30_000 });
const ISSUER = "https://cp.example.test", KID = "cap-2026-10-session";
const signingKey = testEd25519Key(KID), published = Object.freeze([testSigningJwk(KID)]);
const keyStore = { signer: () => ({ kid: KID, key: signingKey.privateKey }), publicKeySet: () => published } as unknown as CapabilitySigningKeyStore;
const ADMIT = "/internal/v2/cloud-workspaces/engine/capability-session-admission";
const RENEW = "/internal/v2/cloud-workspaces/engine/capability-session-renewal";
const LEGACY = "/internal/v2/cloud-workspaces/engine/capability-admission";
type FutureService = {
  admitCapabilitySession(input: unknown): Promise<unknown>;
  renewCapabilitySession(input: unknown): Promise<unknown>;
};
type Admission = { actorSessionId: string; mode: string; capability: { claims: { exp: number }; revision: number } };

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("capability actor sessions with PostgreSQL", () => {
  let pool: pg.Pool, fixture: ReadyCloudWorkspaceFixture, user: AuthedUser, sourceId: string, deviceId: string;
  let deviceKey: KeyObject, actors: DatabaseCloudWorkspaceActorSessionService, on: Set<RolloutFlagName>;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    await pool.query("INSERT INTO workos_organization_links(organization_id,workos_organization_id,external_id,state) VALUES($1::uuid,$2,$1::text,'active')",
      [fixture.organizationId, `org_${randomUUID()}`]);
    await pool.query("UPDATE cloud_workspace_engine_instances SET actor_protocol_version=2 WHERE id=$1", [fixture.engineInstanceId]);
    on = new Set(["capabilities", "runtime_connect", "realtime_uplink", "capability_actor_sessions"] as RolloutFlagName[]);
    user = await ensureUser(pool, { provider: "workos", providerSubject: `workos|${fixture.userId}`, email: `actor-${fixture.userId}@example.test`,
      displayName: "Owner", session: { id: `session_${randomUUID()}`, clientKind: "desktop", authTime: Math.floor(Date.now() / 1000),
        tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600 } });
    sourceId = (await pool.query<{ id: string }>(`INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at)
      VALUES($1,$2,$3,'desktop',now()+interval '1 hour') RETURNING id`, [user.authentication.sessionId, user.identity.subject, user.id])).rows[0]!.id;
    const pair = generateKeyPairSync("ed25519"); deviceKey = pair.privateKey;
    const publicKey = Buffer.from(pair.publicKey.export({ format: "jwk" }).x!, "base64url");
    deviceId = (await pool.query<{ id: string }>(`INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint)
      VALUES($1,'Actor','macos',$2,$3) RETURNING id`, [user.id, publicKey, createHash("sha256").update(publicKey).digest()])).rows[0]!.id;
    const { kid: _kid, use: _use, alg: _alg, ...publicJwk } = published[0]!;
    await pool.query(`INSERT INTO cloud_capability_signing_keys(kid,public_jwk,key_version,nonce,ciphertext,auth_tag,state,activated_at)
      VALUES($1,$2,1,$3,$4,$5,'current',clock_timestamp())`, [KID, publicJwk, Buffer.alloc(12), Buffer.alloc(32), Buffer.alloc(16)]);
    actors = new DatabaseCloudWorkspaceActorSessionService({ pool, enginePort: 39393,
      bridgeUrl: "wss://api.example.test/v1/cloud-workspaces/bridge", workosEnabled: true });
  });
  const engine = () => ({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1,
    engineInstanceId: fixture.engineInstanceId, heartbeatToken: fixture.heartbeatToken });
  const flags = { enabled: (org: string, flag: RolloutFlagName) => org === fixture.organizationId && on.has(flag),
    anyEnabled: (flag: RolloutFlagName) => on.has(flag) };
  function routes() {
    const future = actors as unknown as FutureService;
    const service = {
      admitCapabilityActor: (input: Parameters<typeof actors.admitCapability>[0]) => actors.admitCapability(input),
      admitCapabilitySession: (input: unknown) => future.admitCapabilitySession(input),
      renewCapabilitySession: (input: unknown) => future.renewCapabilitySession(input),
    } as unknown as CloudWorkspaceInternalSetupService;
    return createCloudWorkspaceInternalRoutes(service, { clientCapabilities: createEngineClientCapabilityGate({ pool, keyStore,
      issuer: ISSUER, workosEnabled: true, flags }) });
  }
  async function token() {
    return (await withSystemTx(pool, tx => issueClientCapabilities(tx, keyStore, ISSUER, {
      organizationId: fixture.organizationId, workspaceId: fixture.workspaceId, actorUserId: user.id, deviceId, sessionId: sourceId,
    }, ["zeros:engine"]))).capabilities["zeros:engine"].token;
  }
  function proof(capability: string, route: CapabilityRoute = "direct") {
    const claims = JSON.parse(Buffer.from(capability.split(".")[1]!, "base64url").toString("utf8")) as { aud: string; wsp: string; jti: string };
    const timestampMs = Date.now(), nonce = randomBytes(16).toString("base64url");
    return { timestampMs, nonce, signature: sign(null,
      capabilityProofMessage({ aud: claims.aud, wsp: claims.wsp, jti: claims.jti, timestampMs, nonce, route }), deviceKey).toString("base64url") };
  }
  async function body(capability = "") {
    capability ||= await token();
    const { heartbeatToken: _heartbeat, ...scope } = engine();
    return { ...scope, capability, proof: proof(capability), route: "direct", version: 1, mode: "capability-session-v1" };
  }
  function post(path: string, value: unknown, app = routes()) {
    return app.request(path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${fixture.heartbeatToken}` },
      body: JSON.stringify(value) });
  }
  async function admit(): Promise<Admission> {
    const response = await post(ADMIT, await body());
    expect(response.status).toBe(200);
    return response.json() as Promise<Admission>;
  }

  it("keeps a capability session current after the legacy 30-second renewal window", async () => {
    const admitted = await admit();
    expect(admitted.mode).toBe("capability-session-v1");
    await pool.query("UPDATE cloud_workspace_actor_sessions SET last_renewed_at=clock_timestamp()-interval '31 seconds' WHERE id=$1", [admitted.actorSessionId]);
    const { heartbeatToken: _heartbeat, ...scope } = engine();
    await expect(withSystemTx(pool, tx => assertCloudActorSession(tx, scope, admitted.actorSessionId, "read")))
      .resolves.toMatchObject({ sessionId: admitted.actorSessionId, deviceId });
    const expiry = (await pool.query<{ session_expires_at: Date }>("SELECT session_expires_at FROM cloud_workspace_actor_sessions WHERE id=$1", [admitted.actorSessionId])).rows[0]!;
    expect(expiry.session_expires_at.getTime()).toBe(admitted.capability.claims.exp * 1000);
  });

  it("acknowledges the same signed expiry on a fresh-proof lost-response retry", async () => {
    const value = await body(), app = routes();
    const response = await post(ADMIT, value, app);
    expect(response.status).toBe(200);
    const admitted = await response.json() as Admission;
    const retry = await post(RENEW, { ...value, proof: proof(value.capability), actorSessionId: admitted.actorSessionId,
      expectedRevision: admitted.capability.revision }, app);
    expect(retry.status).toBe(200);
    const result = await retry.json() as Admission;
    expect(result.actorSessionId).toBe(admitted.actorSessionId);
    expect(result.capability.revision).toBe(admitted.capability.revision);
    expect(result.capability.claims.exp).toBe(admitted.capability.claims.exp);
  });

  it("preserves the strict legacy admission response and its short renewal requirement", async () => {
    const { version: _version, mode: _mode, ...value } = await body();
    const response = await post(LEGACY, value);
    expect(response.status).toBe(200);
    const admitted = await response.json() as { actorSessionId: string; renewalToken: string };
    expect(Object.keys(admitted).sort()).toEqual(["accountUserId", "actorSessionId", "admitted", "audience", "authorityEpoch", "deviceId", "fingerprint", "renewalToken", "role", "version"]);
    await pool.query("UPDATE cloud_workspace_actor_sessions SET last_renewed_at=clock_timestamp()-interval '31 seconds' WHERE id=$1", [admitted.actorSessionId]);
    await expect(actors.consume({ ...engine(), token: admitted.renewalToken, renew: true })).rejects.toMatchObject({ status: 401 });
  });
});
