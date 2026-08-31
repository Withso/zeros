import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { ensureUser, type AuthedUser } from "../auth.js";
import { withSystemTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import {
  authorizeCloudWorkspaceOperation,
  CloudWorkspaceAuthorizationError,
} from "./authorization.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("cloud paid-work authorization", () => {
  let pool: pg.Pool;
  let owner: AuthedUser;
  let member: AuthedUser;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    owner = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_${randomUUID().replaceAll("-", "")}`,
      email: `owner-${randomUUID()}@example.test`,
      displayName: "Owner",
    });
    member = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_${randomUUID().replaceAll("-", "")}`,
      email: `member-${randomUUID()}@example.test`,
      displayName: "Member",
    });
  });

  async function personalScope() {
    const result = await pool.query<{ org_id: string; team_id: string }>(
      `SELECT o.id AS org_id, t.id AS team_id
       FROM organizations o
       JOIN teams t ON t.org_id = o.id AND t.is_default AND t.deleted_at IS NULL
       WHERE o.created_by = $1 AND o.is_personal AND o.deleted_at IS NULL`,
      [owner.id],
    );
    return result.rows[0]!;
  }

  async function collaborativeScope() {
    return withSystemTx(pool, async (tx) => {
      const organization = await tx.query<{ id: string }>(
        `INSERT INTO organizations (
           slug, name, created_by, is_personal, cloud_workspaces_allowed
         ) VALUES ($1, 'Cloud Org', $2, false, true) RETURNING id`,
        [`cloud-${randomUUID()}`, owner.id],
      );
      const organizationId = organization.rows[0]!.id;
      await tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
        [organizationId, owner.id, member.id],
      );
      const team = await tx.query<{ id: string }>(
        `INSERT INTO teams (org_id, slug, name, is_default, created_by)
         VALUES ($1, 'default', 'Default', true, $2) RETURNING id`,
        [organizationId, owner.id],
      );
      await tx.query(
        `INSERT INTO team_members (team_id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'maintainer'), ($1, $2, $4, 'member')`,
        [team.rows[0]!.id, organizationId, owner.id, member.id],
      );
      return { orgId: organizationId, teamId: team.rows[0]!.id };
    });
  }

  it("requires an active Pro account entitlement for Personal cloud", async () => {
    const scope = await personalScope();
    await expect(
      withSystemTx(pool, (tx) =>
        authorizeCloudWorkspaceOperation(tx, {
          organizationId: scope.org_id,
          teamId: scope.team_id,
          actorUserId: owner.id,
          billingOwnerUserId: owner.id,
          workosEnabled: true,
          requireWorkspaceOwner: false,
        }),
      ),
    ).rejects.toMatchObject({ code: "cloud_account_entitlement_required" });

    await withSystemTx(pool, (tx) =>
      tx.query(
        `INSERT INTO account_entitlements (
           user_id, plan, status, cloud_workspaces_allowed, source
         ) VALUES ($1, 'pro', 'active', true, 'operator')`,
        [owner.id],
      ),
    );
    const admitted = await withSystemTx(pool, (tx) =>
      authorizeCloudWorkspaceOperation(tx, {
        organizationId: scope.org_id,
        teamId: scope.team_id,
        actorUserId: owner.id,
        billingOwnerUserId: owner.id,
        workosEnabled: true,
        requireWorkspaceOwner: false,
      }),
    );
    expect(admitted).toMatchObject({
      isPersonal: true,
      plan: "pro",
      entitlementScope: "account",
      billingOwnerUserId: owner.id,
    });
  });

  it("requires every active collaborator to hold Pro independently", async () => {
    const scope = await collaborativeScope();
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO workos_organization_links (
           organization_id, workos_organization_id, external_id, state
         ) VALUES ($1::uuid, $2::text, $1::uuid::text, 'active')`,
        [scope.orgId, `org_${randomUUID().replaceAll("-", "")}`],
      );
      await tx.query(
        `INSERT INTO organization_entitlements (
           org_id, plan, status, cloud_workspaces_allowed, source
         ) VALUES ($1, 'pro', 'active', true, 'operator')`,
        [scope.orgId],
      );
      await tx.query(
        `INSERT INTO account_entitlements (
           user_id, plan, status, cloud_workspaces_allowed, source
         ) VALUES ($1, 'pro', 'active', true, 'operator')`,
        [owner.id],
      );
    });

    await expect(
      withSystemTx(pool, (tx) =>
        authorizeCloudWorkspaceOperation(tx, {
          organizationId: scope.orgId,
          teamId: scope.teamId,
          actorUserId: owner.id,
          billingOwnerUserId: owner.id,
          workosEnabled: true,
          requireWorkspaceOwner: false,
        }),
      ),
    ).rejects.toMatchObject({ code: "cloud_pro_collaborator_not_entitled" });

    await withSystemTx(pool, (tx) =>
      tx.query(
        `INSERT INTO account_entitlements (
           user_id, plan, status, cloud_workspaces_allowed, source
         ) VALUES ($1, 'pro', 'active', true, 'operator')`,
        [member.id],
      ),
    );
    const admitted = await withSystemTx(pool, (tx) =>
      authorizeCloudWorkspaceOperation(tx, {
        organizationId: scope.orgId,
        teamId: scope.teamId,
        actorUserId: owner.id,
        billingOwnerUserId: owner.id,
        workosEnabled: true,
        requireWorkspaceOwner: false,
      }),
    );
    expect(admitted.plan).toBe("pro");
  });

  it("requires an active Business seat and enforces the purchased seat ceiling", async () => {
    const scope = await collaborativeScope();
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO organization_entitlements (
           org_id, plan, status, cloud_workspaces_allowed, seat_limit, source
         ) VALUES ($1, 'business', 'active', true, 1, 'operator')`,
        [scope.orgId],
      );
      await tx.query(
        `INSERT INTO organization_seat_assignments (org_id, user_id, state)
         VALUES ($1, $2, 'active')`,
        [scope.orgId, owner.id],
      );
    });

    const admitted = await withSystemTx(pool, (tx) =>
      authorizeCloudWorkspaceOperation(tx, {
        organizationId: scope.orgId,
        teamId: scope.teamId,
        actorUserId: owner.id,
        billingOwnerUserId: owner.id,
        workosEnabled: false,
        requireWorkspaceOwner: false,
      }),
    );
    expect(admitted.plan).toBe("business");

    await withSystemTx(pool, (tx) =>
      tx.query(
        `INSERT INTO organization_seat_assignments (org_id, user_id, state)
         VALUES ($1, $2, 'active')`,
        [scope.orgId, member.id],
      ),
    );
    await expect(
      withSystemTx(pool, (tx) =>
        authorizeCloudWorkspaceOperation(tx, {
          organizationId: scope.orgId,
          teamId: scope.teamId,
          actorUserId: owner.id,
          billingOwnerUserId: owner.id,
          workosEnabled: false,
          requireWorkspaceOwner: false,
        }),
      ),
    ).rejects.toMatchObject({ code: "cloud_organization_seat_limit_exceeded" });
  });

  it("keeps Phase 5 runtime admission owner-only", async () => {
    const scope = await collaborativeScope();
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO organization_entitlements (
           org_id, plan, status, cloud_workspaces_allowed, seat_limit, source
         ) VALUES ($1, 'business', 'active', true, 2, 'operator')`,
        [scope.orgId],
      );
      await tx.query(
        `INSERT INTO organization_seat_assignments (org_id, user_id, state)
         VALUES ($1, $2, 'active'), ($1, $3, 'active')`,
        [scope.orgId, owner.id, member.id],
      );
    });

    await expect(
      withSystemTx(pool, (tx) =>
        authorizeCloudWorkspaceOperation(tx, {
          organizationId: scope.orgId,
          teamId: scope.teamId,
          actorUserId: member.id,
          billingOwnerUserId: owner.id,
          workosEnabled: false,
          requireWorkspaceOwner: true,
        }),
      ),
    ).rejects.toBeInstanceOf(CloudWorkspaceAuthorizationError);
  });
});
