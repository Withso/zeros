import { createHash } from "node:crypto";
import type { z } from "zod";
import { pollProvider } from "../dev-environment/provider-http.mjs";
import { imageContractSha256 } from "../cloud-workspace-validation/config";
import { requireCheck, type PromotionConfig } from "./contracts";
import { workerOwner, workerSnapshotName } from "./worker-owner";
import { WorkerBuilderCleanupSchema, WorkerBuilderProvenanceSchema, WorkerCandidateSchema,
  WorkerBuilderSandboxIdSchema as sandboxId, WorkerBuilderDeletionOperationIdSchema as operationId,
  WorkerBuilderScopeSchema as creationScope, WorkerBuilderCompletedOperationSchema as completedOperation,
  WorkerBuilderPendingOperationSchema as pendingOperation, type WorkerBuilderCleanup, type WorkerBuilderProvenance } from "./worker-builder-contracts";
import { assertHistoricalWorkerNameRetirement } from "./worker-named-retirement";
import { WorkerFailedBuildProvenanceSchema, WorkerFailedBuildRetirementSchema } from "./worker-builder-contracts";
import { releaseHostedAdmission } from "../dev-environment/hosted-admission.mjs";
export * from "./worker-builder-contracts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Context = { lease: any; record: any; profile: any; request: any; readAdmission?: () => Promise<any>; now?: () => number };

function accountBinding(profile: any) {
  const values = [profile.boat?.accountScope, profile.boat?.billingOrg, profile.railway?.projectId,
    profile.planetscale?.organization, profile.planetscale?.database, profile.cloudflare?.accountId];
  requireCheck(values.every(value => typeof value === "string" && value.length > 0), "Worker builder account provenance is missing");
  return hash(values);
}
function releaseScope(config: PromotionConfig, context: Context) {
  const { lease, record, profile } = context, state = lease.state;
  const run = state?.releaseRuns?.find((value: any) => value.runId === config.runId);
  requireCheck(state?.owner === workerOwner(config.channel) && state.identity === hash(["release-worker", config.repository, config.channel]) &&
    state.resources?.images?.includes(record) && record.purpose === "release-worker" && record.releaseRunId === config.runId &&
    record.sourceCommit === config.sourceSha && run?.sourceSha === config.sourceSha && run.inputsSha256 === record.inputsSha256 &&
    record.snapshotId === workerSnapshotName(state, hash([config.sourceSha, config.runId])), "Worker builder release ownership is unconfirmed");
  const scope = creationScope.safeParse({ repository: config.repository, channel: config.channel, runId: config.runId, runAttempt: config.runAttempt,
    sourceSha: config.sourceSha, inputsSha256: record.inputsSha256, owner: state.owner, generation: state.generation,
    accountBinding: accountBinding(profile), protectedBaseSnapshot: profile.boat.baseSnapshot });
  requireCheck(scope.success, "Worker builder admission provenance is missing");
  return scope.data;
}
async function ownedScope(config: PromotionConfig, context: Context, retiredName = false) {
  const { lease, record, profile } = context, state = lease.state, scope = releaseScope(config, context);
  requireCheck(context.readAdmission, "Worker builder admission provenance is missing");
  const ledger = await context.readAdmission();
  if (retiredName) {
    await lease.fence();
    assertHistoricalWorkerNameRetirement(state, ledger?.state, profile, record, (context.now ?? Date.now)());
    return scope;
  }
  requireCheck(ledger?.state?.version === 1 && ledger.state.owner === "account-admission" && ledger.state.account === scope.accountBinding &&
    ledger.state.reservations?.some((row: any) => row.kind === "builder" && row.owner === state.owner && row.generation === state.generation &&
      row.computeId === `snapshot:${record.snapshotId}` && row.snapshotName === record.snapshotId && !row.snapshotReleasedAt),
    "Worker builder admission ownership is unconfirmed");
  return scope;
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
async function provenance(config: PromotionConfig, context: Context, historical: boolean, retiredName = false) {
  const { record, lease } = context, now = (context.now ?? Date.now)();
  const expected = await ownedScope(config, context, retiredName), original = creationScope.safeParse(record.builderIntent?.scope);
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

function failedBuildProvenance(config: PromotionConfig, context: Context) {
  const { record, lease } = context, expected = releaseScope(config, context), builder = record.builder;
  requireCheck(record.candidate === undefined && record.qualified !== true && record.snapshotRequested !== true &&
    record.snapshotCreate === undefined && record.builderProvenance === undefined && builder?.cleanup === undefined &&
    record.builderCreate?.phase === "acknowledged" && builder.billingOrgConfirmed === true &&
    builder.accountBinding === expected.accountBinding && Number.isFinite(record.builderIntent?.at),
    "Worker failed builder must have an acknowledged creation and no capture or candidate");
  const original = creationScope.safeParse(record.builderIntent.scope);
  requireCheck(original.success && Object.keys(expected).every(key => key === "runAttempt"
    ? Number(original.data.runAttempt) <= Number(expected.runAttempt)
    : original.data[key as keyof typeof expected] === expected[key as keyof typeof expected]), "Worker failed builder original scope changed");
  const prefix = config.sourceSha.slice(0, 12), source = jsonProof(record, `${prefix}/source.json`), created = jsonProof(record, "builder.json");
  const proof = WorkerFailedBuildProvenanceSchema.safeParse({ scope: original.data,
    creation: { sandboxId: created.id, key: record.builderIntent.key, requestedAt: new Date(record.builderIntent.at).toISOString(),
      createdAt: created.createdAt, body: record.builderIntent.body, bodySha256: hash(record.builderIntent.body),
      billingOrgConfirmed: builder.billingOrgConfirmed, billingObservedAt: builder.billingObservedAt },
    source: { commit: source.commit, parent: source.parent, tree: source.tree, archiveSha256: source.archiveSha256, exactMergedCommit: source.exactMergedCommit } });
  requireCheck(proof.success && proof.data.creation.sandboxId === builder.id && created.from === proof.data.creation.body.from &&
    created.type === proof.data.creation.body.type &&
    !lease.state.resources.images.some((image: any) => image !== record && image.builder?.id === builder.id) &&
    !lease.state.releaseRuns.some((run: any) => run.canaries?.some((job: any) => job.target?.id === builder.id)),
    "Worker failed builder original creation/source provenance is invalid");
  return proof.data;
}
function savedFailedBuild(config: PromotionConfig, context: Context) {
  const parsed = WorkerFailedBuildRetirementSchema.safeParse(context.record.builder?.failedBuildRetirement), now = (context.now ?? Date.now)();
  requireCheck(parsed.success && parsed.data.provenanceSha256 === hash(failedBuildProvenance(config, context)) &&
    parsed.data.operation.id === context.record.builder.deletionOperationId && parsed.data.snapshotName === context.record.snapshotId &&
    Date.parse(parsed.data.snapshotAbsentObservedAt) <= now + 5000,
    "Worker failed builder retained retirement proof changed");
  return parsed.data;
}
/** Retire only compute for an uncaptured failed build. Never issue an image
 * cleanup/publication proof or discard its diagnostic and storage history. */
export async function retireFailedReleaseBuilder(config: PromotionConfig, context: Context, observeOnly = false) {
  const { lease, record, request } = context, builder = record.builder, now = context.now ?? Date.now;
  const proof = failedBuildProvenance(config, context);
  requireCheck(context.readAdmission, "Worker failed builder admission is missing");
  const ledger = (await context.readAdmission())?.state;
  requireCheck(ledger?.version === 1 && ledger.owner === "account-admission" && ledger.account === proof.scope.accountBinding &&
    Array.isArray(ledger.reservations), "Worker failed builder admission account changed");
  if (builder.failedBuildRetirement !== undefined) savedFailedBuild(config, context);
  const held = ledger.reservations.find((row: any) => row.kind === "builder" && row.owner === proof.scope.owner &&
    row.generation === proof.scope.generation && row.computeId === `snapshot:${record.snapshotId}` && row.snapshotName === record.snapshotId);
  requireCheck(held && !held.snapshotReleasedAt || !held && builder.retiredAt && builder.failedBuildRetirement,
    "Worker failed builder original reservation is missing");
  requireCheck(!builder.deleteRequested || operationId.safeParse(builder.deletionOperationId).success,
    "Worker failed builder deletion response was lost; retain its hold");
  requireCheck(!builder.deletionOperationId || builder.deleteRequested === true && operationId.safeParse(builder.deletionOperationId).success,
    "Worker failed builder deletion acknowledgement is invalid");
  await lease.fence();
  if (!builder.deletionOperationId) {
    requireCheck(!observeOnly && !builder.deleted && !builder.retiredAt, "Worker failed builder deletion acknowledgement is missing");
    builder.deleteRequested = true; await lease.save(); await lease.fence();
    const response = await request("DELETE", `/sandboxes/${builder.id}`, { headers: { "x-ascii-confirm-delete": builder.id } }), operation = response.body?.operation;
    requireCheck(response.status >= 200 && response.status < 300 && operationId.safeParse(operation?.id).success &&
      operation.kind === "sandbox" && operation.targetId === builder.id, "Worker failed builder deletion is unconfirmed");
    builder.deletionOperationId = operation.id; builder.deletionAcceptedAt = new Date(now()).toISOString(); await lease.save();
  }
  const polling = { signal: lease.signal, timeout: observeOnly ? 0 : 300_000 };
  const result = await pollProvider("Worker failed builder retirement", async () => {
    const response = await request("GET", `/deletion-operations/${builder.deletionOperationId}`), operation = response.body?.operation;
    requireCheck(response.status === 200 && operation?.id === builder.deletionOperationId && operation.kind === "sandbox" && operation.targetId === builder.id,
      "Worker failed builder deletion proof changed");
    if (["pending", "processing"].includes(operation.status)) return false;
    const parsed = operation.status === "completed"
      ? completedOperation.safeParse({ id: operation.id, kind: operation.kind, targetId: operation.targetId, status: operation.status, completedAt: operation.completedAt })
      : pendingOperation.safeParse({ id: operation.id, kind: operation.kind, targetId: operation.targetId, status: operation.status,
        stage: operation.stage, expectedBy: operation.expectedBy ?? null });
    requireCheck(parsed.success, "Worker failed builder deletion operation is invalid");
    const operationObservedAt = new Date(now()).toISOString();
    requireCheck((await request("GET", `/sandboxes/${builder.id}`)).status === 404, "Worker failed builder remains available");
    const unavailableObservedAt = new Date(now()).toISOString();
    requireCheck((await request("GET", `/named-snapshots/${record.snapshotId}`)).status === 404, "Worker failed builder unexpectedly has a named image");
    const result = WorkerFailedBuildRetirementSchema.safeParse({ version: 1, kind: "failed-build-unavailable", provenance: proof,
      provenanceSha256: hash(proof), snapshotName: record.snapshotId, operation: parsed.data, operationObservedAt, unavailableObservedAt,
      snapshotAbsentObservedAt: new Date(now()).toISOString(), storage: { status: parsed.data.status === "completed" ? "completed" : "pending", physicalBytes: "unmeasured" } });
    requireCheck(result.success, "Worker failed builder retirement observation is invalid");
    return result.data;
  }, polling);
  await lease.fence();
  builder.failedBuildRetirement = result; await lease.save();
  builder.deleted = result.operation.status === "completed"; builder.retiredAt ??= result.unavailableObservedAt; await lease.save();
}

/** Only an acknowledged failed build still occupying this owner's compute
 * slot is observed on demand. This does not resume historical storage scans. */
export async function reconcileFailedReleaseBuilderHolds(config: PromotionConfig, context: Omit<Context, "record">, store: any) {
  requireCheck(context.readAdmission, "Worker failed builder admission is missing");
  const ledger = (await context.readAdmission())?.state, state = context.lease.state;
  requireCheck(ledger?.account === accountBinding(context.profile) && Array.isArray(ledger?.reservations), "Worker failed builder admission account changed");
  for (const row of ledger.reservations.filter((row: any) => row.kind === "builder" && !row.releasedAt && row.owner === state.owner && row.generation === state.generation)) {
    const record = state.resources.images.find((image: any) => row.computeId === `snapshot:${image.snapshotId}` && row.snapshotName === image.snapshotId);
    if (!record || record.purpose !== "release-worker" || record.candidate || record.snapshotRequested || record.snapshotCreate ||
      !record.builder?.deleteRequested || !record.builder?.deletionOperationId) continue;
    const original = { ...config, runId: record.releaseRunId, sourceSha: record.sourceCommit, runAttempt: record.builderIntent?.scope?.runAttempt };
    await retireFailedReleaseBuilder(original, { ...context, record }, true);
    await releaseHostedAdmission(store, context.lease, context.profile);
  }
}

export async function retireReleaseBuilder(config: PromotionConfig, context: Context, options: { observeOnly?: boolean; historical?: boolean } = {}) {
  const { lease, record, request } = context, builder = record.builder, now = context.now ?? Date.now;
  const retiredName = options.observeOnly === true && options.historical === true && record.snapshotNameRetirement !== undefined;
  requireCheck(sandboxId.safeParse(builder?.id).success, "Worker builder allocation is unconfirmed");
  requireCheck(!builder.deleteRequested || operationId.safeParse(builder.deletionOperationId).success,
    "Worker builder deletion response was lost; reconcile its terminal operation before retrying");
  let proof: WorkerBuilderProvenance | undefined;
  if (record.builderProvenance || builder.cleanup?.kind === "release-owned-sanitized-unavailable" || record.candidate && record.builderIntent?.scope) {
    proof = await provenance(config, context, options.historical === true, retiredName);
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
      if (!retiredName) await readySnapshot(context);
      value = { kind: "release-owned-sanitized-unavailable", sandboxId: builder.id, deletionOperationId: builder.deletionOperationId,
        operation: pending.data, operationObservedAt, unavailableObservedAt: operationObservedAt, provenance: proof, provenanceSha256: hash(proof),
        storage: { status: "pending", scope: "sandbox-unshared-snapshots-and-machine-data", stage: pending.data.stage,
          expectedBy: pending.data.expectedBy, physicalBytes: "unmeasured" } };
    }
    validObservation(value, now());
    const sandbox = await request("GET", `/sandboxes/${builder.id}`);
    requireCheck(sandbox.status === 404, "Worker builder is not confirmed irreversibly unavailable");
    if (retiredName) {
      const named = await request("GET", `/named-snapshots/${record.snapshotId}`);
      requireCheck(named.status === 404, "Worker builder retired name has reappeared");
    }
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
  const failed = (context.lease.state.resources.images ?? []).filter((record: any) => record.builder?.failedBuildRetirement !== undefined);
  for (const record of failed) savedFailedBuild({ ...config, sourceSha: record.sourceCommit, runId: record.releaseRunId,
    runAttempt: record.builderIntent?.scope?.runAttempt }, { ...context, record });
  const pending = (context.lease.state.resources.images ?? []).filter((record: any) => !record.builder?.deleted &&
    record.builder?.failedBuildRetirement === undefined &&
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
