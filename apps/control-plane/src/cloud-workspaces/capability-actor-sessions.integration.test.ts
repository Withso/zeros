import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureUser, type AuthedUser } from "../auth.js";
import { withSystemTx, withUserTx } from "../db.js";
import type { RolloutFlagName } from "../rollout-flags.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { DatabaseCloudWorkspaceActorSessionService, assertCloudActorSession, assertRecordedCloudActor, confirmDetachedCloudActor } from "./actor-sessions.js";
import type { CloudWorkspaceCapability } from "./actors.js";
import { CapabilityClaimsSchema, type CapabilityClaims } from "./capability-contract.js";
import { CapabilitySessionResponseSchema, type CapabilitySessionResponse } from "./capability-actor-contract.js";
import { installCapabilityActorSessionFlags } from "./actor-session-authority.js";
import { issueClientCapabilities } from "./capability-issuer.js";
import type { CapabilitySigningKeyStore } from "./capability-keys.js";
import { createEngineClientCapabilityGate } from "./capability-service-verifier.js";
import { capabilityProofMessage, type CapabilityRoute } from "./capability-verifier.js";
import { testEd25519Key, testSigningJwk, signTestCapability } from "./capability-verifier-test-utils.js";
import { createCloudWorkspaceInternalRoutes, type CloudWorkspaceInternalSetupService } from "./internal-routes.js";
import { DatabaseCloudAgentExecutionService } from "./agent-executions.js";
import { CloudAgentBootCredentialResponseSchema } from "./agent-boot-contract.js";
import { pauseBeforeQuery } from "./authority-deadline-test-utils.js";
import { seedReadyCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";

vi.setConfig({ testTimeout: 30_000 });
const ISSUER = "https://cp.example.test", KID = "cap-2026-10-session";
const signingKey = testEd25519Key(KID), published = Object.freeze([testSigningJwk(KID)]);
const keyStore = { signer: () => ({ kid: KID, key: signingKey.privateKey }), publicKeySet: () => published } as unknown as CapabilitySigningKeyStore;
const ADMIT = "/internal/v2/cloud-workspaces/engine/capability-session-admission";
const RENEW = "/internal/v2/cloud-workspaces/engine/capability-session-renewal";
const LEGACY = "/internal/v2/cloud-workspaces/engine/capability-admission";
type Admission = CapabilitySessionResponse;

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("capability actor sessions with PostgreSQL", () => {
  let pool: pg.Pool, fixture: ReadyCloudWorkspaceFixture, user: AuthedUser, sourceId: string, deviceId: string;
  let deviceKey: KeyObject, actors: DatabaseCloudWorkspaceActorSessionService, on: Set<RolloutFlagName>;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  afterAll(async () => { await pool.end(); });
  afterEach(() => { installCapabilityActorSessionFlags(); vi.restoreAllMocks(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    await pool.query("INSERT INTO workos_organization_links(organization_id,workos_organization_id,external_id,state) VALUES($1::uuid,$2,$1::text,'active')",
      [fixture.organizationId, `org_${randomUUID()}`]);
    await pool.query("UPDATE cloud_workspace_engine_instances SET actor_protocol_version=2 WHERE id=$1", [fixture.engineInstanceId]);
    on = new Set(["capabilities", "runtime_connect", "realtime_uplink", "capability_actor_sessions"]);
    installCapabilityActorSessionFlags(flags);
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
    const service = {
      admitCapabilityActor: (input: Parameters<typeof actors.admitCapability>[0]) => actors.admitCapability(input),
      admitCapabilitySession: (input: Parameters<typeof actors.admitCapabilitySession>[0]) => actors.admitCapabilitySession(input),
      renewCapabilitySession: (input: Parameters<typeof actors.renewCapabilitySession>[0]) => actors.renewCapabilitySession(input),
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
  function post(path: string, value: unknown, app = routes(), signal?: AbortSignal) {
    return app.request(path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${fixture.heartbeatToken}` },
      body: JSON.stringify(value), ...(signal ? {signal} : {}) });
  }
  async function admit(capability?: string): Promise<Admission> {
    const response = await post(ADMIT, await body(capability));
    expect(response.status).toBe(200);
    return CapabilitySessionResponseSchema.parse(await response.json());
  }

  const scope = () => { const { heartbeatToken: _heartbeat, ...value } = engine(); return value; };
  const decode = (value: string) => CapabilityClaimsSchema.parse(JSON.parse(Buffer.from(value.split(".")[1]!, "base64url").toString("utf8")));
  const signed = (claims: CapabilityClaims, kid = KID) => signTestCapability({ alg: "EdDSA", typ: "zeros-cap+jwt", kid }, claims);
  const next = (claims: CapabilityClaims, overrides: Partial<CapabilityClaims> = {}, kid = KID) => signed({ ...claims,
    iat: claims.iat + 1, exp: claims.exp + 1, jti: randomBytes(16).toString("base64url"), ...overrides }, kid);
  const current = (id: string, capability: CloudWorkspaceCapability = "read") => withSystemTx(pool,
    tx => assertCloudActorSession(tx, scope(), id, capability));
  async function renew(admitted: Admission, capability: string, app = routes(), expectedRevision = admitted.capability.revision) {
    return post(RENEW, { ...await body(capability), actorSessionId: admitted.actorSessionId, expectedRevision }, app);
  }
  async function recorded(admitted: Admission, capability: CloudWorkspaceCapability = "read") {
    return withSystemTx(pool, tx => assertRecordedCloudActor(tx, { ...scope(), actorUserId: admitted.accountUserId,
      actor: { actorUserId: admitted.accountUserId, deviceId, deviceKeyVersion: admitted.capability.claims.ep.dk!,
        fingerprint: admitted.fingerprint, sourceSessionId: admitted.actorSessionId }, capability }));
  }
  async function state(id: string) {
    return (await pool.query("SELECT * FROM cloud_workspace_actor_sessions WHERE id=$1", [id])).rows[0]!;
  }
  async function expired(admitted: Admission) {
    // Reconstruct a genuinely historical signed row without weakening the
    // immutable UPDATE fence or relying on a timing sleep.
    const now = Math.floor(Date.now()/1000), claims = { ...admitted.capability.claims, iat: now-300, nbf: now-300, exp: now-1,
      jti: randomBytes(16).toString("base64url") };
    const capability = signed(claims), id = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_actor_sessions
      (id,workspace_id,org_id,generation,engine_instance_id,actor_user_id,device_id,device_key_version,authority_epoch,
       actor_fingerprint,actor_role,created_at,admission_expires_at,session_expires_at,consumed_at,last_renewed_at,
       session_kind,capability_source_session_id,capability_claims,capability_key_id,capability_token_sha256,capability_revision,capability_route)
      SELECT $2,workspace_id,org_id,generation,engine_instance_id,actor_user_id,device_id,device_key_version,authority_epoch,
       actor_fingerprint,actor_role,to_timestamp($3),to_timestamp($4),to_timestamp($4),to_timestamp($3),to_timestamp($3),
       session_kind,capability_source_session_id,$5,capability_key_id,$6,1,capability_route FROM cloud_workspace_actor_sessions WHERE id=$1`,
    [admitted.actorSessionId,id,now-250,claims.exp,claims,createHash("sha256").update(capability).digest()]);
    return { admitted: { ...admitted, actorSessionId: id, capability: { ...admitted.capability, claims } }, capability };
  }

  it("withdraws capability admission and renewal without unbinding tokens or interrupting recorded work", async () => {
    await pool.query(`UPDATE cloud_workspace_engine_instances SET coordinator_version=1,
      interactive_frontend_id=$2,interactive_ready_until=clock_timestamp()+interval '1 minute' WHERE id=$1`,
    [fixture.engineInstanceId, randomUUID()]);
    const admitted = await admit();
    await pool.query("UPDATE cloud_workspace_engine_instances SET interactive_ready_until=NULL WHERE id=$1", [fixture.engineInstanceId]);
    expect(decode(await token()).ein).toBe(fixture.engineInstanceId);
    expect((await post(ADMIT, await body())).status).toBe(401);
    expect((await renew(admitted, next(admitted.capability.claims))).status).toBe(401);
    await expect(recorded(admitted)).resolves.toMatchObject({ actorUserId: user.id });
    expect((await state(admitted.actorSessionId)).capability_revision).toBe("1");
  });

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
  it("uses signed expiry even with less than two minutes remaining", async () => {
    const claims = decode(await token());
    const admitted = await admit(signed({ ...claims, exp: Math.floor(Date.now()/1000)+10 }));
    const row = await state(admitted.actorSessionId);
    expect(row.admission_expires_at).toEqual(row.session_expires_at);
    expect(row.session_expires_at.getTime()).toBe(admitted.capability.claims.exp*1000);
    expect(row.token_hash).toBeNull();
    expect(row.auth_provider).toBeNull();
    expect(row.auth_session_id).toBeNull();
  });

  it("refuses current use at signed expiry while recorded work keeps its separate source proof", async () => {
    const old = await expired(await admit());
    await expect(current(old.admitted.actorSessionId)).rejects.toMatchObject({ status: 401 });
    await expect(recorded(old.admitted)).resolves.toMatchObject({ actorUserId: user.id });
    const denied = await renew(old.admitted, old.capability);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: { code: "capability_expired" } });
    // A fresh full proof can recover the retained row; it never makes the
    // expired token valid or extends another actor/context lifetime.
    const response = await renew(old.admitted, await token());
    expect(response.status).toBe(200);
    expect((await response.json() as Admission).capability.revision).toBe(2);
    await expect(current(old.admitted.actorSessionId)).resolves.toMatchObject({ sessionId: old.admitted.actorSessionId });
  });

  it.each(["capability_actor_sessions", "capabilities", "runtime_connect", "realtime_uplink"] as const)(
    "refuses new and current sessions when %s is off, without converting the persisted row", async flag => {
      const admitted = await admit();
      on.delete(flag);
      expect((await post(ADMIT, await body())).status).toBe(401);
      expect((await renew(admitted, next(admitted.capability.claims))).status).toBe(401);
      await expect(current(admitted.actorSessionId)).rejects.toMatchObject({ status: 401 });
      expect((await state(admitted.actorSessionId)).capability_revision).toBe("1");
      await expect(recorded(admitted)).resolves.toMatchObject({ actorUserId: user.id });
    });

  it.each(["read", "run", "edit", "manage", "credentials", "delete"] as const)(
    "applies the signed scope to both current and recorded %s readers", async operation => {
      const claims = decode(await token());
      const admitted = await admit(signed({ ...claims, scp: ["ws:read"] }));
      if (operation === "read") {
        await expect(current(admitted.actorSessionId, operation)).resolves.toMatchObject({ role: "owner" });
        await expect(recorded(admitted, operation)).resolves.toMatchObject({ role: "owner" });
      } else {
        await expect(current(admitted.actorSessionId, operation)).rejects.toMatchObject({ status: 401 });
        await expect(recorded(admitted, operation)).rejects.toMatchObject({ status: 401 });
      }
    });

  it("never derives run consent from the role of a read-only owner and keeps the 10-second proof", async () => {
    const claims = decode(await token());
    const admitted = await admit(signed({ ...claims, scp: ["ws:read"] }));
    const started = Date.now();
    const confirmed = await withSystemTx(pool, tx => confirmDetachedCloudActor(tx, scope(), admitted.actorSessionId));
    expect(confirmed).toMatchObject({ role: "owner", permitsRun: false });
    expect(confirmed.confirmedUntilMs).toBeLessThanOrEqual(Date.now()+10_000);
    expect(confirmed.confirmedUntilMs).toBeGreaterThan(started);
    await pool.query("UPDATE cloud_workspace_actor_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [admitted.actorSessionId]);
    await expect(current(admitted.actorSessionId)).rejects.toMatchObject({ status: 401 });
    await expect(withSystemTx(pool, tx => confirmDetachedCloudActor(tx, scope(), admitted.actorSessionId)))
      .resolves.toMatchObject({ permitsRun: false });
    await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE id=$1", [sourceId]);
    await expect(recorded(admitted)).rejects.toMatchObject({ status: 401 });
  });

  it.each(["sid", "did", "role", "scopes", "key", "epoch", "generation", "engine", "route"])(
    "cannot transfer an actor's immutable %s binding during renewal", async change => {
      const admitted = await admit(), original = admitted.capability.claims;
      const overrides: Partial<CapabilityClaims> = {};
      if (change === "sid") overrides.sid = randomUUID();
      if (change === "did") overrides.did = randomUUID();
      if (change === "role") overrides.role = "viewer";
      if (change === "scopes") overrides.scp = ["ws:read"];
      if (change === "key") overrides.cnf = { jwk: { kty: "OKP", crv: "Ed25519", x: testEd25519Key("other").x } };
      if (change === "epoch") overrides.ep = { ...original.ep, me: original.ep.me!+1 };
      if (change === "generation") overrides.gen = 2;
      if (change === "engine") overrides.ein = randomUUID();
      const capability = next(original, overrides), request = await body(capability);
      if (change === "route") { request.route = "relay"; request.proof = proof(capability,"relay"); }
      const response = await post(RENEW, { ...request, actorSessionId: admitted.actorSessionId, expectedRevision: 1 });
      expect(response.status).toBe(401);
      expect((await state(admitted.actorSessionId)).capability_revision).toBe("1");
    });

  it.each(["source", "account", "device", "public key", "member", "workspace", "kid", "retired kid"])(
    "rechecks committed %s authority instead of trusting a verifier cache", async change => {
      const admitted = await admit(), capability = next(admitted.capability.claims), app = routes();
      if (change === "source") await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE id=$1",[sourceId]);
      if (change === "account") await pool.query("UPDATE users SET auth_revision=auth_revision+1 WHERE id=$1",[user.id]);
      if (change === "device") await pool.query("UPDATE devices SET key_version=key_version+1 WHERE id=$1",[deviceId]);
      if (change === "public key") await pool.query("UPDATE devices SET public_key=$2 WHERE id=$1",[deviceId,Buffer.alloc(32,8)]);
      if (change === "member") await pool.query(`INSERT INTO cloud_capability_member_epochs(org_id,user_id,epoch) VALUES($1,$2,2)
        ON CONFLICT(org_id,user_id) DO UPDATE SET epoch=cloud_capability_member_epochs.epoch+1`,[fixture.organizationId,user.id]);
      if (change === "workspace") await pool.query("UPDATE cloud_workspaces SET access_revision=access_revision+1 WHERE id=$1",[fixture.workspaceId]);
      if (change === "kid") await pool.query("UPDATE cloud_capability_signing_keys SET state='revoked' WHERE kid=$1",[KID]);
      if (change === "retired kid") await pool.query("UPDATE cloud_capability_signing_keys SET state='retiring',retire_after=clock_timestamp()-interval '1 second' WHERE kid=$1",[KID]);
      await expect(current(admitted.actorSessionId)).rejects.toBeDefined();
      await expect(recorded(admitted)).rejects.toBeDefined();
      expect((await renew(admitted,capability,app)).status).toBe(401);
      expect((await state(admitted.actorSessionId)).capability_revision).toBe("1");
    });

  it("serializes concurrent tokens and idempotently acknowledges only the committed token with fresh PoP", async () => {
    const admitted = await admit(), app = routes();
    const first = next(admitted.capability.claims), second = next(admitted.capability.claims,{ exp: admitted.capability.claims.exp+2, iat: admitted.capability.claims.iat+2 });
    const responses = await Promise.all([renew(admitted,first,app),renew(admitted,second,app)]);
    expect(responses.map(response=>response.status).sort()).toEqual([200,401]);
    const index = responses.findIndex(response=>response.status===200), accepted = await responses[index]!.json() as Admission;
    const token = index===0?first:second;
    const retryBody = { ...await body(token), actorSessionId: admitted.actorSessionId, expectedRevision: 1 };
    expect((await post(RENEW,retryBody,app)).status).toBe(200);
    expect((await post(RENEW,retryBody,app)).status).toBe(401); // The same PoP is still a replay.
    expect((await state(admitted.actorSessionId)).capability_revision).toBe("2");
    expect((await state(admitted.actorSessionId)).session_expires_at.getTime()).toBe(accepted.capability.claims.exp*1000);
    expect((await renew(admitted,token,app,3)).status).toBe(401);
  });

  it("fences N-1 current, recorded and detached SQL readers from a newly admitted row", async () => {
    const admitted = await admit();
    // Frozen fcb18c23 predicates, deliberately not the new shared helper.
    const source = "cloud_workspace_actor_auth_live(session.actor_user_id,session.auth_provider,session.auth_subject,session.auth_session_id,session.auth_session_created_at)";
    const queries = [
      `SELECT session.id FROM cloud_workspace_actor_sessions session WHERE session.id=$1 AND ${source}
        AND session.revoked_at IS NULL AND session.consumed_at IS NOT NULL AND session.session_expires_at>clock_timestamp()
        AND session.last_renewed_at>clock_timestamp()-interval '30 seconds'`,
      `SELECT session.id FROM cloud_workspace_actor_sessions session WHERE session.id=$1 AND ${source}`,
      `SELECT session.id FROM cloud_workspace_actor_sessions session JOIN auth_sessions auth
        ON auth.provider_session_id=session.auth_session_id AND auth.user_id=session.actor_user_id
        WHERE session.id=$1 AND session.consumed_at IS NOT NULL AND auth.status='active' AND auth.last_token_expires_at>clock_timestamp()`,
    ];
    for (const query of queries) expect(await withSystemTx(pool, tx => tx.query(query,[admitted.actorSessionId]))).toMatchObject({ rowCount: 0 });
    expect(await actors.authorizeRelay(`zwa_${randomBytes(32).toString("base64url")}`)).toBeNull();
    expect((await state(admitted.actorSessionId)).token_hash).toBeNull();
    await expect(actors.consume({ ...engine(), token: `zwa_${randomBytes(32).toString("base64url")}`, renew: true })).rejects.toMatchObject({ status: 401 });
  });

  it("counts all 100 live capability sockets after 30 seconds in both admission modes", async () => {
    const admitted = await admit();
    await pool.query(`INSERT INTO cloud_workspace_actor_sessions
      SELECT (jsonb_populate_record(NULL::cloud_workspace_actor_sessions,to_jsonb(session)||jsonb_build_object('id',gen_random_uuid()))).*
      FROM cloud_workspace_actor_sessions session CROSS JOIN generate_series(1,99) WHERE id=$1`,[admitted.actorSessionId]);
    await pool.query("UPDATE cloud_workspace_actor_sessions SET last_renewed_at=clock_timestamp()-interval '31 seconds'");
    expect((await post(ADMIT,await body())).status).toBe(429);
    const {version:_version,mode:_mode,...legacy}=await body();
    expect((await post(LEGACY,legacy)).status).toBe(429);
  });

  it("recovering an expired session cannot exceed the 100 live session limit", async () => {
    const admitted = await admit(), old = await expired(admitted);
    await expect(current(old.admitted.actorSessionId)).rejects.toMatchObject({ status: 401 });
    await pool.query(`INSERT INTO cloud_workspace_actor_sessions
      SELECT (jsonb_populate_record(NULL::cloud_workspace_actor_sessions,to_jsonb(session)||jsonb_build_object('id',gen_random_uuid()))).*
      FROM cloud_workspace_actor_sessions session CROSS JOIN generate_series(1,99) WHERE id=$1`, [admitted.actorSessionId]);
    const liveCount = async () => Number((await pool.query<{ count: string }>(`SELECT count(*) FROM cloud_workspace_actor_sessions
      WHERE workspace_id=$1 AND revoked_at IS NULL AND session_expires_at>clock_timestamp()`, [fixture.workspaceId])).rows[0]!.count);
    expect(await liveCount()).toBe(100);
    const response = await renew(old.admitted, await token());
    expect({ status: response.status, active: await liveCount() }).toEqual({ status: 429, active: 100 });
  });

  it("renews an already live session at capacity without allocating another slot", async () => {
    const admitted = await admit();
    await pool.query(`INSERT INTO cloud_workspace_actor_sessions
      SELECT (jsonb_populate_record(NULL::cloud_workspace_actor_sessions,to_jsonb(session)||jsonb_build_object('id',gen_random_uuid()))).*
      FROM cloud_workspace_actor_sessions session CROSS JOIN generate_series(1,99) WHERE id=$1`, [admitted.actorSessionId]);
    const response = await renew(admitted, next(admitted.capability.claims));
    expect(response.status).toBe(200);
    expect(CapabilitySessionResponseSchema.parse(await response.json())).toMatchObject({ actorSessionId: admitted.actorSessionId,
      capability: { revision: 2 } });
    expect(Number((await pool.query<{ count: string }>(`SELECT count(*) FROM cloud_workspace_actor_sessions
      WHERE workspace_id=$1 AND revoked_at IS NULL AND session_expires_at>clock_timestamp()`, [fixture.workspaceId])).rows[0]!.count)).toBe(100);
  });

  it("serializes expired recovery on the admission fence before competing for the last slot", async () => {
    const admitted = await admit(), first = await expired(admitted), second = await expired(admitted);
    await pool.query(`INSERT INTO cloud_workspace_actor_sessions
      SELECT (jsonb_populate_record(NULL::cloud_workspace_actor_sessions,to_jsonb(session)||jsonb_build_object('id',gen_random_uuid()))).*
      FROM cloud_workspace_actor_sessions session CROSS JOIN generate_series(1,98) WHERE id=$1`, [admitted.actorSessionId]);
    const tokens = await Promise.all([token(), token()]), blocker = await pool.connect();
    let pending: Promise<Response[]> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`cloud-actor-session-limit:${fixture.workspaceId}`]);
      const pid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      pending = Promise.all([renew(first.admitted, tokens[0]!), renew(second.admitted, tokens[1]!)]);
      await vi.waitFor(async () => expect((await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND wait_event='advisory'`, [pid])).rowCount).toBe(2));
      await blocker.query("COMMIT");
      expect((await pending).map(response => response.status).sort()).toEqual([200, 429]);
      expect(Number((await pool.query<{ count: string }>(`SELECT count(*) FROM cloud_workspace_actor_sessions
        WHERE workspace_id=$1 AND revoked_at IS NULL AND session_expires_at>clock_timestamp()`, [fixture.workspaceId])).rows[0]!.count)).toBe(100);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
  });

  it("keeps source fields, kind and renewal authority immutable under SQL and forced RLS", async () => {
    const admitted = await admit();
    for (const [sql,value] of [
      ["session_kind=$2", "legacy"], ["actor_fingerprint=$2", "f".repeat(64)],
      ["capability_source_session_id=$2", randomUUID()], ["capability_claims=jsonb_set(capability_claims,'{scp}',$2::jsonb)", JSON.stringify(["ws:read"])],
      ["session_expires_at=$2", new Date(Date.now()+1000)],
    ] as const) await expect(pool.query(`UPDATE cloud_workspace_actor_sessions SET ${sql} WHERE id=$1`,[admitted.actorSessionId,value])).rejects.toMatchObject({code:"23514"});
    expect(await withUserTx(pool,user.id,tx=>tx.query("SELECT id FROM cloud_workspace_actor_sessions"))).toMatchObject({rowCount:0});
    await expect(withUserTx(pool,user.id,tx=>tx.query("UPDATE cloud_workspace_actor_sessions SET revoked_at=now() WHERE id=$1",[admitted.actorSessionId])))
      .resolves.toMatchObject({rowCount:0});
    expect(await withUserTx(pool,user.id,tx=>tx.query("SELECT cloud_capability_actor_signing_keys_live($1) AS live",[[KID]])))
      .toMatchObject({rows:[{live:false}]});
  });

  it.each(["flag", "source", "key", "abort"])("refuses a renewal held before its row read across %s loss", async loss => {
    const admitted = await admit(), capability = next(admitted.capability.claims);
    const barrier = pauseBeforeQuery(pool, /FOR NO KEY UPDATE OF session/);
    actors = new DatabaseCloudWorkspaceActorSessionService({pool:barrier.pool,enginePort:39393,
      bridgeUrl:"wss://api.example.test/v1/cloud-workspaces/bridge",workosEnabled:true});
    const controller = new AbortController();
    const pending = post(RENEW,{...await body(capability),actorSessionId:admitted.actorSessionId,expectedRevision:1},routes(),controller.signal);
    await barrier.atBarrier;
    try {
      if(loss==="flag")on.delete("capability_actor_sessions");
      if(loss==="source")await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE id=$1",[sourceId]);
      if(loss==="key")await pool.query("UPDATE cloud_capability_signing_keys SET state='revoked' WHERE kid=$1",[KID]);
      if(loss==="abort")controller.abort();
    } finally {barrier.release();}
    expect((await pending).status).toBe(401);
    expect((await state(admitted.actorSessionId)).capability_revision).toBe("1");
  });

  it("rejects a renewal whose real row-lock wait crosses its original signed wall deadline", async () => {
    const admitted = await admit(), capability = next(admitted.capability.claims), request = await body(capability);
    const locked = await pool.connect();
    let pending:Promise<Response>|undefined;
    try {
      await locked.query("BEGIN");
      await locked.query("SELECT id FROM cloud_workspace_actor_sessions WHERE id=$1 FOR UPDATE",[admitted.actorSessionId]);
      const pid = (await locked.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      pending = post(RENEW,{...request,actorSessionId:admitted.actorSessionId,expectedRevision:1});
      await vi.waitFor(async()=>expect((await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`,[pid])).rowCount).toBeGreaterThan(0));
      vi.spyOn(Date,"now").mockReturnValue(decode(capability).exp*1000);
      await locked.query("ROLLBACK");
      expect((await pending).status).toBe(401);
    } finally {await locked.query("ROLLBACK");locked.release();}
    expect((await state(admitted.actorSessionId)).capability_revision).toBe("1");
  });

  it("commits before ACK but rejects a late COMMIT reply even if wall time moves backward", async () => {
    const admitted = await admit(), capability = next(admitted.capability.claims), request = await body(capability);
    const wall = Date.now(), monotonic = performance.now();
    const barrier = pauseBeforeQuery(pool, /^COMMIT$/);
    actors = new DatabaseCloudWorkspaceActorSessionService({pool:barrier.pool,enginePort:39393,
      bridgeUrl:"wss://api.example.test/v1/cloud-workspaces/bridge",workosEnabled:true});
    const pending = post(RENEW,{...request,actorSessionId:admitted.actorSessionId,expectedRevision:1});
    await barrier.atBarrier;
    // This is elapsed observation time, not another positive proof.
    vi.spyOn(Date,"now").mockReturnValue(wall-60_000);
    vi.spyOn(performance,"now").mockReturnValue(monotonic+10_000);
    barrier.release();
    expect((await pending).status).toBe(401);
    expect((await state(admitted.actorSessionId)).capability_revision).toBe("2");
  });

  it("accepts ordinary signing-key rotation but a revoked old key cannot be rescued by a new one", async () => {
    const admitted = await admit(), nextKid = "cap-2026-10-rotated", key = testSigningJwk(nextKid);
    await pool.query("UPDATE cloud_capability_signing_keys SET state='retiring',retire_after=now()+interval '10 minutes' WHERE kid=$1",[KID]);
    const {kid:_kid,use:_use,alg:_alg,...jwk}=key;
    await pool.query(`INSERT INTO cloud_capability_signing_keys(kid,public_jwk,key_version,nonce,ciphertext,auth_tag,state,activated_at)
      VALUES($1,$2,1,$3,$4,$5,'current',now())`,[nextKid,jwk,Buffer.alloc(12),Buffer.alloc(32),Buffer.alloc(16)]);
    const rotatingStore={...keyStore,publicKeySet:()=>[...published,key]} as unknown as CapabilitySigningKeyStore;
    const app=createCloudWorkspaceInternalRoutes({renewCapabilitySession:(input:Parameters<typeof actors.renewCapabilitySession>[0])=>actors.renewCapabilitySession(input)} as unknown as CloudWorkspaceInternalSetupService,
      {clientCapabilities:createEngineClientCapabilityGate({pool,keyStore:rotatingStore,issuer:ISSUER,workosEnabled:true,flags})});
    const old = await expired(admitted);
    const rotated=next(admitted.capability.claims,{},nextKid);
    expect((await renew(admitted,rotated,app)).status).toBe(200);
    await pool.query("UPDATE cloud_capability_signing_keys SET state='revoked' WHERE kid=$1",[KID]);
    expect((await renew(old.admitted,rotated,app)).status).toBe(401);
    expect((await state(old.admitted.actorSessionId)).capability_revision).toBe("1");
  });

  it("withholds owner funding on the real actor-confirm path when the token lacks ws:prompt", async () => {
    const claims = decode(await token()), admitted = await admit(signed({...claims,scp:["ws:read"]}));
    await pool.query("UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=1 WHERE id=$1",[fixture.engineInstanceId]);
    const service = new DatabaseCloudAgentExecutionService(pool,{currentKeyVersion:1,keys:{1:randomBytes(32).toString("base64url")}},true);
    const request = {version:1,mode:"boot-owner-v1",...scope()};
    const boot = CloudAgentBootCredentialResponseSchema.parse(await service.boot(engine(),"bootstrap",request));
    const confirmed = await service.boot(engine(),"actor-confirm",{...request,bootId:boot.bootId,writerEpoch:boot.writerEpoch,actorSessionId:admitted.actorSessionId});
    expect(confirmed).toMatchObject({provenance:{actor:{role:"owner"},fundingGrant:null,fundingConsentVersion:null}});
  });

  it("rejects altered claims under a committed digest at the service boundary", async () => {
    const admitted = await admit();
    await expect(actors.renewCapabilitySession({...engine(),actorSessionId:admitted.actorSessionId,expectedRevision:1,
      claims:{...admitted.capability.claims,exp:admitted.capability.claims.exp+1,iat:admitted.capability.claims.iat+1},
      tokenSha256:admitted.capability.tokenSha256,keyId:KID,route:"direct"})).rejects.toMatchObject({status:401});
    expect((await state(admitted.actorSessionId)).capability_revision).toBe("1");
  });

});
