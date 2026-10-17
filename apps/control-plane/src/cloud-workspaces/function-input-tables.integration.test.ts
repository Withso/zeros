import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { functionInputTables, stripSqlLiterals } from "./function-input-tables-test-utils.js";

const url = process.env.TEST_DATABASE_URL, d = url ? describe : describe.skip;

describe("stripSqlLiterals", () => {
  it("drops comments and string literals but keeps quoted identifiers", () => {
    expect(stripSqlLiterals(`SELECT 'teams' FROM "users" u -- organizations\n/* devices */ WHERE x='it''s'`).replace(/\s+/g, " "))
      .toBe("SELECT '' FROM users u WHERE x=''");
  });
});

d("functionInputTables with PostgreSQL", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 2 });
    await resetMigratedTestDatabase(pool);
    await pool.query(`CREATE FUNCTION zz_input_probe_callee() RETURNS bigint LANGUAGE sql AS $$
      SELECT count(*) FROM devices $$`);
    // Comma-joined FROM items, a LATERAL subquery and an EXISTS probe; the
    // string literal and comment name tables that must not count.
    await pool.query(`CREATE FUNCTION zz_input_probe() RETURNS bigint LANGUAGE sql AS $$
      SELECT count(*) FROM organizations o, teams t, public.team_members tm
      CROSS JOIN LATERAL (SELECT 1 FROM users account WHERE account.id = tm.user_id) a
      WHERE t.org_id = o.id AND EXISTS (SELECT 1 FROM organization_members m WHERE m.org_id = o.id)
        AND 'cloud_workspaces' <> '' -- auth_sessions
        AND zz_input_probe_callee() >= 0 $$`);
  });
  afterAll(async () => { await pool?.end(); });

  it("finds comma-joined, lateral, EXISTS and callee tables and ignores literals", async () => {
    const { tables, functions } = await functionInputTables(pool, ["zz_input_probe"]);
    expect([...functions].sort()).toEqual(["zz_input_probe", "zz_input_probe_callee"]);
    expect([...tables].sort()).toEqual(["devices", "organization_members", "organizations", "team_members", "teams", "users"]);
  });
});
