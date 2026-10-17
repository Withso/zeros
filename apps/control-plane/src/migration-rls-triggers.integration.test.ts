/** Triggers on tables that tenant RLS lets a signed-in user write run inside
 * that user's statement, as zeros_app without app.system. A trigger that
 * writes a system-only table, or inserts a row referencing a parent that a
 * cascade is deleting, fails the user's write or the purge. This suite
 * enumerates those triggers from the catalog, fires each as zeros_app in
 * withUserTx with a member fixture, and runs the organization, account and
 * workspace hard-delete cascades. A new trigger on such a table fails the
 * inventory check until a case below covers it. */
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx, withUserTx, type Tx } from "./db.js";
import { resetMigratedTestDatabase } from "./test-database.js";
import { seedReadyProCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./cloud-workspaces/test-fixtures.js";

const url = process.env.TEST_DATABASE_URL, d = url ? describe : describe.skip;
const DEVICE_IDS = ["00000000-0000-4000-8000-0000000000d1", "00000000-0000-4000-8000-0000000000d2"] as const;
const DEVICE_SESSION_IDS = ["00000000-0000-4000-8000-0000000000e1", "00000000-0000-4000-8000-0000000000e2"] as const;

/** Every non-internal trigger on a table with a policy that admits a
 * non-system write, as of this suite's cases. */
const COVERED_TRIGGERS: Record<string, readonly string[]> = {
  organization_members: [
    "cloud_capability_epoch_org_members", "cloud_capability_epoch_org_members_changes",
    "cloud_workspace_data_org_membership_removed", "organization_member_cloud_workspace_access_revoke",
    "organization_membership_cloud_authority_check", "pro_workspace_guest_membership_removed", "zz_cloud_authority_cache",
  ],
  organizations: [
    "cloud_capability_epoch_organizations", "organization_cloud_authority_check", "organization_cloud_workspace_retirement",
    "organizations_personal_classification_immutable", "zz_cloud_authority_cache",
  ],
  team_members: [
    "cloud_capability_epoch_team_members", "cloud_capability_epoch_team_members_changes",
    "cloud_workspace_data_team_membership_removed", "team_member_cloud_workspace_access_revoke",
    "team_membership_cloud_authority_check", "zz_cloud_authority_cache",
  ],
  teams: ["cloud_capability_epoch_teams", "team_cloud_workspace_retirement", "zz_cloud_authority_cache"],
  users: [
    "cloud_actor_staff_revision", "cloud_capability_epoch_users", "staff_pro_benefit_sync", "user_auth_cloud_authority_check",
    "user_cloud_workspace_authority_retirement", "user_staff_cloud_authority_check", "zz_cloud_authority_cache",
  ],
};

d("triggers on user-writable tables with PostgreSQL", () => {
  let pool: pg.Pool, fixture: ReadyCloudWorkspaceFixture, member: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: url, max: 3 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyProCloudWorkspace(pool);
    member = await addUser("Member");
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [fixture.organizationId, member]);
    await pool.query("INSERT INTO team_members(team_id,org_id,user_id,role) VALUES($1,$2,$3,'member')",
      [fixture.teamId, fixture.organizationId, member]);
    await pool.query("INSERT INTO cloud_workspace_members(workspace_id,org_id,user_id,role) VALUES($1,$2,$3,'developer')",
      [fixture.workspaceId, fixture.organizationId, member]);
  });

  async function addUser(label: string) {
    const id = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,$3)", [id, `${id}@example.test`, label]);
    return id;
  }
  async function seedDeviceSession(userId: string, deviceId: string, deviceSessionId: string) {
    const key = createHash("sha256").update(`key:${deviceId}`).digest();
    await pool.query("INSERT INTO devices(id,user_id,label,platform,public_key,key_fingerprint) VALUES($1,$2,'Purge','linux',$3,$4)",
      [deviceId, userId, key, createHash("sha256").update(key).digest()]);
    await pool.query(`INSERT INTO cloud_device_sessions(id,user_id,device_id,ticket_hash,ticket_expires_at,expires_at)
      VALUES($1,$2,$3,$4,now()+interval '1 minute',now()+interval '1 day')`,
    [deviceSessionId, userId, deviceId, createHash("sha256").update(`ticket:${deviceSessionId}`).digest()]);    return deviceId;
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
          AND expression NOT LIKE '%relowner%' AND expression NOT LIKE 'cloud_workspace_data_purge_authorized(%'
      )
      SELECT relation.relname AS table, trigger.tgname AS trigger
      FROM writable JOIN pg_class relation ON relation.oid = writable.rel
      JOIN pg_trigger trigger ON trigger.tgrelid = relation.oid AND NOT trigger.tgisinternal
      ORDER BY 1, 2`)).rows;
    const found: Record<string, string[]> = {};
    for (const row of rows) (found[row.table] ??= []).push(row.trigger);
    expect(found).toEqual(Object.fromEntries(Object.entries(COVERED_TRIGGERS).map(([table, names]) => [table, [...names].sort()])));
    // cloud_workspace_data_purge_authorized() itself requires app_is_system().
    const purge = (await pool.query<{ body: string }>(
      "SELECT prosrc AS body FROM pg_proc WHERE proname='cloud_workspace_data_purge_authorized'")).rows[0]!.body;
    expect(purge.trim()).toMatch(/^SELECT app_is_system\(\) AND /);
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
      await asUser(member, "UPDATE users SET deleted_at=clock_timestamp() WHERE id=$1", [member]);
    });
  });

  describe("hard-delete cascades in system context", () => {
    it("an organization with members, a team, seats and guests", async () => {
      const owner = await addUser("Owner"), guest = await addUser("Guest");
      const orgId = randomUUID(), teamId = randomUUID();
      await pool.query("INSERT INTO organizations(id,slug,name,created_by) VALUES($1,$2,'Purge Co',$3)",
        [orgId, `purge-${orgId.slice(0, 8)}`, owner]);
      await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [orgId, owner]);
      await pool.query("INSERT INTO teams(id,org_id,slug,name,created_by) VALUES($1,$2,'purge','Purge',$3)", [teamId, orgId, owner]);
      await pool.query("INSERT INTO team_members(team_id,org_id,user_id,role) VALUES($1,$2,$3,'maintainer')", [teamId, orgId, owner]);
      await pool.query(`INSERT INTO organization_entitlements(org_id,plan,status,cloud_workspaces_allowed,seat_limit,source,valid_from)
        VALUES($1,'business','active',true,5,'operator',now())`, [orgId]);
      await pool.query("INSERT INTO organization_seat_assignments(org_id,user_id,state,assigned_by) VALUES($1,$2,'active',$2)", [orgId, owner]);
      expect(guest).toBeTruthy();
      await asSystem("DELETE FROM organizations WHERE id=$1", [orgId]);
      expect((await pool.query("SELECT 1 FROM organizations WHERE id=$1", [orgId])).rowCount).toBe(0);
    });

    it("an account with memberships, a guest grant and an accepted invitation", async () => {
      const guest = await addUser("Guest");
      await pool.query(`INSERT INTO cloud_workspace_guest_grants(id,workspace_id,org_id,user_id,role,revision,created_by,expires_at)
        VALUES($1,$2,$3,$4,'viewer',1,$5,now()+interval '1 day')`,
      [randomUUID(), fixture.workspaceId, fixture.organizationId, guest, fixture.userId]);
      await pool.query(`INSERT INTO cloud_workspace_invitations(id,workspace_id,org_id,recipient_email_sha256,token_hash,role,invited_by,
        inviter_fingerprint,expires_at,accepted_at,accepted_by) VALUES($1,$2,$3,$4,$5,'viewer',$6,$7,now()+interval '1 day',now(),$8)`,
      [randomUUID(), fixture.workspaceId, fixture.organizationId, Buffer.alloc(32, 1), Buffer.alloc(32, 2), fixture.userId,
        "a".repeat(64), guest]);
      // Device sessions cascade with their device and with their account.
      const removedDevice = await seedDeviceSession(member, DEVICE_IDS[0], DEVICE_SESSION_IDS[0]);
      await seedDeviceSession(member, DEVICE_IDS[1], DEVICE_SESSION_IDS[1]);
      await asSystem("DELETE FROM devices WHERE id=$1", [removedDevice]);
      expect((await pool.query("SELECT id FROM cloud_device_sessions ORDER BY id")).rows).toEqual([{ id: DEVICE_SESSION_IDS[1] }]);
      await asSystem("DELETE FROM users WHERE id=$1", [guest]);
      await asSystem("DELETE FROM users WHERE id=$1", [member]);
      expect((await pool.query("SELECT 1 FROM users WHERE id IN ($1,$2)", [guest, member])).rowCount).toBe(0);
      expect((await pool.query("SELECT 1 FROM cloud_device_sessions")).rowCount).toBe(0);
    });

    it("a workspace with members once its restricting computer source is gone", async () => {
      // The computer source restricts the workspace delete and is immutable
      // outside the Organization purge's lease (deletion-lifecycle tests
      // cover that path end to end); drop it as the owner with its guard
      // off, then delete the workspace the way the purge does.
      const owner = await pool.connect();
      try {
        await owner.query("BEGIN");
        await owner.query("ALTER TABLE cloud_workspace_computer_sources DISABLE TRIGGER USER");
        await owner.query("DELETE FROM cloud_workspace_computer_sources WHERE workspace_id=$1", [fixture.workspaceId]);
        await owner.query("ALTER TABLE cloud_workspace_computer_sources ENABLE TRIGGER USER");
        await owner.query("COMMIT");
      } finally { owner.release(); }
      await asSystem("DELETE FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId]);
      expect((await pool.query("SELECT 1 FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rowCount).toBe(0);
      expect((await pool.query("SELECT 1 FROM cloud_capability_access_losses WHERE workspace_id=$1", [fixture.workspaceId])).rowCount).toBe(0);
    });
  });
});
