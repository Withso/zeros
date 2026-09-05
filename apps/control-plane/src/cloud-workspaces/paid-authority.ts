import type pg from "pg";

import { audit } from "../audit.js";
import { withSystemTx, type Tx } from "../db.js";
import {
  authorizeCloudWorkspaceOperation,
  CloudWorkspaceAuthorizationError,
  type CloudWorkspaceAuthorization,
} from "./authorization.js";
import { cancelCloudWorkspaceGenerationTransition } from "./generation-transitions.js";
import { retireCloudWorkspaceRuntimeAccess } from "./runtime-access.js";

type PaidAuthorityWorkspace = {
  id: string;
  org_id: string;
  team_id: string;
  owner_user_id: string;
  desired_state: string;
  status: string;
  current_generation: number;
  authority_epoch: string | number;
};

const PROVIDER_CLEANUP_MARGIN_SECONDS = 5 * 60;

type ExecutionAuthorityLoss =
  | "paid_authority_revoked"
  | "provider_authority_revoked";

export type CloudWorkspacePaidAuthorityReconcileResult = {
  workspaceId: string;
  action: "unchanged" | "billing_rebound" | "stopped" | "inactive";
  reason: string;
};

function safePositiveInteger(value: string | number, label: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`Invalid cloud workspace ${label}`);
  }
  return normalized;
}

async function paidAuthorityLive(
  tx: Tx,
  workspaceId: string,
  ownerUserId: string,
  workosEnabled: boolean,
): Promise<boolean> {
  const result = await tx.query<{ live: boolean }>(
    `SELECT cloud_workspace_paid_authority_live($1, $2, $3) AS live`,
    [workspaceId, ownerUserId, workosEnabled],
  );
  return result.rows[0]?.live === true;
}

async function providerAuthorityLive(
  tx: Tx,
  workspaceId: string,
  generation: number,
  minimumRemainingSeconds: number,
): Promise<boolean> {
  const result = await tx.query<{ live: boolean }>(
    `SELECT cloud_workspace_generation_provider_authority_live(
       $1, $2, $3
     ) AS live`,
    [workspaceId, generation, minimumRemainingSeconds],
  );
  return result.rows[0]?.live === true;
}

/**
 * Bind a workspace to the current entitlement revision without rewriting
 * historical usage ownership. Callers must hold the organization lock before
 * the workspace lock, matching create/wake/rebuild lock order.
 */
export async function refreshCloudWorkspaceBillingEpoch(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    authorization: CloudWorkspaceAuthorization;
  },
): Promise<{ billingEpoch: number; changed: boolean }> {
  if (input.authorization.organizationId !== input.organizationId) {
    throw new Error("Cloud workspace billing authorization scope mismatch");
  }
  const workspace = (
    await tx.query<{
      owner_user_id: string;
      current_billing_epoch: string | number;
    }>(
      `SELECT owner_user_id, current_billing_epoch
       FROM cloud_workspaces
       WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [input.workspaceId, input.organizationId],
    )
  ).rows[0];
  if (
    !workspace ||
    workspace.owner_user_id !== input.authorization.billingOwnerUserId
  ) {
    throw new Error("Cloud workspace billing owner changed");
  }

  const currentEpoch = safePositiveInteger(
    workspace.current_billing_epoch,
    "billing epoch",
  );
  const current = (
    await tx.query<{
      billing_owner_user_id: string;
      entitlement_scope: string;
      entitlement_plan: string;
      entitlement_revision: string | number;
      ended_at: Date | string | null;
      max_billing_epoch: string | number;
    }>(
      `SELECT billing.billing_owner_user_id, billing.entitlement_scope,
              billing.entitlement_plan, billing.entitlement_revision,
              billing.ended_at,
              (SELECT max(candidate.billing_epoch)
               FROM workspace_billing_epochs candidate
               WHERE candidate.workspace_id = billing.workspace_id
              ) AS max_billing_epoch
       FROM workspace_billing_epochs billing
       WHERE billing.workspace_id = $1 AND billing.org_id = $2
         AND billing.billing_epoch = $3
       FOR UPDATE`,
      [input.workspaceId, input.organizationId, currentEpoch],
    )
  ).rows[0];
  if (!current) throw new Error("Current cloud workspace billing epoch is missing");

  const entitlementRevision = safePositiveInteger(
    current.entitlement_revision,
    "billing entitlement revision",
  );
  if (
    current.ended_at === null &&
    current.billing_owner_user_id === input.authorization.billingOwnerUserId &&
    current.entitlement_scope === input.authorization.entitlementScope &&
    current.entitlement_plan === input.authorization.plan &&
    entitlementRevision === input.authorization.entitlementRevision
  ) {
    return { billingEpoch: currentEpoch, changed: false };
  }

  const nextEpoch =
    safePositiveInteger(current.max_billing_epoch, "maximum billing epoch") + 1;
  await tx.query(
    `UPDATE workspace_billing_epochs
     SET ended_at = coalesce(ended_at, now())
     WHERE workspace_id = $1 AND ended_at IS NULL`,
    [input.workspaceId],
  );
  await tx.query(
    `INSERT INTO workspace_billing_epochs (
       workspace_id, billing_epoch, org_id, billing_owner_user_id,
       entitlement_scope, entitlement_plan, entitlement_revision, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.workspaceId,
      nextEpoch,
      input.organizationId,
      input.authorization.billingOwnerUserId,
      input.authorization.entitlementScope,
      input.authorization.plan,
      input.authorization.entitlementRevision,
      input.authorization.actorUserId,
    ],
  );
  await tx.query(
    `UPDATE cloud_workspaces
     SET current_billing_epoch = $2, version = version + 1, updated_at = now()
     WHERE id = $1 AND org_id = $3`,
    [input.workspaceId, nextEpoch, input.organizationId],
  );
  await audit(
    tx,
    input.organizationId,
    input.authorization.actorUserId,
    "cloud_workspace.billing_epoch_rebound",
    {
      workspaceId: input.workspaceId,
      previousBillingEpoch: currentEpoch,
      billingEpoch: nextEpoch,
      billingOwnerUserId: input.authorization.billingOwnerUserId,
      entitlementScope: input.authorization.entitlementScope,
      entitlementPlan: input.authorization.plan,
      entitlementRevision: input.authorization.entitlementRevision,
    },
  );
  return { billingEpoch: nextEpoch, changed: true };
}

async function nextCheckAt(
  tx: Tx,
  authorization: CloudWorkspaceAuthorization,
  recheckIntervalMs: number,
  workspaceId: string,
  generation: number,
): Promise<Date> {
  const result = authorization.isPersonal
    ? await tx.query<{ next_check_at: Date }>(
        `SELECT least(
           now() + ($2::bigint * interval '1 millisecond'),
           coalesce(entitlement.valid_until,
             now() + ($2::bigint * interval '1 millisecond'))
         ) AS next_check_at
         FROM account_entitlements entitlement
         WHERE entitlement.user_id = $1`,
        [authorization.billingOwnerUserId, recheckIntervalMs],
      )
    : await tx.query<{ next_check_at: Date }>(
        `SELECT least(
           now() + ($3::bigint * interval '1 millisecond'),
           coalesce(min(expiry.valid_until),
             now() + ($3::bigint * interval '1 millisecond'))
         ) AS next_check_at
         FROM (
           SELECT entitlement.valid_until
           FROM organization_entitlements entitlement
           WHERE entitlement.org_id = $1
           UNION ALL
           SELECT account_entitlement.valid_until
           FROM organization_members membership
           JOIN account_entitlements account_entitlement
             ON account_entitlement.user_id = membership.user_id
           WHERE membership.org_id = $1 AND $2::text = 'pro'
         ) expiry`,
        [authorization.organizationId, authorization.plan, recheckIntervalMs],
      );
  const next = result.rows[0]?.next_check_at;
  if (!(next instanceof Date) || !Number.isFinite(next.getTime())) {
    throw new Error("Cloud workspace paid-authority deadline is invalid");
  }
  const provider = (
    await tx.query<{ next_check_at: Date }>(
      `SELECT CASE
         WHEN version.credential_source = 'delegated'
          AND version.credential_expires_at IS NOT NULL
         THEN greatest(
           now(),
           version.credential_expires_at - interval '5 minutes'
         )
         ELSE now() + ($3::bigint * interval '1 millisecond')
       END AS next_check_at
       FROM cloud_workspace_generations generation
       JOIN provider_connection_versions version
         ON version.connection_id = generation.provider_connection_id
        AND version.org_id = generation.org_id
        AND version.version = generation.provider_connection_version
       WHERE generation.workspace_id = $1 AND generation.generation = $2`,
      [workspaceId, generation, recheckIntervalMs],
    )
  ).rows[0]?.next_check_at;
  if (!(provider instanceof Date) || !Number.isFinite(provider.getTime())) {
    throw new Error("Cloud workspace provider-authority deadline is invalid");
  }
  return provider.getTime() < next.getTime() ? provider : next;
}

async function scheduleExecutionAuthorityStop(
  tx: Tx,
  workspace: PaidAuthorityWorkspace,
  denialCode: string,
  authorityLoss: ExecutionAuthorityLoss,
): Promise<void> {
  if (workspace.desired_state !== "running" || workspace.status === "deleted") {
    return;
  }
  await cancelCloudWorkspaceGenerationTransition(tx, {
    workspaceId: workspace.id,
    organizationId: workspace.org_id,
    reason: authorityLoss,
  });
  const current = (
    await tx.query<{
      current_generation: number;
      authority_epoch: string | number;
    }>(
      `SELECT current_generation, authority_epoch
       FROM cloud_workspaces
       WHERE id = $1 AND org_id = $2
       FOR UPDATE`,
      [workspace.id, workspace.org_id],
    )
  ).rows[0];
  if (!current) return;
  const nextAuthorityEpoch =
    safePositiveInteger(current.authority_epoch, "authority epoch") + 1;

  await retireCloudWorkspaceRuntimeAccess(tx, {
    workspaceId: workspace.id,
    organizationId: workspace.org_id,
    reason: authorityLoss,
  });
  const errorMessage =
    authorityLoss === "paid_authority_revoked"
      ? "Paid cloud workspace authority was revoked"
      : "Cloud provider credential authority was revoked";
  await tx.query(
    `UPDATE cloud_workspace_lifecycle_intents
     SET state = 'superseded', completed_at = now(), updated_at = now(),
         lease_owner = NULL, lease_expires_at = NULL,
         error_code = $3,
         error_message = $4
     WHERE workspace_id = $1 AND org_id = $2
       AND operation <> 'delete'
       AND state IN ('queued', 'observing')`,
    [workspace.id, workspace.org_id, authorityLoss, errorMessage],
  );
  await tx.query(
    `UPDATE workspace_checkpoint_requests
     SET state = 'cancelled', completed_at = now(),
         error_code = $3
     WHERE workspace_id = $1 AND org_id = $2
       AND state IN ('queued', 'delivered')`,
    [workspace.id, workspace.org_id, authorityLoss],
  );
  await tx.query(
    `INSERT INTO cloud_workspace_provider_bindings (
       workspace_id, generation, org_id, provider
     )
     SELECT generation.workspace_id, generation.generation,
            generation.org_id, generation.provider
     FROM cloud_workspace_generations generation
     WHERE generation.workspace_id = $1 AND generation.org_id = $2
     ON CONFLICT (workspace_id, generation) DO NOTHING`,
    [workspace.id, workspace.org_id],
  );
  await tx.query(
    `INSERT INTO cloud_workspace_lifecycle_intents (
       id, workspace_id, generation, org_id, requested_by, operation,
       idempotency_key, request_sha256, affects_workspace
     )
     SELECT gen_random_uuid(), generation.workspace_id, generation.generation,
            generation.org_id, NULL, 'stop'::cloud_workspace_operation,
            'system:' || $5::text || '-stop:' ||
              generation.workspace_id::text || ':e' ||
              $3::bigint::text || ':g' || generation.generation::text,
            digest(
              $5::text || ':' || generation.workspace_id::text ||
              ':' || $3::bigint::text || ':' || generation.generation::text,
              'sha256'
            ),
            generation.generation = $4
     FROM cloud_workspace_generations generation
     WHERE generation.workspace_id = $1 AND generation.org_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM cloud_workspace_lifecycle_intents active
         WHERE active.workspace_id = generation.workspace_id
           AND active.org_id = generation.org_id
           AND active.generation = generation.generation
           AND active.operation IN ('stop', 'delete')
           AND active.state IN ('queued', 'dispatching', 'observing')
       )`,
    [
      workspace.id,
      workspace.org_id,
      nextAuthorityEpoch,
      current.current_generation,
      authorityLoss,
    ],
  );
  await tx.query(
    `UPDATE cloud_workspaces
     SET desired_state = 'stopped', status = 'stopping',
         authority_epoch = $3, version = version + 1, updated_at = now(),
         last_error_code = $4,
         last_error_message = $5
     WHERE id = $1 AND org_id = $2 AND desired_state = 'running'`,
    [
      workspace.id,
      workspace.org_id,
      nextAuthorityEpoch,
      authorityLoss,
      errorMessage,
    ],
  );
  await audit(
    tx,
    workspace.org_id,
    null,
    `cloud_workspace.${authorityLoss}`,
    {
      workspaceId: workspace.id,
      denialCode,
      authorityEpoch: nextAuthorityEpoch,
      finalCheckpointSkipped: true,
    },
  );
}

/**
 * Claims one durable authority check. Runtime credentials already fail closed;
 * this controller is responsible for provider-cost convergence and seamless
 * billing-epoch rollover when the new entitlement is still eligible.
 */
export class DatabaseCloudWorkspacePaidAuthorityReconciler {
  private readonly workosEnabled: boolean;
  private readonly recheckIntervalMs: number;

  constructor(
    private readonly pool: pg.Pool,
    options: { workosEnabled: boolean; recheckIntervalMs?: number },
  ) {
    this.workosEnabled = options.workosEnabled;
    this.recheckIntervalMs = options.recheckIntervalMs ?? 5 * 60_000;
    if (
      !Number.isSafeInteger(this.recheckIntervalMs) ||
      this.recheckIntervalMs < 1_000 ||
      this.recheckIntervalMs > 60 * 60_000
    ) {
      throw new Error("Cloud workspace paid-authority interval is invalid");
    }
  }

  async runOnce(): Promise<CloudWorkspacePaidAuthorityReconcileResult | null> {
    return withSystemTx(this.pool, async (tx) => {
      const candidate = (
        await tx.query<{ workspace_id: string; org_id: string; reason: string }>(
          `SELECT authority.workspace_id, authority.org_id, authority.reason
           FROM cloud_workspace_paid_authority_checks authority
           WHERE authority.next_check_at <= now()
           ORDER BY authority.next_check_at, authority.workspace_id
           LIMIT 1`,
        )
      ).rows[0];
      if (!candidate) return null;

      // Public routes acquire organization -> workspace -> child rows. Do not
      // claim the queue first: a route's workspace trigger also touches that
      // row and would otherwise create a queue -> organization wait cycle.
      await tx.query(`SELECT id FROM organizations WHERE id = $1 FOR UPDATE`, [
        candidate.org_id,
      ]);
      const workspace = (
        await tx.query<PaidAuthorityWorkspace>(
          `SELECT id, org_id, team_id, owner_user_id, desired_state,
                  status, current_generation, authority_epoch
           FROM cloud_workspaces
           WHERE id = $1 AND org_id = $2
           FOR UPDATE`,
          [candidate.workspace_id, candidate.org_id],
        )
      ).rows[0];
      const authorityCheck = (
        await tx.query<{ reason: string }>(
          `SELECT reason
           FROM cloud_workspace_paid_authority_checks
           WHERE workspace_id = $1 AND org_id = $2
             AND next_check_at <= now()
           FOR UPDATE`,
          [candidate.workspace_id, candidate.org_id],
        )
      ).rows[0];
      if (!authorityCheck) return null;
      if (!workspace) {
        await tx.query(
          `DELETE FROM cloud_workspace_paid_authority_checks
           WHERE workspace_id = $1`,
          [candidate.workspace_id],
        );
        return null;
      }
      if (workspace.desired_state !== "running" || workspace.status === "deleted") {
        await tx.query(
          `UPDATE cloud_workspace_paid_authority_checks
           SET next_check_at = NULL, last_checked_at = now(), updated_at = now()
           WHERE workspace_id = $1`,
          [workspace.id],
        );
        return {
          workspaceId: workspace.id,
          action: "inactive",
          reason: authorityCheck.reason,
        };
      }

      if (
        !(await providerAuthorityLive(
          tx,
          workspace.id,
          workspace.current_generation,
          PROVIDER_CLEANUP_MARGIN_SECONDS,
        ))
      ) {
        await scheduleExecutionAuthorityStop(
          tx,
          workspace,
          "provider_credential_expired_or_unavailable",
          "provider_authority_revoked",
        );
        await tx.query(
          `UPDATE cloud_workspace_paid_authority_checks
           SET next_check_at = NULL, last_checked_at = now(), updated_at = now()
           WHERE workspace_id = $1`,
          [workspace.id],
        );
        return {
          workspaceId: workspace.id,
          action: "stopped",
          reason: "provider_authority_revoked",
        };
      }

      if (
        await paidAuthorityLive(
          tx,
          workspace.id,
          workspace.owner_user_id,
          this.workosEnabled,
        )
      ) {
        const authorization = await authorizeCloudWorkspaceOperation(tx, {
          organizationId: workspace.org_id,
          teamId: workspace.team_id,
          actorUserId: workspace.owner_user_id,
          billingOwnerUserId: workspace.owner_user_id,
          workosEnabled: this.workosEnabled,
          requireWorkspaceOwner: true,
        });
        await tx.query(
          `UPDATE cloud_workspace_paid_authority_checks
           SET next_check_at = $2, last_checked_at = now(), updated_at = now()
           WHERE workspace_id = $1`,
          [
            workspace.id,
            await nextCheckAt(
              tx,
              authorization,
              this.recheckIntervalMs,
              workspace.id,
              workspace.current_generation,
            ),
          ],
        );
        return {
          workspaceId: workspace.id,
          action: "unchanged",
          reason: authorityCheck.reason,
        };
      }

      let authorization: CloudWorkspaceAuthorization;
      try {
        authorization = await authorizeCloudWorkspaceOperation(tx, {
          organizationId: workspace.org_id,
          teamId: workspace.team_id,
          actorUserId: workspace.owner_user_id,
          billingOwnerUserId: workspace.owner_user_id,
          workosEnabled: this.workosEnabled,
          requireWorkspaceOwner: true,
        });
      } catch (error) {
        if (!(error instanceof CloudWorkspaceAuthorizationError)) throw error;
        await scheduleExecutionAuthorityStop(
          tx,
          workspace,
          error.code,
          "paid_authority_revoked",
        );
        await tx.query(
          `UPDATE cloud_workspace_paid_authority_checks
           SET next_check_at = NULL, last_checked_at = now(), updated_at = now()
           WHERE workspace_id = $1`,
          [workspace.id],
        );
        return {
          workspaceId: workspace.id,
          action: "stopped",
          reason: "paid_authority_revoked",
        };
      }

      const billing = await refreshCloudWorkspaceBillingEpoch(tx, {
        workspaceId: workspace.id,
        organizationId: workspace.org_id,
        authorization,
      });
      if (
        !(await paidAuthorityLive(
          tx,
          workspace.id,
          workspace.owner_user_id,
          this.workosEnabled,
        ))
      ) {
        // A missing workspace-owner projection or another non-entitlement
        // authority edge cannot be repaired by rotating billing metadata.
        await scheduleExecutionAuthorityStop(
          tx,
          workspace,
          "workspace_authority_invalid",
          "paid_authority_revoked",
        );
        await tx.query(
          `UPDATE cloud_workspace_paid_authority_checks
           SET next_check_at = NULL, last_checked_at = now(), updated_at = now()
           WHERE workspace_id = $1`,
          [workspace.id],
        );
        return {
          workspaceId: workspace.id,
          action: "stopped",
          reason: "paid_authority_revoked",
        };
      }

      await tx.query(
        `UPDATE cloud_workspace_paid_authority_checks
         SET next_check_at = $2, last_checked_at = now(), updated_at = now()
         WHERE workspace_id = $1`,
        [
          workspace.id,
          await nextCheckAt(
            tx,
            authorization,
            this.recheckIntervalMs,
            workspace.id,
            workspace.current_generation,
          ),
        ],
      );
      return {
        workspaceId: workspace.id,
        action: billing.changed ? "billing_rebound" : "unchanged",
        reason: authorityCheck.reason,
      };
    });
  }
}
