import type pg from "pg";

import { withSystemTx } from "../db.js";

export type CloudWorkspaceHealth = {
  enabled: true;
  setupExecution: "enabled" | "paused";
  durability: "enabled" | "disabled";
  outboxDelivery: "enabled" | "retained";
  operationalState: "healthy" | "degraded";
  reasons: string[];
};

type HealthSignals = {
  lifecycle_stalled: boolean;
  setup_lease_expired: boolean;
  engine_lease_expired: boolean;
  access_revocation_stalled: boolean;
  outbox_stalled: boolean;
  deletion_jobs_failed: boolean;
  deletion_provider_stalled: boolean;
  object_rotation_failed: boolean;
  object_deletion_stalled: boolean;
  provider_orphans_stalled: boolean;
  durability_stalled: boolean;
};

/** Aggregate-only health: no workspace, Organization, user, provider, or
 * repository identifiers leave this service. `/healthz` can therefore expose
 * release posture to Railway without becoming a tenant-enumeration surface. */
export class DatabaseCloudWorkspaceHealthService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly posture: {
      setupExecutionEnabled: boolean;
      durabilityEnabled: boolean;
      outboxDeliveryEnabled: boolean;
    },
  ) {}

  async read(): Promise<CloudWorkspaceHealth> {
    const signals = await withSystemTx(this.pool, async (tx) =>
      (
        await tx.query<HealthSignals>(
          `SELECT
             EXISTS (
               SELECT 1 FROM cloud_workspace_lifecycle_intents
               WHERE state IN ('queued', 'observing')
                 AND next_attempt_at <= now() - interval '15 minutes'
                 AND updated_at <= now() - interval '15 minutes'
             ) AS lifecycle_stalled,
             CASE WHEN $3::boolean THEN EXISTS (
               SELECT 1 FROM cloud_workspace_setup_runs
               WHERE state = 'running' AND lease_expires_at <= now()
             ) ELSE false END AS setup_lease_expired,
             CASE WHEN $3::boolean THEN EXISTS (
               SELECT 1 FROM cloud_workspace_engine_instances
               WHERE state = 'ready' AND lease_expires_at <= now()
             ) ELSE false END AS engine_lease_expired,
             EXISTS (
               SELECT 1 FROM cloud_workspace_client_access_grants
               WHERE state = 'failed'
                  OR (state = 'revocation_pending'
                      AND updated_at <= now() - interval '15 minutes')
             ) AS access_revocation_stalled,
             CASE WHEN $1::boolean THEN EXISTS (
               SELECT 1 FROM cloud_workspace_outbox
               WHERE state = 'dead'
                  OR (state IN ('queued', 'processing')
                      AND created_at <= now() - interval '15 minutes')
             ) ELSE false END AS outbox_stalled,
             EXISTS (
               SELECT 1 FROM workspace_deletion_jobs WHERE state = 'failed'
             ) AS deletion_jobs_failed,
             EXISTS (
               SELECT 1 FROM workspace_deletion_jobs
               WHERE state = 'waiting_for_provider'
                 AND created_at <= now() - interval '24 hours'
             ) AS deletion_provider_stalled,
             CASE WHEN $2::boolean THEN EXISTS (
               SELECT 1 FROM workspace_blob_rotation_jobs
               WHERE state = 'failed'
                  OR (
                    state IN ('cleanup_pending', 'target_cleanup_pending')
                    AND (
                      created_at <= now() - interval '15 minutes'
                      OR (error_code IS NOT NULL AND attempt_count >= 3)
                    )
                  )
             ) ELSE false END AS object_rotation_failed,
             CASE WHEN $2::boolean THEN EXISTS (
               SELECT 1 FROM workspace_blob_object_deletions
               WHERE fenced_at IS NULL
                 AND (
                   created_at <= now() - interval '15 minutes'
                   OR (last_error_code IS NOT NULL AND attempt_count >= 3)
                 )
             ) ELSE false END AS object_deletion_stalled,
             EXISTS (
               SELECT 1 FROM cloud_workspace_provider_orphans
               WHERE deletion_verified_at IS NULL
                 AND first_seen_at <= now() - interval '1 hour'
             ) AS provider_orphans_stalled,
             CASE WHEN $2::boolean THEN EXISTS (
               SELECT 1
               FROM cloud_workspaces workspace
               LEFT JOIN workspace_content_heads content
                 ON content.workspace_id = workspace.id
                AND content.org_id = workspace.org_id
               LEFT JOIN workspace_record_heads record
                 ON record.workspace_id = workspace.id
                AND record.org_id = workspace.org_id
               WHERE workspace.status IN ('ready', 'busy')
                 AND workspace.updated_at <= now() - interval '15 minutes'
                 AND (
                   (content.current_revision > content.durable_revision)
                   OR (record.current_revision > 0 AND record.last_durable_at IS NULL)
                 )
             ) ELSE false END AS durability_stalled`,
          [
            this.posture.outboxDeliveryEnabled,
            this.posture.durabilityEnabled,
            this.posture.setupExecutionEnabled,
          ],
        )
      ).rows[0]!,
    );
    const reasons = (Object.entries(signals) as Array<
      [keyof HealthSignals, boolean]
    >)
      .filter(([, active]) => active)
      .map(([reason]) => reason);
    return {
      enabled: true,
      setupExecution: this.posture.setupExecutionEnabled ? "enabled" : "paused",
      durability: this.posture.durabilityEnabled ? "enabled" : "disabled",
      outboxDelivery: this.posture.outboxDeliveryEnabled ? "enabled" : "retained",
      operationalState: reasons.length === 0 ? "healthy" : "degraded",
      reasons,
    };
  }
}
