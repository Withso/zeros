import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { RolloutFlagSnapshot } from "../rollout-flags.js";
import { seedReadyProCloudWorkspace, type ReadyCloudWorkspaceFixture } from "../cloud-workspaces/test-fixtures.js";
import { loadCapabilityKeyring } from "../cloud-workspaces/capability-keyring.js";
import { CapabilitySigningKeyStore } from "../cloud-workspaces/capability-keys.js";
import { manageCloudCapabilityKey } from "../manage-cloud-capability-key.js";
import { DatabaseUplinkAuthSource, UplinkEngineCapabilityIssuer, UPLINK_AUTH_REVOCATION_RETENTION_MS } from "./uplink-auth-source.js";
import { CapabilityClaimsSchema } from "../cloud-workspaces/capability-contract.js";
import { decodeProtectedHeader, decodeJwt } from "jose";

const url = process.env.TEST_DATABASE_URL, d = url ? describe : describe.skip;
const keyring = loadCapabilityKeyring({
  CLOUD_CAPABILITY_KEYS_JSON: JSON.stringify({ 1: randomBytes(32).toString("base64url") }),
  CLOUD_CAPABILITY_CURRENT_KEY_VERSION: "1",
})!;
const ISSUER = "https://cp.example.test";

d("uplink auth source with PostgreSQL", () => {
  let pool: pg.Pool, listenerPool: pg.Pool, fixture: ReadyCloudWorkspaceFixture;
  let flags: RolloutFlagSnapshot, keyStore: CapabilitySigningKeyStore;
  let source: DatabaseUplinkAuthSource, issuer: UplinkEngineCapabilityIssuer;
  const operator = randomUUID();
  const identity = () => ({
    workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
    generation: 1, engineInstanceId: fixture.engineInstanceId, bootId: randomUUID(),
  });

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    listenerPool = createPool(url!, { maxConnections: 1, keepAlive: true, applicationName: "zeros-notifications" });
  });
  afterAll(async () => { await listenerPool.end(); await pool.end(); });
  afterEach(async () => { await keyStore?.stop(); await flags?.stop(); keyStore = undefined as never; flags = undefined as never; });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyProCloudWorkspace(pool);
    await pool.query("INSERT INTO users(id,email,display_name,staff_role) VALUES($1,$2,'Operator','platform_owner')", [operator, `${operator}@example.test`]);
    await pool.query("INSERT INTO cloud_rollout_flags(org_id,flag,enabled) VALUES($1,'capabilities',true)", [fixture.organizationId]);
    flags = new RolloutFlagSnapshot({ pool, listenerPool, refreshMs: 3_600_000 });
    await flags.start();
    const options = { databaseUrl: url!, channel: "development", keyring };
    const doc = (action: string) => ({ operationId: randomUUID(), channel: "development", actorUserId: operator,
      reason: "Uplink auth source fixture setup", action, kid: "cap-2026-10-a" });
    const execute = async (change: ReturnType<typeof doc>) => {
      const plan = await manageCloudCapabilityKey(pool, change, options);
      return manageCloudCapabilityKey(pool, change, { ...options, execute: true, approval: plan.planSha256 });
    };
    await execute(doc("create"));
    await execute(doc("activate"));
    keyStore = new CapabilitySigningKeyStore({ pool, listenerPool, keyring, refreshMs: 3_600_000, logger: { warn: vi.fn(), info: vi.fn() } });
    await keyStore.start();
    await vi.waitFor(() => { if (!keyStore.signer()) throw new Error("signer not loaded"); });
    source = new DatabaseUplinkAuthSource({ pool, keyStore, flags });
    issuer = new UplinkEngineCapabilityIssuer({ pool, keyStore, issuer: ISSUER, flags });
  });

  it("publishes the live JWKS", async () => {
    const keys = await source.keys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kid: "cap-2026-10-a", kty: "OKP", crv: "Ed25519", use: "sig", alg: "EdDSA" });
  });

  it("returns the S1 snapshot scope for the workspace", async () => {
    const publicKey = randomBytes(32);
    const device = (await pool.query<{ id: string }>(
      "INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint) VALUES($1,'uplink','macos',$2,$3) RETURNING id",
      [fixture.userId, publicKey, createHash("sha256").update(publicKey).digest()])).rows[0]!;
    const session = (await pool.query<{ id: string }>(
      `INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at)
       VALUES($1,$2,$3,'desktop',now()+interval '1 hour') RETURNING id`, [`s-${randomUUID()}`, `sub-${fixture.userId}`, fixture.userId])).rows[0]!;

    const snapshot = await source.snapshot(identity(), undefined);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.authCursor).toMatch(/^t\d+$/);
    expect(snapshot.epochs.wa).toBeGreaterThanOrEqual(1);
    expect(snapshot.epochs.wr).toBeGreaterThanOrEqual(1);
    expect(snapshot.epochs.members?.[fixture.userId]).toBeGreaterThanOrEqual(1);
    expect(snapshot.epochs.accounts?.[fixture.userId]).toBe(1);
    expect(snapshot.epochs.devices?.[device.id]).toBe(1);
    expect(snapshot.revocations).toEqual([]);

    // A revoked session and device appear, each with its drop deadline.
    const before = Date.now();
    await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=now(),revocation_reason='test' WHERE id=$1", [session.id]);
    await pool.query("UPDATE devices SET trust_state='revoked',revoked_at=now() WHERE id=$1", [device.id]);
    const next = await source.snapshot(identity(), snapshot.authCursor);
    expect(next.complete).toBe(true);
    expect(next.epochs.devices?.[device.id]).toBeUndefined();
    const byKind = Object.fromEntries(next.revocations.map(entry => [entry.kind, entry]));
    expect(byKind.session?.id).toBe(session.id);
    expect(byKind.device?.id).toBe(device.id);
    for (const entry of next.revocations) {
      expect(entry.until).toBeGreaterThan(before + UPLINK_AUTH_REVOCATION_RETENTION_MS - 5_000);
      expect(entry.until).toBeLessThan(Date.now() + UPLINK_AUTH_REVOCATION_RETENTION_MS + 5_000);
    }
  });

  it("lists a recently removed member with their raised epoch", async () => {
    const member = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Member')", [member, `${member}@example.test`]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [fixture.organizationId, member]);
    await pool.query("INSERT INTO cloud_workspace_members(workspace_id,org_id,user_id,role) VALUES($1,$2,$3,'developer')", [fixture.workspaceId, fixture.organizationId, member]);
    const withMember = await source.snapshot(identity(), undefined);
    const epoch = withMember.epochs.members?.[member];
    expect(epoch).toBeGreaterThanOrEqual(1);
    await pool.query("DELETE FROM cloud_workspace_members WHERE workspace_id=$1 AND user_id=$2", [fixture.workspaceId, member]);
    const afterRemoval = await source.snapshot(identity(), undefined);
    expect(afterRemoval.epochs.members?.[member]).toBeGreaterThan(epoch!);
  });

  it("issues the engine token from current authority and reports revocation as authority loss", async () => {
    const issued = await issuer.issue(identity());
    expect(issued.ok).toBe(true);
    if (issued.ok) {
      expect(decodeProtectedHeader(issued.token)).toMatchObject({ alg: "EdDSA", typ: "zeros-cap+jwt", kid: "cap-2026-10-a" });
      const claims = CapabilityClaimsSchema.parse(decodeJwt(issued.token));
      expect(claims).toMatchObject({ iss: ISSUER, aud: "zeros:api", knd: "engine", ein: fixture.engineInstanceId });
      expect(issued.expiresAtMs).toBeGreaterThan(Date.now());
    }
    await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1", [fixture.engineInstanceId]);
    expect(await issuer.issue(identity())).toEqual({ ok: false, reason: "authority" });
  });

  it("stays inert for an organization whose capabilities flag is off", async () => {
    await pool.query("DELETE FROM cloud_rollout_flags WHERE org_id=$1 AND flag='capabilities'", [fixture.organizationId]);
    await flags.reload();
    await expect(source.snapshot(identity(), undefined)).rejects.toThrow();
    expect(await issuer.issue(identity())).toEqual({ ok: false, reason: "unavailable" });
  });
});
