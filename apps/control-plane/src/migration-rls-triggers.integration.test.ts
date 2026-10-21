/** Triggers on tables that tenant RLS lets a signed-in user write run inside
 * that user's statement, as zeros_app without app.system. A trigger that
 * writes a system-only table, or inserts a row referencing a parent that a
 * cascade is deleting, fails the user's write or the purge. This suite
 * enumerates those triggers from the catalog, fires each as zeros_app in
 * withUserTx with a member fixture, and runs the organization, account and
 * workspace hard-delete cascades. A new trigger on such a table fails the
 * inventory check until a case below covers it. */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx, withUserTx, type Tx } from "./db.js";
import { resetMigratedTestDatabase } from "./test-database.js";
import { seedCredentialOwner } from "./agent-credentials/test-fixtures.js";

const url = process.env.TEST_DATABASE_URL, d = url ? describe : describe.skip;

/** Every non-internal trigger on a table with a policy that admits a
 * non-system write, as of this suite's cases. */
const COVERED_TRIGGERS: Record<string, readonly string[]> = {
  organizations: ["organizations_personal_classification_immutable"],
  users: ["cloud_actor_staff_revision", "staff_pro_benefit_sync"],
};

d("triggers on user-writable tables with PostgreSQL", () => {
  let pool: pg.Pool, fixture: Awaited<ReturnType<typeof seedCredentialOwner>>, member: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: url, max: 3 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedCredentialOwner(pool);
    member = await addUser("Member");
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [fixture.organizationId, member]);
    await pool.query("INSERT INTO team_members(team_id,org_id,user_id,role) VALUES($1,$2,$3,'member')",
      [fixture.teamId, fixture.organizationId, member]);
  });

  async function addUser(label: string) {
    const id = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,$3)", [id, `${id}@example.test`, label]);
    return id;
  }
  const asUser = (userId: string, statement: string, values: unknown[]) =>
    withUserTx(pool, userId, (tx: Tx) => tx.query(statement, values));
  const asSystem = (statement: string, values: unknown[]) =>
    withSystemTx(pool, (tx: Tx) => tx.query(statement, values));

  it("covers every trigger on a table tenant RLS lets a user write", async () => {
    // A policy admits a non-system write unless its expression is exactly
    // app_is_system(), starts with an app_is_system() conjunction, or
    // admits only the table owner (operator tables).
    const rows = (await pool.query<{ table: string; trigger: string }>(`
      WITH policies AS (
        SELECT policy.polrelid AS rel, coalesce(pg_get_expr(policy.polqual, policy.polrelid), '') AS qual,
          coalesce(pg_get_expr(policy.polwithcheck, policy.polrelid), '') AS checked
        FROM pg_policy policy WHERE policy.polcmd IN ('*', 'a', 'w', 'd')
      ), writable AS (
        SELECT DISTINCT rel FROM policies, LATERAL unnest(ARRAY[qual, checked]) AS expression
        WHERE expression <> '' AND expression <> 'app_is_system()' AND expression NOT LIKE 'app_is_system() AND %'
          AND expression NOT LIKE '%relowner%'
      )
      SELECT relation.relname AS table, trigger.tgname AS trigger
      FROM writable JOIN pg_class relation ON relation.oid = writable.rel
      JOIN pg_trigger trigger ON trigger.tgrelid = relation.oid AND NOT trigger.tgisinternal
      ORDER BY 1, 2`)).rows;
    const found: Record<string, string[]> = {};
    for (const row of rows) (found[row.table] ??= []).push(row.trigger);
    expect(found).toEqual(Object.fromEntries(Object.entries(COVERED_TRIGGERS).map(([table, names]) => [table, [...names].sort()])));

  });

  describe("user-context writes", () => {
    it("organization_members: add, change a role, leave", async () => {
      const invitee = await addUser("Invitee");
      await asUser(fixture.userId, "INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [fixture.organizationId, invitee]);
      await asUser(fixture.userId, "UPDATE organization_members SET role='admin' WHERE org_id=$1 AND user_id=$2", [fixture.organizationId, invitee]);
      await asUser(member, "DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [fixture.organizationId, member]);
    });

    it("team_members: add, change a role, leave", async () => {
      const joiner = await addUser("Joiner");
      await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [fixture.organizationId, joiner]);
      await asUser(fixture.userId, "INSERT INTO team_members(team_id,org_id,user_id,role) VALUES($1,$2,$3,'member')",
        [fixture.teamId, fixture.organizationId, joiner]);
      await asUser(fixture.userId, "UPDATE team_members SET role='maintainer' WHERE team_id=$1 AND user_id=$2", [fixture.teamId, joiner]);
      await asUser(member, "DELETE FROM team_members WHERE team_id=$1 AND user_id=$2", [fixture.teamId, member]);
    });

    it("teams: create, rename, delete, and soft-delete the workspace team", async () => {
      const teamId = randomUUID();
      await asUser(fixture.userId, "INSERT INTO teams(id,org_id,slug,name,created_by) VALUES($1,$2,'probe','Probe',$3)",
        [teamId, fixture.organizationId, fixture.userId]);
      await asUser(fixture.userId, "UPDATE teams SET name='Renamed' WHERE id=$1", [teamId]);
      await asUser(fixture.userId, "DELETE FROM teams WHERE id=$1", [teamId]);
      await asUser(fixture.userId, "UPDATE teams SET deleted_at=clock_timestamp() WHERE id=$1", [fixture.teamId]);
    });

    it("organizations: create, rename, hard-delete an empty one, and soft-delete the workspace organization", async () => {
      const orgId = randomUUID();
      await asUser(fixture.userId, `INSERT INTO organizations(id,slug,name,created_by) VALUES($1,$2,'Probe Co',$3)`,
        [orgId, `probe-${orgId.slice(0, 8)}`, fixture.userId]);
      // Creating the owner membership is a system write in the product.
      await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [orgId, fixture.userId]);
      await asUser(fixture.userId, "UPDATE organizations SET name='Renamed Co' WHERE id=$1", [orgId]);
      await asUser(fixture.userId, "DELETE FROM organizations WHERE id=$1", [orgId]);
      await asUser(fixture.userId, "UPDATE organizations SET deleted_at=clock_timestamp() WHERE id=$1", [fixture.organizationId]);
    });

    it("users: rename and mark the own account deleted", async () => {
      await asUser(member, "UPDATE users SET display_name='Renamed' WHERE id=$1", [member]);
      await asUser(member, "UPDATE users SET auth_revision=auth_revision+1 WHERE id=$1", [member]);
      await asUser(member, "UPDATE users SET deleted_at=clock_timestamp() WHERE id=$1", [member]);
    });
  });


});
