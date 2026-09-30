import { createHash } from "node:crypto";
import { z } from "zod";
import { nativeRuntimeEvidence, qualificationRateLimited } from "../dev-environment/native-agent-canary.mjs";
import { CloudAgentRuntimeEvidenceSchema } from "../../apps/control-plane/src/manage-cloud-agent-runtime";
import { CHANNELS, DIGEST, SHA, WorkerIdentity, requireCheck, type Channel } from "./contracts";
import type { WorkerQualificationProfile } from "./worker-profile";
import { ReleaseCanaryBindingsSchema, RELEASE_CANARY_MODELS, type ReleaseCanaryConnection } from "../../apps/control-plane/src/cloud-workspaces/release-canary-contract";

export const WORKER_CREDENTIAL_KINDS = ["claude-setup-token", "codex-chatgpt", "cursor-api-key"] as const;
const credentialKind = z.enum(WORKER_CREDENTIAL_KINDS);
export const WorkerReceipt = z.object({ version: z.literal(1), status: z.literal("success"), channel: z.enum(["alpha", "beta", "production"]),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), branch: z.string(), runId: z.string().regex(/^[1-9]\d*$/), runAttempt: z.string().regex(/^[1-9]\d*$/),
  sourceSha: z.string().regex(SHA), inputsSha256: z.string().regex(DIGEST), worker: WorkerIdentity.refine(worker => worker.provider === "boat" && worker.architecture === "linux/amd64"),
  qualifiedKinds: z.array(credentialKind).length(3).refine(kinds => new Set(kinds).size === 3), qualificationProfile: z.enum(["smoke", "full"]), runtimeContractSha256: z.string().regex(DIGEST),
  evidenceSha256: z.string().regex(DIGEST), approvalPlanSha256: z.string().regex(DIGEST),
  approvalTargetSha256: z.string().regex(DIGEST), roleDeleted: z.literal(true), resourcesDeleted: z.literal(true), completedAt: z.string().datetime() }).strict();
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
  qualify(image: WorkerCandidate, kind: string): Promise<{ connection: ReleaseCanaryConnection; outcome: unknown; startedAt: number }>;
  withOwner<T>(action: (owner: { loginIdentity: string; manage(document: unknown, approval?: string): Promise<any> }) => Promise<T>): Promise<{ value: T; deleted: boolean }>;
  updateIdentity(variables: Record<string, string>): Promise<void>;
  cleanup(): Promise<boolean>;
  assertCurrent?(): Promise<void>;
  saveEvidence?(evidence: unknown): Promise<void>;
};
export async function promoteWorker(input: WorkerPromotionInput, deps: WorkerDependencies) {
  requireCheck(Object.hasOwn(CHANNELS, input.channel) && SHA.test(input.sourceSha) && DIGEST.test(input.inputsSha256) &&
    z.string().uuid().safeParse(input.actorUserId).success && z.string().uuid().safeParse(input.operationId).success &&
    input.kinds.length === WORKER_CREDENTIAL_KINDS.length && WORKER_CREDENTIAL_KINDS.every(kind => input.kinds.includes(kind)) &&
    new Set(input.kinds).size === input.kinds.length && ["smoke", "full"].includes(input.qualificationProfile) && /^[\w.-]+\/[\w.-]+$/.test(input.repository) && /^[1-9]\d*$/.test(input.runId) && /^[1-9]\d*$/.test(input.runAttempt) &&
    (input.channel === "alpha" ? input.branch === "main" : /^release\/\d+\.\d+\.\d+$/.test(input.branch)), "Invalid worker source/credential policy");
  const bindings = ReleaseCanaryBindingsSchema.safeParse(input.releaseCanaryBindings);
  requireCheck(bindings.success && (input.qualificationProfile !== "smoke" || bindings.data.every(row => row.model === RELEASE_CANARY_MODELS[row.kind])),
    "Worker qualification requires exact discovered credential designation bindings");
  let cleaned = false;
  try {
    await deps.assertCurrent?.();
    const image = await deps.build();
    requireCheck(image.sourceCommit === input.sourceSha, "Worker build source differs from the event SHA");
    const evidence = [];
    for (const kind of input.kinds) {
      const result = await deps.qualify(image, kind);
      requireCheck(result.connection.kind === kind, "Canary credential kind mismatch");
      requireCheck(!qualificationRateLimited(result.outcome), "canary account rate-limited; release qualification stopped without retrying or approving this image");
      const binding = bindings.data.find(row => row.kind === kind);
      requireCheck(binding && ["credentialId", "credentialRevision", "designationId", "model"].every(key =>
        result.connection[key as keyof ReleaseCanaryConnection] === binding[key as keyof ReleaseCanaryConnection]), "Canary credential designation binding changed");
      // Reuse only the pure report verifier. Replace the Dev channel label
      // before hashing and pass the release document through the real schema.
      const checked = nativeRuntimeEvidence(image, { ...result.connection, qualificationProfile: input.qualificationProfile }, result.outcome, result.startedAt);
      if (input.qualificationProfile === "full") {
        const required = kind === "codex-chatgpt" ? ["nativeGoals", "nativeFork", "transcriptFork", "nativeReview", "nativeApps", "nativeMultiAgent"] : ["transcriptFork"];
        requireCheck(required.every(check => (result.outcome as any)?.report?.checks?.includes(check)), "Full native qualification did not prove its advertised capabilities");
      }
      evidence.push(checked);
    }
    const first = evidence[0];
    requireCheck(evidence.every(row => row.runtimeContractSha256 === first.runtimeContractSha256), "Canaries measured different runtime contracts");
    const { evidenceSha256: _oldDigest, ...base } = first;
    const document = { ...base, channel: input.channel, releaseCanaryBindings: bindings.data, credentials: evidence.flatMap(row => row.credentials),
      qualifiedAt: evidence.map(row => row.qualifiedAt).sort()[0] };
    const approvedEvidence = CloudAgentRuntimeEvidenceSchema.parse({ ...document,
      evidenceSha256: createHash("sha256").update(JSON.stringify(document)).digest("hex") });
    await deps.saveEvidence?.(approvedEvidence);
    // Retire every credential-bearing canary before creating an approval.
    cleaned = await deps.cleanup();
    requireCheck(cleaned, "Worker canary cleanup is unconfirmed");
    await deps.assertCurrent?.();
    const change = { operationId: input.operationId, actorUserId: input.actorUserId, enabled: true,
      reason: "Ordered channel worker promotion after native qualification", evidence: approvedEvidence };
    const approval = await deps.withOwner(async owner => {
      const login = owner.loginIdentity;
      const plan = await owner.manage(change);
      requireCheck(["planned", "replayed"].includes(plan.state) && DIGEST.test(plan.planSha256 ?? "") && DIGEST.test(plan.targetSha256 ?? ""), "Runtime approval plan missing");
      requireCheck(owner.loginIdentity === login, "Runtime approval login changed between plan and execute");
      const applied = await owner.manage(change, plan.planSha256);
      requireCheck(["changed", "replayed"].includes(applied.state) && applied.planSha256 === plan.planSha256 && applied.targetSha256 === plan.targetSha256,
        "Runtime approval execution does not match its plan");
      return { planSha256: plan.planSha256 as string, targetSha256: plan.targetSha256 as string };
    });
    requireCheck(approval.deleted, "Worker approval owner-role deletion is unconfirmed");
    const worker = WorkerIdentity.parse({ provider: "boat", imageRef: approvedEvidence.imageRef, sourceSha: image.sourceCommit,
      architecture: image.architecture, storageMiB: image.storageMiB });
    // One provider operation; skipDeploys must stay true in the adapter.
    await deps.assertCurrent?.();
    await deps.updateIdentity({ CLOUD_WORKSPACE_PROVIDER: "boat", BOAT_SNAPSHOT_ID: image.snapshotId, BOAT_IMAGE_BUILD_SHA256: image.buildSha256,
      ZEROS_CLOUD_SOURCE_COMMIT: image.sourceCommit, ZEROS_CLOUD_IMAGE_ARCHITECTURE: image.architecture, CLOUD_WORKSPACE_STORAGE_MIB: String(image.storageMiB) });
    return WorkerReceipt.parse({ version: 1, status: "success", channel: input.channel, sourceSha: input.sourceSha,
      repository: input.repository, branch: input.branch, runId: input.runId, runAttempt: input.runAttempt,
      inputsSha256: input.inputsSha256, worker, qualifiedKinds: input.kinds, qualificationProfile: input.qualificationProfile, runtimeContractSha256: approvedEvidence.runtimeContractSha256,
      evidenceSha256: approvedEvidence.evidenceSha256, approvalPlanSha256: approval.value.planSha256, approvalTargetSha256: approval.value.targetSha256,
      roleDeleted: true, resourcesDeleted: true, completedAt: new Date().toISOString() });
  } finally { if (!cleaned) await deps.cleanup(); }
}
