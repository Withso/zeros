import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureUser } from "../auth.js";
import { withSystemTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import { authorizeCloudWorkspaceOperation } from "./authorization.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("individual Pro launch authority", () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 4,
    });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await runMigrations(pool);
  });
  async function account() {
    return ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_${randomUUID()}`,
      email: `pro-${randomUUID()}@example.test`,
      displayName: "Pro test",
    });
  }
  async function pro(userId: string) {
    await pool.query(
      `INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source)
    VALUES($1,'pro','active',true,'operator')`,
      [userId],
    );
  }
  async function scope(userId: string) {
    const org = (
      await pool.query(
        `INSERT INTO organizations(slug,name,created_by,is_personal,cloud_workspaces_allowed)
      VALUES($1,'Pro Organization',$2,false,true) RETURNING id`,
        [`pro-${randomUUID()}`, userId],
      )
    ).rows[0].id as string;
    await pool.query(
      "INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')",
      [org, userId],
    );
    const team = (
      await pool.query(
        "INSERT INTO teams(org_id,slug,name,created_by,is_default) VALUES($1,'default','Default',$2,true) RETURNING id",
        [org, userId],
      )
    ).rows[0].id as string;
    await pool.query(
      "INSERT INTO team_members(team_id,org_id,user_id,role) VALUES($1,$2,$3,'member')",
      [team, org, userId],
    );
    return {
      organizationId: org,
      teamId: team,
      actorUserId: userId,
      billingOwnerUserId: userId,
      workosEnabled: false,
      requireWorkspaceOwner: true,
    };
  }
  it("admits a non-staff Pro sponsor without an Organization subscription or seat", async () => {
    const user = await account();
    await pro(user.id);
    const input = await scope(user.id);
    await expect(
      withSystemTx(pool, (tx) => authorizeCloudWorkspaceOperation(tx, input)),
    ).resolves.toMatchObject({ plan: "pro", entitlementScope: "account" });
    await pool.query(
      `INSERT INTO organization_entitlements(org_id,plan,status,cloud_workspaces_allowed,seat_limit,source)
      VALUES($1,'business','expired',false,1,'operator')`,
      [input.organizationId],
    );
    await expect(
      withSystemTx(pool, (tx) => authorizeCloudWorkspaceOperation(tx, input)),
    ).resolves.toMatchObject({ entitlementScope: "account" });
  });
  it("gives standing staff audited complimentary Pro without overwriting paid Pro", async () => {
    const user = await account();
    const input = await scope(user.id);
    await expect(
      withSystemTx(pool, (tx) => authorizeCloudWorkspaceOperation(tx, input)),
    ).rejects.toMatchObject({ code: "cloud_account_entitlement_required" });
    await pool.query("UPDATE users SET staff_role='developer' WHERE id=$1", [
      user.id,
    ]);
    await expect(
      withSystemTx(pool, (tx) => authorizeCloudWorkspaceOperation(tx, input)),
    ).resolves.toMatchObject({ entitlementScope: "account" });
    await pro(user.id);
    await pool.query("UPDATE users SET staff_role=NULL WHERE id=$1", [user.id]);
    await expect(
      withSystemTx(pool, (tx) => authorizeCloudWorkspaceOperation(tx, input)),
    ).resolves.toMatchObject({ entitlementScope: "account" });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM staff_pro_benefit_changes WHERE user_id=$1",
          [user.id],
        )
      ).rows[0].n,
    ).toBe(2);
    expect(
      (
        await pool.query(
          "SELECT source FROM account_entitlements WHERE user_id=$1",
          [user.id],
        )
      ).rows[0].source,
    ).toBe("operator");
  });
  it("revokes complimentary access with staff status and prevents runtime self-grants", async () => {
    const user = await account();
    const input = await scope(user.id);
    await pool.query("UPDATE users SET staff_role='developer' WHERE id=$1", [
      user.id,
    ]);
    await pool.query("UPDATE users SET staff_role=NULL WHERE id=$1", [user.id]);
    await expect(
      withSystemTx(pool, (tx) => authorizeCloudWorkspaceOperation(tx, input)),
    ).rejects.toMatchObject({ code: "cloud_account_entitlement_required" });
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          "UPDATE staff_pro_benefits SET revoked_at=NULL WHERE user_id=$1",
          [user.id],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("bootstraps finite Organization safety caps idempotently without a subscription or seats", async () => {
    const user = await account();
    const input = await scope(user.id);
    const bootstrap = () =>
      withSystemTx(pool, (tx) =>
        tx.query("SELECT provision_cloud_workspace_pro_defaults($1)", [
          input.organizationId,
        ]),
      );
    await bootstrap();
    await bootstrap();
    expect(
      (
        await pool.query(
          "SELECT max_workspaces,max_running_workspaces,max_storage_mib,default_policy_version FROM cloud_workspace_quotas WHERE org_id=$1",
          [input.organizationId],
        )
      ).rows,
    ).toEqual([
      {
        max_workspaces: 10,
        max_running_workspaces: 5,
        max_storage_mib: 1500000,
        default_policy_version: "pro-v1",
      },
    ]);
    await pool.query(
      "UPDATE cloud_workspace_quotas SET max_workspaces=3,max_running_workspaces=3,default_policy_version=NULL WHERE org_id=$1",
      [input.organizationId],
    );
    await pool.query(
      "UPDATE cloud_workspace_object_storage_limits SET max_workspace_bytes=1000000,default_policy_version=NULL WHERE org_id=$1",
      [input.organizationId],
    );
    await bootstrap();
    expect(
      (
        await pool.query(
          "SELECT max_workspaces,default_policy_version FROM cloud_workspace_quotas WHERE org_id=$1",
          [input.organizationId],
        )
      ).rows[0],
    ).toEqual({ max_workspaces: 3, default_policy_version: null });
    expect(
      (
        await pool.query(
          "SELECT max_workspace_bytes FROM cloud_workspace_object_storage_limits WHERE org_id=$1",
          [input.organizationId],
        )
      ).rows[0].max_workspace_bytes,
    ).toBe("1000000");
    expect(
      (
        await pool.query(
          "SELECT 1 FROM organization_entitlements WHERE org_id=$1",
          [input.organizationId],
        )
      ).rowCount,
    ).toBe(0);
    const personal = (
      await pool.query(
        "SELECT id FROM organizations WHERE is_personal AND created_by=$1",
        [user.id],
      )
    ).rows[0];
    expect(personal).toBeDefined();
    if (personal) {
      await withSystemTx(pool, (tx) =>
        tx.query("SELECT provision_cloud_workspace_pro_defaults($1)", [
          personal.id,
        ]),
      );
      expect(
        (
          await pool.query(
            "SELECT 1 FROM cloud_workspace_quotas WHERE org_id=$1",
            [personal.id],
          )
        ).rowCount,
      ).toBe(0);
    }
  });
});
