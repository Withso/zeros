import type pg from "pg";
import { withSystemTx } from "../db.js";
import type { ClaimedJob } from "../job-queue.js";
import { computeLeaseDueAtSql } from "./compute-rechecks.js";

/** Lifecycle due work on the durable job queue (migration 0157). Triggers on
 * every deadline's source table enqueue a job per (kind, workspace) at a lower
 * bound of its due time in the writer's transaction; the handler claims
 * through the existing fenced transaction for that workspace and then
 * reschedules the job at the exact next due time read here. */
export const LIFECYCLE_JOB_KINDS = {
  lifecycle: "cloud_lifecycle_intent",
  finalSave: "cloud_final_save_recovery",
  paidAuthority: "cloud_paid_authority_check",
  engineHealth: "cloud_engine_health",
  compute: "cloud_compute_lease",
  drift: "cloud_workspace_drift",
  diagnostics: "cloud_diagnostic_cleanup",
} as const;
export type LifecycleWork = keyof typeof LIFECYCLE_JOB_KINDS;
export type LifecycleJobKind = (typeof LIFECYCLE_JOB_KINDS)[LifecycleWork];

const WORK_BY_KIND = new Map(Object.entries(LIFECYCLE_JOB_KINDS).map(([work, kind]) => [kind, work as LifecycleWork]));
export function lifecycleWorkForJob(kind: string): LifecycleWork | null { return WORK_BY_KIND.get(kind as LifecycleJobKind) ?? null; }

// Each branch yields (workspace_id, org_id, due_at) for one kind, with the
// same eligibility as that kind's claim. $scope limits it to one workspace
// (null: all), $provider filters by provider (null: all), and $drift/$stopped
// are the running and settled-stopped drift intervals in ms.
const DUE: Record<LifecycleWork, string> = {
  finalSave: `SELECT workspace_id,org_id,next_attempt_at AS due_at FROM cloud_workspace_final_save_recoveries
    WHERE ($scope::uuid IS NULL OR workspace_id=$scope) AND state NOT IN ('proven','resolved')`,
  lifecycle: `
    SELECT i.workspace_id, i.org_id, greatest(i.next_attempt_at,
      CASE WHEN i.state='dispatching' THEN i.lease_expires_at END,
      (SELECT max(active.lease_expires_at) FROM cloud_workspace_lifecycle_intents active
        WHERE active.workspace_id=i.workspace_id AND active.id<>i.id AND active.state='dispatching')) AS due_at
    FROM cloud_workspace_lifecycle_intents i
    JOIN cloud_workspaces cw ON cw.id=i.workspace_id
    JOIN cloud_workspace_generations g ON g.workspace_id=i.workspace_id AND g.generation=i.generation AND g.org_id=i.org_id
    JOIN cloud_workspace_provider_bindings pb ON pb.workspace_id=g.workspace_id AND pb.generation=g.generation
    LEFT JOIN workspace_checkpoint_requests request ON request.lifecycle_intent_id=i.id
    WHERE ($scope::uuid IS NULL OR i.workspace_id=$scope)
      AND i.state IN ('queued','observing','dispatching') AND (i.state<>'dispatching' OR i.lease_expires_at IS NOT NULL)
      AND (i.resume_after_intent_id IS NULL OR EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents prerequisite
        WHERE prerequisite.id=i.resume_after_intent_id AND prerequisite.state='succeeded'))
      AND (i.operation NOT IN ('stop','archive','delete') OR cloud_final_save_proven(i.id)
        OR NOT EXISTS (SELECT 1 FROM cloud_workspace_final_save_recoveries recovery WHERE recovery.lifecycle_intent_id=i.id))
      AND (i.operation<>'create' OR NOT EXISTS (SELECT 1 FROM workspace_fork_intents fork
        WHERE fork.target_cloud_workspace_id=i.workspace_id AND fork.org_id=i.org_id AND fork.operation='local_to_cloud' AND fork.state<>'succeeded'))`,
  paidAuthority: `
    SELECT workspace_id, org_id, next_check_at AS due_at FROM cloud_workspace_paid_authority_checks
    WHERE ($scope::uuid IS NULL OR workspace_id=$scope)`,
  engineHealth: `
    SELECT workspace.id AS workspace_id, workspace.org_id, least(
      CASE WHEN NOT EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents intent
        WHERE intent.workspace_id=workspace.id AND intent.org_id=workspace.org_id
          AND (intent.generation=workspace.current_generation OR intent.affects_workspace)
          AND intent.state IN ('queued','dispatching','observing'))
        THEN coalesce((SELECT max(engine.lease_expires_at) FROM cloud_workspace_engine_instances engine
          WHERE engine.workspace_id=workspace.id AND engine.org_id=workspace.org_id AND engine.generation=workspace.current_generation
            AND engine.state='ready' AND engine.revoked_at IS NULL),now()) END,
      (SELECT min(engine.interactive_ready_until) FROM cloud_workspace_engine_instances engine
        WHERE engine.workspace_id=workspace.id AND engine.org_id=workspace.org_id AND engine.generation=workspace.current_generation
          AND engine.coordinator_version=1)) AS due_at
    FROM cloud_workspaces workspace JOIN cloud_workspace_generations generation
      ON generation.workspace_id=workspace.id AND generation.org_id=workspace.org_id AND generation.generation=workspace.current_generation
    WHERE ($scope::uuid IS NULL OR workspace.id=$scope) AND ($provider::text IS NULL OR generation.provider=$provider) AND workspace.desired_state='running'
      AND workspace.status IN ('ready','busy') AND workspace.deleted_at IS NULL`,
  compute: `
    SELECT lease.workspace_id, lease.org_id, greatest(${computeLeaseDueAtSql},
      CASE WHEN lease.lease_owner IS NOT NULL THEN lease.lease_expires_at END,
      (SELECT max(CASE WHEN runtime.phase IN ('activated','enrolling','checking') THEN runtime.activation_deadline_at ELSE runtime.rollback_deadline_at END)
        FROM cloud_workspace_runtime_transitions runtime WHERE runtime.workspace_id=lease.workspace_id
          AND ((runtime.phase IN ('activated','enrolling','checking') AND runtime.activation_deadline_at>now())
            OR (runtime.phase IN ('rolling_back','rollback_enrolling','rollback_checking') AND runtime.rollback_deadline_at>now())))) AS due_at
    FROM managed_compute_allocation_leases lease WHERE ($scope::uuid IS NULL OR lease.workspace_id=$scope) AND lease.state<>'settled'`,
  drift: `
    SELECT cw.id AS workspace_id, cw.org_id, greatest(pb.next_drift_check_at,pb.drift_paced_until,pb.last_observed_at+
      (CASE WHEN (cw.desired_state='stopped' AND cw.status='stopped') OR (cw.desired_state='archived' AND cw.status='archived')
        THEN $stopped::bigint ELSE $drift::bigint END)*interval '1 millisecond') AS due_at
    FROM cloud_workspaces cw JOIN cloud_workspace_provider_bindings pb ON pb.workspace_id=cw.id AND pb.generation=cw.current_generation
    WHERE ($scope::uuid IS NULL OR cw.id=$scope) AND cw.status<>'deleted' AND ($provider::text IS NULL OR pb.provider=$provider)
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_restore_incidents incident WHERE incident.workspace_id=cw.id
        AND incident.source_generation=cw.current_generation AND incident.state IN ('queued','waiting_for_capacity','waiting_for_funding','restoring','recovery_needed'))
      AND NOT EXISTS (SELECT 1 FROM cloud_workspace_lifecycle_intents i WHERE i.workspace_id=cw.id
        AND (i.generation=cw.current_generation OR i.affects_workspace) AND i.state IN ('queued','dispatching','observing'))`,
  // A singleton: the hourly retention pass, or now while recovery
  // publications are pending.
  diagnostics: `
    SELECT NULL::uuid AS workspace_id, NULL::uuid AS org_id, next_run_at AS due_at
    FROM cloud_workspace_diagnostic_cleanup WHERE id
    UNION ALL (SELECT NULL::uuid, NULL::uuid, now() FROM cloud_workspace_diagnostic_incidents incident
      JOIN cloud_workspaces workspace ON workspace.id=incident.workspace_id AND workspace.org_id=incident.org_id
      WHERE incident.recovered_at IS NULL AND incident.last_at<=workspace.diagnostic_recovery_at
        AND incident.generation<=workspace.diagnostic_recovery_generation LIMIT 1)`,
};

type DueParameters = { scope: string | null; provider: string | null; drift: number; stopped: number };

/** Default drift cadence for workspaces settled stopped or archived: a few
 * hours instead of every minute. Running and transitional workspaces keep
 * the reconciler interval. */
export const DEFAULT_STOPPED_DRIFT_INTERVAL_MS = 6 * 60 * 60_000;

/** Bind one kind's due query after `leading` caller parameters, passing only
 * the named parameters it uses: PostgreSQL rejects an unreferenced one. */
function dueQuery(work: LifecycleWork, values: DueParameters, leading: readonly unknown[]): { text: string; values: unknown[] } {
  const bound = [...leading];
  const positions = new Map<keyof DueParameters, number>();
  const text = DUE[work].replace(/\$(scope|provider|drift|stopped)\b/g, (_match, name: keyof DueParameters) => {
    if (!positions.has(name)) { bound.push(values[name]); positions.set(name, bound.length); }
    return `$${positions.get(name)}`;
  });
  return { text, values: bound };
}

export type LifecycleDueScope = { provider: string | null; driftIntervalMs: number; stoppedDriftIntervalMs?: number };

function dueParameters(scope: LifecycleDueScope, workspaceId: string | null): DueParameters {
  return { scope: workspaceId, provider: scope.provider, drift: scope.driftIntervalMs,
    stopped: scope.stoppedDriftIntervalMs ?? DEFAULT_STOPPED_DRIFT_INTERVAL_MS };
}

/** The exact next due time of one kind for one workspace (or the diagnostics
 * singleton), in milliseconds from now; null when nothing is pending. */
export async function readLifecycleDueInMs(
  pool: pg.Pool, work: LifecycleWork, workspaceId: string | null, scope: LifecycleDueScope,
): Promise<number | null> {
  const due = dueQuery(work, dueParameters(scope, workspaceId), []);
  return withSystemTx(pool, async tx => {
    const row = (await tx.query<{ delay_ms: string | null }>(
      `SELECT extract(epoch FROM (min(due_at)-now()))*1000 AS delay_ms FROM (${due.text}) work WHERE due_at IS NOT NULL`,
      due.values)).rows[0];
    return row?.delay_ms === null || row?.delay_ms === undefined ? null : Number(row.delay_ms);
  });
}

/** Floor for the next run when work is due but this run claimed nothing (its
 * row was locked elsewhere): 1 s doubling to 1 min, so a mismatch between a
 * due time and its claim cannot spin. A domain write resets the streak. */
export function emptyRunDelayMs(previousEmptyRuns: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(16, Math.max(0, previousEmptyRuns)));
}

export function lifecycleJobEmptyRuns(job: Pick<ClaimedJob, "payload">): number {
  const value = job.payload.emptyRuns;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? Math.min(value, 1_000) : 0;
}

/** Reschedule a running lifecycle job at its exact next due time in one
 * statement. While the job runs, the enqueue records a rerun that completion
 * turns into the next run; nothing is enqueued when no work is pending. */
export async function rescheduleLifecycleJob(
  pool: pg.Pool, work: LifecycleWork, job: Pick<ClaimedJob, "workspaceId" | "orgId" | "payload">,
  scope: LifecycleDueScope & { processed: boolean },
): Promise<void> {
  const workspaceId = work === "diagnostics" ? null : job.workspaceId;
  const emptyRuns = lifecycleJobEmptyRuns(job);
  const due = dueQuery(work, dueParameters(scope, workspaceId), [
    LIFECYCLE_JOB_KINDS[work], workspaceId === null ? "singleton" : `workspace:${workspaceId}`,
    workspaceId, workspaceId === null ? null : job.orgId, scope.processed, emptyRuns, emptyRunDelayMs(emptyRuns),
  ]);
  await withSystemTx(pool, tx => tx.query(`
    INSERT INTO control_plane_jobs AS job (kind, dedupe_key, workspace_id, org_id, payload, run_at)
    SELECT $1, $2, $3::uuid, $4::uuid,
      CASE WHEN min(due_at) <= now() AND NOT $5::boolean THEN jsonb_build_object('emptyRuns', $6::integer + 1) ELSE '{}'::jsonb END,
      CASE WHEN min(due_at) > now() THEN min(due_at) WHEN $5::boolean THEN now()
        ELSE now() + $7::bigint * interval '1 millisecond' END
    FROM (${due.text}) work WHERE due_at IS NOT NULL HAVING min(due_at) IS NOT NULL
    ON CONFLICT (kind, dedupe_key) WHERE state IN ('queued','running') DO UPDATE SET
      payload = EXCLUDED.payload,
      run_at = CASE WHEN job.state = 'queued' THEN least(job.run_at, EXCLUDED.run_at) ELSE job.run_at END,
      rerun_at = CASE WHEN job.state = 'running' THEN least(job.rerun_at, EXCLUDED.run_at) END,
      updated_at = clock_timestamp()
    WHERE job.payload IS DISTINCT FROM EXCLUDED.payload
      OR (job.state = 'queued' AND EXCLUDED.run_at < job.run_at)
      OR (job.state = 'running' AND (job.rerun_at IS NULL OR EXCLUDED.run_at < job.rerun_at))`, due.values));
}

/** Safety net for a lost enqueue: give every pending deadline a queued job at
 * or before its due time. Returns the jobs created or moved earlier per kind;
 * under correct operation there are none. A running job is left alone: its
 * handler reschedules it when it finishes. */
export async function auditLifecycleJobs(pool: pg.Pool, scope: LifecycleDueScope): Promise<Partial<Record<LifecycleWork, number>>> {
  const repaired: Partial<Record<LifecycleWork, number>> = {};
  for (const work of Object.keys(DUE) as LifecycleWork[]) {
    const due = dueQuery(work, dueParameters(scope, null), [LIFECYCLE_JOB_KINDS[work]]);
    const count = await withSystemTx(pool, async tx => (await tx.query(`
      INSERT INTO control_plane_jobs AS job (kind, dedupe_key, org_id, workspace_id, run_at)
      SELECT $1, coalesce('workspace:' || workspace_id::text, 'singleton'), org_id, workspace_id, min(due_at)
      FROM (${due.text}) work WHERE due_at IS NOT NULL GROUP BY workspace_id, org_id
      ON CONFLICT (kind, dedupe_key) WHERE state IN ('queued','running') DO UPDATE SET
        run_at = EXCLUDED.run_at, updated_at = clock_timestamp()
      WHERE job.state = 'queued' AND EXCLUDED.run_at < job.run_at`, due.values)).rowCount ?? 0);
    if (count) repaired[work] = count;
  }
  return repaired;
}
