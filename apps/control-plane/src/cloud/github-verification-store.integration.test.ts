import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../authz.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { PostgresGithubVerificationStore, type GithubVerificationScope } from "./github-verification-store.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("durable cloud GitHub permission observations", () => {
  let pool: pg.Pool, store: PostgresGithubVerificationStore, scope: GithubVerificationScope;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    scope = { organizationId: randomUUID(), userId: randomUUID(), repositoryId: "42", fingerprint: "a".repeat(64) };
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'User')", [scope.userId, `${scope.userId}@example.test`]);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Org',$3,false,true)",
      [scope.organizationId, `org-${scope.organizationId}`, scope.userId]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [scope.organizationId, scope.userId]);
    store = new PostgresGithubVerificationStore(pool);
  });
  const age = () => pool.query("UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp()-interval '11 minutes' WHERE org_id=$1", [scope.organizationId]);
  async function allow() {
    const claim = await store.claim(scope);
    expect(claim?.claimId).toBeTruthy();
    return (await store.finish(scope, claim!.claimId!, { allowed: true }))!;
  }

  it("shares one claim across replicas and retains its original start time", async () => {
    const started = Date.now();
    const claims = await Promise.all(Array.from({ length: 12 }, () => new PostgresGithubVerificationStore(pool).claim(scope)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    const value = await store.finish(scope, claim.claimId!, { allowed: true, canonicalRepository: "current/project" });
    expect(value?.verifiedAt).toBeLessThanOrEqual(Date.now());
    expect(value?.verifiedAt).toBeGreaterThanOrEqual(started - 1000);
    const other = await new PostgresGithubVerificationStore(pool).read(scope);
    expect(other?.verifiedAt).not.toBeNull();
    expect(other?.failure).toBeNull();
    expect(other?.canonicalRepository).toBe("current/project");
    expect(other?.observedAt).toBeInstanceOf(Date);
    expect(await store.claim(scope)).toBeNull();
  });

  it("retains a positive observation during throttling and shares cooldown across repositories", async () => {
    await allow(); await age();
    const claim = await store.claim(scope);
    const failure = new HttpError(429, "github_rate_limited", "synthetic upstream detail");
    const value = await store.finish(scope, claim!.claimId!, { allowed: false, temporary: true, error: failure, retryAfterMs: 300_000 });
    expect(value?.verifiedAt).toBeLessThan(Date.now() - 10 * 60_000);
    expect(value?.retryAt).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(await new PostgresGithubVerificationStore(pool).claim(scope)).toBeNull();
    const otherRepository = { ...scope, repositoryId: "99" };
    expect(await store.read(otherRepository)).toBeNull();
    expect((await store.backoff(otherRepository))?.failure).toMatchObject({ code: "github_rate_limited" });
    expect((await store.backoff({ ...scope, fingerprint: "b".repeat(64) }))).toBeNull();
    expect(JSON.stringify(await store.read(scope))).not.toContain("synthetic upstream detail");
  });

  it("withdraws positive evidence on confirmed denial instead of retaining outage grace", async () => {
    await allow(); await age();
    const claim = await store.claim(scope);
    await store.finish(scope, claim!.claimId!, { allowed: false, temporary: false,
      error: new HttpError(403, "github_cloud_access_denied", "denied"), retryAfterMs: 60_000 });
    const other = await new PostgresGithubVerificationStore(pool).read(scope);
    expect(other?.verifiedAt).toBeNull();
    expect(other?.failure).toMatchObject({ status: 403 });
    expect(await store.backoff({ ...scope, repositoryId: "99" })).toBeNull();
  });

  it("rejects a late success after another replica replaced its expired claim", async () => {
    const original = await store.claim(scope);
    await pool.query("UPDATE cloud_github_source_verifications SET claim_until=clock_timestamp()-interval '1 second' WHERE org_id=$1", [scope.organizationId]);
    const successor = await store.claim(scope);
    expect(successor?.claimId).not.toBe(original?.claimId);
    await store.finish(scope, successor!.claimId!, { allowed: false, temporary: false,
      error: new HttpError(403, "github_cloud_access_denied", "denied"), retryAfterMs: 60_000 });
    expect(await store.finish(scope, original!.claimId!, { allowed: true })).toBeNull();
    expect((await store.read(scope))?.verifiedAt).toBeNull();
  });

  it("never imports a predecessor connection's observations or in-flight result", async () => {
    const original = await store.claim(scope);
    const next = { ...scope, fingerprint: "b".repeat(64) };
    expect(await store.read(next)).toBeNull();
    const successor = await store.claim(next);
    expect(await store.finish(scope, original!.claimId!, { allowed: true })).toBeNull();
    expect((await store.read(next))?.verifiedAt).toBeNull();
    expect(await store.finish(next, successor!.claimId!, { allowed: true })).not.toBeNull();
    expect(await store.read(scope)).toBeNull();
  });

  it("uses database ages across replicas with different wall clocks", async () => {
    await allow(); await age();
    const fastClock = Date.now() + 3 * 60 * 60_000;
    const value = await new PostgresGithubVerificationStore(pool, () => fastClock).read(scope);
    expect(fastClock - value!.verifiedAt!).toBeGreaterThanOrEqual(11 * 60_000);
    expect(fastClock - value!.verifiedAt!).toBeLessThan(12 * 60_000);
  });

  it("keeps observations system-only and removes them with organization membership", async () => {
    await allow();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE zeros_app");
      await client.query("SELECT set_config('app.system','off',true),set_config('app.user_id',$1,true)", [scope.userId]);
      expect((await client.query("SELECT * FROM cloud_github_source_verifications")).rowCount).toBe(0);
    } finally { await client.query("ROLLBACK"); client.release(); }
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [scope.organizationId, scope.userId]);
    expect(await store.read(scope)).toBeNull();
  });
});
