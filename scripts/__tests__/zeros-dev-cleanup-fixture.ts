import { randomUUID } from "node:crypto";
import type { Run, RunHandle } from "../zeros-dev/receipts";

/** Synthetic retirement evidence only; never contains a provider resource ID. */
export function fixtureRetirement(run: Run, observedAt = run.create?.result?.createdAt ?? run.createdAt) {
  const created = run.create?.result, intent = run.lifecycle.at(-1);
  if (!created) throw new Error("test create receipt required");
  if (intent?.operation !== "delete") throw new Error("test delete receipt required");
  return {
    version: 1 as const, status: "compute_retired_storage_pending" as const,
    organizationId: "22222222-2222-4222-8222-222222222222", ownerUserId: created.createdBy,
    createdBy: created.createdBy, createdAt: created.createdAt,
    workspaceId: created.id, repositoryId: "66666666-6666-4666-8666-666666666666",
    name: run.create!.body.name, currentGeneration: created.generation,
    deleteIntentId: randomUUID(), deleteIdempotencyKey: intent.key,
    requestedAt: observedAt, observedAt, deletionConfirmed: false,
    admissionFenced: true as const, computeSettled: true as const, accessRetired: true as const,
    reserved: { cpuMillicores: 0 as const, memoryMiB: 0 as const, storageMiB: 16_384 },
    generations: [{ generation: created.generation, status: "compute_retired_storage_pending" as const,
      receiptSha256: "c".repeat(64), requestedAt: observedAt, storageStage: "waiting_for_uploads" as const,
      expectedBy: new Date(Date.parse(observedAt) + 6 * 3_600_000).toISOString(),
      reserved: { cpuMillicores: 0 as const, memoryMiB: 0 as const, storageMiB: 16_384 } }],
  };
}

export function retireFixtureCompute(handle: RunHandle, observedAt = handle.run.create?.result?.createdAt ?? handle.run.createdAt) {
  const created = handle.run.create?.result;
  if (!created) throw new Error("test create receipt required");
  handle.run.lifecycle.push({ operation: "delete", key: randomUUID(), generation: created.generation, confirmed: false });
  const proof = fixtureRetirement(handle.run, observedAt);
  Object.assign(handle.run, { retirement: proof });
  return proof;
}
