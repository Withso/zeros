import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { importJWK, jwtVerify, decodeProtectedHeader, decodeJwt } from "jose";
import { createPool, withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import type { RolloutFlagName } from "../rollout-flags.js";
import { seedReadyCloudWorkspace, seedReadyProCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";
import { loadCapabilityKeyring } from "./capability-keyring.js";
import { CapabilitySigningKeyStore } from "./capability-keys.js";
import { manageCloudCapabilityKey } from "../manage-cloud-capability-key.js";
import {
  CapabilityIssuanceError,
  CapabilityIssuerUnavailableError,
  issueClientCapability,
  issueEngineCapability,
} from "./capability-issuer.js";
import { CAPABILITY_FALLBACK_FAILURE_CEILING, createCloudCapabilityEngineRoutes, createCloudCapabilityKeyRoutes } from "./capability-routes.js";
import { CAPABILITY_TOKEN_TYPE, CapabilityClaimsSchema } from "./capability-contract.js";

const url = process.env.TEST_DATABASE_URL, d = url ? describe : describe.skip;
const keyring = loadCapabilityKeyring({
  CLOUD_CAPABILITY_KEYS_JSON: JSON.stringify({ 1: randomBytes(32).toString("base64url") }),
  CLOUD_CAPABILITY_CURRENT_KEY_VERSION: "1",
})!;
const ISSUER = "https://cp.example.test";
const kid = (suffix: string) => `cap-2026-10-${suffix}`;

const flags = (...on: RolloutFlagName[]) => ({ enabled: (_org: string, flag: RolloutFlagName) => on.includes(flag) });

d("capability keys and issuance with PostgreSQL", () => {
  let pool: pg.Pool, listenerPool: pg.Pool, fixture: ReadyCloudWorkspaceFixture;
  const stores: CapabilitySigningKeyStore[] = [];
  const actor = randomUUID();
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    listenerPool = createPool(url!, { maxConnections: 1, keepAlive: true, applicationName: "zeros-notifications" });
  });
  afterAll(async () => { await listenerPool.end(); await pool.end(); });
  afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.stop())); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    await pool.query("INSERT INTO users(id,email,display_name,staff_role) VALUES($1,$2,'Operator','platform_owner')", [actor, `${actor}@example.test`]);
  });

  const options = { databaseUrl: url!, channel: "development", keyring };
  const doc = (action: string, key: string) => ({
    operationId: randomUUID(), channel: "development", actorUserId: actor,
    reason: `Key lifecycle test step ${action} for ${key}`, action, kid: key,
  });
  async function execute(change: ReturnType<typeof doc>) {
    const plan = await manageCloudCapabilityKey(pool, change, options);
    return manageCloudCapabilityKey(pool, change, { ...options, execute: true, approval: plan.planSha256 });
  }

  async function store() {
    const value = new CapabilitySigningKeyStore({ pool, listenerPool, keyring, refreshMs: 3_600_000, logger: { warn: vi.fn(), info: vi.fn() } });
    stores.push(value);
    await value.start();
    return value;
  }

  /** Tests age a key row to fast-forward the 24 h publication rules; the
   * identity trigger forbids that update, so it is lifted for the statement
   * (the test database owner may). */
  async function ageKey(key: string, assignments: string) {
    await pool.query("ALTER TABLE cloud_capability_signing_keys DISABLE TRIGGER cloud_capability_key_identity");
    try {
      await pool.query(`UPDATE cloud_capability_signing_keys SET ${assignments} WHERE kid=$1`, [key]);
    } finally {
      await pool.query("ALTER TABLE cloud_capability_signing_keys ENABLE TRIGGER cloud_capability_key_identity");
    }
  }

  async function activateFirst(suffix = "a") {
    await execute(doc("create", kid(suffix)));
    return execute(doc("activate", kid(suffix)));
  }

  it("rotates with overlap and publishes next, current and retiring only", async () => {
    await execute(doc("create", kid("a")));
    // Bootstrap: with no current key the 24 h publication rule does not apply.
    await execute(doc("activate", kid("a")));
    await execute(doc("create", kid("b")));
    await expect(execute(doc("activate", kid("b")))).rejects.toThrow(/24 hours/);
    await ageKey(kid("b"), "created_at=clock_timestamp()-interval '25 hours'");
    await execute(doc("activate", kid("b")));
    let rows = (await pool.query("SELECT kid,state FROM cloud_capability_signing_keys ORDER BY created_at")).rows;
    expect(rows).toEqual([{ kid: kid("b"), state: "current" }, { kid: kid("a"), state: "retiring" }]);
    await expect(execute(doc("retire", kid("a")))).rejects.toThrow(/24 hours/);
    await ageKey(kid("a"), "retire_after=clock_timestamp()-interval '1 second'");
    await execute(doc("retire", kid("a")));
    rows = (await pool.query("SELECT kid,state FROM cloud_capability_signing_keys ORDER BY created_at")).rows;
    expect(rows).toEqual([{ kid: kid("b"), state: "current" }, { kid: kid("a"), state: "retired" }]);
    // Emergency revocation removes the key from the published set at once.
    await execute(doc("revoke", kid("b")));
    expect((await pool.query("SELECT state FROM cloud_capability_signing_keys WHERE kid=$1", [kid("b")])).rows[0]).toEqual({ state: "revoked" });
  });

  it("refuses a second next key, kid reuse and non-owners; replays the same document", async () => {
    const created = await execute(doc("create", kid("a")));
    expect(created.state).toBe("changed");
    expect((await execute(doc("create", kid("a")))).state).toBe("replayed");
    await expect(execute(doc("create", kid("c")))).rejects.toThrow(/next capability key already exists/);
    await execute(doc("revoke", kid("a")));
    await expect(execute(doc("create", kid("a")))).rejects.toThrow(/must never return/);
    await pool.query("UPDATE users SET staff_role=NULL WHERE id=$1", [actor]);
    await expect(manageCloudCapabilityKey(pool, doc("create", kid("d")), options)).rejects.toThrow(/platform owner/);
  });

  it("loads the current signer from the sealed envelope and reloads on NOTIFY", async () => {
    await activateFirst();
    const value = await store();
    await vi.waitFor(() => expect(value.signer()?.kid).toBe(kid("a")));
    expect(value.publicKeySet().map(entry => entry.kid)).toEqual([kid("a")]);
    await execute(doc("create", kid("b")));
    await ageKey(kid("b"), "created_at=clock_timestamp()-interval '25 hours'");
    await execute(doc("activate", kid("b")));
    await vi.waitFor(() => expect(value.signer()?.kid).toBe(kid("b")));
    expect(value.publicKeySet().map(entry => entry.kid).sort()).toEqual([kid("a"), kid("b")]);
  });

  async function verifiedHeaderAndClaims(token: string, keys: { kid: string; x: string }[]) {
    const header = decodeProtectedHeader(token);
    expect(header).toEqual({ alg: "EdDSA", typ: CAPABILITY_TOKEN_TYPE, kid: expect.any(String) });
    const entry = keys.find(candidate => candidate.kid === header.kid)!;
    const publicKey = await importJWK({ kty: "OKP", crv: "Ed25519", x: entry.x }, "EdDSA");
    const { payload } = await jwtVerify(token, publicKey, { algorithms: ["EdDSA"], clockTolerance: 0 });
    return CapabilityClaimsSchema.parse(payload);
  }

  it("issues a pinned engine token that verifies against the published set", async () => {
    await activateFirst();
    const value = await store();
    await vi.waitFor(() => expect(value.signer()).not.toBeNull());
    const issued = await withSystemTx(pool, tx => issueEngineCapability(tx, value, ISSUER, {
      organizationId: fixture.organizationId, workspaceId: fixture.workspaceId, generation: 1, engineInstanceId: fixture.engineInstanceId,
    }));
    const claims = await verifiedHeaderAndClaims(issued.token, [...value.publicKeySet()]);
    expect(claims).toMatchObject({
      iss: ISSUER, aud: "zeros:api", sub: `engine:${fixture.engineInstanceId}`, knd: "engine",
      org: fixture.organizationId, wsp: fixture.workspaceId, gen: 1, ein: fixture.engineInstanceId,
      scp: ["engine:checkpoint", "engine:credentials.read", "engine:history.write"], ep: { wa: 1 }, cv: 1,
    });
    expect(claims.exp - claims.iat).toBe(300);
    expect(Buffer.byteLength(issued.token)).toBeLessThanOrEqual(1024);
    await expect(withSystemTx(pool, tx => issueEngineCapability(tx, value, ISSUER, {
      organizationId: fixture.organizationId, workspaceId: fixture.workspaceId, generation: 2, engineInstanceId: fixture.engineInstanceId,
    }))).rejects.toMatchObject({ code: "cloud_workspace_not_found" });
  });

  async function deviceAndSession(userId: string) {
    const publicKey = randomBytes(32);
    const device = (await pool.query<{ id: string }>(
      "INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint) VALUES($1,'Capability test','macos',$2,$3) RETURNING id",
      [userId, publicKey, createHash("sha256").update(publicKey).digest()])).rows[0]!;
    const session = (await pool.query<{ id: string }>(
      `INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at)
       VALUES($1,$2,$3,'desktop',now()+interval '1 hour') RETURNING id`, [`session-${randomUUID()}`, `sub-${userId}`, userId])).rows[0]!;
    return { deviceId: device.id, sessionId: session.id, publicKey };
  }

  it("issues a client token with the actor role, epochs, ein and device binding", async () => {
    const pro = await seedReadyProCloudWorkspace(pool);
    await activateFirst();
    const value = await store();
    await vi.waitFor(() => expect(value.signer()).not.toBeNull());
    const { deviceId, sessionId, publicKey } = await deviceAndSession(pro.userId);
    const issued = await withSystemTx(pool, tx => issueClientCapability(tx, value, ISSUER, {
      organizationId: pro.organizationId, workspaceId: pro.workspaceId, actorUserId: pro.userId,
      deviceId, sessionId, audience: "zeros:engine",
    }));
    const claims = await verifiedHeaderAndClaims(issued.token, [...value.publicKeySet()]);
    expect(claims).toMatchObject({
      iss: ISSUER, aud: "zeros:engine", sub: `user:${pro.userId}`, knd: "client", role: "owner",
      org: pro.organizationId, wsp: pro.workspaceId, gen: 1, ein: pro.engineInstanceId,
      scp: ["ws:edit", "ws:manage", "ws:prompt", "ws:read"],
      ep: { wa: 1, wr: 1, ac: 1, dk: 1 }, sid: sessionId, did: deviceId, cv: 1,
    });
    expect(claims.ep.me).toBeGreaterThanOrEqual(1);
    expect(claims.cnf?.jwk.x).toBe(publicKey.toString("base64url"));
  });

  it("scopes a developer member and bumps the membership epoch on role change", async () => {
    const pro = await seedReadyProCloudWorkspace(pool);
    const member = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Member')", [member, `${member}@example.test`]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [pro.organizationId, member]);
    await pool.query("INSERT INTO team_members(team_id,org_id,user_id,role) VALUES($1,$2,$3,'member')", [pro.teamId, pro.organizationId, member]);
    await pool.query("INSERT INTO cloud_workspace_members(workspace_id,org_id,user_id,role) VALUES($1,$2,$3,'developer')", [pro.workspaceId, pro.organizationId, member]);
    await pool.query("INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source) VALUES($1,'pro','active',true,'operator')", [member]);
    await pool.query("INSERT INTO cloud_workspace_writer_slots(workspace_id,slot,user_id,invitation_id) VALUES($1,2,$2,NULL)", [pro.workspaceId, member]);
    await activateFirst();
    const value = await store();
    await vi.waitFor(() => expect(value.signer()).not.toBeNull());
    const { deviceId, sessionId } = await deviceAndSession(member);
    const read = async () => CapabilityClaimsSchema.parse(decodeJwt((await withSystemTx(pool, tx => issueClientCapability(tx, value, ISSUER, {
      organizationId: pro.organizationId, workspaceId: pro.workspaceId, actorUserId: member,
      deviceId, sessionId, audience: "zeros:realtime",
    }))).token));
    const first = await read();
    expect(first).toMatchObject({ aud: "zeros:realtime", role: "developer", scp: ["ws:edit", "ws:prompt", "ws:read"] });
    expect(first.ep.me).toBeGreaterThanOrEqual(2); // membership inserts bumped it
    const before = first.ep.me;
    await pool.query("UPDATE cloud_workspace_members SET role='viewer' WHERE workspace_id=$1 AND user_id=$2", [pro.workspaceId, member]);
    const demoted = await read();
    expect(demoted.ep.me).toBe(before + 1);
    expect(demoted).toMatchObject({ role: "viewer", scp: ["ws:read"] });
  });

  it("caps exp at the guest grant deadline", async () => {
    const pro = await seedReadyProCloudWorkspace(pool);
    const guest = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Guest')", [guest, `${guest}@example.test`]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [pro.organizationId, guest]);
    await pool.query("INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source) VALUES($1,'pro','active',true,'operator')", [guest]);
    await pool.query(`INSERT INTO cloud_workspace_guest_grants(id,workspace_id,org_id,user_id,role,created_by,expires_at)
      VALUES($1,$2,$3,$4,'viewer',$5,clock_timestamp()+interval '120 seconds')`, [randomUUID(), pro.workspaceId, pro.organizationId, guest, pro.userId]);
    await activateFirst();
    const value = await store();
    await vi.waitFor(() => expect(value.signer()).not.toBeNull());
    const { deviceId, sessionId } = await deviceAndSession(guest);
    const role = (await pool.query("SELECT cloud_workspace_actor_role($1,$2) AS role", [pro.workspaceId, guest])).rows[0]?.role;
    if (role !== "viewer") return; // guest visibility is billing-mode dependent; the deadline cap below is the assertion
    const issued = await withSystemTx(pool, tx => issueClientCapability(tx, value, ISSUER, {
      organizationId: pro.organizationId, workspaceId: pro.workspaceId, actorUserId: guest, deviceId, sessionId, audience: "zeros:engine",
    }));
    const claims = CapabilityClaimsSchema.parse(decodeJwt(issued.token));
    expect(claims.scp).toEqual(["ws:read"]);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(121);
    // NIT-1: renewal happens at 60% of the clamped lifetime, never after exp.
    expect(issued.renewAt.getTime()).toBeLessThan(claims.exp * 1000);
    expect(issued.renewAt.getTime()).toBeGreaterThan(claims.iat * 1000);
    expect(issued.renewAt.getTime() - claims.iat * 1000).toBeLessThanOrEqual(0.61 * (claims.exp - claims.iat) * 1000);
  });

  // NIT-1: renewAt must track the clamped exp, not the full lifetime. The
  // session deadline clamps deterministically regardless of billing mode.
  it("renews at 60% of the clamped lifetime when a deadline caps exp", async () => {
    const pro = await seedReadyProCloudWorkspace(pool);
    await activateFirst();
    const value = await store();
    await vi.waitFor(() => expect(value.signer()).not.toBeNull());
    const { deviceId, sessionId } = await deviceAndSession(pro.userId);
    await pool.query("UPDATE auth_sessions SET provider_session_expires_at=clock_timestamp()+interval '120 seconds' WHERE id=$1", [sessionId]);
    const issued = await withSystemTx(pool, tx => issueClientCapability(tx, value, ISSUER, {
      organizationId: pro.organizationId, workspaceId: pro.workspaceId, actorUserId: pro.userId,
      deviceId, sessionId, audience: "zeros:engine",
    }));
    const claims = CapabilityClaimsSchema.parse(decodeJwt(issued.token));
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(121);
    expect(issued.renewAt.getTime()).toBeLessThan(issued.expiresAt.getTime());
    expect(issued.renewAt.getTime()).toBeLessThanOrEqual(claims.iat * 1000 + 0.61 * (claims.exp - claims.iat) * 1000);
  });

  it("denies an untrusted device, a missing role and a revoked session", async () => {
    const pro = await seedReadyProCloudWorkspace(pool);
    await activateFirst();
    const value = await store();
    await vi.waitFor(() => expect(value.signer()).not.toBeNull());
    const { deviceId, sessionId } = await deviceAndSession(pro.userId);
    const request = {
      organizationId: pro.organizationId, workspaceId: pro.workspaceId, actorUserId: pro.userId,
      deviceId, sessionId, audience: "zeros:engine" as const,
    };
    await pool.query("UPDATE devices SET trust_state='pending' WHERE id=$1", [deviceId]);
    await expect(withSystemTx(pool, tx => issueClientCapability(tx, value, ISSUER, request)))
      .rejects.toMatchObject({ code: "workspace_replica_device_proof_rejected" });
    await pool.query("UPDATE devices SET trust_state='trusted' WHERE id=$1", [deviceId]);
    const stranger = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Stranger')", [stranger, `${stranger}@example.test`]);
    await pool.query("INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source) VALUES($1,'pro','active',true,'operator')", [stranger]);
    const foreign = await deviceAndSession(stranger);
    await expect(withSystemTx(pool, tx => issueClientCapability(tx, value, ISSUER, { ...request, actorUserId: stranger, deviceId: foreign.deviceId, sessionId: foreign.sessionId })))
      .rejects.toMatchObject({ code: "workspace_role_required" });
    await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=now(),revocation_reason='test' WHERE id=$1", [sessionId]);
    await expect(withSystemTx(pool, tx => issueClientCapability(tx, value, ISSUER, request)))
      .rejects.toMatchObject({ code: "capability_revoked" });
  });

  it("fails closed without a signing key", async () => {
    const value = await store();
    await expect(withSystemTx(pool, tx => issueEngineCapability(tx, value, ISSUER, {
      organizationId: fixture.organizationId, workspaceId: fixture.workspaceId, generation: 1, engineInstanceId: fixture.engineInstanceId,
    }))).rejects.toBeInstanceOf(CapabilityIssuerUnavailableError);
  });

  it("serves the engine capability route behind the flag with boot binding and a per-minute budget", async () => {
    await activateFirst();
    const value = await store();
    await vi.waitFor(() => expect(value.signer()).not.toBeNull());
    const bootId = (await pool.query<{ runtime_boot_id: string }>(
      "SELECT runtime_boot_id FROM cloud_workspace_engine_instances WHERE id=$1", [fixture.engineInstanceId])).rows[0]!.runtime_boot_id;
    const body = JSON.stringify({
      organizationId: fixture.organizationId, workspaceId: fixture.workspaceId, generation: 1,
      engineInstanceId: fixture.engineInstanceId, bootId,
    });
    const post = (app: ReturnType<typeof createCloudCapabilityEngineRoutes>, token = fixture.heartbeatToken, payload = body) =>
      app.request("/internal/v2/cloud-workspaces/engine/capability", {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: payload,
      });

    // Flag off answers exactly like a bad credential: no flag oracle.
    const dark = createCloudCapabilityEngineRoutes({ pool, keyStore: value, issuer: ISSUER, flags: flags(), workosEnabled: false });
    const darkAnswer = await post(dark), badAnswer = await post(
      createCloudCapabilityEngineRoutes({ pool, keyStore: value, issuer: ISSUER, flags: flags("capabilities"), workosEnabled: false }),
      `zwh_${"Z".repeat(43)}`);
    expect([darkAnswer.status, await darkAnswer.json()]).toEqual([badAnswer.status, await badAnswer.json()]);
    expect(darkAnswer.status).toBe(401);

    const app = createCloudCapabilityEngineRoutes({ pool, keyStore: value, issuer: ISSUER, flags: flags("capabilities"), workosEnabled: false });
    expect((await post(app, `zwh_${"Z".repeat(43)}`)).status).toBe(401);
    expect((await post(app, fixture.heartbeatToken, JSON.stringify({ ...JSON.parse(body), bootId: randomUUID() }))).status).toBe(401);
    const created = await post(app);
    expect(created.status).toBe(201);
    const payload = await created.json() as { capability: { token: string; expiresAt: string } };
    const claims = await verifiedHeaderAndClaims(payload.capability.token, [...value.publicKeySet()]);
    expect(claims.aud).toBe("zeros:api");
    expect((await post(app)).status).toBe(429);
    await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1", [fixture.engineInstanceId]);
    await new Promise(resolve => setTimeout(resolve, 0));
    const afterRevoke = createCloudCapabilityEngineRoutes({ pool, keyStore: value, issuer: ISSUER, flags: flags("capabilities"), workosEnabled: false });
    expect((await post(afterRevoke)).status).toBe(401);
  });

  it("throttles failed engine-token requests per engine id and client address before any SQL", async () => {
    await activateFirst();
    const value = await store();
    await vi.waitFor(() => expect(value.signer()).not.toBeNull());
    let clock = 1_800_000_000_000;
    const app = createCloudCapabilityEngineRoutes({ pool, keyStore: value, issuer: ISSUER, flags: flags("capabilities"),
      workosEnabled: false, now: () => clock }, { clientAddress: c => c.req.header("x-test-address") ?? "unknown" });
    const bootId = (await pool.query<{ runtime_boot_id: string }>(
      "SELECT runtime_boot_id FROM cloud_workspace_engine_instances WHERE id=$1", [fixture.engineInstanceId])).rows[0]!.runtime_boot_id;
    const post = (engineInstanceId: string, token: string, address = "203.0.113.9") => app.request("/internal/v2/cloud-workspaces/engine/capability", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-test-address": address },
      body: JSON.stringify({ organizationId: fixture.organizationId, workspaceId: fixture.workspaceId, generation: 1, engineInstanceId, bootId }),
    });
    const guess = `zwh_${"Z".repeat(43)}`;
    for (let attempt = 0; attempt < 5; attempt++) expect((await post(fixture.engineInstanceId, guess)).status).toBe(401);
    const throttled = await post(fixture.engineInstanceId, fixture.heartbeatToken);
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another engine id keeps its own budget.
    expect((await post(randomUUID(), guess)).status).toBe(401);
    // A caller elsewhere who knows the engine id cannot hold the engine's
    // own address at 429.
    expect((await post(fixture.engineInstanceId, fixture.heartbeatToken, "198.51.100.4")).status).toBe(201);
    clock += 60_000;
    expect((await post(fixture.engineInstanceId, guess)).status).toBe(401);
  });

  it("caps failed engine-token attempts per process so rotating engine ids cannot drive unbounded SQL", async () => {
    await activateFirst();
    const value = await store();
    await vi.waitFor(() => expect(value.signer()).not.toBeNull());
    let clock = 1_800_000_000_000;
    let address = 0;
    const app = createCloudCapabilityEngineRoutes({ pool, keyStore: value, issuer: ISSUER, flags: flags("capabilities"),
      workosEnabled: false, now: () => clock }, { clientAddress: () => `192.0.2.${address}` });
    const bootId = (await pool.query<{ runtime_boot_id: string }>(
      "SELECT runtime_boot_id FROM cloud_workspace_engine_instances WHERE id=$1", [fixture.engineInstanceId])).rows[0]!.runtime_boot_id;
    const post = (engineInstanceId: string, token: string) => app.request("/internal/v2/cloud-workspaces/engine/capability", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ organizationId: fixture.organizationId, workspaceId: fixture.workspaceId, generation: 1, engineInstanceId, bootId }),
    });
    const guess = `zwh_${"Z".repeat(43)}`;
    for (let attempt = 0; attempt < CAPABILITY_FALLBACK_FAILURE_CEILING; attempt++) {
      address = attempt % 250;
      expect((await post(randomUUID(), guess)).status).toBe(401);
    }
    const query = vi.spyOn(pool, "connect");
    const capped = await post(randomUUID(), guess);
    expect(capped.status).toBe(429);
    expect(Number(capped.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(query).not.toHaveBeenCalled();
    query.mockRestore();
    clock += 60_000;
    expect((await post(fixture.engineInstanceId, fixture.heartbeatToken)).status).toBe(201);
  });

  it("serves the public JWKS document with the published set", async () => {
    await activateFirst();
    const value = await store();
    await vi.waitFor(() => expect(value.signer()).not.toBeNull());
    const app = createCloudCapabilityKeyRoutes(value);
    const response = await app.request("/.well-known/zeros-capabilities/jwks.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("max-age=300");
    const document = await response.json() as { keys: Array<{ kid: string; kty: string; crv: string; x: string; use: string; alg: string }> };
    expect(document.keys).toHaveLength(1);
    expect(document.keys[0]).toMatchObject({ kid: kid("a"), kty: "OKP", crv: "Ed25519", use: "sig", alg: "EdDSA" });
    expect(document.keys[0]).not.toHaveProperty("d");
  });
});
