import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureUser } from "./auth.js";
import { seedReadyCloudWorkspace } from "./cloud-workspaces/test-fixtures.js";
import { withSystemTx } from "./db.js";
import {
  cloudWorkspaceQuotaApprovalText,
  manageCloudWorkspaceQuota,
  validateCloudWorkspaceQuotaRequest,
} from "./manage-cloud-workspace-quota.js";
import { runMigrations } from "./migrate.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("owner-managed cloud-workspace quotas", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 3 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("plans, target-binds, provisions, updates, and append-only audits one Organization quota", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const actor = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_quota_actor_${suffix}`,
      email: `quota-actor-${suffix}@example.test`,
      displayName: "Quota owner",
    });
    await pool.query(
      `UPDATE users SET staff_role = 'platform_owner' WHERE id = $1`,
      [actor.id],
    );
    const organizationId = randomUUID();
    const organizationSlug = `quota-${suffix}`;
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO organizations (
           id, slug, name, created_by, is_personal, cloud_workspaces_allowed
         ) VALUES ($1, $2, 'Quota Organization', $3, false, true)`,
        [organizationId, organizationSlug, actor.id],
      );
      await tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [organizationId, actor.id],
      );
      await tx.query(
        `INSERT INTO organization_entitlements (
           org_id, plan, status, cloud_workspaces_allowed, seat_limit, source
         ) VALUES ($1, 'business', 'active', true, 1, 'operator')`,
        [organizationId],
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
      maxWorkspaces: "8",
      maxRunningWorkspaces: "4",
      maxCpuMillicores: "16000",
      maxMemoryMiB: "32768",
      maxStorageMiB: "163840",
      reason: "Approve the reviewed Alpha cloud workspace pilot quota.",
    } as const;

    // Possessing the write grants is deliberately insufficient: the audited
    // workflow is reserved for the migration/table owner.
    const delegateRole = `quota_delegate_${suffix.slice(0, 16)}`;
    const delegatePassword = `delegate_${suffix.slice(16, 40)}`;
    await pool.query(
      `CREATE ROLE ${delegateRole} LOGIN PASSWORD '${delegatePassword}'`,
    );
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${delegateRole}`);
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE ON cloud_workspace_quotas TO ${delegateRole}`,
    );
    await pool.query(
      `GRANT INSERT ON cloud_workspace_quota_changes TO ${delegateRole}`,
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
        manageCloudWorkspaceQuota(
          delegatePool,
          validateCloudWorkspaceQuotaRequest(base),
        ),
      ).rejects.toThrow(/database\/migration owner/i);
    } finally {
      await delegatePool.end();
      await pool.query(`DROP OWNED BY ${delegateRole}`);
      await pool.query(`DROP ROLE ${delegateRole}`);
    }

    const plannedRequest = validateCloudWorkspaceQuotaRequest(base);
    const plan = await manageCloudWorkspaceQuota(pool, plannedRequest);
    expect(plan).toMatchObject({
      state: "planned",
      previous: null,
      next: {
        maxWorkspaces: 8,
        maxRunningWorkspaces: 4,
        maxCpuMillicores: 16_000,
        maxMemoryMiB: 32_768,
        maxStorageMiB: 163_840,
      },
      organizationId,
      actorUserId: actor.id,
    });
    expect(plan.approval).toBe(
      cloudWorkspaceQuotaApprovalText(plannedRequest, null),
    );

    await expect(
      manageCloudWorkspaceQuota(
        pool,
        validateCloudWorkspaceQuotaRequest({
          ...base,
          execute: true,
          approval: `${plan.approval}-wrong`,
        }),
      ),
    ).rejects.toThrow(/approval/i);

    const changed = await manageCloudWorkspaceQuota(
      pool,
      validateCloudWorkspaceQuotaRequest({
        ...base,
        execute: true,
        approval: plan.approval,
      }),
    );
    expect(changed.state).toBe("changed");

    const firstEvidence = await pool.query<{
      max_workspaces: number;
      updated_by: string;
      change_count: string;
    }>(
      `SELECT quota.max_workspaces, quota.updated_by,
              (SELECT count(*) FROM cloud_workspace_quota_changes change
               WHERE change.org_id = quota.org_id) AS change_count
       FROM cloud_workspace_quotas quota WHERE quota.org_id = $1`,
      [organizationId],
    );
    expect(firstEvidence.rows[0]).toEqual({
      max_workspaces: 8,
      updated_by: actor.id,
      change_count: "1",
    });

    const updateBase = {
      ...base,
      maxWorkspaces: "10",
      maxRunningWorkspaces: "5",
      maxCpuMillicores: "20000",
      maxMemoryMiB: "40960",
      maxStorageMiB: "204800",
      reason: "Increase the reviewed Alpha pilot after capacity approval.",
    } as const;
    const updateRequest = validateCloudWorkspaceQuotaRequest(updateBase);
    const updatePlan = await manageCloudWorkspaceQuota(pool, updateRequest);
    expect(updatePlan.previous).toEqual(plan.next);
    await manageCloudWorkspaceQuota(
      pool,
      validateCloudWorkspaceQuotaRequest({
        ...updateBase,
        execute: true,
        approval: updatePlan.approval,
      }),
    );
    await expect(
      manageCloudWorkspaceQuota(
        pool,
        validateCloudWorkspaceQuotaRequest({
          ...base,
          execute: true,
          approval: plan.approval,
        }),
      ),
    ).rejects.toThrow(/approval/i);

    const evidence = await pool.query<{
      previous_max_workspaces: number | null;
      next_max_workspaces: number;
      reason: string;
    }>(
      `SELECT previous_max_workspaces, next_max_workspaces, reason
       FROM cloud_workspace_quota_changes
       WHERE org_id = $1 ORDER BY id`,
      [organizationId],
    );
    expect(evidence.rows).toEqual([
      {
        previous_max_workspaces: null,
        next_max_workspaces: 8,
        reason: base.reason,
      },
      {
        previous_max_workspaces: 8,
        next_max_workspaces: 10,
        reason: updateBase.reason,
      },
    ]);

    await expect(
      pool.query(
        `UPDATE cloud_workspace_quota_changes SET reason = reason
         WHERE org_id = $1`,
        [organizationId],
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      pool.query(
        `DELETE FROM cloud_workspace_quota_changes WHERE org_id = $1`,
        [organizationId],
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      pool.query(`TRUNCATE cloud_workspace_quota_changes`),
    ).rejects.toThrow(/append-only/i);
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          `INSERT INTO cloud_workspace_quota_changes (
             org_id, actor_user_id, next_max_workspaces,
             next_max_running_workspaces, next_max_cpu_millicores,
             next_max_memory_mib, next_max_storage_mib,
             deployment_channel, target_fingerprint, database_principal, reason
           ) VALUES ($1, $2, 1, 1, 2000, 4096, 20480,
                     'alpha', '0000000000000000', 'zeros_app',
                     'Application code cannot forge operator evidence.')`,
          [organizationId, actor.id],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("rejects Personal tenants, ineligible Organizations, non-owner operators, and quotas below live usage", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const actor = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_quota_guard_${suffix}`,
      email: `quota-guard-${suffix}@example.test`,
      displayName: "Quota guard",
    });
    const personal = await pool.query<{ id: string; slug: string }>(
      `SELECT id, slug::text FROM organizations
       WHERE created_by = $1 AND is_personal`,
      [actor.id],
    );
    const common = {
      databaseUrl: url!,
      channel: "alpha",
      railwayEnvironmentName: "alpha",
      execute: false,
      productionConfirmed: undefined,
      approval: undefined,
      actorUserId: actor.id,
      maxWorkspaces: "5",
      maxRunningWorkspaces: "2",
      maxCpuMillicores: "10000",
      maxMemoryMiB: "20480",
      maxStorageMiB: "102400",
      reason: "Verify that unsafe quota provisioning fails closed.",
    } as const;

    await expect(
      manageCloudWorkspaceQuota(
        pool,
        validateCloudWorkspaceQuotaRequest({
          ...common,
          organizationId: personal.rows[0]!.id,
          expectedOrganizationSlug: personal.rows[0]!.slug,
        }),
      ),
    ).rejects.toThrow(/platform owner/i);

    await pool.query(
      `UPDATE users SET staff_role = 'platform_owner' WHERE id = $1`,
      [actor.id],
    );
    await expect(
      manageCloudWorkspaceQuota(
        pool,
        validateCloudWorkspaceQuotaRequest({
          ...common,
          organizationId: personal.rows[0]!.id,
          expectedOrganizationSlug: personal.rows[0]!.slug,
        }),
      ),
    ).rejects.toThrow(/personal/i);

    const organizationId = randomUUID();
    const organizationSlug = `quota-ineligible-${suffix}`;
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO organizations (
           id, slug, name, created_by, is_personal, cloud_workspaces_allowed
         ) VALUES ($1, $2, 'Ineligible Organization', $3, false, true)`,
        [organizationId, organizationSlug, actor.id],
      );
    });
    await expect(
      manageCloudWorkspaceQuota(
        pool,
        validateCloudWorkspaceQuotaRequest({
          ...common,
          organizationId,
          expectedOrganizationSlug: organizationSlug,
        }),
      ),
    ).rejects.toThrow(/entitlement/i);

    const used = await seedReadyCloudWorkspace(pool);
    await pool.query(
      `UPDATE users SET staff_role = 'platform_owner' WHERE id = $1`,
      [used.userId],
    );
    const usedOrganization = await pool.query<{ slug: string }>(
      `SELECT slug::text FROM organizations WHERE id = $1`,
      [used.organizationId],
    );
    await expect(
      manageCloudWorkspaceQuota(
        pool,
        validateCloudWorkspaceQuotaRequest({
          ...common,
          organizationId: used.organizationId,
          expectedOrganizationSlug: usedOrganization.rows[0]!.slug,
          actorUserId: used.userId,
          maxWorkspaces: "1",
          maxRunningWorkspaces: "1",
          maxCpuMillicores: "1999",
          maxMemoryMiB: "4096",
          maxStorageMiB: "20480",
        }),
      ),
    ).rejects.toThrow(/below.*current workspace usage/i);
  });

  it("rejects a quota decrease while a replacement candidate reserves headroom", async () => {
    const used = await seedReadyCloudWorkspace(pool);
    await pool.query(
      `UPDATE users SET staff_role = 'platform_owner' WHERE id = $1`,
      [used.userId],
    );
    const organization = await pool.query<{ slug: string }>(
      `SELECT slug::text FROM organizations WHERE id = $1`,
      [used.organizationId],
    );
    const drainIntentId = randomUUID();
    const transitionId = randomUUID();
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO cloud_workspace_quotas (
           org_id, max_workspaces, max_running_workspaces,
           max_cpu_millicores, max_memory_mib, max_storage_mib, updated_by
         ) VALUES ($1, 5, 5, 10000, 20480, 61440, $2)`,
        [used.organizationId, used.userId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by, provider_connection_id
         ) SELECT workspace_id, 2, org_id, provider, image_ref,
                  architecture, cpu_millicores, memory_mib, storage_mib,
                  source_commit, created_by, provider_connection_id
           FROM cloud_workspace_generations
           WHERE workspace_id = $1 AND generation = 1`,
        [used.workspaceId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider, observed_state
         ) VALUES ($1, 2, $2, 'daytona', 'absent')`,
        [used.workspaceId, used.organizationId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_lifecycle_intents (
           id, workspace_id, generation, org_id, requested_by, operation,
           idempotency_key, request_sha256, affects_workspace
         ) VALUES ($1, $2, 1, $3, $4, 'stop', $5, $6, false)`,
        [
          drainIntentId,
          used.workspaceId,
          used.organizationId,
          used.userId,
          `quota-headroom-${randomUUID()}`,
          Buffer.alloc(32, 1),
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_generation_transitions (
           id, workspace_id, org_id, requested_by, operation,
           source_generation, template_generation, candidate_generation,
           state, drain_intent_id
         ) VALUES ($1, $2, $3, $4, 'upgrade', 1, 1, 2, 'draining', $5)`,
        [
          transitionId,
          used.workspaceId,
          used.organizationId,
          used.userId,
          drainIntentId,
        ],
      );
      await tx.query(
        `UPDATE cloud_workspace_lifecycle_intents
         SET generation_transition_id = $2 WHERE id = $1`,
        [drainIntentId, transitionId],
      );
    });

    const input = {
      databaseUrl: url!,
      channel: "alpha",
      railwayEnvironmentName: "alpha",
      execute: false,
      productionConfirmed: undefined,
      approval: undefined,
      organizationId: used.organizationId,
      expectedOrganizationSlug: organization.rows[0]!.slug,
      actorUserId: used.userId,
      maxWorkspaces: "1",
      maxRunningWorkspaces: "1",
      maxCpuMillicores: "2000",
      maxMemoryMiB: "4096",
      maxStorageMiB: "20480",
      reason: "Retain replacement capacity until the candidate is retired.",
    } as const;
    await expect(
      manageCloudWorkspaceQuota(
        pool,
        validateCloudWorkspaceQuotaRequest(input),
      ),
    ).rejects.toThrow(/below.*current workspace usage/i);

    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `UPDATE cloud_workspace_generations SET retired_at = now()
         WHERE workspace_id = $1 AND generation = 2`,
        [used.workspaceId],
      );
      await tx.query(
        `UPDATE cloud_workspace_generation_transitions
         SET state = 'cancelled', completed_at = now(), updated_at = now()
         WHERE id = $1`,
        [transitionId],
      );
    });
    await expect(
      manageCloudWorkspaceQuota(
        pool,
        validateCloudWorkspaceQuotaRequest(input),
      ),
    ).resolves.toMatchObject({ state: "planned" });
  });

  it("rejects a quota decrease while retired provider storage awaits verified deletion", async () => {
    const used = await seedReadyCloudWorkspace(pool);
    await pool.query(
      `UPDATE users SET staff_role = 'platform_owner' WHERE id = $1`,
      [used.userId],
    );
    const organization = await pool.query<{ slug: string }>(
      `SELECT slug::text FROM organizations WHERE id = $1`,
      [used.organizationId],
    );
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO cloud_workspace_quotas (
           org_id, max_workspaces, max_running_workspaces,
           max_cpu_millicores, max_memory_mib, max_storage_mib, updated_by
         ) VALUES ($1, 5, 5, 10000, 20480, 61440, $2)`,
        [used.organizationId, used.userId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by, provider_connection_id
         ) SELECT workspace_id, 2, org_id, provider, image_ref,
                  architecture, cpu_millicores, memory_mib, storage_mib,
                  source_commit, created_by, provider_connection_id
           FROM cloud_workspace_generations
           WHERE workspace_id = $1 AND generation = 1`,
        [used.workspaceId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider,
           provider_resource_id, observed_state, last_observed_at
         ) VALUES ($1, 2, $2, 'daytona', $3, 'running', now())`,
        [
          used.workspaceId,
          used.organizationId,
          `sandbox-${used.workspaceId}-2`,
        ],
      );
      await tx.query(
        `UPDATE cloud_workspace_generations SET retired_at = now()
         WHERE workspace_id = $1 AND generation = 1`,
        [used.workspaceId],
      );
      await tx.query(
        `UPDATE cloud_workspace_provider_bindings
         SET observed_state = 'stopped', updated_at = now()
         WHERE workspace_id = $1 AND generation = 1`,
        [used.workspaceId],
      );
      await tx.query(
        `UPDATE cloud_workspaces
         SET current_generation = 2, status = 'ready', updated_at = now()
         WHERE id = $1`,
        [used.workspaceId],
      );
    });

    const input = {
      databaseUrl: url!,
      channel: "alpha",
      railwayEnvironmentName: "alpha",
      execute: false,
      productionConfirmed: undefined,
      approval: undefined,
      organizationId: used.organizationId,
      expectedOrganizationSlug: organization.rows[0]!.slug,
      actorUserId: used.userId,
      maxWorkspaces: "1",
      maxRunningWorkspaces: "1",
      maxCpuMillicores: "2000",
      maxMemoryMiB: "4096",
      maxStorageMiB: "20480",
      reason: "Retain retired provider disk until deletion is verified.",
    } as const;
    await expect(
      manageCloudWorkspaceQuota(
        pool,
        validateCloudWorkspaceQuotaRequest(input),
      ),
    ).rejects.toThrow(/below.*current workspace usage/i);

    await withSystemTx(pool, (tx) =>
      tx.query(
        `UPDATE cloud_workspace_provider_bindings
         SET observed_state = 'deleted', deletion_verified_at = now(),
             last_observed_at = now(), updated_at = now()
         WHERE workspace_id = $1 AND generation = 1`,
        [used.workspaceId],
      ),
    );
    await expect(
      manageCloudWorkspaceQuota(
        pool,
        validateCloudWorkspaceQuotaRequest(input),
      ),
    ).resolves.toMatchObject({ state: "planned" });
  });

  it("can raise a historically valid quota that predates current resource minima", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const actor = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_quota_legacy_${suffix}`,
      email: `quota-legacy-${suffix}@example.test`,
      displayName: "Legacy quota owner",
    });
    await pool.query(
      `UPDATE users SET staff_role = 'platform_owner' WHERE id = $1`,
      [actor.id],
    );
    const organizationId = randomUUID();
    const organizationSlug = `quota-legacy-${suffix}`;
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO organizations (
           id, slug, name, created_by, is_personal, cloud_workspaces_allowed
         ) VALUES ($1, $2, 'Legacy Quota Organization', $3, false, true)`,
        [organizationId, organizationSlug, actor.id],
      );
      await tx.query(
        `INSERT INTO organization_entitlements (
           org_id, plan, status, cloud_workspaces_allowed, seat_limit, source
         ) VALUES ($1, 'business', 'active', true, 1, 'operator')`,
        [organizationId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_quotas (
           org_id, max_workspaces, max_running_workspaces,
           max_cpu_millicores, max_memory_mib, max_storage_mib, updated_by
         ) VALUES ($1, 1, 1, 1, 1, 1, $2)`,
        [organizationId, actor.id],
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
      maxWorkspaces: "2",
      maxRunningWorkspaces: "1",
      maxCpuMillicores: "2000",
      maxMemoryMiB: "4096",
      maxStorageMiB: "20480",
      reason: "Raise a legacy quota to the current minimum resource policy.",
    } as const;
    const request = validateCloudWorkspaceQuotaRequest(base);
    const plan = await manageCloudWorkspaceQuota(pool, request);
    expect(plan.previous).toEqual({
      maxWorkspaces: 1,
      maxRunningWorkspaces: 1,
      maxCpuMillicores: 1,
      maxMemoryMiB: 1,
      maxStorageMiB: 1,
    });
    await expect(
      manageCloudWorkspaceQuota(
        pool,
        validateCloudWorkspaceQuotaRequest({
          ...base,
          execute: true,
          approval: plan.approval,
        }),
      ),
    ).resolves.toMatchObject({ state: "changed" });
  });
});
