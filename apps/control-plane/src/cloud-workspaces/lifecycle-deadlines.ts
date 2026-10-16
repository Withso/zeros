import type pg from "pg";
import { withSystemTx } from "../db.js";

export type LifecycleWork = "lifecycle" | "paidAuthority" | "engineHealth" | "compute" | "drift" | "diagnostics";

/** Read-only scheduling hints. Keep the health/funding deadlines distinct
 * from inventory polling: a quieter fallback must never extend authority. */
export async function readLifecycleDeadlines(pool: pg.Pool, provider: string | null, driftIntervalMs: number): Promise<Partial<Record<LifecycleWork, number>>> {
  return withSystemTx(pool, async tx => {
    const started = Date.now();
    const result = await tx.query<{ kind: LifecycleWork; delay_ms: string | null }>(`
      SELECT kind,extract(epoch FROM (min(due_at)-now()))*1000 AS delay_ms FROM (
        SELECT 'lifecycle' AS kind,greatest(i.next_attempt_at,
          CASE WHEN i.state='dispatching' THEN i.lease_expires_at END,
          (SELECT max(active.lease_expires_at) FROM cloud_workspace_lifecycle_intents active
            WHERE active.workspace_id=i.workspace_id AND active.id<>i.id AND active.state='dispatching')) AS due_at
        FROM cloud_workspace_lifecycle_intents i
        JOIN cloud_workspaces cw ON cw.id=i.workspace_id
        JOIN cloud_workspace_generations g ON g.workspace_id=i.workspace_id AND g.generation=i.generation AND g.org_id=i.org_id
        JOIN cloud_workspace_provider_bindings pb ON pb.workspace_id=g.workspace_id AND pb.generation=g.generation
        LEFT JOIN workspace_checkpoint_requests request ON request.lifecycle_intent_id=i.id
        WHERE i.state IN ('queued','observing','dispatching') AND (i.state<>'dispatching' OR i.lease_expires_at IS NOT NULL)
          AND (i.resume_after_intent_id IS NULL OR EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents prerequisite
            WHERE prerequisite.id=i.resume_after_intent_id AND prerequisite.state='succeeded'))
          AND (request.id IS NULL OR request.state='succeeded' OR (request.state='cancelled' AND request.error_code='stop_unsealed'))
          AND (i.operation<>'create' OR NOT EXISTS (SELECT 1 FROM workspace_fork_intents fork
            WHERE fork.target_cloud_workspace_id=i.workspace_id AND fork.org_id=i.org_id AND fork.operation='local_to_cloud' AND fork.state<>'succeeded'))
        UNION ALL SELECT 'paidAuthority',next_check_at FROM cloud_workspace_paid_authority_checks
        UNION ALL SELECT 'engineHealth',coalesce((SELECT max(engine.lease_expires_at) FROM cloud_workspace_engine_instances engine
          WHERE engine.workspace_id=workspace.id AND engine.org_id=workspace.org_id AND engine.generation=workspace.current_generation
            AND engine.state='ready' AND engine.revoked_at IS NULL),now())
        FROM cloud_workspaces workspace JOIN cloud_workspace_generations generation
          ON generation.workspace_id=workspace.id AND generation.org_id=workspace.org_id AND generation.generation=workspace.current_generation
        WHERE ($1::text IS NULL OR generation.provider=$1) AND workspace.desired_state='running'
          AND workspace.status IN ('ready','busy') AND workspace.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents intent
            WHERE intent.workspace_id=workspace.id AND intent.org_id=workspace.org_id
              AND (intent.generation=workspace.current_generation OR intent.affects_workspace) AND intent.state IN ('queued','dispatching','observing'))
        UNION ALL SELECT 'compute',greatest(lease.next_check_at,
          CASE WHEN lease.lease_owner IS NOT NULL THEN lease.lease_expires_at END,
          (SELECT max(CASE WHEN runtime.phase IN ('activated','enrolling','checking') THEN runtime.activation_deadline_at ELSE runtime.rollback_deadline_at END)
            FROM cloud_workspace_runtime_transitions runtime WHERE runtime.workspace_id=lease.workspace_id
              AND ((runtime.phase IN ('activated','enrolling','checking') AND runtime.activation_deadline_at>now())
                OR (runtime.phase IN ('rolling_back','rollback_enrolling','rollback_checking') AND runtime.rollback_deadline_at>now()))))
        FROM managed_compute_allocation_leases lease WHERE lease.state<>'settled'
        UNION ALL SELECT 'drift',greatest(pb.next_drift_check_at,pb.last_observed_at+($2::bigint*interval '1 millisecond'))
        FROM cloud_workspaces cw JOIN cloud_workspace_provider_bindings pb ON pb.workspace_id=cw.id AND pb.generation=cw.current_generation
        WHERE cw.status<>'deleted' AND ($1::text IS NULL OR pb.provider=$1)
          AND NOT EXISTS (SELECT 1 FROM cloud_workspace_restore_incidents incident WHERE incident.workspace_id=cw.id
            AND incident.source_generation=cw.current_generation AND incident.state IN ('queued','waiting_for_capacity','waiting_for_funding','restoring','recovery_needed'))
          AND NOT EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents i WHERE i.workspace_id=cw.id
            AND (i.generation=cw.current_generation OR i.affects_workspace) AND i.state IN ('queued','dispatching','observing'))
        UNION ALL SELECT 'diagnostics',next_run_at FROM cloud_workspace_diagnostic_cleanup WHERE id
        UNION ALL SELECT 'diagnostics',now() FROM cloud_workspace_diagnostic_incidents incident
          JOIN cloud_workspaces workspace ON workspace.id=incident.workspace_id AND workspace.org_id=incident.org_id
          WHERE incident.recovered_at IS NULL AND incident.last_at<=workspace.diagnostic_recovery_at
            AND incident.generation<=workspace.diagnostic_recovery_generation
      ) work WHERE due_at IS NOT NULL GROUP BY kind`, [provider, driftIntervalMs]);
    const elapsed = Date.now() - started;
    return Object.fromEntries(result.rows.filter(row => row.delay_ms !== null)
      .map(row => [row.kind, Number(row.delay_ms) - elapsed]));
  }, { consistentRead: true });
}
