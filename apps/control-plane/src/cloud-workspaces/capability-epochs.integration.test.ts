/** S1 member epochs (0153): every input of the role functions bumps the
 * affected principals' `me` in the committing transaction, under the roles
 * production uses (zeros_app in user or system context, never the superuser
 * the fixtures seed with), and no bump can break the organization and
 * account deletion cascades it fires inside. */
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx, withUserTx, type Tx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { functionInputTables } from "./function-input-tables-test-utils.js";
import { seedReadyProCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";

const url = process.env.TEST_DATABASE_URL, d = url ? describe : describe.skip;

/** cloud_workspace_actor_role reaches every other role function. */
const ROLE_FUNCTIONS = ["cloud_workspace_actor_role"];

/** Inputs that need no epoch trigger, each with the reason. */
const EPOCH_EXEMPT_INPUTS: Record<string, string> = {};

d("capability member epochs with PostgreSQL", () => {
  let pool: pg.Pool, fixture: ReadyCloudWorkspaceFixture, member: string;
  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: url, max: 3 });
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyProCloudWorkspace(pool);
    member = await addUser("Member");
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [fixture.organizationId, member]);
    await pool.query("INSERT INTO cloud_workspace_members(workspace_id,org_id,user_id,role) VALUES($1,$2,$3,'developer')",
      [fixture.workspaceId, fixture.organizationId, member]);
  });
  afterAll(async () => { await pool?.end(); });

  async function addUser(label: string) {
    const id = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,$3)", [id, `${id}@example.test`, label]);
    return id;
  }
  const roleOf = (userId: string) =>
    withSystemTx(pool, tx => tx.query<{ role: string | null }>(
      "SELECT cloud_workspace_actor_role($1,$2) AS role", [fixture.workspaceId, userId]))
      .then(result => result.rows[0]?.role ?? null);
  /** Read as the superuser: the epoch table is readable only to the system. */
  async function epochs(orgId = fixture.organizationId): Promise<Record<string, number>> {
    const rows = (await pool.query<{ user_id: string; epoch: string }>(
      "SELECT user_id, epoch::text AS epoch FROM cloud_capability_member_epochs WHERE org_id=$1", [orgId])).rows;
    return Object.fromEntries(rows.map(row => [row.user_id, Number(row.epoch)]));
  }
  const epochOf = (all: Record<string, number>, userId: string) => all[userId] ?? 1; // no row is epoch 1
  async function expectBumped(change: () => Promise<unknown>, raised: string[], unchanged: string[] = []) {
    const before = await epochs();
    await change();
    const after = await epochs();
    for (const userId of raised) expect(epochOf(after, userId), `epoch of ${userId}`).toBeGreaterThan(epochOf(before, userId));
    for (const userId of unchanged) expect(epochOf(after, userId), `epoch of ${userId}`).toBe(epochOf(before, userId));
  }
  const asUser = (userId: string, statement: string, values: unknown[]) =>
    withUserTx(pool, userId, (tx: Tx) => tx.query(statement, values));
  const asSystem = (statement: string, values: unknown[]) =>
    withSystemTx(pool, (tx: Tx) => tx.query(statement, values));
  const lossOf = async (userId: string) => (await pool.query(
    "SELECT 1 FROM cloud_capability_access_losses WHERE workspace_id=$1 AND user_id=$2", [fixture.workspaceId, userId])).rowCount;

  describe("deletion cascades", () => {
    it("hard-deletes an organization whose members have no epoch rows", async () => {
      // Every per-member input cascades from organizations; inserting an
      // epoch row that references the vanishing organization used to fail
      // its foreign key and roll the whole Organization purge back.
      const purged = await addUser("Purged member");
      const orgId = randomUUID(), teamId = randomUUID();
      await pool.query("INSERT INTO organizations(id,slug,name,created_by) VALUES($1,$2,'Purge Co',$3)",
        [orgId, `purge-${orgId.slice(0, 8)}`, purged]);
      await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [orgId, purged]);
      await pool.query("INSERT INTO teams(id,org_id,slug,name,created_by) VALUES($1,$2,'purge','Purge',$3)", [teamId, orgId, purged]);
      await pool.query("INSERT INTO team_members(team_id,org_id,user_id,role) VALUES($1,$2,$3,'maintainer')", [teamId, orgId, purged]);
      await pool.query(`INSERT INTO organization_entitlements(org_id,plan,status,cloud_workspaces_allowed,seat_limit,source,valid_from)
        VALUES($1,'business','active',true,5,'operator',now())`, [orgId]);
      await pool.query("INSERT INTO organization_seat_assignments(org_id,user_id,state,assigned_by) VALUES($1,$2,'active',$2)", [orgId, purged]);
      await pool.query("DELETE FROM cloud_capability_member_epochs WHERE org_id=$1", [orgId]);
      await pool.query("DELETE FROM organizations WHERE id=$1", [orgId]);
      expect((await pool.query("SELECT 1 FROM organizations WHERE id=$1", [orgId])).rowCount).toBe(0);
      expect(await epochs(orgId)).toEqual({});
    });

    it("hard-deletes an account whose guest grant, slot and memberships cascade without epoch rows", async () => {
      const guest = await addUser("Guest");
      await pool.query(`INSERT INTO cloud_workspace_guest_grants(id,workspace_id,org_id,user_id,role,revision,created_by,expires_at)
        VALUES($1,$2,$3,$4,'viewer',1,$5,now()+interval '1 day')`,
        [randomUUID(), fixture.workspaceId, fixture.organizationId, guest, fixture.userId]);
      await pool.query("DELETE FROM cloud_capability_member_epochs WHERE user_id IN ($1,$2)", [guest, member]);
      await pool.query("DELETE FROM users WHERE id=$1", [guest]);
      await pool.query("DELETE FROM users WHERE id=$1", [member]);
      expect((await pool.query("SELECT 1 FROM users WHERE id IN ($1,$2)", [guest, member])).rowCount).toBe(0);
      expect((await pool.query("SELECT 1 FROM cloud_capability_access_losses WHERE user_id IN ($1,$2)", [guest, member])).rowCount).toBe(0);
    });
  });

  // Tables tenant RLS lets a signed-in user write: the trigger must still
  // reach the system-only epoch table from that statement.
  describe("user-context writes", () => {
    it("organization_members: a member leaving", async () => {
      await expectBumped(() => asUser(member, "DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2",
        [fixture.organizationId, member]), [member], [fixture.userId]);
      expect(await lossOf(member)).toBe(1);
    });

    it("organization_members: a role change", async () => {
      await expectBumped(() => asUser(fixture.userId, "UPDATE organization_members SET role='admin' WHERE org_id=$1 AND user_id=$2",
        [fixture.organizationId, member]), [member], [fixture.userId]);
    });

    it("team_members: the owner leaving the workspace team", async () => {
      expect(await roleOf(fixture.userId)).toBe("owner");
      await expectBumped(() => asUser(fixture.userId, "DELETE FROM team_members WHERE org_id=$1 AND user_id=$2",
        [fixture.organizationId, fixture.userId]), [fixture.userId], [member]);
      expect(await roleOf(fixture.userId)).not.toBe("owner");
    });

    it("teams: soft-deleting the workspace team", async () => {
      await expectBumped(() => asUser(fixture.userId, "UPDATE teams SET deleted_at=clock_timestamp() WHERE id=$1",
        [fixture.teamId]), [fixture.userId, member]);
      expect(await roleOf(fixture.userId)).toBeNull();
    });

    it("organizations: soft-deleting the organization", async () => {
      await expectBumped(() => asUser(fixture.userId, "UPDATE organizations SET deleted_at=clock_timestamp() WHERE id=$1",
        [fixture.organizationId]), [fixture.userId, member]);
      expect(await roleOf(member)).toBeNull();
    });

    it("users: an account marking itself deleted", async () => {
      await expectBumped(() => asUser(member, "UPDATE users SET deleted_at=clock_timestamp() WHERE id=$1", [member]),
        [member], [fixture.userId]);
    });
  });

  // Tables whose RLS admits only system transactions: zeros_app with
  // app.system, the role production writes them with.
  describe("system-context writes", () => {
    it("cloud_workspace_members: a role change and a removal", async () => {
      await expectBumped(() => asSystem("UPDATE cloud_workspace_members SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",
        [fixture.workspaceId, member]), [member], [fixture.userId]);
      await expectBumped(() => asSystem("DELETE FROM cloud_workspace_members WHERE workspace_id=$1 AND user_id=$2",
        [fixture.workspaceId, member]), [member]);
      expect(await lossOf(member)).toBe(1);
    });

    it("cloud_workspace_guest_grants: a grant, a shortened expiry and a revocation", async () => {
      const guest = await addUser("Guest"), grantId = randomUUID();
      await expectBumped(() => asSystem(`INSERT INTO cloud_workspace_guest_grants(id,workspace_id,org_id,user_id,role,revision,created_by,expires_at)
        VALUES($1,$2,$3,$4,'viewer',1,$5,now()+interval '1 day')`,
      [grantId, fixture.workspaceId, fixture.organizationId, guest, fixture.userId]), [guest]);
      await expectBumped(() => asSystem("UPDATE cloud_workspace_guest_grants SET expires_at=now()+interval '1 hour' WHERE id=$1",
        [grantId]), [guest]);
      await expectBumped(() => asSystem("UPDATE cloud_workspace_guest_grants SET revoked_at=now() WHERE id=$1", [grantId]), [guest]);
      expect(await lossOf(guest)).toBe(1);
    });

    it("cloud_workspace_invitations: revoking an accepted invitation", async () => {
      const invitationId = randomUUID();
      await pool.query(`INSERT INTO cloud_workspace_invitations(id,workspace_id,org_id,recipient_email_sha256,token_hash,role,invited_by,
        inviter_fingerprint,expires_at,accepted_at,accepted_by) VALUES($1,$2,$3,$4,$5,'viewer',$6,$7,now()+interval '1 day',now(),$8)`,
      [invitationId, fixture.workspaceId, fixture.organizationId, randomBytes(32), randomBytes(32), fixture.userId,
        randomBytes(32).toString("hex"), member]);
      await expectBumped(() => asSystem("UPDATE cloud_workspace_invitations SET revoked_at=now() WHERE id=$1", [invitationId]), [member]);
      expect(await lossOf(member)).toBe(1);
    });

    it("organization_seat_assignments: pulling a seat under the organization billing scope", async () => {
      await pool.query("UPDATE workspace_billing_epochs SET entitlement_scope='organization' WHERE workspace_id=$1 AND billing_epoch=2",
        [fixture.workspaceId]);
      expect(await roleOf(fixture.userId)).toBe("owner");
      await expectBumped(() => asSystem("DELETE FROM organization_seat_assignments WHERE org_id=$1 AND user_id=$2",
        [fixture.organizationId, fixture.userId]), [fixture.userId], [member]);
      expect(await roleOf(fixture.userId)).toBeNull();
    });

    it("organization_seat_assignments: an active seat past the limit lowers everyone", async () => {
      await pool.query("UPDATE organization_entitlements SET seat_limit=(SELECT count(*) FROM organization_seat_assignments WHERE org_id=$1 AND state='active') WHERE org_id=$1",
        [fixture.organizationId]);
      await expectBumped(() => asSystem("INSERT INTO organization_seat_assignments(org_id,user_id,state,assigned_by) VALUES($1,$2,'active',$3)",
        [fixture.organizationId, member, fixture.userId]), [member, fixture.userId]);
    });

    it("cloud_workspace_writer_slots: assigning and releasing a writer slot", async () => {
      const assignment = randomUUID();
      await expectBumped(() => asSystem("INSERT INTO cloud_workspace_writer_slots(workspace_id,slot,assignment_id,user_id) VALUES($1,2,$2,$3)",
        [fixture.workspaceId, assignment, member]), [member], [fixture.userId]);
      await expectBumped(() => asSystem("DELETE FROM cloud_workspace_writer_slots WHERE assignment_id=$1", [assignment]), [member]);
    });

    it("organization_entitlements: a plan change bumps every principal", async () => {
      await expectBumped(() => asSystem("UPDATE organization_entitlements SET seat_limit=seat_limit+1 WHERE org_id=$1",
        [fixture.organizationId]), [fixture.userId, member]);
    });

    it("workspace_billing_epochs: a billing-scope flip bumps every principal", async () => {
      await expectBumped(() => asSystem("UPDATE workspace_billing_epochs SET entitlement_scope='organization' WHERE workspace_id=$1 AND billing_epoch=2",
        [fixture.workspaceId]), [fixture.userId, member]);
    });

    it("cloud_workspaces: a role-relevant change bumps every principal unless wr or wa moves with it", async () => {
      await expectBumped(() => asSystem("UPDATE cloud_workspaces SET single_member_mode=true WHERE id=$1", [fixture.workspaceId]),
        [fixture.userId, member]);
      expect(await roleOf(member)).toBeNull();
      // access_revision already ends every older token for this workspace.
      await expectBumped(() => asSystem("UPDATE cloud_workspaces SET single_member_mode=false,access_revision=access_revision+1 WHERE id=$1",
        [fixture.workspaceId]), [], [fixture.userId, member]);
    });

    it("users: a status change bumps unless auth_revision moves with it", async () => {
      await expectBumped(() => asSystem("UPDATE users SET auth_status='suspended' WHERE id=$1", [member]), [member], [fixture.userId]);
      await expectBumped(() => asSystem("UPDATE users SET auth_status='active',auth_revision=auth_revision+1 WHERE id=$1", [member]),
        [], [member]);
    });
  });

  // Only the migration owner writes these (operator commands; zeros_app
  // reads them), so the owner role is the production writer here.
  describe("owner-only writes", () => {
    it("account_entitlements: losing Pro bumps, a pure extension does not", async () => {
      await pool.query("UPDATE account_entitlements SET valid_until=now()+interval '400 days' WHERE user_id=$1", [fixture.userId]);
      await expectBumped(() => pool.query("UPDATE account_entitlements SET valid_until=valid_until+interval '30 days' WHERE user_id=$1",
        [fixture.userId]), [], [fixture.userId]);
      await expectBumped(() => pool.query("UPDATE account_entitlements SET cloud_workspaces_allowed=false WHERE user_id=$1", [fixture.userId]),
        [fixture.userId], [member]);
    });

    it("staff_pro_benefits: granting and revoking the staff benefit", async () => {
      // A staff role syncs the benefit row (0101 staff_pro_benefit_sync).
      await expectBumped(() => pool.query("UPDATE users SET staff_role='developer' WHERE id=$1", [member]), [member]);
      await expectBumped(() => pool.query("UPDATE staff_pro_benefits SET revoked_at=now() WHERE user_id=$1", [member]), [member]);
      await expectBumped(() => pool.query("DELETE FROM staff_pro_benefits WHERE user_id=$1", [member]), [member]);
    });
  });

  // AFTER UPDATE OF col fires whenever col is in the SET list. A directory
  // sync rewriting unchanged roles must not revoke every member's tokens.
  describe("writes that change no input", () => {
    it("a WorkOS-style membership upsert with the same role", async () => {
      await expectBumped(() => asSystem(`INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')
        ON CONFLICT (org_id,user_id) DO UPDATE SET role=EXCLUDED.role`, [fixture.organizationId, member]), [], [member, fixture.userId]);
    });

    it("no-op updates on every per-principal input", async () => {
      const guest = await addUser("Guest"), grantId = randomUUID(), assignment = randomUUID(), invitationId = randomUUID();
      await pool.query(`INSERT INTO cloud_workspace_guest_grants(id,workspace_id,org_id,user_id,role,revision,created_by,expires_at)
        VALUES($1,$2,$3,$4,'viewer',1,$5,now()+interval '1 day')`, [grantId, fixture.workspaceId, fixture.organizationId, guest, fixture.userId]);
      await pool.query("INSERT INTO cloud_workspace_writer_slots(workspace_id,slot,assignment_id,user_id) VALUES($1,2,$2,$3)",
        [fixture.workspaceId, assignment, member]);
      await pool.query(`INSERT INTO cloud_workspace_invitations(id,workspace_id,org_id,recipient_email_sha256,token_hash,role,invited_by,
        inviter_fingerprint,expires_at,accepted_at,accepted_by) VALUES($1,$2,$3,$4,$5,'viewer',$6,$7,now()+interval '1 day',now(),$8)`,
      [invitationId, fixture.workspaceId, fixture.organizationId, randomBytes(32), randomBytes(32), fixture.userId,
        randomBytes(32).toString("hex"), member]);
      await pool.query("UPDATE users SET staff_role='developer' WHERE id=$1", [member]);
      const everyone = [fixture.userId, member, guest];
      const noOps: Array<[string, unknown[]]> = [
        ["UPDATE organization_members SET role=role, org_id=org_id, user_id=user_id WHERE org_id=$1", [fixture.organizationId]],
        ["UPDATE cloud_workspace_members SET role=role, user_id=user_id WHERE workspace_id=$1", [fixture.workspaceId]],
        ["UPDATE cloud_workspace_guest_grants SET role=role, revoked_at=revoked_at, expires_at=expires_at WHERE id=$1", [grantId]],
        ["UPDATE team_members SET team_id=team_id, user_id=user_id WHERE org_id=$1", [fixture.organizationId]],
        ["UPDATE organization_seat_assignments SET state=state, user_id=user_id WHERE org_id=$1", [fixture.organizationId]],
        ["UPDATE cloud_workspace_writer_slots SET user_id=user_id, invitation_id=invitation_id WHERE workspace_id=$1", [fixture.workspaceId]],
        ["UPDATE workspace_billing_epochs SET entitlement_scope=entitlement_scope, org_id=org_id WHERE workspace_id=$1", [fixture.workspaceId]],
        ["UPDATE cloud_workspace_invitations SET revoked_at=revoked_at, accepted_by=accepted_by WHERE id=$1", [invitationId]],
      ];
      for (const [statement, values] of noOps) await expectBumped(() => asSystem(statement, values), [], everyone);
      await expectBumped(() => pool.query("UPDATE staff_pro_benefits SET valid_from=valid_from, revoked_at=revoked_at WHERE user_id=$1",
        [member]), [], everyone);
    });
  });

  it("keeps the bump helpers out of reach of the runtime role", async () => {
    const [org, user, workspace] = [fixture.organizationId, fixture.userId, fixture.workspaceId];
    for (const [call, values] of [
      ["bump_cloud_capability_member_epoch($1::uuid,$2::uuid)", [org, user]],
      ["bump_cloud_capability_org_epochs($1::uuid)", [org]],
      ["bump_cloud_capability_user_epochs($1::uuid)", [user]],
      ["record_cloud_capability_access_loss($1::uuid,$2::uuid,$3::uuid)", [workspace, org, user]],
    ] as const) {
      await expect(asSystem(`SELECT ${call}`, [...values]), call).rejects.toThrow(/permission denied/);
    }
  });

  it("puts an epoch bump on every table the role functions read", async () => {
    // Derived from the live function bodies (functionInputTables): a role
    // function that starts reading a new table fails here until the table
    // gains an epoch trigger or a documented exemption.
    const { tables, functions } = await functionInputTables(pool, ROLE_FUNCTIONS);
    for (const input of ["organization_members", "cloud_workspace_members", "cloud_workspace_guest_grants", "team_members",
      "teams", "organizations", "organization_seat_assignments", "organization_entitlements", "cloud_workspace_writer_slots",
      "workspace_billing_epochs", "cloud_workspaces", "users", "account_entitlements", "staff_pro_benefits"]) expect(tables).toContain(input);
    for (const callee of ["cloud_workspace_legacy_actor_role", "cloud_workspace_pro_user_live", "cloud_workspace_pilot_user_live",
      "cloud_workspace_pro_entitlement"]) expect(functions).toContain(callee);
    const { rows } = await pool.query<{ table: string }>(
      `SELECT DISTINCT relation.relname AS table FROM pg_trigger trigger
       JOIN pg_class relation ON relation.oid=trigger.tgrelid
       JOIN pg_proc function ON function.oid=trigger.tgfoid
       WHERE NOT trigger.tgisinternal AND trigger.tgenabled='O'
         AND function.proname LIKE 'bump\\_cloud\\_capability\\_%'`);
    const covered = new Set(rows.map(row => row.table));
    expect([...tables].filter(table => !covered.has(table) && !Object.hasOwn(EPOCH_EXEMPT_INPUTS, table)).sort()).toEqual([]);
    expect(Object.keys(EPOCH_EXEMPT_INPUTS).filter(table => !tables.has(table))).toEqual([]);
  });
});
