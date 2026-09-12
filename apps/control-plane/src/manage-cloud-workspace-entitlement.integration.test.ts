import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureUser } from "./auth.js";
import { withSystemTx } from "./db.js";
import {
  cloudWorkspaceEntitlementApprovalText,
  manageCloudWorkspaceEntitlement,
  validateCloudWorkspaceEntitlementRequest,
} from "./manage-cloud-workspace-entitlement.js";
import {
  manageCloudWorkspaceQuota,
  validateCloudWorkspaceQuotaRequest,
} from "./manage-cloud-workspace-quota.js";
import { runMigrations } from "./migrate.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("owner-managed cloud-workspace Organization entitlements", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 3 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("plans, target-binds, activates explicit seats, audits, and unlocks first-quota planning", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const actor = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_entitlement_actor_${suffix}`,
      email: `entitlement-actor-${suffix}@example.test`,
      displayName: "Entitlement operator",
    });
    const owner = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_entitlement_owner_${suffix}`,
      email: `entitlement-owner-${suffix}@example.test`,
      displayName: "Organization owner",
    });
    const member = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_entitlement_member_${suffix}`,
      email: `entitlement-member-${suffix}@example.test`,
      displayName: "Organization member",
    });
    await pool.query(
      `UPDATE users SET staff_role = 'platform_owner' WHERE id = $1`,
      [actor.id],
    );

    const organizationId = randomUUID();
    const organizationSlug = `entitlement-${suffix}`;
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO organizations (
           id, slug, name, created_by, is_personal, cloud_workspaces_allowed
         ) VALUES ($1, $2, 'Entitlement Organization', $3, false, true)`,
        [organizationId, organizationSlug, owner.id],
      );
      await tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
        [organizationId, owner.id, member.id],
      );
      await tx.query(
        `INSERT INTO workos_organization_links (
           organization_id, workos_organization_id, external_id, state
         ) VALUES ($1::uuid, $2, ($1::uuid)::text, 'active')`,
        [organizationId, `org_entitlement_${suffix}`],
      );
    });

    const validFrom = new Date(Date.now() - 60_000).toISOString();
    const validUntil = new Date(Date.now() + 86_400_000).toISOString();
    const base = {
      databaseUrl: url!,
      channel: "alpha",
      railwayEnvironmentName: "alpha",
      execute: false,
      productionConfirmed: undefined,
      approval: undefined,
      organizationId,
      expectedOrganizationSlug: organizationSlug,
      actorUserId: actor.id,
      plan: "business",
      status: "active",
      validFrom,
      validUntil,
      seatLimit: "2",
      activeSeatUserIds: `${member.id},${owner.id}`,
      reason: "Activate the reviewed Alpha Organization entitlement.",
    } as const;

    const delegateRole = `entitlement_delegate_${suffix.slice(0, 12)}`;
    const delegatePassword = `delegate_${suffix.slice(12, 36)}`;
    await pool.query(
      `CREATE ROLE ${delegateRole} LOGIN PASSWORD '${delegatePassword}'`,
    );
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${delegateRole}`);
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE ON organization_entitlements,
         organization_seat_assignments TO ${delegateRole}`,
    );
    await pool.query(
      `GRANT INSERT ON cloud_workspace_entitlement_changes TO ${delegateRole}`,
    );
    const delegateUrl = new URL(url!);
    delegateUrl.username = delegateRole;
    delegateUrl.password = delegatePassword;
    const delegatePool = new pg.Pool({
      connectionString: delegateUrl.toString(),
      max: 1,
    });
    try {
      await expect(
        manageCloudWorkspaceEntitlement(
          delegatePool,
          validateCloudWorkspaceEntitlementRequest(base),
        ),
      ).rejects.toThrow(/database\/migration owner/i);
    } finally {
      await delegatePool.end();
      await pool.query(`DROP OWNED BY ${delegateRole}`);
      await pool.query(`DROP ROLE ${delegateRole}`);
    }

    const plannedRequest = validateCloudWorkspaceEntitlementRequest(base);
    const plan = await manageCloudWorkspaceEntitlement(pool, plannedRequest);
    expect(plan).toMatchObject({
      state: "planned",
      organizationId,
      actorUserId: actor.id,
      previous: null,
      next: {
        plan: "business",
        status: "active",
        cloudWorkspacesAllowed: true,
        seatLimit: 2,
        source: "operator",
        validFrom,
        validUntil,
        activeSeatUserIds: [owner.id, member.id].sort(),
      },
    });
    expect(plan.approval).toBe(
      cloudWorkspaceEntitlementApprovalText(plannedRequest, null),
    );

    await expect(
      manageCloudWorkspaceEntitlement(
        pool,
        validateCloudWorkspaceEntitlementRequest({
          ...base,
          execute: true,
          approval: `${plan.approval}-wrong`,
        }),
      ),
    ).rejects.toThrow(/approval/i);

    await expect(
      manageCloudWorkspaceEntitlement(
        pool,
        validateCloudWorkspaceEntitlementRequest({
          ...base,
          execute: true,
          approval: plan.approval,
        }),
      ),
    ).resolves.toMatchObject({ state: "changed" });

    const current = await pool.query<{
      plan: string;
      status: string;
      cloud_workspaces_allowed: boolean;
      seat_limit: number;
      source: string;
      source_reference: string;
      revision: string;
      seat_ids: string[];
      change_count: string;
    }>(
      `SELECT entitlement.plan, entitlement.status,
              entitlement.cloud_workspaces_allowed, entitlement.seat_limit,
              entitlement.source, entitlement.source_reference,
              entitlement.revision::text,
              ARRAY(
                SELECT seat.user_id FROM organization_seat_assignments seat
                WHERE seat.org_id = entitlement.org_id
                  AND seat.state = 'active'
                ORDER BY seat.user_id
              ) AS seat_ids,
              (SELECT count(*)::text
               FROM cloud_workspace_entitlement_changes change
               WHERE change.org_id = entitlement.org_id) AS change_count
       FROM organization_entitlements entitlement WHERE entitlement.org_id = $1`,
      [organizationId],
    );
    expect(current.rows[0]).toEqual({
      plan: "business",
      status: "active",
      cloud_workspaces_allowed: true,
      seat_limit: 2,
      source: "operator",
      source_reference: expect.stringMatching(/^operator:alpha:[a-f0-9]{16}$/),
      revision: "1",
      seat_ids: [owner.id, member.id].sort(),
      change_count: "1",
    });

    // Entitlement/seat activation is deliberately separate from quota
    // provisioning, but it must satisfy the quota command's paid gate.
    await expect(
      manageCloudWorkspaceQuota(
        pool,
        validateCloudWorkspaceQuotaRequest({
          databaseUrl: url!,
          channel: "alpha",
          railwayEnvironmentName: "alpha",
          execute: false,
          productionConfirmed: undefined,
          approval: undefined,
          organizationId,
          expectedOrganizationSlug: organizationSlug,
          actorUserId: actor.id,
          maxWorkspaces: "2",
          maxRunningWorkspaces: "1",
          maxCpuMillicores: "4000",
          maxMemoryMiB: "8192",
          maxStorageMiB: "40960",
          reason: "Provision the first reviewed quota after activation.",
        }),
      ),
    ).resolves.toMatchObject({ state: "planned", previous: null });

    const unchanged = await manageCloudWorkspaceEntitlement(
      pool,
      validateCloudWorkspaceEntitlementRequest(base),
    );
    expect(unchanged).toMatchObject({ state: "unchanged", approval: null });
    await expect(
      manageCloudWorkspaceEntitlement(
        pool,
        validateCloudWorkspaceEntitlementRequest({
          ...base,
          execute: true,
          approval: plan.approval,
        }),
      ),
    ).rejects.toThrow(/already at the requested value/i);

    const enterpriseBase = {
      ...base,
      plan: "enterprise",
      reason: "Move the reviewed Organization to its Enterprise contract.",
    } as const;
    const enterpriseRequest =
      validateCloudWorkspaceEntitlementRequest(enterpriseBase);
    const enterprisePlan = await manageCloudWorkspaceEntitlement(
      pool,
      enterpriseRequest,
    );
    const trialBase = {
      ...base,
      status: "trialing",
      reason:
        "Record the reviewed Organization trial while approval is current.",
    } as const;
    const trialRequest = validateCloudWorkspaceEntitlementRequest(trialBase);
    const trialPlan = await manageCloudWorkspaceEntitlement(pool, trialRequest);
    await manageCloudWorkspaceEntitlement(
      pool,
      validateCloudWorkspaceEntitlementRequest({
        ...trialBase,
        execute: true,
        approval: trialPlan.approval,
      }),
    );
    await expect(
      manageCloudWorkspaceEntitlement(
        pool,
        validateCloudWorkspaceEntitlementRequest({
          ...enterpriseBase,
          execute: true,
          approval: enterprisePlan.approval,
        }),
      ),
    ).rejects.toThrow(/approval.*current target-bound plan/i);
    await expect(
      pool.query(
        `SELECT entitlement.status, entitlement.revision::text,
                count(change.id)::text AS change_count
         FROM organization_entitlements entitlement
         JOIN cloud_workspace_entitlement_changes change
           ON change.org_id = entitlement.org_id
         WHERE entitlement.org_id = $1
         GROUP BY entitlement.status, entitlement.revision`,
        [organizationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ status: "trialing", revision: "2", change_count: "2" }],
    });

    await expect(
      pool.query(
        `UPDATE cloud_workspace_entitlement_changes SET reason = reason
         WHERE org_id = $1`,
        [organizationId],
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      pool.query(
        `DELETE FROM cloud_workspace_entitlement_changes WHERE org_id = $1`,
        [organizationId],
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      pool.query(`TRUNCATE cloud_workspace_entitlement_changes`),
    ).rejects.toThrow(/append-only/i);
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          `INSERT INTO cloud_workspace_entitlement_changes (
             org_id, actor_user_id, previous_active_seat_user_ids,
             next_plan, next_status, next_cloud_workspaces_allowed,
             next_seat_limit, next_source, next_valid_from, next_revision,
             next_active_seat_user_ids, deployment_channel,
             target_fingerprint, database_principal, reason
           ) VALUES (
             $1, $2, '{}'::uuid[], 'business', 'active', true,
             1, 'operator', now(), 1, ARRAY[$2]::uuid[], 'alpha',
             '0000000000000000', 'zeros_app',
             'Application code cannot forge entitlement evidence.'
           )`,
          [organizationId, actor.id],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);

    await pool.query(
      `UPDATE organizations SET lifecycle_status = 'purging', deleted_at = now()
       WHERE id = $1`,
      [organizationId],
    );
    await withSystemTx(pool, (tx) =>
      tx.query(`SELECT purge_cloud_workspace_operator_configuration($1)`, [
        organizationId,
      ]),
    );
    await expect(
      pool.query(
        `SELECT count(*)::integer AS count
         FROM cloud_workspace_entitlement_changes WHERE org_id = $1`,
        [organizationId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("refuses unsafe authorities, identities, validity, and stale current state", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const actor = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_entitlement_guard_${suffix}`,
      email: `entitlement-guard-${suffix}@example.test`,
      displayName: "Entitlement guard",
    });
    const owner = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_entitlement_guard_owner_${suffix}`,
      email: `entitlement-guard-owner-${suffix}@example.test`,
      displayName: "Guard owner",
    });
    const outsider = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_entitlement_outsider_${suffix}`,
      email: `entitlement-outsider-${suffix}@example.test`,
      displayName: "Outsider",
    });
    const organizationId = randomUUID();
    const organizationSlug = `entitlement-guard-${suffix}`;
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO organizations (
           id, slug, name, created_by, is_personal, cloud_workspaces_allowed
         ) VALUES ($1, $2, 'Guard Organization', $3, false, true)`,
        [organizationId, organizationSlug, owner.id],
      );
      await tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [organizationId, owner.id],
      );
    });
    const common = {
      databaseUrl: url!,
      channel: "alpha",
      railwayEnvironmentName: "alpha",
      execute: false,
      productionConfirmed: undefined,
      approval: undefined,
      organizationId,
      expectedOrganizationSlug: organizationSlug,
      actorUserId: actor.id,
      plan: "business",
      status: "active",
      validFrom: new Date(Date.now() - 60_000).toISOString(),
      validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      seatLimit: "1",
      activeSeatUserIds: owner.id,
      reason: "Verify unsafe Organization entitlement activation is refused.",
    } as const;

    await expect(
      manageCloudWorkspaceEntitlement(
        pool,
        validateCloudWorkspaceEntitlementRequest(common),
      ),
    ).rejects.toThrow(/platform owner/i);
    await pool.query(
      `UPDATE users SET staff_role = 'platform_owner' WHERE id = $1`,
      [actor.id],
    );
    await expect(
      manageCloudWorkspaceEntitlement(
        pool,
        validateCloudWorkspaceEntitlementRequest(common),
      ),
    ).rejects.toThrow(/workos.*identity/i);

    await withSystemTx(pool, (tx) =>
      tx.query(
        `INSERT INTO workos_organization_links (
           organization_id, workos_organization_id, external_id, state
         ) VALUES ($1::uuid, $2, ($1::uuid)::text, 'active')`,
        [organizationId, `org_entitlement_guard_${suffix}`],
      ),
    );
    await expect(
      manageCloudWorkspaceEntitlement(
        pool,
        validateCloudWorkspaceEntitlementRequest({
          ...common,
          activeSeatUserIds: outsider.id,
        }),
      ),
    ).rejects.toThrow(/active Organization member/i);
    await expect(
      manageCloudWorkspaceEntitlement(
        pool,
        validateCloudWorkspaceEntitlementRequest({
          ...common,
          validFrom: new Date(Date.now() + 86_400_000).toISOString(),
          validUntil: new Date(Date.now() + 172_800_000).toISOString(),
        }),
      ),
    ).rejects.toThrow(/not current/i);

    await withSystemTx(pool, (tx) =>
      tx.query(
        `INSERT INTO organization_entitlements (
           org_id, plan, status, cloud_workspaces_allowed, seat_limit,
           source, source_reference, valid_from, valid_until
         ) VALUES ($1, 'business', 'active', true, 1, 'contract',
                   'contract-external-authority', now(), now() + interval '1 day')`,
        [organizationId],
      ),
    );
    await expect(
      manageCloudWorkspaceEntitlement(
        pool,
        validateCloudWorkspaceEntitlementRequest(common),
      ),
    ).rejects.toThrow(/non-operator.*billing authority/i);
  });

  it("activates Pro only when every current collaborator already has live account authority", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const actor = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_entitlement_pro_actor_${suffix}`,
      email: `entitlement-pro-actor-${suffix}@example.test`,
      displayName: "Pro entitlement operator",
    });
    const owner = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_entitlement_pro_owner_${suffix}`,
      email: `entitlement-pro-owner-${suffix}@example.test`,
      displayName: "Pro Organization owner",
    });
    await pool.query(
      `UPDATE users SET staff_role = 'platform_owner' WHERE id = $1`,
      [actor.id],
    );
    const organizationId = randomUUID();
    const organizationSlug = `entitlement-pro-${suffix}`;
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO organizations (
           id, slug, name, created_by, is_personal, cloud_workspaces_allowed
         ) VALUES ($1, $2, 'Pro Entitlement Organization', $3, false, true)`,
        [organizationId, organizationSlug, owner.id],
      );
      await tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [organizationId, owner.id],
      );
      await tx.query(
        `INSERT INTO workos_organization_links (
           organization_id, workos_organization_id, external_id, state
         ) VALUES ($1::uuid, $2, ($1::uuid)::text, 'active')`,
        [organizationId, `org_entitlement_pro_${suffix}`],
      );
    });
    const base = {
      databaseUrl: url!,
      channel: "alpha",
      railwayEnvironmentName: "alpha",
      execute: false,
      productionConfirmed: undefined,
      approval: undefined,
      organizationId,
      expectedOrganizationSlug: organizationSlug,
      actorUserId: actor.id,
      plan: "pro",
      status: "active",
      validFrom: new Date(Date.now() - 60_000).toISOString(),
      validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      seatLimit: "none",
      activeSeatUserIds: "none",
      reason: "Activate Pro after verifying every collaborator account.",
    } as const;

    await expect(
      manageCloudWorkspaceEntitlement(
        pool,
        validateCloudWorkspaceEntitlementRequest(base),
      ),
    ).rejects.toThrow(/every collaborator.*Pro account authority/i);
    await withSystemTx(pool, (tx) =>
      tx.query(
        `INSERT INTO account_entitlements (
           user_id, plan, status, cloud_workspaces_allowed, source,
           valid_from, valid_until
         ) VALUES ($1, 'pro', 'active', true, 'operator',
                   now() - interval '1 minute', now() + interval '1 day')`,
        [owner.id],
      ),
    );
    const request = validateCloudWorkspaceEntitlementRequest(base);
    const plan = await manageCloudWorkspaceEntitlement(pool, request);
    await expect(
      manageCloudWorkspaceEntitlement(
        pool,
        validateCloudWorkspaceEntitlementRequest({
          ...base,
          execute: true,
          approval: plan.approval,
        }),
      ),
    ).resolves.toMatchObject({ state: "changed" });
    await expect(
      pool.query(
        `SELECT entitlement.plan, entitlement.seat_limit,
                count(seat.user_id)::integer AS seat_count
         FROM organization_entitlements entitlement
         LEFT JOIN organization_seat_assignments seat
           ON seat.org_id = entitlement.org_id AND seat.state = 'active'
         WHERE entitlement.org_id = $1
         GROUP BY entitlement.plan, entitlement.seat_limit`,
        [organizationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ plan: "pro", seat_limit: null, seat_count: 0 }],
    });
  });
});
