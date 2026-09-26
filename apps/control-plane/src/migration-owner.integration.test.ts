import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe, it, expect } from "vitest";
import { createMigrationPool, createPool } from "./db.js";
import { planMigrations, runMigrations, verifyMigrations } from "./migrate.js";
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("stable migration owner with rotating NOINHERIT logins", () => {
  it("plans without DDL and preserves every object owner across login rotation", async () => {
    const url = process.env.TEST_DATABASE_URL!;
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    const suffix = randomBytes(6).toString("hex"),
      owner = "owner_" + suffix,
      first = "migrator_a_" + suffix,
      second = "migrator_b_" + suffix;
    const roles = [first, second, owner];
    const passwords = new Map([
      [first, randomBytes(24).toString("hex")],
      [second, randomBytes(24).toString("hex")],
    ]);
    const pools: pg.Pool[] = [];
    try {
      await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      const emptyPlan = await planMigrations(admin);
      expect(emptyPlan.pendingMigrations.length).toBeGreaterThan(0);
      expect(emptyPlan.controlledApprovals).toHaveLength(10);
      expect(
        (
          await admin.query(
            "SELECT to_regclass('public.schema_migrations') AS ledger",
          )
        ).rows[0].ledger,
      ).toBeNull();
      await admin.query(`CREATE ROLE ${owner} NOLOGIN NOINHERIT NOBYPASSRLS`);
      await admin.query(
        `CREATE ROLE ${first} LOGIN NOINHERIT NOBYPASSRLS PASSWORD '${passwords.get(first)}';CREATE ROLE ${second} LOGIN NOINHERIT NOBYPASSRLS PASSWORD '${passwords.get(second)}'; GRANT ${owner} TO ${first},${second}`,
      );
      await admin.query(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zeros_app') THEN CREATE ROLE zeros_app NOLOGIN NOBYPASSRLS; END IF; END $$; GRANT zeros_app TO ${owner} WITH ADMIN OPTION`,
      );
      await admin.query(`ALTER SCHEMA public OWNER TO ${owner}`);
      const databaseName = (
        await admin.query("SELECT current_database() AS name")
      ).rows[0].name as string;
      await admin.query(
        `GRANT CREATE ON DATABASE "${databaseName.replaceAll('"', '""')}" TO ${owner}`,
      );
      const routed = (login: string) => {
        const result = new URL(url);
        result.username = login;
        result.password = passwords.get(login)!;
        return result.toString();
      };
      const raw = createPool(routed(first), { maxConnections: 1 });
      pools.push(raw);
      await expect(
        raw.query("CREATE TABLE public.forbidden_owner_drift (id integer)"),
      ).rejects.toMatchObject({ code: "42501" });
      const initial = createMigrationPool(routed(first), {
        role: owner,
        maxConnections: 1,
      });
      pools.push(initial);
      await runMigrations(initial, {
        env: {
          NODE_ENV: "production",
          CONTROL_PLANE_MIGRATION_APPROVALS:
            emptyPlan.controlledApprovals.join(","),
        },
      });
      const rotated = createMigrationPool(routed(second), {
        role: owner,
        maxConnections: 1,
      });
      pools.push(rotated);
      expect(
        (
          await rotated.query(
            "SELECT current_user AS principal,session_user AS login",
          )
        ).rows[0],
      ).toEqual({ principal: owner, login: second });
      await expect(runMigrations(rotated)).resolves.toEqual([]);
      await rotated.query(
        "CREATE TABLE qualification_owner_probe(id integer PRIMARY KEY)",
      );
      const wrong = (
        await admin.query(
          "SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','S') AND pg_get_userbyid(relowner)<>$1",
          [owner],
        )
      ).rows;
      expect(wrong).toEqual([]);
      await verifyMigrations(rotated);
      expect(await planMigrations(rotated)).toEqual({
        pendingMigrations: [],
        controlledApprovals: [],
      });
      expect(
        (
          await admin.query(
            "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid=$1::regclass",
            ["qualification_owner_probe"],
          )
        ).rows[0].owner,
      ).toBe(owner);
    } finally {
      for (const pool of pools) await pool.end();
      try {
        await admin.query("DROP SCHEMA public CASCADE;CREATE SCHEMA public");
        for (const role of roles) {
          if (!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount) continue;
          await admin.query(`DROP OWNED BY ${role}`);
          await admin.query(`DROP ROLE ${role}`);
        }
      } finally { await admin.end(); }
    }
  }, 60000);
});
