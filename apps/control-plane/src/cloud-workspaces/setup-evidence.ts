import type { Tx } from "../db.js";
import { cloudDiagnosticSchema } from "./cloud-diagnostics.js";
import { parseSetupTimings } from "./setup-timings.js";
import { parseSetupObservations, setupReuseDecisions } from "./setup-observations.js";
import { setupClaimSchema, setupEvidenceSchema, setupFailureSchema, setupErrorCodes, type SetupClaim, type SetupEvidence } from "./setup-evidence-schema.js";

const actions = ["cloud_workspace.setup_claimed", "cloud_workspace.setup_reclaimed", "cloud_workspace.setup_materials_redeemed",
  "cloud_workspace.setup_preparation_changed", "cloud_workspace.setup_succeeded", "cloud_workspace.setup_claim_failed", "cloud_workspace.setup_publish_rejected"];
const timestamp = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Call only after the ordinary workspace read authorization, in its transaction.
 * The status row's exact run/fence is rechecked before reading any telemetry.
 * No audit or engine history scan is added to catalog or ordinary status reads.
 */
export async function readCloudWorkspaceSetupEvidence(tx: Tx, scope: {
  organizationId: string; workspaceId: string; generation: number; setupRunId: string; executionFence: number;
}): Promise<SetupEvidence | null> {
  const run = (await tx.query<{
    id: string; attempt: number; claim_count: number; execution_fence: string; state: SetupEvidence["state"];
    created_at: Date; started_at: Date | null; completed_at: Date | null; stage_timings: unknown; runtime_id: string | null;
  }>(`SELECT run.id,run.attempt,run.claim_count,run.execution_fence,run.state,
      run.created_at,run.started_at,run.completed_at,run.stage_timings,g.runtime_id
    FROM cloud_workspace_setup_runs run
    JOIN cloud_workspaces w ON w.id=run.workspace_id AND w.org_id=run.org_id AND w.current_generation=run.generation
    JOIN cloud_workspace_generations g ON g.workspace_id=run.workspace_id AND g.org_id=run.org_id AND g.generation=run.generation
    WHERE run.id=$1 AND run.org_id=$2 AND run.workspace_id=$3 AND run.generation=$4 AND run.execution_fence=$5`,
  [scope.setupRunId, scope.organizationId, scope.workspaceId, scope.generation, scope.executionFence])).rows[0];
  if (!run) return null;
  // Recent claims plus the first failure: even a long retry history cannot
  // evict the original failure. The org/time index bounds the audit search.
  const receipts = (await tx.query<{ id: string; action: string; subject: Record<string, unknown>; created_at: Date }>(`
    WITH scoped AS NOT MATERIALIZED (
      SELECT id,action,subject,created_at FROM audit_log
      WHERE org_id=$1 AND created_at >= $5 AND subject->>'setupRunId'=$2
        AND subject->>'workspaceId'=$3 AND subject->>'generation'=$4 AND action=ANY($6::text[])
    ), recent AS (SELECT * FROM scoped ORDER BY created_at DESC,id DESC LIMIT 41),
    first_failure AS (SELECT * FROM scoped WHERE action='cloud_workspace.setup_claim_failed' ORDER BY created_at,id LIMIT 1)
    SELECT * FROM (SELECT * FROM recent UNION SELECT * FROM first_failure) receipts ORDER BY created_at,id`,
  [scope.organizationId, scope.setupRunId, scope.workspaceId, String(scope.generation), run.created_at, actions])).rows;
  const claims = new Map<number, SetupClaim>();
  const claim = (fence: number, count: number): SetupClaim => {
    let value = claims.get(fence);
    if (!value) {
      value = { executionFence: fence, claimCount: count, outcome: "started", startedAt: null, completedAt: null };
      claims.set(fence, value);
    }
    return value;
  };
  for (const receipt of receipts) {
    const subject = receipt.subject, fence = subject.executionFence, count = subject.claimCount;
    // Material redemption predates claim-count telemetry; its exact fence is
    // sufficient to enrich an already observed claim, never create authority.
    if (!positive(fence) || fence > scope.executionFence) continue;
    const value = positive(count) && count <= run.claim_count ? claim(fence, count) : claims.get(fence);
    if (!value) continue;
    const at = timestamp(receipt.created_at);
    if (receipt.action === "cloud_workspace.setup_claimed" || receipt.action === "cloud_workspace.setup_reclaimed") value.startedAt ??= at;
    if (setupReuseDecisions.includes(subject.reuseDecision as typeof setupReuseDecisions[number]))
      value.reuseDecision = subject.reuseDecision as typeof setupReuseDecisions[number];
    const timings = parseSetupTimings(subject.timings), observations = parseSetupObservations(subject.observations);
    // Keep the first terminal failure of a fence when later cleanup also fails.
    if (value.failure) continue;
    if (timings) value.timings = timings;
    if (observations) value.observations = observations;
    if (receipt.action === "cloud_workspace.setup_succeeded") { value.outcome = "succeeded"; value.completedAt = at; }
    if (receipt.action === "cloud_workspace.setup_claim_failed" || receipt.action === "cloud_workspace.setup_publish_rejected") {
      value.outcome = receipt.action === "cloud_workspace.setup_claim_failed" ? "failed" : "cancelled";
      value.completedAt = at;
      const diagnostic = cloudDiagnosticSchema.safeParse(subject.diagnostic);
      const failure = setupFailureSchema.safeParse(diagnostic.success ? {
        phase: diagnostic.data.phase, code: setupErrorCodes.includes(diagnostic.data.code as typeof setupErrorCodes[number]) ? diagnostic.data.code : "unknown", retryable: diagnostic.data.retryable,
        ...(diagnostic.data.setup?.engineStartup ? { engineStartup: diagnostic.data.setup.engineStartup } : {}),
      } : subject.failure);
      if (failure.success) value.failure = failure.data;
    }
  }
  if (scope.executionFence > 0 && run.claim_count > 0) {
    const current = claim(scope.executionFence, run.claim_count);
    const timings = parseSetupTimings(run.stage_timings);
    if (timings && !current.timings) current.timings = timings;
    if (run.state === "succeeded" || run.state === "failed" || run.state === "cancelled") {
      current.outcome = run.state; current.completedAt ??= timestamp(run.completed_at);
    }
  }
  const all = [...claims.values()].sort((a, b) => a.executionFence - b.executionFence);
  const firstFailure = all.find(value => value.outcome === "failed"), latest = all.slice(-5);
  if (all.length > 5 && firstFailure && !latest.includes(firstFailure)) { latest.shift(); latest.unshift(firstFailure); }
  const engines = latest.length ? (await tx.query<{ id: string; setup_execution_fence: string; created_at: Date; registered_at: Date | null }>(`
    SELECT DISTINCT ON (setup_execution_fence) id,setup_execution_fence,created_at,registered_at
    FROM cloud_workspace_engine_instances WHERE org_id=$1 AND workspace_id=$2 AND generation=$3 AND setup_run_id=$4
      AND setup_execution_fence=ANY($5::bigint[]) ORDER BY setup_execution_fence,created_at DESC,id DESC LIMIT 5`,
  [scope.organizationId, scope.workspaceId, scope.generation, scope.setupRunId, latest.map(value => value.executionFence)])).rows : [];
  for (const engine of engines) {
    const value = claims.get(Number(engine.setup_execution_fence));
    if (value) value.engine = { id: engine.id, createdAt: timestamp(engine.created_at)!, registeredAt: timestamp(engine.registered_at) };
  }
  const result = setupEvidenceSchema.safeParse({ version: 1, workspaceId: scope.workspaceId, generation: scope.generation,
    setupRunId: run.id, attempt: run.attempt, claimCount: run.claim_count, executionFence: scope.executionFence, state: run.state,
    runtimeId: run.runtime_id, createdAt: timestamp(run.created_at), startedAt: timestamp(run.started_at), completedAt: timestamp(run.completed_at),
    claims: latest.filter(value => setupClaimSchema.safeParse(value).success), truncated: all.length > 5 || all.length < run.claim_count || receipts.length >= 41 });
  return result.success ? result.data : null;
}
