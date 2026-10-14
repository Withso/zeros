import type { Run } from "./receipts";
import { DeletionRetirementSchema, FIXTURE_STORAGE_MIB, MAX_PENDING_AGE_MS, MAX_PENDING_STORAGE_MIB,
  MAX_PENDING_WORKSPACES, type CleanupSummary, type DeletionRetirement } from "./cleanup-contract";
import { ZerosDevError } from "./errors";

export function retirementMatchesRun(run: Run, value: unknown): value is DeletionRetirement {
  const parsed = DeletionRetirementSchema.safeParse(value), created = run.create?.result, last = run.lifecycle.at(-1);
  if (!parsed.success || !created || !last || last.operation !== "delete") return false;
  const proof = parsed.data, known = new Set([created.generation, ...run.lifecycle.map(row => row.generation)]);
  return proof.workspaceId === created.id && proof.currentGeneration === created.generation &&
    proof.ownerUserId === created.createdBy && proof.createdBy === created.createdBy && proof.createdAt === created.createdAt &&
    proof.name === run.create?.body.name && /^zd-[a-z0-9-]{1,100}$/.test(proof.name) &&
    proof.deleteIdempotencyKey === last.key && last.generation === created.generation &&
    proof.generations.length === known.size && proof.generations.every(row => known.has(row.generation));
}

export function cleanupOutcome(run: Run): CleanupSummary["outcome"] {
  if (!run.create) return "none";
  if (run.deletionConfirmed) return !run.retirement || retirementMatchesRun(run, run.retirement) && run.retirement.deletionConfirmed
    ? "physically_deleted" : "unconfirmed";
  if (retirementMatchesRun(run, run.retirement) && run.retirement.status === "compute_retired_storage_pending")
    return "compute_retired_storage_pending";
  return "unconfirmed";
}

export function requireComputeCleanup(run: Run): void {
  if (cleanupOutcome(run) === "unconfirmed") throw new ZerosDevError("cleanup_pending");
}

export function retirementRequestedAt(proof: DeletionRetirement): number {
  return Math.min(Date.parse(proof.requestedAt), ...proof.generations
    .filter(row => row.status === "compute_retired_storage_pending").map(row => Date.parse(row.requestedAt)));
}

/** Input receipts are authenticated by RunStore. Callers admitting allocation
 * must refresh every observation through CP first; a signature is not liveness. */
export function requireCleanupCapacity(runs: readonly Run[], reserveNext = false): void {
  for (const run of runs) requireComputeCleanup(run);
  const pending = runs.filter(run => cleanupOutcome(run) === "compute_retired_storage_pending");
  const reserve = reserveNext ? 1 : 0;
  if (pending.length + reserve > MAX_PENDING_WORKSPACES ||
      pending.reduce((sum, run) => sum + run.retirement!.reserved.storageMiB, 0) + reserve * FIXTURE_STORAGE_MIB > MAX_PENDING_STORAGE_MIB ||
      pending.some(run => Date.parse(run.retirement!.observedAt) - retirementRequestedAt(run.retirement!) > MAX_PENDING_AGE_MS))
    throw new ZerosDevError("cleanup_backlog_exceeded");
}

export function summarizeCleanup(runs: readonly Run[], primary?: Run): CleanupSummary {
  const pending = runs.filter(run => cleanupOutcome(run) === "compute_retired_storage_pending");
  const unconfirmed = runs.filter(run => cleanupOutcome(run) === "unconfirmed").length;
  return { outcome: primary ? cleanupOutcome(primary) : "none", deletionConfirmed: primary?.deletionConfirmed ?? false,
    pendingWorkspaces: pending.length,
    pendingGenerations: pending.reduce((sum, run) => sum + run.retirement!.generations.filter(row => row.status === "compute_retired_storage_pending").length, 0),
    reservedStorageMiB: pending.reduce((sum, run) => sum + run.retirement!.reserved.storageMiB, 0),
    oldestRequestedAt: pending.length ? new Date(Math.min(...pending.map(run => retirementRequestedAt(run.retirement!)))).toISOString() : null,
    unconfirmedWorkspaces: unconfirmed, reservationCoverage: unconfirmed ? "unavailable" : "complete" };
}
