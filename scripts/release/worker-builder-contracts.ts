import { createHash } from "node:crypto";
import { z } from "zod";
import { DIGEST, SHA } from "./contracts";
import { workerOwner, workerSnapshotName } from "./worker-owner";

const timestamp = z.string().datetime({ offset: true });
const sourceSha = z.string().regex(SHA);
const digest = z.string().regex(DIGEST);
const sandboxId = z.string().regex(/^bx_[a-z0-9]+$/);
const operationId = z.string().regex(/^bdop_[a-f0-9]{32}$/);
const snapshotName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const WorkerCandidateSchema = z.object({ snapshotId: snapshotName, sourceCommit: sourceSha, buildSha256: digest,
  architecture: z.literal("linux/amd64"), storageMiB: z.number().int().positive() }).strict();
export const WorkerBuilderCreationBodySchema = z.object({ type: z.enum(["small", "default", "large", "xlarge"]), from: snapshotName,
  ttlSeconds: z.literal(3600), noEnv: z.literal(true), env: z.object({}).strict() }).strict();
const creationScope = z.object({ repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), channel: z.enum(["alpha", "beta", "production"]),
  runId: z.string().regex(/^[1-9]\d*$/), runAttempt: z.string().regex(/^[1-9]\d*$/), sourceSha, inputsSha256: digest,
  owner: z.string().regex(/^[a-f0-9]{24}$/), generation: z.string().uuid(), accountBinding: digest, protectedBaseSnapshot: snapshotName }).strict();
const sanitation = z.object({ qualified: z.literal(true), sourceCommit: sourceSha, buildSha256: digest, observedAt: timestamp }).strict();
export const WorkerBuilderProvenanceSchema = z.object({ version: z.literal(1), purpose: z.literal("release-worker"), scope: creationScope,
  creation: z.object({ sandboxId, key: z.string().uuid(), requestedAt: timestamp, createdAt: timestamp,
    body: WorkerBuilderCreationBodySchema, bodySha256: digest, billingOrgConfirmed: z.literal(true), billingObservedAt: timestamp }).strict(),
  source: z.object({ commit: sourceSha, parent: sourceSha, tree: sourceSha, archiveSha256: digest, exactMergedCommit: z.literal(true) }).strict(),
  generation: z.object({ commit: sourceSha, previous: sourceSha, contract: digest, attempt: z.string().regex(/^m2-build-[a-f0-9]{32}$/),
    scriptSha256: digest, buildSha256: digest, snapshotName }).strict(),
  attestation: z.object({ qualified: z.literal(true), secureSetup: z.literal(true), sourceCommit: sourceSha,
    buildSha256: digest, storageMiB: z.number().int().positive(), sha256: digest }).strict(),
  snapshot: z.object({ name: snapshotName, sourceSandboxId: sandboxId, sourceCommit: sourceSha, buildSha256: digest,
    savedAt: timestamp, readyObservedAt: timestamp, sanitation, sanitationSha256: digest, sanitationReportSha256: digest }).strict(),
  candidate: WorkerCandidateSchema,
}).strict().refine(proof => {
  const savedAt = Date.parse(proof.snapshot.savedAt), observedAt = Date.parse(proof.snapshot.sanitation.observedAt);
  return proof.scope.owner === workerOwner(proof.scope.channel) && proof.creation.body.from === proof.scope.protectedBaseSnapshot &&
    proof.creation.bodySha256 === hash(proof.creation.body) && proof.snapshot.sanitationSha256 === hash(proof.snapshot.sanitation) &&
    Date.parse(proof.creation.requestedAt) <= Date.parse(proof.creation.createdAt) && Date.parse(proof.creation.createdAt) <= savedAt &&
    Date.parse(proof.creation.billingObservedAt) >= Date.parse(proof.creation.requestedAt) && Date.parse(proof.creation.billingObservedAt) <= savedAt &&
    observedAt <= savedAt && savedAt - observedAt <= 60_000 && Date.parse(proof.snapshot.readyObservedAt) >= savedAt &&
    proof.creation.sandboxId === proof.snapshot.sourceSandboxId && proof.candidate.snapshotId === proof.snapshot.name &&
    proof.generation.snapshotName === proof.snapshot.name && proof.attestation.storageMiB === proof.candidate.storageMiB &&
    [proof.source.parent, proof.source.commit, proof.generation.commit, proof.attestation.sourceCommit, proof.snapshot.sourceCommit,
      proof.snapshot.sanitation.sourceCommit, proof.candidate.sourceCommit].every(commit => commit === proof.scope.sourceSha) &&
    [proof.generation.buildSha256, proof.attestation.buildSha256, proof.snapshot.buildSha256,
      proof.snapshot.sanitation.buildSha256].every(build => build === proof.candidate.buildSha256) &&
    proof.candidate.snapshotId === workerSnapshotName(proof.scope, hash([proof.scope.sourceSha, proof.scope.runId]));
});
export type WorkerBuilderProvenance = z.infer<typeof WorkerBuilderProvenanceSchema>;

const pendingStage = z.enum(["waiting_for_uploads", "kept_for_newer_snapshots", "waiting_for_restore"]);
const completedOperation = z.object({ id: operationId, kind: z.literal("sandbox"), targetId: sandboxId,
  status: z.literal("completed"), completedAt: timestamp }).strict();
const pendingOperation = z.object({ id: operationId, kind: z.literal("sandbox"), targetId: sandboxId, status: z.literal("blocked"),
  stage: pendingStage, expectedBy: timestamp.nullable() }).strict();
export const WorkerBuilderCleanupSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("physically-deleted"), sandboxId, deletionOperationId: operationId,
    operation: completedOperation, operationObservedAt: timestamp, unavailableObservedAt: timestamp, completedAt: timestamp }).strict(),
  z.object({ kind: z.literal("release-owned-sanitized-unavailable"), sandboxId, deletionOperationId: operationId,
    operation: pendingOperation, operationObservedAt: timestamp, unavailableObservedAt: timestamp,
    provenance: WorkerBuilderProvenanceSchema, provenanceSha256: digest,
    storage: z.object({ status: z.literal("pending"), scope: z.literal("sandbox-unshared-snapshots-and-machine-data"),
      stage: pendingStage, expectedBy: timestamp.nullable(), physicalBytes: z.literal("unmeasured") }).strict() }).strict(),
]).refine(result => {
  if (result.operation.id !== result.deletionOperationId || result.operation.targetId !== result.sandboxId ||
      Date.parse(result.operationObservedAt) > Date.parse(result.unavailableObservedAt)) return false;
  if (result.kind === "physically-deleted") return result.completedAt === result.operation.completedAt &&
    Date.parse(result.completedAt) <= Date.parse(result.operationObservedAt);
  return result.provenanceSha256 === hash(result.provenance) && result.provenance.creation.sandboxId === result.sandboxId &&
    result.operation.stage === result.storage.stage && result.operation.expectedBy === result.storage.expectedBy &&
    (result.storage.stage !== "waiting_for_uploads" || result.storage.expectedBy !== null &&
      Date.parse(result.storage.expectedBy) >= Date.parse(result.provenance.creation.requestedAt) &&
      Date.parse(result.storage.expectedBy) <= Date.parse(result.operationObservedAt) + 6 * 3600_000 + 5000);
});
export type WorkerBuilderCleanup = z.infer<typeof WorkerBuilderCleanupSchema>;
export const WorkerCleanupSchema = z.object({ credentialCanaryResourcesDeleted: z.literal(true), imageBuilder: WorkerBuilderCleanupSchema }).strict();
export type WorkerCleanup = z.infer<typeof WorkerCleanupSchema>;
export const WorkerDeferredCleanupSchema = z.object({ credentialCanaryResourcesDeleted: z.literal(false), imageBuilder: WorkerBuilderCleanupSchema,
  pendingNativeStorage: z.object({ status: z.literal("pending"), count: z.number().int().min(1).max(3), proofSha256: digest,
    physicalBytes: z.literal("unmeasured") }).strict() }).strict();
export const WorkerReleaseCleanupSchema = z.union([WorkerCleanupSchema, WorkerDeferredCleanupSchema]);
export type WorkerReleaseCleanup = z.infer<typeof WorkerReleaseCleanupSchema>;
export { sandboxId as WorkerBuilderSandboxIdSchema, operationId as WorkerBuilderDeletionOperationIdSchema,
  creationScope as WorkerBuilderScopeSchema, completedOperation as WorkerBuilderCompletedOperationSchema,
  pendingOperation as WorkerBuilderPendingOperationSchema };
