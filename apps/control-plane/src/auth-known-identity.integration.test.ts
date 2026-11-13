import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUser, resolveAuthenticatedUser } from "./auth.js";
import { resetMigratedTestDatabase } from "./test-database.js";
import { workOSProviderSubjectLockKey, workOSUserProviderLockKey } from "./workos-provider-locks.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const identity = () => {
  const subject = `user_${randomUUID()}`;
  return {
    provider: "workos" as const, providerSubject: subject,
    email: `${subject}@example.test`, displayName: "Known identity",
    session: { id: `session_${randomUUID()}`, clientKind: "desktop" as const,
      authTime: Math.floor(Date.now() / 1000), tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600 },
  };
};

database("known WorkOS identity admission", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 }); });
  beforeEach(() => resetMigratedTestDatabase(pool));
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => pool.end());

  it("uses the exact subject without scanning account, recovery or historical session associations", async () => {
    const input = identity(), user = await ensureUser(pool, input);
    await resolveAuthenticatedUser(pool, input);
    const client = await pool.connect(), query = vi.spyOn(client, "query");
    client.release();

    expect((await resolveAuthenticatedUser(pool, input)).id).toBe(user.id);
    const statements = query.mock.calls.map(([value]) => typeof value === "string" ? value : value.text);
    expect(statements.filter(sql => /FROM account_recovery_requests|FROM users account WHERE account.email/.test(sql))).toEqual([]);
    expect(statements.filter(sql => /FROM user_identities/.test(sql)).length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the exact account when its token email matches another account", async () => {
    const input = identity(), user = await ensureUser(pool, input), other = identity();
    await ensureUser(pool, other);
    expect((await resolveAuthenticatedUser(pool, { ...input, email: other.email })).id).toBe(user.id);
  });

  it("still rejects a session already bound to another subject", async () => {
    const input = identity(), other = identity();
    await ensureUser(pool, input);
    await ensureUser(pool, other);
    await resolveAuthenticatedUser(pool, other);
    await expect(resolveAuthenticatedUser(pool, { ...input, session: other.session }))
      .rejects.toMatchObject({ status: 401, code: "session_identity_mismatch" });
  });

  it("still refuses a superseded exact identity", async () => {
    const input = identity();
    await ensureUser(pool, input);
    await pool.query("UPDATE user_identities SET status='superseded' WHERE provider='workos' AND provider_sub=$1", [input.providerSubject]);
    await expect(resolveAuthenticatedUser(pool, input)).rejects.toMatchObject({ status: 401 });
  });

  it("rediscovers and locks the new account when an exact identity moves while admission waits", async () => {
    const input = identity(), other = identity();
    await ensureUser(pool,input);
    const target = await ensureUser(pool,other);
    const blocker = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await blocker.connect();
    let pending: ReturnType<typeof resolveAuthenticatedUser> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [workOSProviderSubjectLockKey({ kind: "user", id: input.providerSubject })]);
      const client = await pool.connect(), query = vi.spyOn(client,"query"); client.release();
      pending = resolveAuthenticatedUser(pool,input); void pending.catch(() => {});
      const locks = () => query.mock.calls.filter(([sql]) => typeof sql === "string" && sql.includes("workos-authentication"));
      await expect.poll(() => locks().length, { timeout: 3000, interval: 5 }).toBeGreaterThan(0);
      await blocker.query("UPDATE user_identities SET status='superseded' WHERE provider='workos' AND provider_sub=$1", [other.providerSubject]);
      await blocker.query("UPDATE user_identities SET user_id=$2 WHERE provider='workos' AND provider_sub=$1", [input.providerSubject,target.id]);
      await blocker.query("COMMIT");
      expect((await pending).id).toBe(target.id);
      expect(locks().map(([,values]) => values?.[0])).toContainEqual(expect.arrayContaining([workOSUserProviderLockKey(target.id)]));
    } finally {
      await blocker.query("ROLLBACK"); await pending?.catch(() => {}); await blocker.end();
    }
  });
});
