import { createHash } from "node:crypto";
import { z } from "zod";
import { ReleaseCanaryBindingsSchema, NativeCanaryPhysicalCleanupSchema, NativeCanaryStorageRetirementSchema } from "../../apps/control-plane/src/cloud-workspaces/release-canary-contract";
import { requireCheck, type PromotionConfig } from "./contracts";
import { workerOwner } from "./worker-admission";

const terminal = z.object({ version: z.literal(1), operationId: z.string().uuid(), deletionOperationId: z.string().regex(/^bdop_[a-f0-9]{32}$/) }).strict();
const deferred = terminal.extend({ version: z.literal(2), storagePending: z.literal(true) }).strict();
type Reconcile = (operationId: string, deletionOperationId: string, leaseToken: string, signal?: AbortSignal) => Promise<"physically-deleted" | "storage-pending" | void>;

function hasPhysicalCleanup(row: any, job: any) {
  const proof = NativeCanaryPhysicalCleanupSchema.safeParse(row.builder?.physicalCleanup);
  return proof.success && row.builder.deleted === true && row.builder.deleteRequested === true && proof.data.operationId === job.id &&
    proof.data.operation.id === row.builder.deletionOperationId && proof.data.targetId === row.builder.id &&
    proof.data.sourceCommit === job.image.sourceCommit && proof.data.snapshotId === job.image.snapshotId &&
    proof.data.buildSha256 === job.image.buildSha256 &&
    Date.parse(proof.data.operation.requestedAt) >= row.builderIntent.at && Date.parse(proof.data.unavailableObservedAt) <= Date.now() &&
    proof.data.creationIntentSha256 === createHash("sha256").update(JSON.stringify(row.builderIntent)).digest("hex");
}

export function releaseCanaryCleanup(lease: any, run: any) {
  const pending = [];
  for (const job of run.canaries) {
    const rows = lease.state.resources.images.filter((row: any) => row.agentQualificationId === job.id);
    requireCheck(rows.length === 1 && job.retired === true, "Release canary cleanup journal is unconfirmed");
    const row = rows[0];
    if (row.builder?.deleted === true) {
      const marker = terminal.safeParse(job.auditRetired);
      requireCheck(hasPhysicalCleanup(row, job) && marker.success && marker.data.operationId === job.id &&
        marker.data.deletionOperationId === row.builder.deletionOperationId, "Release canary physical cleanup journal is unconfirmed");
    } else {
      const marker = deferred.safeParse(job.auditRetired), proof = NativeCanaryStorageRetirementSchema.safeParse(row.builder?.storageRetirement);
      requireCheck(marker.success && proof.success && marker.data.operationId === job.id && marker.data.deletionOperationId === row.builder?.deletionOperationId &&
        proof.data.operationId === job.id && proof.data.operation.id === marker.data.deletionOperationId && proof.data.targetId === row.builder.id &&
        proof.data.sourceCommit === job.image.sourceCommit && proof.data.snapshotId === job.image.snapshotId && proof.data.buildSha256 === job.image.buildSha256 &&
        proof.data.creationIntentSha256 === createHash("sha256").update(JSON.stringify(row.builderIntent)).digest("hex"), "Release canary storage retirement journal is unconfirmed");
      pending.push(proof.data);
    }
  }
  return pending.length ? { credentialCanaryResourcesDeleted: false as const,
    pendingNativeStorage: { status: "pending" as const, count: pending.length,
      proofSha256: createHash("sha256").update(JSON.stringify(pending)).digest("hex"), physicalBytes: "unmeasured" as const } }
    : { credentialCanaryResourcesDeleted: true as const };
}

export async function retireReleaseCanary(lease: any, core: any, reconcile: Reconcile, job: any, signal?: AbortSignal) {
  const acknowledge = async (pending: boolean) => {
    const row = lease.state.resources.images.find((value: any) => value.agentQualificationId === job.id);
    const proof = pending ? NativeCanaryStorageRetirementSchema.safeParse(row.builder?.storageRetirement) : NativeCanaryPhysicalCleanupSchema.safeParse(row.builder?.physicalCleanup);
    requireCheck(proof.success && (pending ? row.builder.deleted !== true : row.builder.deleted === true) && proof.data.operationId === job.id &&
      proof.data.operation.id === row.builder.deletionOperationId, "Release canary terminal cleanup proof is unconfirmed");
    await lease.save(); await lease.fence();
    const result = await reconcile(job.id, row.builder.deletionOperationId, lease.state.lease.token, signal);
    requireCheck(pending ? result === "storage-pending" : result !== "storage-pending", "Release canary cleanup acknowledgment does not match its proof");
    job.auditRetired = pending ? { version: 2, operationId: job.id, deletionOperationId: row.builder.deletionOperationId, storagePending: true }
      : { version: 1, operationId: job.id, deletionOperationId: row.builder.deletionOperationId };
    job.retired = true; await lease.save();
  };
  let storageAcknowledged = false;
  await lease.fence(); await core.retire(job, async () => { await acknowledge(true); storageAcknowledged = true; });
  const row = lease.state.resources.images.find((value: any) => value.agentQualificationId === job.id);
  if (row?.nativeDispatchStarted && !storageAcknowledged) await acknowledge(false);
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
  const required: { job: any; row: any; optional: boolean }[] = [], acknowledged: typeof required = [];
  for (const run of state.releaseRuns) {
    requireCheck(Array.isArray(run.canaries) && run.canaries.length <= 3, "Release canary historical job inventory is invalid");
    for (const job of run.canaries) {
      const bindings = ReleaseCanaryBindingsSchema.safeParse(run.releaseCanaryBindings);
      const binding = bindings.success ? bindings.data.find(value => value.kind === job.kind) : undefined;
      const ownedJob = run.actorUserId === actorUserId && /^[1-9]\d*$/.test(run.runId ?? "") && /^[a-f0-9]{40}$/.test(run.sourceSha ?? "") &&
        z.string().uuid().safeParse(job.id).success && Number.isFinite(job.startedAt) && ["smoke", "full"].includes(run.qualificationProfile) &&
        binding && ["credentialId", "credentialRevision", "designationId", "model"].every(key => binding[key as keyof typeof binding] === job[key]) &&
        job.qualificationProfile === run.qualificationProfile && job.image?.sourceCommit === run.sourceSha &&
        /^[a-z0-9][a-z0-9-]{0,62}$/.test(job.image?.snapshotId ?? "") && /^[a-f0-9]{64}$/.test(job.image?.buildSha256 ?? "");
      const currentJob = ownedJob && run.runId === config.runId && run.sourceSha === config.sourceSha;
      const rows = state.resources.images.filter((value: any) => value.agentQualificationId === job.id);
      if (rows.length === 0 && ownedJob && job.phase === "allocating" && (job.retired === undefined || job.retired === true) &&
        [job.outcome, job.auditRetired, job.prelaunchFailure, job.admissionRequest].every(value => value === undefined)) continue;
      requireCheck(rows.length === 1, "Release canary historical allocation journal is missing or ambiguous");
      const row = rows[0];
      const pendingMarker = deferred.safeParse(job.auditRetired);
      if (pendingMarker.success) {
        const proof = NativeCanaryStorageRetirementSchema.safeParse(row.builder?.storageRetirement);
        requireCheck(ownedJob && row.nativeDispatchStarted === true && proof.success && job.retired === true && pendingMarker.data.operationId === job.id &&
          pendingMarker.data.deletionOperationId === row.builder?.deletionOperationId && proof.data.operationId === job.id &&
          proof.data.operation.id === pendingMarker.data.deletionOperationId, "Release canary historical deferred journal is invalid");
      }
      if (job.auditRetired !== undefined && !pendingMarker.success) {
        const marker = terminal.safeParse(job.auditRetired), proof = NativeCanaryPhysicalCleanupSchema.safeParse(row.builder?.physicalCleanup);
        requireCheck(row.nativeDispatchStarted === true && marker.success && proof.success && marker.data.operationId === job.id && marker.data.deletionOperationId === row.builder?.deletionOperationId &&
          proof.data.operationId === job.id && proof.data.operation.id === marker.data.deletionOperationId && row.builder.deleted === true && job.retired === true,
          "Release canary historical terminal journal is invalid");
        continue;
      }
      if (row.nativeDispatchStarted === true && job.retired && job.outcome && !pendingMarker.success && row.builder?.storageRetirement === undefined) continue;
      if (currentJob && !job.retired && !row.builder?.deleteRequested && row.builder?.deleted !== true &&
        !row.builder?.retiredAt && job.prelaunchFailure === undefined) continue;
      requireCheck(ownedJob && row.purpose === "native-agent-qualification" && row.sourceCommit === run.sourceSha && row.sourceImage === job.image.snapshotId,
        "Release canary historical ownership or image binding is unconfirmed");
      if (pendingMarker.success) {
        requireCheck(typeof core.validateRetainedCleanup === "function", "Release canary retained cleanup validator is missing");
        core.validateRetainedCleanup(job);
        for (const key of ["retiredAt", "lastReconcileAt"]) {
          requireCheck(row.builder[key] === undefined || typeof row.builder[key] === "string" &&
            Number.isFinite(Date.parse(row.builder[key])) && Date.parse(row.builder[key]) <= now(),
          "Release canary historical observation time is invalid");
        }
      }
      if (row.nativeDispatchStarted !== true) {
        requireCheck(row.nativeDispatchStarted === undefined && ["allocating", "starting"].includes(job.phase) &&
          [job.outcome, job.prelaunchFailure, job.admissionRequest].every(value => value === undefined) &&
          row.builderIntent?.key === job.id && Number.isFinite(row.builderIntent.at) && row.builderIntent.body?.from === job.image.snapshotId &&
          row.builderIntent.body.noEnv === true && JSON.stringify(row.builderIntent.body.env) === "{}",
          "Release canary historical pre-dispatch intent is unconfirmed");
        if (!row.builder && ["planned", "rejected"].includes(row.builderCreate?.phase) &&
          job.retired === true && row.retired === true && row.deleted === true) continue;
        if (job.retired === true) {
          requireCheck(row.retired === true && row.deleted === true && hasPhysicalCleanup(row, job), "Release canary historical physical cleanup proof is unconfirmed");
          continue;
        }
      }
      requireCheck(/^bx_[a-z0-9]+$/.test(row.builder?.id ?? "") &&
        row.builder?.deleteRequested === true && /^bdop_[a-f0-9]{32}$/.test(row.builder.deletionOperationId ?? ""),
        "Release canary historical dispatch requires exact retained ownership and deletion operation; never allocate or DELETE again");
      const optional = pendingMarker.success && row.retired === true && row.deleted === false &&
        row.builder.deleted !== true && row.builder.retiredAt !== undefined;
      (optional ? acknowledged : required).push({ job, row, optional });
    }
  }
  // Unacknowledged recovery must finish before fresh work. Already-audited
  // storage remains truthfully pending and rotates across bounded later passes.
  acknowledged.sort((left, right) => (Date.parse(left.row.builder.lastReconcileAt) || 0) - (Date.parse(right.row.builder.lastReconcileAt) || 0));
  let observed = 0;
  for (const { job, row, optional } of [...required, ...acknowledged]) {
    requireCheck(!lease.signal?.aborted && !signal.aborted, "Release canary historical recovery budget exhausted; retain all remaining holds");
    if (optional && (observed >= maxRecords || deadline - now() < 100)) break;
    requireCheck(observed < maxRecords && now() < deadline, "Release canary historical recovery budget exhausted; retain all remaining holds");
    await retireReleaseCanary(lease, core, reconcile, job, signal);
    requireCheck(!lease.signal?.aborted && !signal.aborted && now() < deadline,
      "Release canary historical recovery budget exhausted; retain all remaining holds");
    if (row.nativeDispatchStarted !== true) {
      requireCheck(hasPhysicalCleanup(row, job), "Release canary historical physical cleanup proof is unconfirmed");
      job.retired = true;
    }
    row.builder.lastReconcileAt = new Date(now()).toISOString();
    await lease.save();
    observed++;
  }
  return observed;
}
