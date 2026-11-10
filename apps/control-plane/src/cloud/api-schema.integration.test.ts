import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx, withUserTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("cloud API schema and privilege boundary", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL }); });
  afterAll(() => pool.end());
  beforeEach(() => resetMigratedTestDatabase(pool));

  it("installs private key and preference tables with forced RLS", async () => {
    const { rows } = await pool.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname IN ('cloud_api_keys','cloud_api_access_settings') ORDER BY relname`);
    expect(rows).toEqual([
      { relname: "cloud_api_access_settings", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "cloud_api_keys", relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it("opts old workspace inserts in and hides key hashes outside system transactions", async () => {
    const user = randomUUID(), org = randomUUID(), workspace = randomUUID();
    await pool.query("INSERT INTO users(id,email) VALUES($1,$2)", [user, `${user}@example.test`]);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by) VALUES($1,$2,'Org',$3)", [org, `org-${org}`, user]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, user]);
    await pool.query(`INSERT INTO cloud_v2_workspaces(id,org_id,creator_user_id,name,repository,branch,base_branch,state)
      VALUES($1,$2,$3,'fixture','example/project','work','main','stopped')`, [workspace, org, user]);
    expect((await pool.query("SELECT api_access, restart_stop_generation FROM cloud_v2_workspaces WHERE id=$1", [workspace])).rows[0])
      .toEqual({ api_access: true, restart_stop_generation: null });
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_api_keys(org_id,owner_user_id,name,prefix,token_hash)
      VALUES($1,$2,'Fixture','zk_abcd',decode(repeat('a',64),'hex'))`, [org, user]));
    expect((await withUserTx(pool, user, tx => tx.query("SELECT id FROM cloud_api_keys"))).rows).toEqual([]);
    expect((await withSystemTx(pool, tx => tx.query("SELECT id FROM cloud_api_keys"))).rowCount).toBe(1);
  });
});
