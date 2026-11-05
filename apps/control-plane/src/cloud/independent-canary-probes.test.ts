import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { workosTestEnv } from "../test-workos-env.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { RuntimeCanaryAuthority } from "./runtime-canary.js";
import { CloudV2Store } from "./store.js";

describe("independent dedicated-key identity probes", () => {
  const worker = generateKeyPairSync("ed25519"), prior = generateKeyPairSync("ed25519"), separate = generateKeyPairSync("ed25519");
  const fixture = { creatorUserId: randomUUID(), organizationId: randomUUID(), repositoryId: "42" };
  const env = {
    DATABASE_URL: "postgres://fixture@localhost/test_worker", DATABASE_MIGRATIONS_ON_BOOT: "false", ...workosTestEnv(),
    AUTH_AUDIENCE: "https://api.example.test", RAILWAY_ENVIRONMENT_NAME: "alpha", CLOUD_V2_ENABLED: "true", BOAT_API_KEY: "synthetic-unused-key",
    CLOUD_V2_API_URL: "https://api.example.test", CLOUD_V2_REALTIME_URL: "wss://realtime.example.test",
    CLOUD_V2_RUNTIME_SHA256: "a".repeat(64), CLOUD_V2_RUNTIME_STORE_ENDPOINT: "https://storage.example.test",
    CLOUD_V2_RUNTIME_STORE_BUCKET: "test", CLOUD_V2_RUNTIME_STORE_ACCESS_KEY_ID: "fixture", CLOUD_V2_RUNTIME_STORE_SECRET_ACCESS_KEY: "fixture",
    CLOUD_V2_WORKER_SIGNING_KEY: worker.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    CLOUD_V2_WORKER_SIGNING_KEY_PREVIOUS: prior.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
  const config = (publicKey: string) => loadConfig({ ...env, CLOUD_V2_RUNTIME_CANARY_CONFIG: JSON.stringify({ keys: [{ id: "candidate", publicKey }], fixture }) });
  it.each(["current", "previous"])("refuses the %s worker key even with another accepted SPKI byte encoding", which => {
    const pair = which === "current" ? worker : prior;
    const canonical = pair.publicKey.export({ format: "der", type: "spki" });
    const alternate = Buffer.concat([canonical, Buffer.from([0, 0])]);
    expect(createPublicKey({ key: alternate, format: "der", type: "spki" }).export({ format: "der", type: "spki" })).toEqual(canonical);
    let accepted = false;
    try {
      const policy = config(alternate.toString("base64")).cloudV2!.runtimeCanary!;
      const now = Math.floor(Date.now() / 1000);
      const claims = { version: 1, iss: "zeros-runtime-release", aud: "zeros-cloud-runtime-canary", channel: "alpha",
        jti: randomUUID(), iat: now, exp: now + 900, runId: "456", runAttempt: 1, runtimeSha256: "b".repeat(64), sourceSha: "c".repeat(40),
        ...fixture, createKey: "independent-key-proof" };
      const input = [{ alg: "EdDSA", typ: "zeros-runtime-canary+jwt", kid: "candidate" }, claims].map(v => Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
      const grant = `${input}.${sign(null, Buffer.from(input), pair.privateKey).toString("base64url")}`;
      accepted = new RuntimeCanaryAuthority(policy).verify(grant, claims).runtimeSha256 === claims.runtimeSha256;
    } catch { /* Either policy parsing or distinct-key validation must refuse. */ }
    expect(accepted).toBe(false);
  });
  it("refuses canonical worker keys and accepts a distinct release key", () => {
    for (const pair of [worker, prior]) expect(() => config(pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"))).toThrow();
    expect(config(separate.publicKey.export({ format: "der", type: "spki" }).toString("base64")).cloudV2?.runtimeCanary).toBeDefined();
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("independent nonce lock/expiry probes", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  beforeEach(() => resetMigratedTestDatabase(pool));
  afterAll(() => pool.end());
  it.each(["expire", "release", "retire"])("rechecks nonce ownership after an insert conflict: %s", async mode => {
    const user = randomUUID(), org = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Review fixture')", [user, `${user}@example.test`]);
    await grantTestPro(pool, user);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Fixture',$3,false,true)", [org, `fixture-${org}`, user]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, user]);
    const pair = generateKeyPairSync("ed25519"), now = Math.floor(Date.now() / 1000);
    const claims = { version: 1, iss: "zeros-runtime-release", aud: "zeros-cloud-runtime-canary", channel: "alpha", jti: randomUUID(),
      iat: now, exp: now + (mode === "expire" ? 2 : 900), runId: "456", runAttempt: 1,
      runtimeSha256: "b".repeat(64), sourceSha: "c".repeat(40), creatorUserId: user, organizationId: org, repositoryId: "42", createKey: randomUUID() };
    const unsigned = [{ alg: "EdDSA", typ: "zeros-runtime-canary+jwt", kid: "candidate" }, claims].map(v => Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
    const grant = `${unsigned}.${sign(null, Buffer.from(unsigned), pair.privateKey).toString("base64url")}`;
    const authority = new RuntimeCanaryAuthority({ keys: [{ id: "candidate", publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64") }],
      fixture: { creatorUserId: user, organizationId: org, repositoryId: "42" } });
    const admission = authority.verify(grant, claims), blocker = await pool.connect();
    let pending: Promise<{ ok: boolean; code?: string }> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(`INSERT INTO cloud_v2_runtime_canaries(grant_id,creator_user_id,org_id,repository_id,runtime_sha256,source_sha,grant_sha256,create_key_sha256,run_id,run_attempt,issued_at,expires_at)
        VALUES($1,$2,$3,42,$4,$5,$6,$7,'456',1,to_timestamp($8),to_timestamp($9))`,
      [claims.jti, user, org, claims.runtimeSha256, claims.sourceSha, admission.grantHash, createHash("sha256").update(claims.createKey).digest("hex"), claims.iat, claims.exp]);
      const store = new CloudV2Store(pool);
      pending = store.createWorkspaceOnce({ id: randomUUID(), organizationId: org, creatorUserId: user, name: "Candidate", repository: "fixture/repo", sourceRepositoryId: "42",
        branch: "review", baseBranch: "main", computerBuildId: null, runtimeCanary: admission }, claims.createKey, "d".repeat(64), w => ({ workspace: w }))
        .then(() => ({ ok: true }), e => ({ ok: false, code: e.code }));
      await expect.poll(async () => (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event='transactionid' AND query LIKE '%INSERT INTO cloud_v2_runtime_canaries%'`)).rows[0].n,
      { timeout: 1500, interval: 10 }).toBe(1);
      if (mode === "expire") await expect.poll(async () => (await pool.query("SELECT clock_timestamp()>to_timestamp($1) AS expired", [claims.exp])).rows[0].expired,
        { timeout: 3000, interval: 20 }).toBe(true);
      await blocker.query(mode === "retire" ? "COMMIT" : "ROLLBACK");
      const result = await pending;
      expect(result).toEqual(mode === "release" ? { ok: true } : { ok: false, code: "cloud_runtime_canary_refused" });
      const count = (await pool.query("SELECT count(*)::int AS n FROM cloud_v2_workspaces")).rows[0].n;
      expect(count).toBe(mode === "release" ? 1 : 0);
    } finally {
      await blocker.query("ROLLBACK"); blocker.release(); await pending;
    }
  });
});
