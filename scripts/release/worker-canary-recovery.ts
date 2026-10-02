import { z } from "zod";
import { ReleaseCanaryBindingsSchema, NativeCanaryPhysicalCleanupSchema } from "../../apps/control-plane/src/cloud-workspaces/release-canary-contract";
import { requireCheck, type PromotionConfig } from "./contracts";
import { workerOwner } from "./worker-admission";

const terminal = z.object({ version: z.literal(1), operationId: z.string().uuid(), deletionOperationId: z.string().regex(/^bdop_[a-f0-9]{32}$/) }).strict();
type Reconcile = (operationId: string, deletionOperationId: string, leaseToken: string, signal?: AbortSignal) => Promise<void>;

export async function retireReleaseCanary(lease: any, core: any, reconcile: Reconcile, job: any, signal?: AbortSignal) {
  await lease.fence(); await core.retire(job);
  const row = lease.state.resources.images.find((value: any) => value.agentQualificationId === job.id);
  if (!row?.nativeDispatchStarted) return;
  const proof = NativeCanaryPhysicalCleanupSchema.safeParse(row.builder?.physicalCleanup);
  requireCheck(proof.success && row.builder.deleted === true && proof.data.operationId === job.id &&
    proof.data.operation.id === row.builder.deletionOperationId, "Release canary terminal cleanup proof is unconfirmed");
  await lease.save(); await lease.fence();
  await reconcile(job.id, row.builder.deletionOperationId, lease.state.lease.token, signal);
  job.auditRetired = { version: 1, operationId: job.id, deletionOperationId: row.builder.deletionOperationId };
  job.retired = true; await lease.save();
}

export async function reconcileReleaseCanaryRetirements(config: PromotionConfig, actorUserId: string, lease: any,
  core: any, reconcile: Reconcile, options: { maxRecords?: number; budgetMs?: number; now?: () => number; signal?: AbortSignal } = {}) {
  const maxRecords = options.maxRecords ?? 16, budgetMs = options.budgetMs ?? 15_000, now = options.now ?? Date.now;
  requireCheck(Number.isSafeInteger(maxRecords) && maxRecords > 0 && maxRecords <= 100 && Number.isFinite(budgetMs) && budgetMs >= 100,
    "Release canary recovery observation budget is invalid");
  const deadline = now() + budgetMs, state = lease.state;
  const signal = options.signal ?? AbortSignal.any([...(lease.signal ? [lease.signal] : []), AbortSignal.timeout(budgetMs)]);
  requireCheck(state.owner === workerOwner(config.channel) && Array.isArray(state.releaseRuns) && state.releaseRuns.length <= 100 &&
    Array.isArray(state.resources.images), "Release canary historical ownership is unconfirmed");
  let observed = 0;
  for (const run of state.releaseRuns) {
    requireCheck(Array.isArray(run.canaries) && run.canaries.length <= 3, "Release canary historical job inventory is invalid");
    for (const job of run.canaries) {
      const bindings = ReleaseCanaryBindingsSchema.safeParse(run.releaseCanaryBindings);
      const binding = bindings.success ? bindings.data.find(value => value.kind === job.kind) : undefined;
      const currentJob = run.runId === config.runId && run.sourceSha === config.sourceSha && run.actorUserId === actorUserId &&
        binding && ["credentialId", "credentialRevision", "designationId", "model"].every(key => binding[key as keyof typeof binding] === job[key]) &&
        job.qualificationProfile === run.qualificationProfile && job.image?.sourceCommit === config.sourceSha;
      const rows = state.resources.images.filter((value: any) => value.agentQualificationId === job.id);
      if (rows.length === 0 && currentJob && job.phase === "allocating" &&
        [job.outcome, job.auditRetired, job.retired, job.prelaunchFailure, job.admissionRequest].every(value => value === undefined)) continue;
      requireCheck(rows.length === 1, "Release canary historical allocation journal is missing or ambiguous");
      const row = rows[0];
      if (!row.nativeDispatchStarted) continue;
      if (job.auditRetired !== undefined) {
        const marker = terminal.safeParse(job.auditRetired), proof = NativeCanaryPhysicalCleanupSchema.safeParse(row.builder?.physicalCleanup);
        requireCheck(marker.success && proof.success && marker.data.operationId === job.id && marker.data.deletionOperationId === row.builder?.deletionOperationId &&
          proof.data.operationId === job.id && proof.data.operation.id === marker.data.deletionOperationId && row.builder.deleted === true && job.retired === true,
          "Release canary historical terminal journal is invalid");
        continue;
      }
      if (job.retired && job.outcome) continue;
      if (currentJob && !row.builder?.deleteRequested && job.prelaunchFailure === undefined) continue;
      requireCheck(observed < maxRecords && now() < deadline && !signal.aborted, "Release canary historical recovery budget exhausted; retain all remaining holds");
      requireCheck(run.actorUserId === actorUserId && /^[a-f0-9]{40}$/.test(run.sourceSha ?? "") &&
        binding && ["credentialId", "credentialRevision", "designationId", "model"].every(key => binding[key as keyof typeof binding] === job[key]) &&
        job.qualificationProfile === run.qualificationProfile && job.image?.sourceCommit === run.sourceSha &&
        row.purpose === "native-agent-qualification" && row.sourceCommit === run.sourceSha && row.sourceImage === job.image.snapshotId &&
        row.builder?.deleteRequested === true && /^bdop_[a-f0-9]{32}$/.test(row.builder.deletionOperationId ?? ""),
        "Release canary historical dispatch requires exact retained ownership and deletion operation; never allocate or DELETE again");
      await retireReleaseCanary(lease, core, reconcile, job, signal);
      observed++;
    }
  }
  return observed;
}
