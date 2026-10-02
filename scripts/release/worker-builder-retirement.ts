import { createHash } from "node:crypto";
import { z } from "zod";
import { pollProvider } from "../dev-environment/provider-http.mjs";
import { imageContractSha256 } from "../cloud-workspace-validation/config";
import { DIGEST, SHA, requireCheck, type PromotionConfig } from "./contracts";
import { workerOwner, workerSnapshotName } from "./worker-admission";

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
type Context = { lease: any; record: any; profile: any; request: any; readAdmission?: () => Promise<any>; now?: () => number };

function accountBinding(profile: any) {
  const values = [profile.boat?.accountScope, profile.boat?.billingOrg, profile.railway?.projectId,
    profile.planetscale?.organization, profile.planetscale?.database, profile.cloudflare?.accountId];
  requireCheck(values.every(value => typeof value === "string" && value.length > 0), "Worker builder account provenance is missing");
  return hash(values);
}
async function ownedScope(config: PromotionConfig, context: Context) {
  const { lease, record, profile } = context, state = lease.state;
  const run = state?.releaseRuns?.find((value: any) => value.runId === config.runId);
  requireCheck(state?.owner === workerOwner(config.channel) && state.identity === hash(["release-worker", config.repository, config.channel]) &&
    state.resources?.images?.includes(record) && record.purpose === "release-worker" && record.releaseRunId === config.runId &&
    record.sourceCommit === config.sourceSha && run?.sourceSha === config.sourceSha && run.inputsSha256 === record.inputsSha256 &&
    record.snapshotId === workerSnapshotName(state, hash([config.sourceSha, config.runId])), "Worker builder release ownership is unconfirmed");
  const scope = creationScope.safeParse({ repository: config.repository, channel: config.channel, runId: config.runId, runAttempt: config.runAttempt,
    sourceSha: config.sourceSha, inputsSha256: record.inputsSha256, owner: state.owner, generation: state.generation,
    accountBinding: accountBinding(profile), protectedBaseSnapshot: profile.boat.baseSnapshot });
  requireCheck(scope.success && context.readAdmission, "Worker builder admission provenance is missing");
  const ledger = await context.readAdmission();
  requireCheck(ledger?.state?.version === 1 && ledger.state.owner === "account-admission" && ledger.state.account === scope.data.accountBinding &&
    ledger.state.reservations?.some((row: any) => row.kind === "builder" && row.owner === state.owner && row.generation === state.generation &&
      row.computeId === `snapshot:${record.snapshotId}` && row.snapshotName === record.snapshotId && !row.snapshotReleasedAt),
    "Worker builder admission ownership is unconfirmed");
  return scope.data;
}
export async function releaseBuilderCreationScope(config: PromotionConfig, context: Context) {
  return ownedScope(config, context);
}
function jsonProof(record: any, file: string) {
  let value;
  try { value = JSON.parse(record.kitFiles?.[file]); } catch { throw new Error("Worker builder kit provenance is missing or invalid"); }
  requireCheck(value && typeof value === "object", "Worker builder kit provenance is missing or invalid");
  return value;
}
function candidateMatches(left: any, right: any) {
  return ["snapshotId", "sourceCommit", "buildSha256", "architecture", "storageMiB"].every(key => left?.[key] === right?.[key]);
}
export function builderCleanupBelongsToRun(result: WorkerBuilderCleanup, expected: {
  repository: string; channel: string; runId: string; sourceSha: string; inputsSha256: string;
}, candidate: z.infer<typeof WorkerCandidateSchema>) {
  if (result.kind === "physically-deleted") return true;
  const scope = result.provenance.scope;
  return ["repository", "channel", "runId", "sourceSha", "inputsSha256"].every(key =>
    scope[key as keyof typeof scope] === expected[key as keyof typeof expected]) && candidateMatches(result.provenance.candidate, candidate);
}
async function provenance(config: PromotionConfig, context: Context, historical: boolean) {
  const { record, lease } = context, now = (context.now ?? Date.now)();
  const expected = await ownedScope(config, context), original = creationScope.safeParse(record.builderIntent?.scope);
  requireCheck(original.success && Object.keys(expected).every(key => key === "runAttempt"
    ? Number(original.data.runAttempt) <= Number(expected.runAttempt)
    : original.data[key as keyof typeof expected] === expected[key as keyof typeof expected]), "Worker builder original creation scope changed");
  const id = record.builder?.id;
  requireCheck(!lease.state.resources.images.some((image: any) => image !== record && image.builder?.id === id) &&
    !lease.state.releaseRuns.some((run: any) => run.canaries?.some((job: any) => job.target?.id === id)),
    "Worker image builder is also recorded as a native canary");
  let value = record.builderProvenance ?? record.builder.cleanup?.provenance;
  if (!value) {
    const prefix = config.sourceSha.slice(0, 12), source = jsonProof(record, `${prefix}/source.json`), generation = jsonProof(record, `${prefix}/generation.json`);
    const attestation = jsonProof(record, `${prefix}/native-attestation.json`), ledger = jsonProof(record, `${prefix}/snapshot-ledger.json`), builder = jsonProof(record, "builder.json");
    requireCheck(ledger.version === 1 && ledger.state === "ready" && record.qualified === true && record.snapshotRequested === true &&
      record.snapshotCreate?.phase === "acknowledged" && record.builderCreate?.phase === "acknowledged" &&
      generation.contract === imageContractSha256() && Number.isSafeInteger(source.archiveBytes) && source.archiveBytes > 0 &&
      Number.isSafeInteger(source.parts) && source.parts > 0 && Number.isSafeInteger(source.sourceFiles) && source.sourceFiles > 0 &&
      Number.isSafeInteger(attestation.resources?.allocation?.storageBytes) && attestation.resources.allocation.storageBytes > 0 &&
      record.builder.billingOrgConfirmed === true && record.builder.accountBinding === original.data.accountBinding,
      "Worker builder build/save provenance is incomplete");
    const sanitationProof = { qualified: ledger.sanitation?.qualified, sourceCommit: ledger.sanitation?.sourceCommit,
      buildSha256: ledger.sanitation?.buildSha256, observedAt: ledger.sanitation?.observedAt };
    requireCheck(Number.isFinite(record.builderIntent.at), "Worker builder creation timestamp is invalid");
    value = { version: 1, purpose: "release-worker", scope: original.data,
      creation: { sandboxId: builder.id, key: record.builderIntent.key, requestedAt: new Date(record.builderIntent.at).toISOString(), createdAt: builder.createdAt,
        body: record.builderIntent.body, bodySha256: hash(record.builderIntent.body), billingOrgConfirmed: true, billingObservedAt: record.builder.billingObservedAt },
      source: { commit: source.commit, parent: source.parent, tree: source.tree, archiveSha256: source.archiveSha256, exactMergedCommit: source.exactMergedCommit },
      generation: { commit: generation.commit, previous: generation.previous, contract: generation.contract, attempt: generation.attempt,
        scriptSha256: generation.scriptSha256, buildSha256: generation.buildSha256, snapshotName: generation.snapshotName },
      attestation: { qualified: attestation.qualified, secureSetup: attestation.setupQualification?.secure,
        sourceCommit: attestation.metadata?.build?.source?.commit, buildSha256: attestation.metadata?.buildSha256,
        storageMiB: Math.floor(attestation.resources.allocation.storageBytes / 1048576), sha256: hash(attestation) },
      snapshot: { name: ledger.name, sourceSandboxId: ledger.resourceId, sourceCommit: ledger.sourceCommit, buildSha256: ledger.buildSha256,
        savedAt: ledger.createdAt, readyObservedAt: ledger.lastObservedAt, sanitation: sanitationProof,
        sanitationSha256: hash(sanitationProof), sanitationReportSha256: hash(ledger.sanitation) }, candidate: record.candidate };
    requireCheck(builder.from === record.builderIntent.body.from && builder.type === record.builderIntent.body.type,
      "Worker builder original base/shape changed");
  }
  const parsed = WorkerBuilderProvenanceSchema.safeParse(value);
  requireCheck(parsed.success && Buffer.byteLength(JSON.stringify(parsed.data)) <= 4096 && parsed.data.creation.sandboxId === id &&
    hash(parsed.data.scope) === hash(original.data) && candidateMatches(parsed.data.candidate, record.candidate) &&
    parsed.data.candidate.buildSha256 === record.buildSha256 && parsed.data.creation.key === record.builderIntent.key &&
    Number.isFinite(record.builderIntent.at) && Date.parse(parsed.data.creation.requestedAt) === record.builderIntent.at &&
    parsed.data.creation.bodySha256 === hash(record.builderIntent.body) && Date.parse(parsed.data.snapshot.readyObservedAt) <= now + 5000 &&
    (historical || parsed.data.generation.contract === imageContractSha256()), "Worker builder provenance certificate is invalid");
  if (record.builder.cleanup?.kind === "release-owned-sanitized-unavailable") {
    const cleanup = WorkerBuilderCleanupSchema.safeParse(record.builder.cleanup);
    requireCheck(cleanup.success && cleanup.data.kind === "release-owned-sanitized-unavailable" && cleanup.data.provenanceSha256 === hash(parsed.data) &&
      cleanup.data.sandboxId === id && cleanup.data.deletionOperationId === record.builder.deletionOperationId,
      "Worker builder retained cleanup proof changed");
  }
  return parsed.data;
}
async function readySnapshot(context: Context) {
  const { record, request } = context;
  const response = await request("GET", `/named-snapshots/${record.snapshotId}`), snapshot = response.body?.snapshot;
  requireCheck(response.status === 200 && snapshot?.name === record.snapshotId && snapshot.status === "ready" && snapshot.sourceSandboxId === record.builder.id,
    "Worker builder retained candidate identity is unconfirmed");
}
function validObservation(value: unknown, now: number) {
  const parsed = WorkerBuilderCleanupSchema.safeParse(value);
  requireCheck(parsed.success && Date.parse(parsed.data.unavailableObservedAt) <= now + 5000,
    "Worker builder cleanup observation is invalid");
  return parsed.data;
}
export async function retireReleaseBuilder(config: PromotionConfig, context: Context, options: { observeOnly?: boolean; historical?: boolean } = {}) {
  const { lease, record, request } = context, builder = record.builder, now = context.now ?? Date.now;
  requireCheck(sandboxId.safeParse(builder?.id).success, "Worker builder allocation is unconfirmed");
  requireCheck(!builder.deleteRequested || operationId.safeParse(builder.deletionOperationId).success,
    "Worker builder deletion response was lost; reconcile its terminal operation before retrying");
  let proof: WorkerBuilderProvenance | undefined;
  if (record.builderProvenance || builder.cleanup?.kind === "release-owned-sanitized-unavailable" || record.candidate && record.builderIntent?.scope) {
    proof = await provenance(config, context, options.historical === true);
    if (!builder.deleted && !builder.deletionOperationId) await readySnapshot(context);
    if (!record.builderProvenance && !builder.cleanup?.provenance) { record.builderProvenance = proof; await lease.save(); }
  }
  if (!builder.deletionOperationId) {
    requireCheck(!builder.deleted && !options.observeOnly, "Worker builder terminal operation is missing");
    builder.deleteRequested = true; await lease.save(); await lease.fence();
    const response = await request("DELETE", `/sandboxes/${builder.id}`, { headers: { "x-ascii-confirm-delete": builder.id } }), operation = response.body?.operation;
    requireCheck(response.status >= 200 && response.status < 300 && operationId.safeParse(operation?.id).success &&
      operation.kind === "sandbox" && operation.targetId === builder.id, "Worker builder deletion is unconfirmed; a 404 is not physical proof");
    builder.deletionOperationId = operation.id; builder.deletionAcceptedAt = new Date(now()).toISOString(); await lease.save();
  }
  const polling = { signal: lease.signal, timeout: options.observeOnly ? 0 : 300_000 };
  const result = await pollProvider("Worker builder retirement", async () => {
    const response = await request("GET", `/deletion-operations/${builder.deletionOperationId}`), operation = response.body?.operation;
    requireCheck(response.status === 200 && operation?.id === builder.deletionOperationId && operation.kind === "sandbox" && operation.targetId === builder.id,
      "Worker builder deletion proof changed");
    const operationObservedAt = new Date(now()).toISOString();
    if (operation.status !== "completed" && operation.status !== "blocked") {
      requireCheck(["pending", "processing"].includes(operation.status), "Worker builder deletion status is unknown");
      return false;
    }
    let value: unknown;
    if (operation.status === "completed") {
      const terminal = completedOperation.safeParse({ id: operation.id, kind: operation.kind, targetId: operation.targetId,
        status: operation.status, completedAt: operation.completedAt });
      requireCheck(terminal.success && (!proof || Date.parse(terminal.data.completedAt) >= Date.parse(proof.creation.requestedAt) - 5000),
        "Worker builder physical deletion is unconfirmed");
      value = { kind: "physically-deleted", sandboxId: builder.id, deletionOperationId: builder.deletionOperationId,
        operation: terminal.data, operationObservedAt, unavailableObservedAt: operationObservedAt, completedAt: terminal.data.completedAt };
    } else {
      requireCheck(proof && !builder.deleted, "Worker builder deferred-storage provenance is unconfirmed");
      const pending = pendingOperation.safeParse({ id: operation.id, kind: operation.kind, targetId: operation.targetId,
        status: operation.status, stage: operation.stage, expectedBy: operation.expectedBy ?? null });
      requireCheck(pending.success, "Worker builder pending-storage stage/deadline is invalid");
      await readySnapshot(context);
      value = { kind: "release-owned-sanitized-unavailable", sandboxId: builder.id, deletionOperationId: builder.deletionOperationId,
        operation: pending.data, operationObservedAt, unavailableObservedAt: operationObservedAt, provenance: proof, provenanceSha256: hash(proof),
        storage: { status: "pending", scope: "sandbox-unshared-snapshots-and-machine-data", stage: pending.data.stage,
          expectedBy: pending.data.expectedBy, physicalBytes: "unmeasured" } };
    }
    validObservation(value, now());
    const sandbox = await request("GET", `/sandboxes/${builder.id}`);
    requireCheck(sandbox.status === 404, "Worker builder is not confirmed irreversibly unavailable");
    return validObservation({ ...value as object, unavailableObservedAt: new Date(now()).toISOString() }, now());
  }, polling);
  if (result.kind === "physically-deleted" && proof) record.builderProvenance = proof;
  builder.cleanup = result; await lease.save();
  if (result.kind === "physically-deleted") builder.deleted = true;
  else { builder.deleted = false; builder.retiredAt ??= result.unavailableObservedAt; delete record.builderProvenance; }
  await lease.save();
  if (record.candidate && record.kitFiles) { delete record.kitFiles; await lease.save(); }
  return result as WorkerBuilderCleanup;
}

export async function reconcileReleaseBuilderRetentions(config: PromotionConfig, context: Omit<Context, "record">, options: {
  maxRecords?: number; budgetMs?: number;
} = {}) {
  const maxRecords = options.maxRecords ?? 16, budgetMs = options.budgetMs ?? 15_000, now = context.now ?? Date.now;
  requireCheck(Number.isSafeInteger(maxRecords) && maxRecords > 0 && maxRecords <= 100 && Number.isFinite(budgetMs) && budgetMs >= 100,
    "Worker builder retention observation budget is invalid");
  const pending = (context.lease.state.resources.images ?? []).filter((record: any) => !record.builder?.deleted &&
    (record.builder?.retiredAt || record.builder?.cleanup) && (record.purpose === "release-worker" || record.releaseRunId !== undefined ||
      record.builder?.cleanup?.provenance?.purpose === "release-worker"))
    .sort((left: any, right: any) => (Date.parse(left.builder.lastReconcileAt) || 0) - (Date.parse(right.builder.lastReconcileAt) || 0));
  for (const record of pending) {
    try {
      const saved = validObservation(record.builder.cleanup, now());
      requireCheck(record.purpose === "release-worker" && saved.sandboxId === record.builder.id && saved.deletionOperationId === record.builder.deletionOperationId,
        "Worker builder retained cleanup ownership changed");
      if (saved.kind === "release-owned-sanitized-unavailable") {
        const scope = saved.provenance.scope;
        requireCheck(scope.repository === config.repository && scope.channel === config.channel && scope.owner === context.lease.state.owner &&
          scope.generation === context.lease.state.generation && scope.accountBinding === accountBinding(context.profile) &&
          scope.runId === record.releaseRunId && scope.sourceSha === record.sourceCommit && scope.inputsSha256 === record.inputsSha256 &&
          hash(scope) === hash(record.builderIntent?.scope) && candidateMatches(saved.provenance.candidate, record.candidate),
          "Worker builder retained provenance ownership changed");
      }
    } catch {
      record.builder.reconcileUnconfirmed = true; await context.lease.save();
      throw new Error("Worker builder retained storage is unconfirmed; retain its operation/provenance for reconciliation");
    }
  }
  const deadline = now() + budgetMs;
  let unconfirmed = false;
  for (const record of pending.slice(0, maxRecords)) {
    if (deadline - now() < 100) break;
    record.builder.lastReconcileAt = new Date(now()).toISOString();
    try {
      const historical = { ...config, sourceSha: record.sourceCommit, runId: record.releaseRunId, runAttempt: record.builderIntent?.scope?.runAttempt ?? config.runAttempt };
      await retireReleaseBuilder(historical, { ...context, record,
        request: (method: string, route: string, settings: any = {}) => {
          requireCheck(deadline - now() >= 100, "Worker builder retention observation deadline reached");
          return context.request(method, route, { ...settings, timeoutMs: Math.min(15_000, deadline - now()) });
        } }, { observeOnly: true, historical: true });
      delete record.builder.reconcileUnconfirmed;
    } catch { record.builder.reconcileUnconfirmed = true; unconfirmed = true; }
    await context.lease.save();
  }
  requireCheck(!unconfirmed, "Worker builder retained storage is unconfirmed; retain its operation/provenance for reconciliation");
}
