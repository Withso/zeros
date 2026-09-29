import { createHash } from "node:crypto";
import { z } from "zod";
import { nativeRuntimeEvidence } from "../dev-environment/hosted-agents.mjs";
import { CloudAgentRuntimeEvidenceSchema } from "../../apps/control-plane/src/manage-cloud-agent-runtime";
import { CHANNELS, DIGEST, SHA, WorkerIdentity, requireCheck, type Channel } from "./contracts";

export const WorkerReceipt = z.object({ version: z.literal(1), status: z.literal("success"), channel: z.enum(["alpha", "beta", "production"]),
  sourceSha: z.string().regex(SHA), inputsSha256: z.string().regex(DIGEST), worker: WorkerIdentity,
  evidenceSha256: z.string().regex(DIGEST), approvalPlanSha256: z.string().regex(DIGEST),
  roleDeleted: z.literal(true), resourcesDeleted: z.literal(true), completedAt: z.string().datetime() });
export type WorkerCandidate = { snapshotId: string; buildSha256: string; sourceCommit: string; architecture: "linux/amd64" | "linux/arm64"; storageMiB: number };
export type WorkerDependencies = {
  build(): Promise<WorkerCandidate>;
  qualify(image: WorkerCandidate, kind: string): Promise<{ connection: { kind: string; model: string }; outcome: unknown; startedAt: number }>;
  withOwner<T>(action: (owner: { loginIdentity: string; manage(document: unknown, approval?: string): Promise<any> }) => Promise<T>): Promise<{ value: T; deleted: boolean }>;
  updateIdentity(variables: Record<string, string>): Promise<void>;
  cleanup(): Promise<boolean>;
};
/** Testable release lane. Qualification transports receive CI-held credentials,
 * not development owners, database seeds or fixture authorization bypasses. */
export async function promoteWorker(input: { channel: Channel; sourceSha: string; inputsSha256: string; actorUserId: string; operationId: string; kinds: string[] }, deps: WorkerDependencies) {
  requireCheck(Object.hasOwn(CHANNELS, input.channel) && SHA.test(input.sourceSha) && DIGEST.test(input.inputsSha256) &&
    z.string().uuid().safeParse(input.actorUserId).success && z.string().uuid().safeParse(input.operationId).success &&
    input.kinds.length > 0 && input.kinds.every(kind => ["claude-api-key", "claude-setup-token", "codex-api-key", "codex-chatgpt", "cursor-api-key"].includes(kind)) &&
    new Set(input.kinds).size === input.kinds.length, "Invalid worker source/credential policy");
  let cleaned = false;
  try {
    const image = await deps.build();
    requireCheck(image.sourceCommit === input.sourceSha, "Worker build source differs from the event SHA");
    const evidence = [];
    for (const kind of input.kinds) {
      const result = await deps.qualify(image, kind);
      requireCheck(result.connection.kind === kind, "Canary credential kind mismatch");
      // Reuse only the pure report verifier. Replace the Dev channel label
      // before hashing and pass the release document through the real schema.
      const checked = nativeRuntimeEvidence(image, result.connection, result.outcome, result.startedAt);
      evidence.push(checked);
    }
    const first = evidence[0];
    requireCheck(evidence.every(row => row.runtimeContractSha256 === first.runtimeContractSha256), "Canaries measured different runtime contracts");
    const { evidenceSha256: _oldDigest, ...base } = first;
    const document = { ...base, channel: input.channel, credentials: evidence.flatMap(row => row.credentials),
      qualifiedAt: evidence.map(row => row.qualifiedAt).sort()[0] };
    const approvedEvidence = CloudAgentRuntimeEvidenceSchema.parse({ ...document,
      evidenceSha256: createHash("sha256").update(JSON.stringify(document)).digest("hex") });
    // Retire every credential-bearing canary before creating an approval.
    cleaned = await deps.cleanup();
    requireCheck(cleaned, "Worker canary cleanup is unconfirmed");
    const change = { operationId: input.operationId, actorUserId: input.actorUserId, enabled: true,
      reason: "Ordered channel worker promotion after native qualification", evidence: approvedEvidence };
    const approval = await deps.withOwner(async owner => {
      const login = owner.loginIdentity;
      const plan = await owner.manage(change);
      requireCheck(plan.state === "planned" && DIGEST.test(plan.planSha256 ?? ""), "Runtime approval plan missing");
      requireCheck(owner.loginIdentity === login, "Runtime approval login changed between plan and execute");
      const applied = await owner.manage(change, plan.planSha256);
      requireCheck(["changed", "replayed"].includes(applied.state) && applied.planSha256 === plan.planSha256 && applied.targetSha256 === plan.targetSha256,
        "Runtime approval execution does not match its plan");
      return plan.planSha256 as string;
    });
    requireCheck(approval.deleted, "Worker approval owner-role deletion is unconfirmed");
    const worker = WorkerIdentity.parse({ provider: "boat", imageRef: approvedEvidence.imageRef, sourceSha: image.sourceCommit,
      architecture: image.architecture, storageMiB: image.storageMiB });
    // One provider operation; skipDeploys must stay true in the adapter.
    await deps.updateIdentity({ CLOUD_WORKSPACE_PROVIDER: "boat", BOAT_SNAPSHOT_ID: image.snapshotId, BOAT_IMAGE_BUILD_SHA256: image.buildSha256,
      ZEROS_CLOUD_SOURCE_COMMIT: image.sourceCommit, ZEROS_CLOUD_IMAGE_ARCHITECTURE: image.architecture, CLOUD_WORKSPACE_STORAGE_MIB: String(image.storageMiB) });
    return WorkerReceipt.parse({ version: 1, status: "success", channel: input.channel, sourceSha: input.sourceSha,
      inputsSha256: input.inputsSha256, worker, evidenceSha256: approvedEvidence.evidenceSha256, approvalPlanSha256: approval.value,
      roleDeleted: true, resourcesDeleted: true, completedAt: new Date().toISOString() });
  } finally { if (!cleaned) await deps.cleanup(); }
}
