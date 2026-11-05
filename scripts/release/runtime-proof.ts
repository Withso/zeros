import { createHash } from "node:crypto";
import { z } from "zod";
import { RuntimeCanaryReceiptSchema, RuntimeReleaseSchema, type RuntimeRelease } from "../../apps/control-plane/src/cloud/runtime-release";
import { requireCheck } from "./contracts";
import { RuntimeBuildSchema, RuntimeQualification, type RuntimeManifest, type RuntimeReleaseConfig } from "./runtime-contracts";
import type { ReleaseCanary } from "./runtime-canary";

export function runtimeJson(value: unknown): string {
  const sorted = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(sorted) : entry && typeof entry === "object"
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sorted(item)])) : entry;
  return JSON.stringify(sorted(value)) + "\n";
}
export const runtimeJsonSha256 = (value: unknown) => createHash("sha256").update(runtimeJson(value)).digest("hex");

export function qualifiedRuntime(config: RuntimeReleaseConfig, manifest: RuntimeManifest, canary: ReleaseCanary,
  value: unknown, cleanup: { deleted: true; workspaceId: string | null }): RuntimeQualification {
  const parsed = RuntimeCanaryReceiptSchema.safeParse(value);
  requireCheck(config.channel === "alpha" && parsed.success, "Runtime qualification receipt is invalid");
  const receipt = parsed.data, claims = canary.claims;
  requireCheck(receipt.cpSourceSha === config.expectedCpSha && receipt.previousRuntimeSha256 === config.expectedRuntimeSha256 &&
    receipt.runId === config.runId && receipt.runAttempt === config.runAttempt && receipt.grantId === claims.jti &&
    receipt.runtimeSha256 === manifest.sha256 && receipt.sourceSha === manifest.sourceSha &&
    claims.runtimeSha256 === manifest.sha256 && claims.sourceSha === manifest.sourceSha &&
    receipt.creatorUserId === claims.creatorUserId && receipt.organizationId === claims.organizationId && receipt.repositoryId === claims.repositoryId &&
    cleanup.deleted === true && cleanup.workspaceId === receipt.workspaceId &&
    Date.parse(receipt.completedAt) >= claims.iat * 1000 - 30_000 && Date.parse(receipt.completedAt) <= Date.now() + 30_000,
    "Runtime qualification does not prove this exact candidate and cleanup");
  const release = RuntimeReleaseSchema.parse({ version: 1, sha256: manifest.sha256, sourceSha: manifest.sourceSha, sourceSha256: manifest.sourceSha256,
    qualification: { channel: "alpha", runId: config.runId, runAttempt: config.runAttempt,
      completedAt: receipt.completedAt, receiptSha256: runtimeJsonSha256(receipt), deleted: true } });
  return RuntimeQualification.parse({ version: 1, repository: config.repository, workflowSha: config.workflowSha, manifest, receipt, release });
}

const WorkflowRun = z.object({ id: z.number().int().positive(), run_attempt: z.number().int().positive(),
  head_sha: z.string(), head_branch: z.string(), path: z.string(), event: z.string(), status: z.string(), conclusion: z.string().nullable(),
  repository: z.object({ full_name: z.string() }), head_repository: z.object({ full_name: z.string() }) });
const Jobs = z.object({ total_count: z.number().int().min(0).max(100), jobs: z.array(z.object({
  run_id: z.number(), run_attempt: z.number().optional(), head_sha: z.string(), name: z.string(), status: z.string(), conclusion: z.string().nullable(),
  steps: z.array(z.object({ name: z.string(), conclusion: z.string().nullable() })),
})) });

export function assertRuntimeBuildProducer(config: Pick<RuntimeReleaseConfig, "runId" | "runAttempt" | "workflowSha">, value: unknown): void {
  const jobs = Jobs.safeParse(value);
  requireCheck(jobs.success && jobs.data.total_count === jobs.data.jobs.length && jobs.data.jobs.filter(job =>
    String(job.run_id) === config.runId && (job.run_attempt === undefined || job.run_attempt === config.runAttempt) && job.head_sha === config.workflowSha &&
    job.name === "Runtime archive build" && job.status === "completed" && job.conclusion === "success" &&
    ["Build exact runtime", "Save runtime archive"].every(name => job.steps.some(step => step.name === name && step.conclusion === "success"))).length === 1,
    "Runtime archive lacks its successful exact-attempt publication producer");
}

export async function verifyRuntimeQualification(config: RuntimeReleaseConfig, manifest: RuntimeManifest, value: unknown, deps: {
  read(path: string): Promise<unknown>;
  artifact(runId: string, attempt: number): Promise<unknown>;
  buildArtifact(runId: string, attempt: number): Promise<unknown>;
  mainSource(sourceSha: string): Promise<void>;
  sameControlPlane(left: string, right: string): Promise<boolean>;
}, pinnedPrevious?: RuntimeRelease): Promise<RuntimeQualification> {
  const parsed = RuntimeQualification.safeParse(value);
  requireCheck(parsed.success, "Retained runtime qualification is invalid");
  const record = parsed.data, proof = record.release.qualification, receipt = record.receipt;
  requireCheck(record.repository === config.repository && runtimeJson(record.manifest) === runtimeJson(manifest) &&
    record.release.sha256 === manifest.sha256 && record.release.sourceSha === manifest.sourceSha && record.release.sourceSha256 === manifest.sourceSha256 &&
    receipt.runtimeSha256 === manifest.sha256 && receipt.sourceSha === manifest.sourceSha && receipt.runId === proof.runId && receipt.runAttempt === proof.runAttempt &&
    runtimeJsonSha256(receipt) === proof.receiptSha256 && receipt.completedAt === proof.completedAt,
    "Retained Alpha qualification does not match this archive");
  if (config.action === "rollback") {
    // The prior pin's receipt hash remains authoritative after GitHub artifacts expire.
    const pinned = RuntimeReleaseSchema.safeParse(pinnedPrevious);
    requireCheck(config.channel !== "alpha" && pinned.success && runtimeJson(pinned.data) === runtimeJson(record.release),
      "Rollback qualification differs from the channel's recorded previous pin");
    requireCheck(await deps.sameControlPlane(receipt.cpSourceSha, config.expectedCpSha), "Destination control-plane code differs from the previous runtime qualification");
    return record;
  }
  const run = WorkflowRun.safeParse(await deps.read(`/actions/runs/${proof.runId}/attempts/${proof.runAttempt}`));
  requireCheck(run.success && String(run.data.id) === proof.runId && run.data.run_attempt === proof.runAttempt &&
    run.data.head_sha === record.workflowSha && run.data.head_branch === "main" && run.data.path === ".github/workflows/runtime-release.yml" &&
    run.data.event === "workflow_dispatch" && run.data.status === "completed" && run.data.conclusion === "success" &&
    run.data.repository.full_name === config.repository && run.data.head_repository.full_name === config.repository,
    "Runtime qualification has no successful trusted Alpha workflow attempt");
  const jobs = Jobs.safeParse(await deps.read(`/actions/runs/${proof.runId}/attempts/${proof.runAttempt}/jobs?per_page=100`));
  requireCheck(jobs.success && jobs.data.jobs.length === jobs.data.total_count && jobs.data.jobs.some(job => job.run_id === run.data.id &&
    (job.run_attempt === undefined || job.run_attempt === proof.runAttempt) && job.head_sha === record.workflowSha &&
    job.name === "Runtime release transaction" && job.status === "completed" && job.conclusion === "success" &&
    ["Qualify and pin runtime", "Save runtime receipt"].every(name => job.steps.some(step => step.name === name && step.conclusion === "success"))),
    "Runtime qualification has no successful producing job");
  assertRuntimeBuildProducer({ runId: proof.runId, runAttempt: proof.runAttempt, workflowSha: record.workflowSha }, jobs.data);
  const build = RuntimeBuildSchema.safeParse(await deps.buildArtifact(proof.runId, proof.runAttempt));
  requireCheck(build.success && build.data.repository === config.repository && build.data.workflowSha === record.workflowSha &&
    build.data.runId === proof.runId && build.data.runAttempt === proof.runAttempt && runtimeJson(build.data.manifest) === runtimeJson(manifest),
    "Runtime qualification differs from its exact publication build artifact");
  await deps.mainSource(record.workflowSha);
  if (manifest.sourceSha !== record.workflowSha) await deps.mainSource(manifest.sourceSha);
  const artifact = RuntimeQualification.safeParse(await deps.artifact(proof.runId, proof.runAttempt));
  requireCheck(artifact.success && runtimeJson(artifact.data) === runtimeJson(record), "Runtime qualification differs from its trusted workflow artifact");
  requireCheck(await deps.sameControlPlane(receipt.cpSourceSha, config.expectedCpSha), "Destination control-plane code differs from Alpha qualification; qualify against the matching code before promotion");
  return record;
}
