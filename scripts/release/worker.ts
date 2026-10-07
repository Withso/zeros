import { refuseRetiredWorkerPromotion } from "./worker-retirement";
import { z } from "zod";
import { DIGEST, SHA, WorkerIdentity, requireCheck, type Channel } from "./contracts";
import type { WorkerQualificationProfile } from "./worker-profile";
import { type ReleaseCanaryConnection } from "../../apps/control-plane/src/cloud-workspaces/release-canary-contract";
import { WorkerCleanupSchema, WorkerDeferredCleanupSchema, builderCleanupBelongsToRun,
  type WorkerBuilderCleanup, type WorkerReleaseCleanup } from "./worker-builder-retirement";

export const WORKER_CREDENTIAL_KINDS = ["claude-setup-token", "codex-chatgpt", "cursor-api-key"] as const;
const credentialKind = z.enum(WORKER_CREDENTIAL_KINDS);
const commonReceipt = z.object({ status: z.literal("success"), channel: z.enum(["alpha", "beta", "production"]),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), branch: z.string(), runId: z.string().regex(/^[1-9]\d*$/), runAttempt: z.string().regex(/^[1-9]\d*$/),
  sourceSha: z.string().regex(SHA), inputsSha256: z.string().regex(DIGEST), worker: WorkerIdentity.refine(worker => worker.provider === "boat" && worker.architecture === "linux/amd64"),
  qualifiedKinds: z.array(credentialKind).length(3).refine(kinds => new Set(kinds).size === 3), qualificationProfile: z.enum(["smoke", "full"]), runtimeContractSha256: z.string().regex(DIGEST),
  evidenceSha256: z.string().regex(DIGEST), approvalPlanSha256: z.string().regex(DIGEST),
  approvalTargetSha256: z.string().regex(DIGEST), roleDeleted: z.literal(true), completedAt: z.string().datetime() });
export const WorkerReceipt = z.discriminatedUnion("version", [
  commonReceipt.extend({ version: z.literal(1), resourcesDeleted: z.literal(true) }).strict(),
  commonReceipt.extend({ version: z.literal(2), cleanup: WorkerCleanupSchema }).strict(),
  commonReceipt.extend({ version: z.literal(3), cleanup: WorkerDeferredCleanupSchema }).strict(),
]).refine(receipt => {
  if (receipt.version === 1) return true;
  const builder = receipt.cleanup.imageBuilder;
  if (Date.parse(builder.unavailableObservedAt) > Date.parse(receipt.completedAt)) return false;
  if (builder.kind === "physically-deleted") return true;
  const candidate = builder.provenance.candidate;
  return builderCleanupBelongsToRun(builder, receipt, candidate) && receipt.worker.sourceSha === candidate.sourceCommit &&
    receipt.worker.imageRef === `boat:${candidate.snapshotId}@sha256:${candidate.buildSha256}` &&
    receipt.worker.architecture === candidate.architecture && receipt.worker.storageMiB === candidate.storageMiB;
});
export function validateWorkerReceipt(value: unknown, expected: { channel: Channel; sourceSha: string; branch: string; repository: string; runId: string; runAttempt: string; inputsSha256?: string }) {
  const parsed = WorkerReceipt.safeParse(value);
  requireCheck(parsed.success, "Worker receipt is invalid or incomplete");
  const receipt = parsed.data;
  requireCheck(receipt.channel === expected.channel && receipt.sourceSha === expected.sourceSha && receipt.worker.sourceSha === expected.sourceSha &&
    receipt.branch === expected.branch && receipt.repository === expected.repository && receipt.runId === expected.runId && receipt.runAttempt === expected.runAttempt &&
    (!expected.inputsSha256 || receipt.inputsSha256 === expected.inputsSha256), "Worker receipt does not belong to this exact run, channel and source");
  requireCheck(Date.parse(receipt.completedAt) <= Date.now() + 5000, "Worker receipt completion is in the future");
  return receipt;
}
export type WorkerPromotionInput = { channel: Channel; sourceSha: string; inputsSha256: string; actorUserId: string; operationId: string; kinds: string[];
  repository: string; branch: string; runId: string; runAttempt: string; qualificationProfile: WorkerQualificationProfile; releaseCanaryBindings: ReleaseCanaryConnection[] };
export type WorkerCandidate = { snapshotId: string; buildSha256: string; sourceCommit: string; architecture: "linux/amd64" | "linux/arm64"; storageMiB: number };
export type WorkerDependencies = {
  build(): Promise<WorkerCandidate>;
  cleanupBuilder(): Promise<WorkerBuilderCleanup | null>;
  qualify(image: WorkerCandidate, kind: string): Promise<{ connection: ReleaseCanaryConnection; outcome: unknown; startedAt: number }>;
  withOwner<T>(action: (owner: { loginIdentity: string; manage(document: unknown, approval?: string): Promise<any> }) => Promise<T>): Promise<{ value: T; deleted: boolean }>;
  updateIdentity(variables: Record<string, string>): Promise<void>;
  cleanup(): Promise<WorkerReleaseCleanup | null>;
  assertCurrent?(): Promise<void>;
  saveEvidence?(evidence: unknown): Promise<void>;
};
/** Historical receipt schemas above remain readable; new v3 promotion cannot
 * build, obtain credentials, approve an image, or update a release tuple. */
export async function promoteWorker(_input: WorkerPromotionInput, _deps: WorkerDependencies): Promise<z.infer<typeof WorkerReceipt>> {
  refuseRetiredWorkerPromotion();
}
