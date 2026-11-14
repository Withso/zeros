import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SYSTEM_DATABASE_CONTEXT } from "./db-context.js";
import { withSystemTx, withUserTx } from "./db.js";
import { migrationChecksum, runMigrations } from "./migrate.js";
import { migrationPhase } from "./migration-phase.js";
import { organizationMemberSeats } from "./organization-seats.js";
import { resetMigratedTestDatabase } from "./test-database.js";
import { grantTestPro } from "./test-pro.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("stored organization seats", () => {
  let pool: pg.Pool, org: string, people: string[];
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6, statement_timeout: 10_000 }); });
  afterAll(() => pool.end());
  const person = (index: number) => people[index]!;
  const createOrg = async () => {
    const id = randomUUID();
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$3,'Seats',$2,false,true)", [id,person(0),`org-${id}`]);
    return id;
  };
  const seats = (organization = org) => withSystemTx(pool, tx => organizationMemberSeats(tx,organization));
  const parity = async (organization = org) => {
    const expected = await withSystemTx(pool, tx => tx.query<{ user_id: string; seat: string }>(
      "SELECT * FROM organization_member_seats_at($1,10,5,now())", [organization]));
    expect(await seats(organization)).toEqual(new Map(expected.rows.map(row => [row.user_id,row.seat])));
    expect((await pool.query("SELECT count(*)::integer AS n FROM organization_member_seat_periods WHERE org_id=$1", [organization])).rows[0].n)
      .toBe(expected.rows.length);
  };
  const restoreLegacySeats = async (tx: pg.PoolClient) => {
    const legacy = await readFile(new URL("../migrations/0216_pro_organization_seats.sql",import.meta.url),"utf8");
    await tx.query(`DROP FUNCTION refresh_changed_organization_seats() CASCADE;
      DROP FUNCTION refresh_organization_member_seats(uuid);
      DROP FUNCTION organization_member_seat_periods_for(uuid[]);
      DROP TABLE organization_member_seat_periods,organization_seat_generations,organization_seat_user_generations;
      ALTER TRIGGER a0_staff_pro_benefit_sync ON users RENAME TO staff_pro_benefit_sync;`);
    await tx.query(legacy.slice(legacy.indexOf("CREATE FUNCTION organization_member_seats(")).replaceAll("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"));
    await tx.query("DROP FUNCTION organization_member_seats_at(uuid,integer,integer,timestamptz)");
  };
  const seedSeats = async () => {
    people = Array.from({ length: 8 }, () => randomUUID());
    await pool.query("INSERT INTO users(id,email) SELECT id,id::text||'@example.test' FROM unnest($1::uuid[]) AS u(id)", [people]);
    await grantTestPro(pool,person(0));
    org = await createOrg();
    await pool.query(`INSERT INTO organization_members(org_id,user_id,role,created_at)
      SELECT $1,id,CASE WHEN n=1 THEN 'owner' ELSE 'member' END::organization_role,'2000-01-01'::timestamptz+n*interval '1 day'
      FROM unnest($2::uuid[]) WITH ORDINALITY AS u(id,n)`, [org,people.slice(0,7)]);
    expect((await seats()).get(person(6))).toBe("hold");
  };
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    await seedSeats();
  });

  it.each(["insert","delete","ordering","rebind","move","account cascade"] as const)("refreshes old and new scope for membership %s", async change => {
    const other = await createOrg();
    await withSystemTx(pool, async tx => {
      if (change === "insert") await tx.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [org,person(7)]);
      if (change === "delete") await tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org,person(1)]);
      if (change === "ordering") await tx.query("UPDATE organization_members SET created_at='1999-01-01' WHERE org_id=$1 AND user_id=$2", [org,person(6)]);
      if (change === "rebind") await tx.query("UPDATE organization_members SET user_id=$3 WHERE org_id=$1 AND user_id=$2", [org,person(1),person(7)]);
      if (change === "move") await tx.query("UPDATE organization_members SET org_id=$3 WHERE org_id=$1 AND user_id=$2", [org,person(1),other]);
    });
    if (change === "account cascade") await pool.query("DELETE FROM users WHERE id=$1", [person(1)]);
    await parity(); await parity(other);
    const state = await seats();
    if (["delete","move","account cascade"].includes(change)) expect(state.get(person(6))).toBe("free");
    if (change === "ordering") {
      expect(state.get(person(6))).toBe("free"); expect(state.get(person(5))).toBe("hold");
    }
    if (change === "rebind") {
      expect(state.has(person(1))).toBe(false); expect(state.get(person(7))).toBe("free");
    }
    if (change === "insert") expect(state.get(person(7))).toBe("hold");
  });

  it.each(["cancel","downgrade","disabled","window","delete","rebind"] as const)("refreshes a Pro %s in every organization", async change => {
    const other = await createOrg();
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [other,person(1)]);
    await grantTestPro(pool,person(1));
    expect((await seats()).get(person(6))).toBe("free");
    expect((await seats(other)).get(person(1))).toBe("pro");
    if (change === "cancel") await pool.query("UPDATE account_entitlements SET status='cancelled' WHERE user_id=$1", [person(1)]);
    if (change === "downgrade") await pool.query("UPDATE account_entitlements SET plan='free',cloud_workspaces_allowed=false WHERE user_id=$1", [person(1)]);
    if (change === "disabled") await pool.query("UPDATE account_entitlements SET cloud_workspaces_allowed=false WHERE user_id=$1", [person(1)]);
    if (change === "window") await pool.query("UPDATE account_entitlements SET valid_until=now()-interval '1 minute',valid_from='1990-01-01' WHERE user_id=$1", [person(1)]);
    if (change === "delete") await pool.query("DELETE FROM account_entitlements WHERE user_id=$1", [person(1)]);
    if (change === "rebind") await pool.query("UPDATE account_entitlements SET user_id=$2 WHERE user_id=$1", [person(1),person(6)]);
    await parity(); await parity(other);
    expect((await seats(other)).get(person(1))).toBe("free");
  });

  it.each(["role","revoke","delete","regrant"] as const)("refreshes staff benefit %s without displacing established free members", async change => {
    await pool.query("UPDATE users SET staff_role='developer' WHERE id=$1", [person(6)]);
    expect((await seats()).get(person(6))).toBe("pro");
    if (change === "role") await pool.query("UPDATE users SET staff_role='support_admin' WHERE id=$1", [person(6)]);
    if (change === "revoke") await pool.query("UPDATE staff_pro_benefits SET revoked_at=clock_timestamp() WHERE user_id=$1", [person(6)]);
    if (change === "delete") await pool.query("DELETE FROM staff_pro_benefits WHERE user_id=$1", [person(6)]);
    if (change === "regrant") {
      await pool.query("UPDATE users SET staff_role=NULL WHERE id=$1", [person(6)]);
      expect((await seats()).get(person(6))).toBe("hold");
      await pool.query("UPDATE users SET staff_role='platform_owner' WHERE id=$1", [person(6)]);
    }
    await parity();
    expect((await seats()).get(person(5))).toBe("free");
    expect((await seats()).get(person(6))).toBe(change === "regrant" ? "pro" : "hold");
  });

  it("stores the exact start/end boundaries, including the free member released by a future grant", async () => {
    await pool.query(`INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source,valid_from,valid_until)
      VALUES($1,'pro','cancelled',true,'operator','2100-01-01','2100-02-01')`, [person(1)]);
    const sample = async (at: string) => {
      const result = await withSystemTx(pool, tx => tx.query<{ user_id: string; seat: string }>(
        `SELECT user_id,CASE WHEN hold_periods @> $2::timestamptz THEN 'hold'
          WHEN pro_periods @> $2::timestamptz THEN 'pro' ELSE 'free' END AS seat
        FROM organization_member_seat_periods WHERE org_id=$1`, [org,at]));
      return new Map(result.rows.map(row => [row.user_id,row.seat]));
    };
    const before = await sample("2099-12-31T23:59:59.999999Z");
    expect(before.get(person(1))).toBe("free"); expect(before.get(person(6))).toBe("hold");
    for (const at of ["2100-01-01T00:00:00Z","2100-01-31T23:59:59.999999Z"]) {
      const active = await sample(at);
      expect(active.get(person(1))).toBe("pro"); expect(active.get(person(6))).toBe("free");
    }
    const expired = await sample("2100-02-01T00:00:00Z");
    expect(expired.get(person(1))).toBe("hold"); expect(expired.get(person(6))).toBe("free");
    await parity();
  });

  it("preserves the legacy policy at every boundary across mixed plans and organizations over the member cap", async () => {
    const added = Array.from({ length: 4 }, () => randomUUID());
    people.push(...added);
    await pool.query("INSERT INTO users(id,email) SELECT id,id::text||'@example.test' FROM unnest($1::uuid[]) AS u(id)", [added]);
    await pool.query(`INSERT INTO organization_members(org_id,user_id,role,created_at)
      SELECT $1,id,'member','2000-01-08'::timestamptz+n*interval '1 day'
      FROM unnest($2::uuid[]) WITH ORDINALITY AS u(id,n)`, [org,people.slice(7)]);
    const other = await createOrg();
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) SELECT $1,id,'member' FROM unnest($2::uuid[]) AS u(id)", [other,[person(0),person(3),person(11)]]);
    await grantTestPro(pool,person(11));
    await pool.query(`INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source,valid_from,valid_until)
      VALUES($1,'pro','active',true,'operator','2100-01-01','2100-02-01'),
        ($2,'pro','active',true,'operator','2000-01-01','2001-01-01'),
        ($3,'pro','trialing',true,'operator','2000-01-01',NULL),
        ($4,'pro','cancelled',true,'operator','2100-01-01','2100-03-01'),
        ($5,'pro','active',false,'operator','2000-01-01','2100-02-01')`, people.slice(1,6));
    await pool.query("UPDATE users SET staff_role='developer' WHERE id=$1", [person(6)]);
    const boundaries = (await pool.query<{ at: string }>(`WITH boundaries(at) AS (
      SELECT now() UNION SELECT valid_from FROM account_entitlements UNION SELECT valid_until FROM account_entitlements WHERE valid_until IS NOT NULL)
      SELECT (at+delta)::text AS at FROM boundaries CROSS JOIN (VALUES(interval '-1 microsecond'),(interval '0'),(interval '1 microsecond')) AS samples(delta)`)).rows;
    for (const { at } of boundaries) {
      for (const organization of [org,other]) {
        await withSystemTx(pool,async tx => {
          const legacy = (await tx.query("SELECT * FROM organization_member_seats_at($1,10,5,$2) ORDER BY user_id", [organization,at])).rows;
          const stored = (await tx.query(`SELECT user_id,CASE WHEN hold_periods @> $2::timestamptz THEN 'hold'
            WHEN pro_periods @> $2::timestamptz THEN 'pro' ELSE 'free' END AS seat
            FROM organization_member_seat_periods WHERE org_id=$1 ORDER BY user_id`, [organization,at])).rows;
          expect(stored).toEqual(legacy);
        });
      }
    }
    expect((await seats()).get(person(11))).toBe("hold");
    expect((await seats(other)).get(person(11))).toBe("pro");
  });

  it("refreshes a status-only cancellation in the same transaction without changing its dates", async () => {
    await grantTestPro(pool,person(1));
    const dates = (await pool.query("SELECT valid_from,valid_until FROM account_entitlements WHERE user_id=$1", [person(1)])).rows;
    const tx = await pool.connect();
    try {
      await tx.query(`BEGIN; ${SYSTEM_DATABASE_CONTEXT}`);
      await tx.query("UPDATE account_entitlements SET status='cancelled' WHERE user_id=$1", [person(1)]);
      expect((await tx.query("SELECT valid_from,valid_until FROM account_entitlements WHERE user_id=$1", [person(1)])).rows).toEqual(dates);
      expect((await tx.query("SELECT seat FROM organization_member_seats($1,10,5) WHERE user_id=$2", [org,person(1)])).rows)
        .toEqual([{ seat: "hold" }]);
    } finally { await tx.query("ROLLBACK"); tx.release(); }
    expect((await seats()).get(person(1))).toBe("pro");
  });

  it.each(["", "off", "on", "caller-context"])("restores the caller's app.system=%j after every input trigger and an early return", async context => {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN"); await tx.query("SELECT set_config('app.system',$1,true)", [context]);
      const statements: Array<[string,unknown[]]> = [
        ["INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [org,person(7)]],
        ["UPDATE organization_members SET created_at=created_at+interval '1 second' WHERE org_id=$1 AND user_id=$2", [org,person(1)]],
        ["INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source) VALUES($1,'pro','active',true,'operator')", [person(1)]],
        ["UPDATE account_entitlements SET status='trialing' WHERE user_id=$1", [person(1)]],
        ["UPDATE users SET staff_role='developer' WHERE id=$1", [person(6)]],
        ["UPDATE staff_pro_benefits SET revoked_at=clock_timestamp() WHERE user_id=$1", [person(6)]],
        ["DELETE FROM staff_pro_benefits WHERE user_id=$1", [person(6)]],
        ["DELETE FROM account_entitlements WHERE user_id=$1", [person(1)]],
        ["DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org,person(7)]],
        ["SELECT refresh_organization_member_seats($1)", [randomUUID()]],
      ];
      for (const [statement,values] of statements) {
        await tx.query(statement,values);
        expect((await tx.query("SELECT current_setting('app.system',true) AS value")).rows[0].value).toBe(context);
      }
    } finally { await tx.query("ROLLBACK"); tx.release(); }
  });

  it.each(["membership","entitlement","staff benefit","staff role"] as const)("restores context when the %s refresh raises inside a savepoint", async writer => {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN; SELECT set_config('app.system','caller-context',true)");
      if (writer === "staff benefit") await tx.query("UPDATE users SET staff_role='developer' WHERE id=$1", [person(6)]);
      await tx.query("UPDATE organization_seat_generations SET revision=9223372036854775807 WHERE org_id=$1", [org]);
      await tx.query("SAVEPOINT input_write");
      const statement = writer === "membership" ? "UPDATE organization_members SET created_at=created_at+interval '1 second' WHERE user_id=$1"
        : writer === "entitlement" ? "INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source) VALUES($1,'pro','active',true,'operator')"
        : writer === "staff benefit" ? "UPDATE staff_pro_benefits SET revoked_at=clock_timestamp() WHERE user_id=$1"
        : "UPDATE users SET staff_role='developer' WHERE id=$1";
      await expect(tx.query(statement,[person(6)])).rejects.toMatchObject({ code: "22003" });
      await tx.query("ROLLBACK TO SAVEPOINT input_write");
      expect((await tx.query("SELECT current_setting('app.system',true) AS value")).rows[0].value).toBe("caller-context");
    } finally { await tx.query("ROLLBACK"); tx.release(); }
    await parity();
  });

  it.each([
    ["entitlement", "cancel-first"], ["entitlement", "join-first"],
    ["staff benefit", "cancel-first"], ["staff benefit", "join-first"],
    ["staff role", "cancel-first"], ["staff role", "join-first"],
  ] as const)("keeps a concurrent %s loss and membership join on Hold (%s)", async (writer, order) => {
    if (writer === "entitlement") await grantTestPro(pool,person(7));
    else await pool.query("UPDATE users SET staff_role='developer' WHERE id=$1", [person(7)]);
    const loss = writer === "entitlement"
      ? "UPDATE account_entitlements SET status='cancelled' WHERE user_id=$1"
      : writer === "staff benefit"
        ? "UPDATE staff_pro_benefits SET revoked_at=clock_timestamp() WHERE user_id=$1"
        : "UPDATE users SET staff_role=NULL WHERE id=$1";
    const join = "INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')";
    const first = await pool.connect(), second = await pool.connect();
    let pending: Promise<pg.QueryResult> | undefined, finished = false;
    try {
      await first.query(`BEGIN; ${SYSTEM_DATABASE_CONTEXT}`);
      const firstPid = (await first.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      if (order === "cancel-first") await first.query(loss, [person(7)]);
      else await first.query(join, [org,person(7)]);
      await second.query(`BEGIN; ${SYSTEM_DATABASE_CONTEXT}`);
      const secondPid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      pending = order === "cancel-first" ? second.query(join, [org,person(7)]) : second.query(loss, [person(7)]);
      void pending.then(() => { finished = true; }, () => { finished = true; });
      await expect.poll(async () => finished || (await pool.query(
        "SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked", [secondPid,firstPid])).rows[0].blocked,
      { timeout: 3000, interval: 10 }).toBe(true);
      await first.query("COMMIT"); await pending; await second.query("COMMIT");
      expect((await seats()).get(person(7))).toBe("hold");
      await parity();
    } finally {
      await first.query("ROLLBACK"); await pending?.catch(() => {}); await second.query("ROLLBACK");
      first.release(); second.release();
    }
  });

  it.each(["move-first", "cancel-first"] as const)("refreshes the destination after an existing member moves during cancellation (%s)", async order => {
    const source = await createOrg();
    await grantTestPro(pool,person(7));
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [source,person(7)]);
    const cancel = "UPDATE account_entitlements SET status='cancelled' WHERE user_id=$1";
    const move = "UPDATE organization_members SET org_id=$3 WHERE org_id=$1 AND user_id=$2";
    const first = await pool.connect(), second = await pool.connect();
    let pending: Promise<pg.QueryResult> | undefined, finished = false;
    try {
      await first.query(`BEGIN; ${SYSTEM_DATABASE_CONTEXT}`);
      const firstPid = (await first.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      if (order === "move-first") {
        await first.query("SELECT 1 FROM organizations WHERE id=$1 FOR NO KEY UPDATE", [org]);
        await first.query(move, [source,person(7),org]);
      } else await first.query(cancel, [person(7)]);
      await second.query(`BEGIN; ${SYSTEM_DATABASE_CONTEXT}`);
      const secondPid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      if (order === "cancel-first") await second.query("SELECT 1 FROM organizations WHERE id=$1 FOR NO KEY UPDATE", [org]);
      pending = order === "move-first" ? second.query(cancel, [person(7)]) : second.query(move, [source,person(7),org]);
      void pending.then(() => { finished = true; }, () => { finished = true; });
      await expect.poll(async () => finished || (await pool.query(
        "SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked", [secondPid,firstPid])).rows[0].blocked,
      { timeout: 3000, interval: 10 }).toBe(true);
      await first.query("COMMIT"); await pending; await second.query("COMMIT");
      expect((await seats()).get(person(7))).toBe("hold");
      await parity(); await parity(source);
    } finally {
      await first.query("ROLLBACK"); await pending?.catch(() => {}); await second.query("ROLLBACK");
      first.release(); second.release();
    }
  });

  it.each(["join", "cancel"] as const)("rejects a stale repeatable-read %s across a previously empty membership scope", async change => {
    await grantTestPro(pool,person(7));
    const stale = await pool.connect();
    const join = "INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')";
    const cancel = "UPDATE account_entitlements SET status='cancelled' WHERE user_id=$1";
    try {
      await stale.query(`BEGIN ISOLATION LEVEL REPEATABLE READ; ${SYSTEM_DATABASE_CONTEXT}`);
      await stale.query("SELECT 1 FROM organization_members WHERE user_id=$1", [person(7)]);
      if (change === "join") {
        await pool.query(cancel, [person(7)]);
        await expect(stale.query(join, [org,person(7)])).rejects.toMatchObject({ code: "40001" });
      } else {
        await pool.query(join, [org,person(7)]);
        await expect(stale.query(cancel, [person(7)])).rejects.toMatchObject({ code: "40001" });
      }
    } finally { await stale.query("ROLLBACK"); stale.release(); }
    await pool.query(cancel, [person(7)]);
    if (change === "join") await pool.query(join, [org,person(7)]);
    expect((await seats()).get(person(7))).toBe("hold");
    await parity();
  });

  it("releases the person lock before waiting on a newly discovered organization", async () => {
    await grantTestPro(pool,person(7));
    const joining = await pool.connect(), cancelling = await pool.connect(), editing = await pool.connect();
    let cancellation: Promise<pg.QueryResult> | undefined, cancelPid: number | undefined, cancellationFinished = false;
    let barrierHeld = false;
    const blockedBy = async (waiting: number, holding: number) => (await pool.query(
      "SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked", [waiting,holding])).rows[0].blocked;
    try {
      // Tuple-lock waiters can be overtaken. Hold cancellation at its person
      // version until the editor owns the newly committed organization.
      await pool.query(`CREATE FUNCTION test_hold_seat_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text,0)); RETURN NEW; END; $$;
        CREATE TRIGGER test_hold_seat_cancellation AFTER UPDATE ON organization_seat_user_generations
        FOR EACH ROW WHEN (current_setting('application_name')='seat-cancellation-test')
        EXECUTE FUNCTION test_hold_seat_cancellation()`);
      await editing.query(`BEGIN; ${SYSTEM_DATABASE_CONTEXT}`);
      const editPid = (await editing.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await editing.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [person(7)]);
      barrierHeld = true;
      await joining.query(`BEGIN; ${SYSTEM_DATABASE_CONTEXT}`);
      const joinPid = (await joining.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await joining.query("SELECT 1 FROM organizations WHERE id=$1 FOR NO KEY UPDATE", [org]);
      await joining.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [org,person(7)]);
      await cancelling.query(`BEGIN; SELECT set_config('app.system','caller-context',true),
        set_config('application_name','seat-cancellation-test',true)`);
      cancelPid = (await cancelling.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      cancellation = cancelling.query("UPDATE account_entitlements SET status='cancelled' WHERE user_id=$1", [person(7)]);
      void cancellation.then(() => { cancellationFinished = true; }, () => { cancellationFinished = true; });
      await expect.poll(() => blockedBy(cancelPid!,joinPid), { timeout: 3000, interval: 10 }).toBe(true);
      await joining.query("COMMIT");
      await expect.poll(async () => (await pool.query(
        "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted AND locktype='advisory') AS waiting", [cancelPid])).rows[0].waiting,
      { timeout: 3000, interval: 10 }).toBe(true);
      await editing.query("SELECT 1 FROM organizations WHERE id=$1 FOR NO KEY UPDATE", [org]);
      await editing.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [person(7)]);
      barrierHeld = false;
      await expect.poll(async () => (await pool.query(`SELECT $2::integer=ANY(pg_blocking_pids($1))
        AND EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted AND locktype='transactionid') AS blocked`, [cancelPid,editPid])).rows[0].blocked,
      { timeout: 3000, interval: 10 }).toBe(true);
      await editing.query("UPDATE organization_members SET created_at=created_at+interval '1 second' WHERE org_id=$1 AND user_id=$2", [org,person(7)]);
      await editing.query("COMMIT"); await cancellation;
      expect((await cancelling.query("SELECT current_setting('app.system',true) AS value")).rows[0].value).toBe("caller-context");
      await cancelling.query("COMMIT");
      expect((await seats()).get(person(7))).toBe("hold");
      await parity();
    } finally {
      if (cancelPid && !cancellationFinished) await pool.query("SELECT pg_cancel_backend($1)", [cancelPid]);
      await cancellation?.catch(() => {});
      await Promise.all([joining.query("ROLLBACK"),editing.query("ROLLBACK"),cancelling.query("ROLLBACK")]);
      if (barrierHeld) await editing.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [person(7)]);
      joining.release(); cancelling.release(); editing.release();
      await pool.query(`DROP TRIGGER IF EXISTS test_hold_seat_cancellation ON organization_seat_user_generations;
        DROP FUNCTION IF EXISTS test_hold_seat_cancellation()`);
    }
  });

  it("does not publish uncommitted seats and serializes writers before refreshing", async () => {
    const first = await pool.connect(), second = await pool.connect();
    let pending: Promise<pg.QueryResult> | undefined;
    try {
      await first.query(`BEGIN; ${SYSTEM_DATABASE_CONTEXT}`);
      const firstPid = (await first.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await first.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org,person(1)]);
      expect((await seats()).get(person(6))).toBe("hold");
      await second.query(`BEGIN; ${SYSTEM_DATABASE_CONTEXT}`);
      const secondPid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      pending = second.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org,person(2)]);
      void pending.catch(() => {});
      await expect.poll(async () => (await pool.query("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked", [secondPid,firstPid])).rows[0].blocked,
        { timeout: 3000, interval: 10 }).toBe(true);
      await first.query("COMMIT"); await pending; await second.query("COMMIT");
      expect((await seats()).get(person(6))).toBe("free");
      await parity();
    } finally {
      await first.query("ROLLBACK"); await pending?.catch(() => {}); await second.query("ROLLBACK");
      first.release(); second.release();
    }
  });

  it("rejects a stale repeatable-read writer instead of overwriting newer seats", async () => {
    const stale = await pool.connect();
    try {
      await stale.query(`BEGIN ISOLATION LEVEL REPEATABLE READ; ${SYSTEM_DATABASE_CONTEXT}`);
      await stale.query("SELECT 1 FROM organization_members WHERE org_id=$1", [org]);
      await grantTestPro(pool,person(1));
      await expect(stale.query("UPDATE organization_members SET created_at='1999-01-01' WHERE org_id=$1 AND user_id=$2", [org,person(6)]))
        .rejects.toMatchObject({ code: "40001" });
    } finally { await stale.query("ROLLBACK"); stale.release(); }
    await parity();
    expect((await seats()).get(person(6))).toBe("free");
  });

  it("keeps projection writes owner-only and fails closed if a projection is missing", async () => {
    expect((await withUserTx(pool,person(1),tx => tx.query("SELECT 1 FROM organization_member_seat_periods"))).rowCount).toBe(0);
    await expect(withSystemTx(pool,tx => tx.query("DELETE FROM organization_member_seat_periods WHERE org_id=$1", [org])))
      .rejects.toMatchObject({ code: "42501" });
    await expect(withSystemTx(pool,tx => tx.query("SELECT refresh_organization_member_seats($1)", [org])))
      .rejects.toMatchObject({ code: "42501" });
    await expect(withSystemTx(pool,tx => tx.query("SELECT * FROM organization_member_seat_periods_for(ARRAY[$1]::uuid[])", [org])))
      .rejects.toMatchObject({ code: "42501" });
    await expect(withSystemTx(pool,tx => tx.query("UPDATE organization_seat_user_generations SET revision=1 WHERE user_id=$1", [person(1)])))
      .rejects.toMatchObject({ code: "42501" });
    await pool.query("DELETE FROM organization_member_seat_periods WHERE org_id=$1 AND user_id=$2", [org,person(1)]);
    expect((await seats()).get(person(1))).toBe("hold");
    expect((await withSystemTx(pool,tx => tx.query("SELECT organization_member_on_hold($1,$2,10,5) AS held", [org,person(1)]))).rows[0].held).toBe(true);
  });

  it("backfills the old policy and accepts old application membership writes after expansion", async () => {
    const migration = await readFile(new URL("../migrations/0249_organization_seat_state.sql",import.meta.url),"utf8");
    const tx = await pool.connect();
    try {
      await tx.query(`BEGIN; ${SYSTEM_DATABASE_CONTEXT}`);
      await restoreLegacySeats(tx);
      const before = (await tx.query("SELECT * FROM organization_member_seats($1,10,5) ORDER BY user_id", [org])).rows;
      await tx.query(migration);
      await tx.query(`SET LOCAL ROLE zeros_app; ${SYSTEM_DATABASE_CONTEXT}`);
      expect((await tx.query("SELECT * FROM organization_member_seats($1,10,5) ORDER BY user_id", [org])).rows).toEqual(before);
      await tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org,person(1)]);
      expect((await tx.query("SELECT seat FROM organization_member_seats($1,10,5) WHERE user_id=$2", [org,person(6)])).rows).toEqual([{ seat: "free" }]);
      expect((await tx.query("SELECT * FROM organization_member_seats($1,8,2) ORDER BY user_id", [org])).rows)
        .toEqual((await tx.query("SELECT * FROM organization_member_seats_at($1,8,2,now()) ORDER BY user_id", [org])).rows);
    } finally { await tx.query("ROLLBACK"); tx.release(); }
  });

  it("rolls back a blocked backfill without a ledger entry and retries on the same populated database", async () => {
    const directory = new URL("../migrations/", import.meta.url);
    const migrations = (await readdir(directory)).filter(file => /^\d{4}_.+\.sql$/.test(file)).sort();
    const boundary = "0249_organization_seat_state.sql";
    const setup = await pool.connect();
    try {
      // Reconstruct the real prefix; deleting only 0249's ledger row leaves
      // later schema and ledger entries that cannot precede this migration.
      await setup.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
        CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now(),checksum text,phase text NOT NULL DEFAULT 'legacy');`);
      for (const file of migrations.filter(file => file < boundary)) {
        const sql = await readFile(new URL(file, directory), "utf8");
        await setup.query("BEGIN");
        await setup.query(sql);
        await setup.query("INSERT INTO schema_migrations(name,checksum,phase) VALUES($1,$2,$3)",
          [file, migrationChecksum(sql), migrationPhase(file, sql).phase]);
        await setup.query("COMMIT");
      }
    } finally { await setup.query("ROLLBACK"); setup.release(); }
    await seedSeats();
    const before = await seats();
    const ledger = (await pool.query("SELECT name,checksum FROM schema_migrations ORDER BY name")).rows;
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN; LOCK TABLE staff_pro_benefits IN ACCESS EXCLUSIVE MODE");
      await expect(runMigrations(pool)).rejects.toThrow("Migration 0249_organization_seat_state.sql failed (SQLSTATE 55P03).");
      expect((await pool.query("SELECT name,checksum FROM schema_migrations ORDER BY name")).rows).toEqual(ledger);
      expect((await pool.query(`SELECT to_regclass('public.organization_member_seat_periods') AS periods,
        to_regclass('public.organization_seat_generations') AS generations,
        to_regclass('public.organization_seat_user_generations') AS people,
        to_regprocedure('public.refresh_changed_organization_seats()') AS refresh`)).rows)
        .toEqual([{ periods: null, generations: null, people: null, refresh: null }]);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
    expect(await seats()).toEqual(before);
    await expect(runMigrations(pool)).resolves.toEqual(migrations.filter(file => file >= boundary));
    expect(await seats()).toEqual(before);
    await parity();
    await expect(runMigrations(pool)).resolves.toEqual([]);
  }, 40_000);
});
