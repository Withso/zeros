import { z } from "zod";

const Uuid = z.string().uuid();
const Timestamp = z.string().datetime();
const Generation = z.number().int().positive().safe();
const DeleteKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const Reserved = z.object({
  cpuMillicores: z.literal(0), memoryMiB: z.literal(0), storageMiB: z.number().int().nonnegative().safe(),
}).strict();

export const CloudWorkspaceDeletionRetirementRequestSchema = z.object({
  generation: Generation, deleteIdempotencyKey: DeleteKey,
}).strict();

const RetiredGeneration = z.object({
  generation: Generation,
  status: z.enum(["compute_retired_storage_pending", "physically_deleted"]),
  receiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestedAt: Timestamp,
  storageStage: z.enum(["waiting_for_uploads", "kept_for_newer_snapshots", "waiting_for_restore", "completed"]),
  expectedBy: Timestamp.nullable(),
  reserved: Reserved,
}).strict();

/** A passive authenticated observation. It cannot authorize allocation,
 * account for physical bytes, erase data, or retire native writer custody. */
export const CloudWorkspaceDeletionRetirementSchema = z.object({
  version: z.literal(1),
  organizationId: Uuid, workspaceId: Uuid, ownerUserId: Uuid, createdBy: Uuid,
  createdAt: Timestamp, repositoryId: Uuid, name: z.string().min(1).max(120),
  currentGeneration: Generation, deleteIntentId: Uuid, deleteIdempotencyKey: DeleteKey,
  requestedAt: Timestamp, observedAt: Timestamp,
  status: z.enum(["compute_retired_storage_pending", "physically_deleted"]),
  deletionConfirmed: z.boolean(), admissionFenced: z.literal(true),
  computeSettled: z.literal(true), accessRetired: z.literal(true),
  generations: z.array(RetiredGeneration).min(1).max(64), reserved: Reserved,
}).strict().superRefine((value, ctx) => {
  const refuse = () => ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Inconsistent deletion retirement observation" });
  const observed = Date.parse(value.observedAt), created = Date.parse(value.createdAt);
  if (Date.parse(value.requestedAt) > observed || created > Date.parse(value.requestedAt)) refuse();
  let storage = 0, previous = 0, pending = 0;
  for (const generation of value.generations) {
    if (generation.generation <= previous || Date.parse(generation.requestedAt) > observed) refuse();
    previous = generation.generation;
    storage += generation.reserved.storageMiB;
    if (generation.status === "physically_deleted") {
      if (generation.storageStage !== "completed" || generation.expectedBy !== null || generation.reserved.storageMiB !== 0) refuse();
    } else {
      pending++;
      if (generation.storageStage === "completed" || generation.reserved.storageMiB === 0 ||
          (generation.storageStage === "waiting_for_uploads" && generation.expectedBy === null)) refuse();
    }
    if (generation.expectedBy !== null &&
        (Date.parse(generation.expectedBy) < created || Date.parse(generation.expectedBy) > observed + 6 * 3600_000 + 5_000)) refuse();
  }
  if (!value.generations.some(row => row.generation === value.currentGeneration) ||
      !Number.isSafeInteger(storage) || storage !== value.reserved.storageMiB ||
      (value.status === "physically_deleted") !== value.deletionConfirmed ||
      (pending === 0) !== value.deletionConfirmed) refuse();
});

export type CloudWorkspaceDeletionRetirement = z.infer<typeof CloudWorkspaceDeletionRetirementSchema>;
