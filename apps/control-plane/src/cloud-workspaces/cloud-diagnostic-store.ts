import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
import { cloudDiagnosticSchema, cloudStopReason, type CloudDiagnostic } from "./cloud-diagnostics.js";

type Scope = { workspaceId: string; organizationId: string; generation: number; operationKind: "compute" | "setup" | "engine"; operationId: string; executionFence?: number; leaseOwner?: string };
const retentionLock = () => "SELECT pg_advisory_xact_lock(837416,114)";
function installerDiagnosticKey(value: CloudDiagnostic): string | null {
  const installer = value.setup?.installer;
  // JSONB reorders object keys. Compare a stable tuple so identical failures
  // coalesce while different installer checks retain separate bounded events.
  return installer ? JSON.stringify([installer.component, installer.stage, installer.ok, installer.exitCode,
    installer.timedOut, [...installer.failedChecks].sort()]) : null;
}
/** Global failure-only serialization bounds aggregate rows/bytes even with many
 * writers. Routine lease renewal never takes this lock. Reserve 64 bytes per
 * row for the later timestamp and int32 recovery generation replacing nulls;
 * recovery can then commit without taking the aggregate retention lock. */
async function enforceCaps(tx: Tx) {
  await tx.query(`DELETE FROM cloud_workspace_diagnostic_incidents WHERE id IN (
    SELECT id FROM (SELECT id,
      row_number() OVER(PARTITION BY workspace_id ORDER BY last_at DESC,id) AS workspace_rank,
      row_number() OVER(PARTITION BY org_id ORDER BY last_at DESC,id) AS org_rank,
      row_number() OVER(ORDER BY last_at DESC,id) AS global_rank,
      sum(octet_length(row_to_json(row)::text)+64) OVER(PARTITION BY org_id ORDER BY last_at DESC,id) AS org_bytes,
      sum(octet_length(row_to_json(row)::text)+64) OVER(ORDER BY last_at DESC,id) AS global_bytes
      FROM cloud_workspace_diagnostic_incidents row) bounded
    WHERE workspace_rank>8 OR org_rank>2048 OR global_rank>16384 OR org_bytes>8388608 OR global_bytes>67108864)`);
}
export async function runCloudDiagnosticCleanup(pool: pg.Pool): Promise<void> {
  await withSystemTx(pool, async tx => {
    await tx.query("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='2s'");
    // Retry publication bookkeeping on every worker pass, even while hourly
    // cleanup is not due. The watermark is committed with ready; later stops
    // and new incidents cannot fabricate or lose that successful publication.
    // Skip contested rows and revisit next pass, with no global retention lock.
    await tx.query(`WITH recovered AS MATERIALIZED (
      SELECT incident.id,workspace.diagnostic_recovery_at AS published_at,workspace.diagnostic_recovery_generation AS generation
      FROM cloud_workspace_diagnostic_incidents incident
      JOIN cloud_workspaces workspace ON workspace.id=incident.workspace_id AND workspace.org_id=incident.org_id
      WHERE incident.recovered_at IS NULL AND incident.last_at<=workspace.diagnostic_recovery_at
        AND incident.generation<=workspace.diagnostic_recovery_generation
      ORDER BY incident.last_at,incident.id LIMIT 256 FOR UPDATE OF incident SKIP LOCKED)
      UPDATE cloud_workspace_diagnostic_incidents incident SET recovered_at=recovered.published_at,recovered_generation=recovered.generation
      FROM recovered WHERE incident.id=recovered.id`);
  });
  // Commit recovery row locks before requesting the retention lock: appenders
  // acquire the retention lock before their incident, so reversing that order
  // within one transaction could deadlock with a concurrent diagnostic append.
  await withSystemTx(pool, async tx => {
    await tx.query("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='2s'");
    const job = await tx.query(`SELECT id FROM cloud_workspace_diagnostic_cleanup WHERE id AND next_run_at<=clock_timestamp() FOR UPDATE SKIP LOCKED`);
    if (!job.rowCount) return;
    await tx.query(retentionLock());
    await tx.query("DELETE FROM cloud_workspace_diagnostic_incidents WHERE last_at<clock_timestamp()-interval '30 days'");
    await tx.query(`UPDATE cloud_workspace_diagnostic_incidents SET
      events=(SELECT coalesce(jsonb_agg(event),'[]'::jsonb) FROM jsonb_array_elements(events) event
        WHERE (event->>'lastAt')::timestamptz>=clock_timestamp()-interval '7 days'),
      first_cause=first_cause-ARRAY['setup','elapsedMs','fundedTtlMs','providerTtlMs','retryCount','decision','claim'],
      terminal_cause=CASE WHEN last_at<clock_timestamp()-interval '7 days'
        THEN terminal_cause-ARRAY['setup','elapsedMs','fundedTtlMs','providerTtlMs','retryCount','decision','claim'] ELSE terminal_cause END
      WHERE first_at<clock_timestamp()-interval '7 days'`);
    await enforceCaps(tx);
    await tx.query("UPDATE cloud_workspace_diagnostic_cleanup SET completed_at=clock_timestamp(),next_run_at=clock_timestamp()+interval '1 hour' WHERE id");
  });
}
/** A stale claim cannot append evidence or rewrite a live incident. A failed
 * insert is diagnostic-only: callers must still execute their safety stop. */
export async function retainCloudDiagnostic(pool: pg.Pool, scope: Scope, value: CloudDiagnostic): Promise<string | null> {
  return withSystemTx(pool, async tx => {
    await tx.query("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='2s'");
    return retainCloudDiagnosticTx(tx, scope, value);
  });
}
export async function retainCloudDiagnosticTx(tx: Tx, scope: Scope, value: CloudDiagnostic): Promise<string | null> {
  const parsed = cloudDiagnosticSchema.safeParse(value);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > 3500) return null;
  const diagnostic = parsed.data;
    // Match lifecycle lock order: organization, workspace, claimed operation.
    await tx.query("SELECT 1 FROM organizations WHERE id=$1 FOR SHARE", [scope.organizationId]);
    const current = await tx.query("SELECT 1 FROM cloud_workspaces WHERE id=$1 AND org_id=$2 AND (current_generation=$3 OR $4='compute') FOR SHARE", [scope.workspaceId, scope.organizationId, scope.generation,scope.operationKind]);
    if (!current.rowCount) return null;
    if (scope.operationKind === "compute") {
      const lease = await tx.query(`SELECT 1 FROM managed_compute_allocation_leases WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4
        AND state<>'settled' AND ($5::text IS NULL OR (lease_owner=$5 AND lease_expires_at>clock_timestamp())) FOR SHARE`,
      [scope.operationId,scope.workspaceId,scope.organizationId,scope.generation,scope.leaseOwner??null]);
      if (!lease.rowCount) return null;
    } else if (scope.operationKind === "setup") {
      const claim = await tx.query(`SELECT 1 FROM cloud_workspace_setup_runs WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4
        AND execution_fence=$5 AND state='running' AND lease_expires_at>clock_timestamp() FOR SHARE`,
      [scope.operationId,scope.workspaceId,scope.organizationId,scope.generation,scope.executionFence??null]);
      if (!claim.rowCount) return null;
    }
    await tx.query(retentionLock());
    const prior = (await tx.query<{ id: string; events: Array<{ diagnostic: CloudDiagnostic; firstAt: string; lastAt: string; count: number }> }>(
      "SELECT id,events FROM cloud_workspace_diagnostic_incidents WHERE workspace_id=$1 AND generation=$2 AND operation_kind=$3 AND operation_id=$4 FOR UPDATE",
      [scope.workspaceId,scope.generation,scope.operationKind,scope.operationId])).rows[0];
    const now = new Date().toISOString();
    const events = prior?.events ?? [];
    const repeated = events.find(event => event.diagnostic.phase === diagnostic.phase && event.diagnostic.code === diagnostic.code && event.diagnostic.sqlState === diagnostic.sqlState &&
      installerDiagnosticKey(event.diagnostic) === installerDiagnosticKey(diagnostic));
    if (repeated) { repeated.lastAt=now; repeated.count=Math.min(Number.MAX_SAFE_INTEGER,repeated.count+1); repeated.diagnostic=diagnostic; }
    else { if (events.length === 16) events.splice(1,1); events.push({ diagnostic, firstAt: now, lastAt: now, count: 1 }); }
    // Freeze the cause that requested a stop; later drain failures remain in
    // events. Its stop timestamp is separate from first_at because the same
    // incident may have begun as a harmless retry before another engine stop.
    const row = (await tx.query<{ id: string }>(`INSERT INTO cloud_workspace_diagnostic_incidents(workspace_id,org_id,generation,operation_kind,operation_id,execution_fence,reason,first_cause,terminal_cause,events,stop_initiated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,CASE WHEN $10 THEN clock_timestamp() END)
      ON CONFLICT(workspace_id,generation,operation_kind,operation_id) DO UPDATE SET last_at=clock_timestamp(),occurrence_count=least(9007199254740991,cloud_workspace_diagnostic_incidents.occurrence_count+1),
        terminal_cause=CASE WHEN cloud_workspace_diagnostic_incidents.stop_initiated_at IS NOT NULL AND cloud_workspace_diagnostic_incidents.recovered_at IS NULL
          THEN cloud_workspace_diagnostic_incidents.terminal_cause ELSE EXCLUDED.terminal_cause END,
        reason=CASE WHEN cloud_workspace_diagnostic_incidents.stop_initiated_at IS NOT NULL AND cloud_workspace_diagnostic_incidents.recovered_at IS NULL
          THEN cloud_workspace_diagnostic_incidents.reason ELSE EXCLUDED.reason END,
        stop_initiated_at=CASE WHEN cloud_workspace_diagnostic_incidents.recovered_at IS NULL
          THEN coalesce(cloud_workspace_diagnostic_incidents.stop_initiated_at,EXCLUDED.stop_initiated_at) ELSE EXCLUDED.stop_initiated_at END,
        events=$9,execution_fence=$6,recovered_at=NULL,recovered_generation=NULL RETURNING id`,
    [scope.workspaceId,scope.organizationId,scope.generation,scope.operationKind,scope.operationId,scope.executionFence??null,cloudStopReason(diagnostic.code).code,JSON.stringify(diagnostic),JSON.stringify(events),
      diagnostic.decision === "checkpoint" || diagnostic.decision === "direct_stop"])).rows[0]!;
    await enforceCaps(tx);
    return row.id;
}
export async function diagnosticStorageFailed(pool: pg.Pool): Promise<void> {
  await withSystemTx(pool, async tx => {
    await tx.query("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='2s'");
    await tx.query("UPDATE cloud_workspace_diagnostic_cleanup SET storage_failures=least(9007199254740991,storage_failures+1) WHERE id");
  }).catch(() => undefined);
}
export async function recoverCloudDiagnostic(pool: pg.Pool, scope: { workspaceId: string; organizationId: string; generation: number;
  setupRunId?: string; executionFence?: number; leaseId?: string; leaseOwner?: string }): Promise<void> {
  await withSystemTx(pool, async tx => {
    await tx.query("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='2s'");
    await tx.query("SELECT 1 FROM organizations WHERE id=$1 FOR SHARE",[scope.organizationId]);
    const current=await tx.query("SELECT 1 FROM cloud_workspaces WHERE id=$1 AND org_id=$2 AND current_generation=$3 AND desired_state='running' AND status IN ('ready','busy') AND deleted_at IS NULL FOR SHARE",
      [scope.workspaceId,scope.organizationId,scope.generation]);
    if(!current.rowCount)return;
    if(scope.setupRunId && !(await tx.query(`SELECT 1 FROM cloud_workspace_setup_runs WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4
      AND execution_fence=$5 AND state='running' AND lease_expires_at>clock_timestamp() FOR SHARE`,
    [scope.setupRunId,scope.workspaceId,scope.organizationId,scope.generation,scope.executionFence??null])).rowCount)return;
    if(scope.leaseId && !(await tx.query(`SELECT 1 FROM managed_compute_allocation_leases WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4
      AND lease_owner=$5 AND lease_expires_at>clock_timestamp() AND state='active' FOR SHARE`,
    [scope.leaseId,scope.workspaceId,scope.organizationId,scope.generation,scope.leaseOwner??null])).rowCount)return;
    await tx.query(`UPDATE cloud_workspace_diagnostic_incidents SET recovered_at=coalesce(recovered_at,clock_timestamp()),recovered_generation=$3
      WHERE workspace_id=$1 AND org_id=$2 AND generation<=$3 AND recovered_at IS NULL`,[scope.workspaceId,scope.organizationId,scope.generation]);
  });
}

/** Roll back only diagnostic storage when the caller already owns a lifecycle
 * transaction. A failed diagnostic must never cancel a required safety stop. */
export async function tryRetainCloudDiagnosticTx(tx: Tx, scope: Scope, value: CloudDiagnostic): Promise<string | null> {
  return tryCloudDiagnosticTx(tx, () => retainCloudDiagnosticTx(tx,scope,value));
}

/** Reuse the cause that initiated this allocation's stop, including a prior
 * engine stop for a workspace already draining. Reads remain best-effort: a
 * diagnostic lock cannot prevent finite-lease enforcement. */
export async function findInitiatingCloudStopTx(tx: Tx, scope: {
  workspaceId: string; organizationId: string; generation: number; leaseId: string; workspaceStopping: boolean;
}): Promise<{ id: string; code: string; stopReason?: "provider_outage" } | null> {
  return tryCloudDiagnosticTx(tx, async () => {
    const row = (await tx.query<{id:string;code:string;stop_reason:string|null}>(`
    SELECT incident.id,incident.terminal_cause->>'code' AS code,incident.terminal_cause->>'stopReason' AS stop_reason
    FROM cloud_workspace_diagnostic_incidents incident
    JOIN cloud_workspaces workspace ON workspace.id=incident.workspace_id AND workspace.org_id=incident.org_id
    WHERE incident.workspace_id=$1 AND incident.org_id=$2 AND incident.generation=$3
      AND incident.stop_initiated_at IS NOT NULL AND incident.recovered_at IS NULL
      AND (workspace.diagnostic_recovery_at IS NULL OR incident.last_at>workspace.diagnostic_recovery_at
        OR incident.generation>workspace.diagnostic_recovery_generation)
      AND ($5 OR (incident.operation_kind='compute' AND incident.operation_id=$4))
    ORDER BY incident.stop_initiated_at,incident.id LIMIT 1`,
  [scope.workspaceId,scope.organizationId,scope.generation,scope.leaseId,scope.workspaceStopping])).rows[0];
    return row ? { id: row.id, code: row.code, ...(row.stop_reason === "provider_outage" ? { stopReason: "provider_outage" as const } : {}) } : null;
  });
}

async function tryCloudDiagnosticTx<T>(tx: Tx, operation: () => Promise<T>): Promise<T | null> {
  await tx.query("SAVEPOINT cloud_diagnostic");
  try {
    const settings = (await tx.query<{lock:string;statement:string}>("SELECT current_setting('lock_timeout') AS lock,current_setting('statement_timeout') AS statement")).rows[0]!;
    await tx.query("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='2s'");
    const result = await operation();
    await tx.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",[settings.lock,settings.statement]);
    await tx.query("RELEASE SAVEPOINT cloud_diagnostic");
    return result;
  } catch {
    await tx.query("ROLLBACK TO SAVEPOINT cloud_diagnostic");
    await tx.query("RELEASE SAVEPOINT cloud_diagnostic");
    return null;
  }
}
