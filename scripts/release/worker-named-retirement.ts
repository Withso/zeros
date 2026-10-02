import { createHash } from "node:crypto";
import { z } from "zod";
import { requireCheck } from "./contracts";
import { workerOwner, workerSnapshotName } from "./worker-owner";
import { WorkerBuilderCleanupSchema, WorkerBuilderProvenanceSchema, WorkerCandidateSchema,
  WorkerBuilderCompletedOperationSchema, WorkerBuilderPendingOperationSchema } from "./worker-builder-contracts";
import { NativeCanaryDeletionOperationSchema, NativeCanaryStorageOperationSchema, NativeCanaryStorageProgressSchema,
  ReleaseCanaryAdmissionSchema } from "../../apps/control-plane/src/cloud-workspaces/release-canary-contract";
import { releaseCanaryRetirementJournal } from "../../apps/control-plane/src/cloud-workspaces/release-canary-retirement";
import { WORKER_NAMED_REFERENCE_DOMAINS, WorkerNamedAdmissionLedgerSchema, WorkerNamedDeleteAcknowledgementSchema,
  WorkerNamedRetirementReviewSchema, WorkerNamedReviewEvidenceSchema, WorkerNamedReservationSchema, WorkerNameRetirementSchema, workerNamedRetirementSha256 as hash,
  type WorkerNameRetirement, type WorkerNamedDeleteAcknowledgement, type WorkerNamedReviewEvidence } from "./worker-named-retirement-contracts";
export * from "./worker-named-retirement-contracts";

const rawHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (left: unknown, right: unknown) => left === undefined || right === undefined ? left === right : hash(left) === hash(right);
const at = (value: string) => Date.parse(value);
const unique = (values: string[]) => new Set(values).size === values.length;
function read<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown, message: string): T {
  const result = schema.safeParse(value); requireCheck(result.success, message); return result.data;
}
function account(profile: any) {
  const values = [profile.boat?.accountScope, profile.boat?.billingOrg, profile.railway?.projectId,
    profile.planetscale?.organization, profile.planetscale?.database, profile.cloudflare?.accountId];
  requireCheck(values.every(value => typeof value === "string" && value.length > 0), "Named retirement account provenance is missing");
  return rawHash(values);
}
function ledgerProof(value: unknown, profile: any) {
  const ledger = read(WorkerNamedAdmissionLedgerSchema, value, "Named retirement admission ledger is invalid");
  requireCheck(ledger.account === account(profile) && unique(ledger.reservations.map(row =>
    `${row.kind}/${row.owner}/${row.generation}/${row.computeId ?? row.snapshotName ?? ""}`)), "Named retirement admission ownership is unconfirmed");
  return ledger;
}
function fresh(time: string, now: number) { return at(time) <= now && now - at(time) <= 60_000; }
function reviewWindow(evidence: WorkerNamedReviewEvidence, now: number) {
  const observations = [evidence.observedAt, evidence.inventory.observedAt, ...evidence.references.map(row => row.observedAt),
    ...evidence.audit.natives.map(row => row.audit.observedAt)];
  const exclusion = evidence.exclusion;
  requireCheck(observations.every(value => fresh(value, now)) && at(evidence.expiresAt) > now &&
    at(evidence.expiresAt) - Math.min(...observations.map(at)) <= 60_000 &&
    at(evidence.bundle.reviewedAt) >= Math.max(...observations.map(at)) && at(evidence.bundle.reviewedAt) <= now &&
    at(exclusion.startedAt) <= Math.min(...observations.map(at)) && at(exclusion.expiresAt) > now &&
    at(exclusion.expiresAt) - at(exclusion.startedAt) <= 300_000 &&
    exclusion.accountBinding === evidence.scope.accountBinding && exclusion.owners.includes(evidence.scope.owner) && unique(exclusion.owners),
  "Named retirement review or writer exclusion is stale");
  requireCheck(unique(evidence.references.map(row => row.domain)) && WORKER_NAMED_REFERENCE_DOMAINS.every(domain =>
    evidence.references.some(row => row.domain === domain)), "Named retirement reference scope is incomplete");
  const namespaces = evidence.references.flatMap(domain => domain.authorities.map(authority => authority.namespace));
  requireCheck(unique(exclusion.namespaces) && same([...new Set(namespaces)].sort(), [...exclusion.namespaces].sort()) &&
    evidence.references.every(domain => unique(domain.authorities.map(authority => authority.namespace)) && domain.authorities.every(authority =>
      authority.accountBinding === evidence.scope.accountBinding && authority.projectionSha256 === hash(authority.projection) &&
      unique(authority.records.map(row => row.key)))) && exclusion.controllers.every(controller => controller.projectionSha256 === hash(controller.projection)),
  "Named retirement retained reference or exclusion evidence changed");
  requireCheck(unique(evidence.inventory.names) && evidence.inventory.names.includes(evidence.scope.protectedBaseSnapshot),
    "Named retirement reviewed inventory is incomplete");
}
function originalBuilder(record: any, evidence: WorkerNamedReviewEvidence, now: number) {
  const retained = evidence.builder;
  requireCheck(retained.kind === "release-owned-sanitized-unavailable", "Named retirement requires the original deferred builder certificate");
  const proof = read(WorkerBuilderProvenanceSchema, record.builderProvenance ?? record.builder?.cleanup?.provenance,
    "Named retirement builder provenance is invalid");
  const candidate = read(WorkerCandidateSchema, record.candidate, "Named retirement candidate is invalid");
  const cleanup = read(WorkerBuilderCleanupSchema, record.builder?.cleanup, "Named retirement builder cleanup is invalid");
  requireCheck(Buffer.byteLength(JSON.stringify(proof)) <= 4096 && same(proof, retained.provenance) && rawHash(proof) === retained.provenanceSha256 && same(proof.scope, evidence.scope) &&
    same(proof.scope, record.builderIntent?.scope) && same(candidate, proof.candidate) &&
    proof.creation.key === record.builderIntent?.key && at(proof.creation.requestedAt) === record.builderIntent?.at &&
    proof.creation.bodySha256 === rawHash(record.builderIntent?.body) && proof.creation.sandboxId === record.builder.id &&
    record.builder.accountBinding === proof.scope.accountBinding && record.builder.billingOrgConfirmed === true &&
    record.builder.billingObservedAt === proof.creation.billingObservedAt &&
    record.builder.deleteRequested === true && record.builder.deletionOperationId === retained.deletionOperationId &&
    Number.isFinite(at(record.builder.deletionAcceptedAt)) && at(record.builder.deletionAcceptedAt) >= at(proof.creation.requestedAt) &&
    cleanup.sandboxId === retained.sandboxId && cleanup.deletionOperationId === retained.deletionOperationId &&
    (cleanup.kind === "physically-deleted" ? record.builder.deleted === true : record.builder.deleted === false &&
      Number.isFinite(at(record.builder.retiredAt)) && cleanup.provenanceSha256 === retained.provenanceSha256) &&
    record.builderCreate?.phase === "acknowledged" && record.snapshotCreate?.phase === "acknowledged" &&
    rawHash(record.builderCreate) === evidence.creates.builderSha256 && rawHash(record.snapshotCreate) === evidence.creates.snapshotSha256 &&
    record.qualified === true && record.snapshotRequested === true && record.buildSha256 === candidate.buildSha256 &&
    record.sourceCommit === proof.scope.sourceSha && record.inputsSha256 === proof.scope.inputsSha256 &&
    record.releaseRunId === proof.scope.runId && record.snapshotId === candidate.snapshotId &&
    at(cleanup.unavailableObservedAt) <= now, "Named retirement original builder or creation identity changed");
  return proof;
}
function nativeSet(state: any, ledger: any, profile: any, record: any, evidence: WorkerNamedReviewEvidence, now: number, historical: boolean) {
  const runs = state.releaseRuns.filter((run: any) => run.runId === evidence.scope.runId);
  requireCheck(runs.length === 1 && runs[0].sourceSha === evidence.scope.sourceSha && runs[0].inputsSha256 === evidence.scope.inputsSha256 &&
    Array.isArray(runs[0].canaries) && runs[0].canaries.length <= 3, "Named retirement original run is ambiguous");
  const jobs = runs[0].canaries, natives = evidence.audit.natives;
  requireCheck(unique(natives.map(row => row.admissionRequest.operationId)), "Named retirement native evidence is ambiguous");
  const allocated: string[] = [];
  for (const job of jobs) {
    const rows = state.resources.images.filter((row: any) => row.agentQualificationId === job.id);
    if (rows.length === 0) {
      requireCheck(job.phase === "allocating" && (job.retired === undefined || job.retired === true) &&
        [job.outcome, job.auditRetired, job.prelaunchFailure, job.admissionRequest, job.target].every(value => value === undefined),
      "Named retirement native allocation history is missing");
    } else { requireCheck(rows.length === 1, "Named retirement native allocation history is ambiguous"); allocated.push(job.id); }
  }
  requireCheck(same([...allocated].sort(), natives.map(row => row.admissionRequest.operationId).sort()) &&
    state.resources.images.filter((row: any) => row !== record && (row.sourceImage === record.snapshotId || row.builderIntent?.body?.from === record.snapshotId))
      .every((row: any) => row.purpose === "native-agent-qualification" && allocated.includes(row.agentQualificationId)),
  "Named retirement complete native allocation set changed");
  const auditNamespaces = evidence.references.find(domain => domain.domain === "primary-audits")!.authorities.map(authority => authority.namespace);
  for (const native of natives) {
    const request = native.admissionRequest, audited = native.audit, subject = audited.subject, retirement = subject.retirement;
    const job = jobs.find((value: any) => value.id === request.operationId);
    const row = state.resources.images.find((value: any) => value.agentQualificationId === request.operationId);
    const currentRequest = read(ReleaseCanaryAdmissionSchema, job.admissionRequest, "Named retirement original native admission is missing");
    requireCheck(job.retired === true && same(currentRequest, request) && same(row.builderIntent, native.creation) &&
      request.target.snapshotId === record.snapshotId && request.target.id !== record.builder.id &&
      audited.actorUserId === request.ownerUserId && audited.organizationId === request.organizationId &&
      auditNamespaces.includes(audited.databaseKey) && at(audited.createdAt) <= at(audited.observedAt) &&
      at(retirement.unavailableObservedAt) <= at(audited.createdAt) && at(audited.observedAt) <= now &&
      subject.operationId === request.operationId && rawHash(currentRequest) === subject.requestSha256 &&
      native.marker.operationId === request.operationId && native.marker.deletionOperationId === row.builder.deletionOperationId &&
      native.cleanup.operationId === request.operationId && native.cleanup.operation.id === row.builder.deletionOperationId &&
      native.cleanup.creationIntentSha256 === rawHash(row.builderIntent) && native.cleanup.targetId === row.builder.id &&
      native.cleanup.accountBinding === evidence.scope.accountBinding && native.cleanup.billingOrg === profile.boat.billingOrg &&
      native.cleanup.sourceCommit === record.sourceCommit && native.cleanup.snapshotId === record.snapshotId &&
      native.cleanup.buildSha256 === record.buildSha256 &&
      retirement.deletionOperationId === row.builder.deletionOperationId && retirement.targetId === row.builder.id &&
      same(retirement.operation, native.cleanup.operation),
    "Named retirement native audit or original identity changed");
    const cleanup = native.cleanup, storage = "kind" in cleanup;
    requireCheck(storage ? native.marker.version === 2 && retirement.version === 2 && audited.action === "cloud.release_canary.storage_retired" &&
      same(cleanup.snapshotsOff, row.snapshotPolicyObserved) && row.snapshotPolicyVersion === 1 && native.creation.body.snapshots === false
      : native.marker.version === 1 && retirement.version === 1 && audited.action === "cloud.release_canary.retired",
    "Named retirement native acknowledgement is not a committed retirement");
    requireCheck(historical || same(native.marker, job.auditRetired) && same(native.cleanup, storage ? row.builder.storageRetirement : row.builder.physicalCleanup),
      "Named retirement reviewed native certificate changed");
    const checked = releaseCanaryRetirementJournal(state, ledger, profile, subject, { version: 1, operationId: request.operationId,
      deletionOperationId: native.cleanup.operation.id, leaseToken: state.lease.token }, audited.organizationId, now);
    requireCheck(checked.provenanceSha256 === retirement.provenanceSha256 &&
      (row.builder.deleted === true ? job.auditRetired?.version === 1 && checked.physicalCleanup !== undefined
        : job.auditRetired?.version === 2 && job.auditRetired.storagePending === true && checked.storageRetirement !== undefined) &&
      job.auditRetired.operationId === request.operationId && job.auditRetired.deletionOperationId === row.builder.deletionOperationId,
    "Named retirement native primary audit does not bind the owned journal");
  }
}
/** Pure pre-action check for the separately reviewed literal helper. The
 * authenticated state must contain the actual current lease; never synthesize
 * one to validate a collector's unleased historical projection. Provider
 * identity/absence reads and the literal action remain the helper's boundary. */
export function validateWorkerNamedRetirementEvidence(state: any, rawLedger: unknown, profile: any, record: any, value: unknown, now = Date.now()) {
  const evidence = read(WorkerNamedReviewEvidenceSchema, value, "Named retirement reviewed evidence is invalid");
  const ledger = ledgerProof(rawLedger, profile), scope = evidence.scope;
  requireCheck(state?.version === 2 && state.owner === workerOwner(scope.channel) && state.owner === scope.owner && state.generation === scope.generation &&
    state.identity === rawHash(["release-worker", scope.repository, scope.channel]) && z.string().uuid().safeParse(state.lease?.token).success &&
    Number.isFinite(state.lease.expiresAt) && state.lease.expiresAt > now && Array.isArray(state.releaseRuns) && state.releaseRuns.length <= 100 &&
    Array.isArray(state.resources?.images) && state.resources.images.length <= 5000 && state.resources.images.includes(record) &&
    state.resources.images.filter((row: any) => row.snapshotId === record.snapshotId).length === 1 && record.purpose === "release-worker" &&
    scope.accountBinding === ledger.account && scope.protectedBaseSnapshot === profile.boat.baseSnapshot &&
    !state.resources.images.some((row: any) => row !== record && row.builder?.id === record.builder?.id) &&
    !state.releaseRuns.some((run: any) => run.canaries?.some((job: any) => job.target?.id === record.builder?.id)),
  "Named retirement owning lease, registry or account changed");
  const proof = originalBuilder(record, evidence, now);
  const holds = ledger.reservations.filter(row => row.snapshotName === record.snapshotId || row.computeId === `snapshot:${record.snapshotId}`);
  requireCheck(holds.length === 1 && record.snapshotDeleted !== true, "Named retirement original named reservation is missing or ambiguous");
  const hold = read(WorkerNamedReservationSchema, holds[0], "Named retirement original reservation is not eligible");
  requireCheck(hold.owner === state.owner && hold.generation === state.generation && hold.snapshotName === record.snapshotId &&
    at(hold.createdAt) <= at(proof.creation.requestedAt) && at(hold.releasedAt) >= at(hold.createdAt) && at(hold.releasedAt) <= now,
  "Named retirement original reservation identity changed");
  reviewWindow(evidence, now); nativeSet(state, ledger, profile, record, evidence, now, false);
  return evidence;
}
function boundAcknowledgement(state: any, ledger: any, profile: any, record: any, now: number) {
  const ack = read(WorkerNamedDeleteAcknowledgementSchema, record.snapshotDeleteIntent, "Named retirement consumed acknowledgement is invalid");
  const { intent, dispatch } = ack, scope = intent.review.scope, target = intent.target;
  requireCheck(state?.version === 2 && state.owner === workerOwner(scope.channel) && state.owner === scope.owner &&
    state.generation === scope.generation && state.identity === rawHash(["release-worker", scope.repository, scope.channel]) &&
    z.string().uuid().safeParse(state.lease?.token).success && Number.isFinite(state.lease.expiresAt) && state.lease.expiresAt > now &&
    Array.isArray(state.releaseRuns) && state.releaseRuns.length <= 100 && Array.isArray(state.resources?.images) && state.resources.images.length <= 5000 &&
    state.resources.images.filter((row: any) => row.snapshotId === target.name).length === 1 && state.resources.images.includes(record) &&
    record.purpose === "release-worker" && scope.accountBinding === account(profile) && scope.accountBinding === ledger.account &&
    scope.protectedBaseSnapshot === profile.boat.baseSnapshot && record.snapshotDeleteRequested === true,
  "Named retirement owning lease, registry or account changed");
  const proof = originalBuilder(record, intent.review, now);
  const times = [at(intent.savedAt), at(dispatch.intentFencedAt), at(dispatch.savedAt), at(dispatch.fencedAt), at(ack.acknowledgedAt)];
  requireCheck(times.every((value, index) => value <= now && (index === 0 || value >= times[index - 1]!)) &&
    dispatch.intentSha256 === hash(intent) && dispatch.leaseToken === intent.leaseToken &&
    fresh(intent.namedSnapshot.observedAt, at(dispatch.fencedAt)) && at(intent.namedSnapshot.observedAt) <= at(intent.savedAt) &&
    at(proof.snapshot.readyObservedAt) <= at(intent.namedSnapshot.observedAt) &&
    ack.response.name === target.name && target.name === record.snapshotId && same(target.candidate, proof.candidate) &&
    target.name === workerSnapshotName(scope, rawHash([scope.sourceSha, scope.runId])) && target.sourceSandboxId === record.builder.id &&
    intent.namedSnapshot.name === target.name && intent.namedSnapshot.sourceSandboxId === target.sourceSandboxId &&
    intent.reservation.owner === scope.owner && intent.reservation.generation === scope.generation && intent.reservation.snapshotName === target.name &&
    at(intent.reservation.createdAt) <= at(proof.creation.requestedAt) && at(intent.reservation.createdAt) <= at(intent.reservation.releasedAt) &&
    at(intent.reservation.releasedAt) <= at(intent.savedAt) &&
    intent.review.inventory.names.includes(target.name), "Named retirement original target or dispatch chronology changed");
  requireCheck(!state.resources.images.some((row: any) => row !== record && row.builder?.id === target.sourceSandboxId) &&
    !state.releaseRuns.some((run: any) => run.canaries?.some((job: any) => job.target?.id === target.sourceSandboxId)),
  "Named retirement builder is also a native allocation");
  reviewWindow(intent.review, at(intent.savedAt)); reviewWindow(intent.review, at(dispatch.fencedAt));
  nativeSet(state, ledger, profile, record, intent.review, now, true);
  return { ack, proof };
}
function boundReview(state: any, ledger: any, profile: any, record: any, ack: WorkerNamedDeleteAcknowledgement, value: unknown, now: number, historical: boolean) {
  const review = read(WorkerNamedRetirementReviewSchema, value, "Named retirement namespace review is invalid"), evidence = review.evidence;
  requireCheck(review.acknowledgementSha256 === hash(ack) && same(evidence.scope, ack.intent.review.scope) &&
    ["sourceSha", "treeSha", "actionSha256", "collectorSha256"].every(key => evidence.bundle[key as keyof typeof evidence.bundle] ===
      ack.intent.review.bundle[key as keyof typeof evidence.bundle]) &&
    same([...evidence.inventory.names].sort(), ack.intent.review.inventory.names.filter(name => name !== ack.intent.target.name).sort()),
  "Named retirement namespace review does not bind the consumed action");
  originalBuilder(record, evidence, now); nativeSet(state, ledger, profile, record, evidence, now, historical);
  return review;
}
function conflicts(ledger: z.infer<typeof WorkerNamedAdmissionLedgerSchema>, ack: WorkerNamedDeleteAcknowledgement) {
  return ledger.reservations.filter(row => row.snapshotName === ack.intent.target.name || row.computeId === ack.intent.reservation.computeId);
}
function validateWitness(witness: WorkerNameRetirement, ack: WorkerNamedDeleteAcknowledgement, now = Date.now()) {
  requireCheck(witness.acknowledgementSha256 === hash(ack) && witness.reviewSha256 === hash(witness.review) &&
    same(witness.scope, ack.intent.review.scope) && same(witness.target, ack.intent.target) && same(witness.reservation, ack.intent.reservation) &&
    witness.review.acknowledgementSha256 === hash(ack), "Named retirement namespace witness changed");
  namespaceProof(witness.namespace, ack, witness.review.evidence, at(witness.preparedAt));
  reviewWindow(witness.review.evidence, at(witness.preparedAt));
  if (witness.phase !== "prepared") {
    const transition = witness.transition, before = structuredClone(transition.remainder);
    requireCheck(transition.reservationIndex <= before.reservations.length && conflicts(before, ack).length === 0,
      "Named retirement admission transition has another target reservation");
    before.reservations.splice(transition.reservationIndex, 0, witness.reservation);
    requireCheck(transition.reservationSha256 === hash(witness.reservation) && transition.beforeSha256 === hash(before) &&
      transition.afterSha256 === hash(transition.remainder) && transition.remainder.account === witness.scope.accountBinding &&
      at(witness.preparedAt) <= at(witness.tombstonedAt), "Named retirement admission transition is invalid");
    reviewWindow(witness.review.evidence, at(witness.tombstonedAt));
    namespaceProof(witness.namespace, ack, witness.review.evidence, at(witness.tombstonedAt));
    if (witness.phase === "committed") {
      requireCheck(at(witness.committedAt) >= at(witness.tombstonedAt) && at(witness.committedAt) <= now, "Named retirement committed chronology is invalid");
      reviewWindow(witness.review.evidence, at(witness.committedAt));
      namespaceProof(witness.namespace, ack, witness.review.evidence, at(witness.committedAt));
    }
  }
}
/** Only historical observe-only callers may substitute this committed history
 * for a pruned original reservation. Current admission never calls this path. */
export function assertHistoricalWorkerNameRetirement(state: any, rawLedger: unknown, profile: any, record: any, now = Date.now()) {
  const ledger = ledgerProof(rawLedger, profile), { ack } = boundAcknowledgement(state, ledger, profile, record, now);
  const witness = read(WorkerNameRetirementSchema, record.snapshotNameRetirement, "Named retirement committed witness is missing");
  requireCheck(witness.phase === "committed" && record.snapshotDeleted === true && conflicts(ledger, ack).length === 0,
    "Named retirement reservation was not durably settled or has reappeared");
  validateWitness(witness, ack, now);
  boundReview(state, ledger, profile, record, ack, witness.review, now, true);
  return witness;
}

async function completeInventory(request: any) {
  const names: string[] = [], cursors = new Set<string>(); let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const response = await request("GET", `/named-snapshots${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    requireCheck(response.status === 200 && Array.isArray(response.body?.snapshots), "Named retirement provider inventory is unavailable");
    for (const row of response.body.snapshots) {
      requireCheck(typeof row?.name === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(row.name) && !names.includes(row.name) && names.length < 10_000,
        "Named retirement provider inventory is ambiguous"); names.push(row.name);
    }
    const next = response.body.nextCursor;
    requireCheck(!response.body.hasMore || typeof next === "string" && next.length > 0, "Named retirement provider inventory is incomplete");
    if (!next) return names.sort();
    requireCheck(typeof next === "string" && next.length <= 1024 && !cursors.has(next), "Named retirement provider inventory cursor changed");
    cursors.add(next); cursor = next;
  }
  throw new Error("Named retirement provider inventory exceeded its bound");
}
async function observeNamespace(ack: WorkerNamedDeleteAcknowledgement, request: any): Promise<WorkerNameRetirement["namespace"]> {
  const original = ack.intent.review.builder;
  requireCheck(original.kind === "release-owned-sanitized-unavailable", "Named retirement builder certificate is missing");
  const response = await request("GET", `/deletion-operations/${original.deletionOperationId}`), raw = response.body?.operation;
  requireCheck(response.status === 200 && raw?.id === original.deletionOperationId && raw.kind === "sandbox" && raw.targetId === original.sandboxId,
    "Named retirement original builder operation changed");
  const operationObservedAt = new Date(Date.now()).toISOString();
  const operation = raw.status === "completed" ? read(WorkerBuilderCompletedOperationSchema, { id: raw.id, kind: raw.kind, targetId: raw.targetId,
    status: raw.status, completedAt: raw.completedAt }, "Named retirement builder completion is invalid")
    : read(WorkerBuilderPendingOperationSchema, { id: raw.id, kind: raw.kind, targetId: raw.targetId, status: raw.status,
      stage: raw.stage, expectedBy: raw.expectedBy ?? null }, "Named retirement builder pending stage is invalid");
  requireCheck(raw.status === "completed" || raw.completedAt == null, "Named retirement builder operation is inconsistent");
  const sandbox = await request("GET", `/sandboxes/${original.sandboxId}`), unavailableObservedAt = new Date(Date.now()).toISOString();
  requireCheck(sandbox.status === 404, "Named retirement builder is still available");
  const builder = read(WorkerBuilderCleanupSchema, operation.status === "completed" ? { kind: "physically-deleted", sandboxId: original.sandboxId,
    deletionOperationId: original.deletionOperationId, operation, operationObservedAt, unavailableObservedAt, completedAt: operation.completedAt }
    : { ...original, operation, operationObservedAt, unavailableObservedAt,
      storage: { ...original.storage, stage: operation.stage, expectedBy: operation.expectedBy } }, "Named retirement builder observation is invalid");
  const natives: WorkerNameRetirement["namespace"]["natives"] = [];
  for (const native of ack.intent.review.audit.natives) {
    const original = native.cleanup;
    const response = await request("GET", `/deletion-operations/${original.operation.id}`), raw = response.body?.operation;
    requireCheck(response.status === 200 && raw?.id === original.operation.id && raw.kind === "sandbox" && raw.targetId === original.targetId &&
      raw.requestedAt === original.operation.requestedAt, "Named retirement original native operation changed");
    const projection = { id: raw.id, kind: raw.kind, targetId: raw.targetId, status: raw.status, requestedAt: raw.requestedAt };
    const operation = raw.status === "completed" ? read(NativeCanaryDeletionOperationSchema, { ...projection, completedAt: raw.completedAt }, "Named retirement native completion is invalid")
      : ["pending", "processing"].includes(raw.status) ? read(NativeCanaryStorageProgressSchema, { ...projection, stage: raw.stage }, "Named retirement native progress is invalid")
        : read(NativeCanaryStorageOperationSchema, { ...projection, stage: raw.stage, expectedBy: raw.expectedBy ?? null }, "Named retirement native pending stage is invalid");
    const operationObservedAt = new Date(Date.now()).toISOString();
    requireCheck(at(operation.requestedAt) <= at(operationObservedAt) && (operation.status === "completed"
      ? at(operation.completedAt) <= at(operationObservedAt) : "kind" in original && raw.completedAt == null &&
        (!("expectedBy" in operation) || operation.expectedBy === null || at(operation.expectedBy) <= at(operationObservedAt) + 6 * 3600_000 + 5000)),
    "Named retirement native observation is inconsistent");
    const sandbox = await request("GET", `/sandboxes/${original.targetId}`);
    requireCheck(sandbox.status === 404, "Named retirement native is still available");
    natives.push({ operationId: original.operationId, operation, operationObservedAt, unavailableObservedAt: new Date(Date.now()).toISOString() });
  }
  const named = await request("GET", `/named-snapshots/${ack.intent.target.name}`), nameObservedAt = new Date(Date.now()).toISOString();
  requireCheck(named.status === 404, "Named retirement alias is still available or has reappeared");
  const names = await completeInventory(request);
  return { builder, natives, nameObservedAt, names, inventoryObservedAt: new Date(Date.now()).toISOString() };
}
function namespaceProof(namespace: WorkerNameRetirement["namespace"], ack: WorkerNamedDeleteAcknowledgement, evidence: WorkerNamedReviewEvidence, now: number) {
  const builder = namespace.builder;
  const times = [namespace.nameObservedAt, namespace.inventoryObservedAt, builder.operationObservedAt, builder.unavailableObservedAt,
    ...namespace.natives.flatMap(row => [row.operationObservedAt, row.unavailableObservedAt])];
  requireCheck(times.every(time => fresh(time, now) && at(time) >= at(ack.acknowledgedAt)) &&
    builder.sandboxId === ack.intent.target.sourceSandboxId && builder.deletionOperationId === ack.intent.review.builder.deletionOperationId &&
    (builder.kind === "physically-deleted" ? at(builder.completedAt) >= at(ack.intent.review.builder.kind === "release-owned-sanitized-unavailable"
      ? ack.intent.review.builder.provenance.creation.requestedAt : ack.intent.savedAt) : same(builder.provenance, evidence.builder.kind === "release-owned-sanitized-unavailable" && evidence.builder.provenance)) &&
    unique(namespace.names) && !namespace.names.includes(ack.intent.target.name) && same([...namespace.names].sort(), [...evidence.inventory.names].sort()) &&
    same(namespace.natives.map(row => row.operationId).sort(), ack.intent.review.audit.natives.map(row => row.admissionRequest.operationId).sort()) &&
    namespace.natives.every(row => { const native = ack.intent.review.audit.natives.find(value => value.admissionRequest.operationId === row.operationId)!;
      return row.operation.id === native.cleanup.operation.id && row.operation.targetId === native.cleanup.targetId &&
        row.operation.requestedAt === native.cleanup.operation.requestedAt && at(row.operationObservedAt) <= at(row.unavailableObservedAt); }),
  "Named retirement namespace or original-operation observation changed");
}
async function durableRecord(store: any, lease: any, record: any) {
  await lease.fence();
  requireCheck(typeof store.read === "function", "Named retirement requires authenticated journal readback");
  const current = await store.read(lease.state.owner), state = current?.state;
  requireCheck(state?.identity === lease.state.identity && state.owner === lease.state.owner && state.generation === lease.state.generation &&
    state.lease?.token === lease.state.lease?.token && state.lease.expiresAt > Date.now(), "Named retirement durable owning journal changed");
  const rows = state.resources?.images?.filter((row: any) => row.snapshotId === record.snapshotId && row.releaseRunId === record.releaseRunId);
  requireCheck(rows?.length === 1 && same(rows[0].snapshotDeleteIntent, record.snapshotDeleteIntent), "Named retirement acknowledgement was not durably saved");
  return rows[0];
}
async function persist(store: any, lease: any, record: any, witness: WorkerNameRetirement) {
  witness = read(WorkerNameRetirementSchema, witness, "Named retirement namespace witness is invalid");
  const before = { witness: record.snapshotNameRetirement, deleted: record.snapshotDeleted, retiredAt: record.snapshotRetiredAt, reason: record.snapshotRetirementReason };
  record.snapshotNameRetirement = witness;
  if (witness.phase === "committed") { record.snapshotDeleted = true; record.snapshotRetiredAt = witness.committedAt;
    record.snapshotRetirementReason = "reviewed-owned-name-retirement-storage-pending"; }
  try {
    await lease.save(); const saved = await durableRecord(store, lease, record);
    requireCheck(same(saved.snapshotNameRetirement, witness) && (witness.phase !== "committed" || saved.snapshotDeleted === true),
      "Named retirement namespace witness was not durably saved");
  } catch (error) {
    for (const [key, value] of Object.entries({ snapshotNameRetirement: before.witness, snapshotDeleted: before.deleted,
      snapshotRetiredAt: before.retiredAt, snapshotRetirementReason: before.reason })) {
      if (value === undefined) delete record[key]; else record[key] = value;
    }
    throw error;
  }
}
/** Consumes reviewed encrypted-journal input. All provider calls are GETs; this
 * module has no deletion entrypoint, reference collector or audit writer. */
export async function settleWorkerNamedRetirement(store: any, lease: any, profile: any, record: any, inventory: { provider: string; id: string }[], request: any) {
  const durable = await durableRecord(store, lease, record);
  const current = await store.readAdmission(), ledger = ledgerProof(current?.state, profile);
  const { ack } = boundAcknowledgement(lease.state, ledger, profile, record, Date.now());
  if (record.snapshotNameRetirement?.phase === "committed") {
    const committed = assertHistoricalWorkerNameRetirement(lease.state, ledger, profile, record);
    requireCheck(same(durable.snapshotNameRetirement, committed), "Named retirement committed witness is not durable");
    await lease.fence();
    const named = await request("GET", `/named-snapshots/${record.snapshotId}`);
    requireCheck(named.status === 404 && !inventory.some(row => row.provider === "boat" && row.id === record.snapshotId), "Named retirement alias has reappeared");
    return false;
  }
  requireCheck(record.snapshotDeleted !== true && same(durable.snapshotRetirementReview, record.snapshotRetirementReview),
    "Named retirement namespace review was not durably saved");
  const review = boundReview(lease.state, ledger, profile, record, ack, record.snapshotRetirementReview, Date.now(), false);
  reviewWindow(review.evidence, Date.now());
  const previous = record.snapshotNameRetirement === undefined ? undefined : read(WorkerNameRetirementSchema, record.snapshotNameRetirement,
    "Named retirement previous witness is invalid");
  if (previous) {
    requireCheck(same(previous, durable.snapshotNameRetirement), "Named retirement previous witness is not durable"); validateWitness(previous, ack);
    boundReview(lease.state, ledger, profile, record, ack, previous.review, Date.now(), true);
  }
  const recovered = previous?.phase === "tombstoned" && hash(ledger) === previous.transition.afterSha256;
  const holds = conflicts(ledger, ack);
  requireCheck(recovered ? holds.length === 0 : holds.length === 1 && same(holds[0], ack.intent.reservation),
    "Named retirement original reservation was replaced or removed without its transition");
  await lease.fence();
  const namespace = await observeNamespace(ack, request), now = Date.now();
  reviewWindow(review.evidence, now); namespaceProof(namespace, ack, review.evidence, now);
  requireCheck(same(namespace.names, inventory.filter(row => row.provider === "boat").map(row => row.id).sort()),
    "Named retirement input and fresh provider inventory disagree");
  const prepared: WorkerNameRetirement = { version: 1, kind: "release-owned-name-retirement", phase: "prepared", acknowledgementSha256: hash(ack),
    reviewSha256: hash(review), review, scope: ack.intent.review.scope, target: ack.intent.target, reservation: ack.intent.reservation,
    preparedAt: new Date(now).toISOString(), namespace };
  const remainder = structuredClone(ledger), reservationIndex = remainder.reservations.findIndex(row => same(row, ack.intent.reservation));
  if (!recovered) remainder.reservations.splice(reservationIndex, 1);
  const transition = recovered ? previous.transition : { etag: current.etag, beforeSha256: hash(ledger), afterSha256: hash(remainder),
    reservationSha256: hash(ack.intent.reservation), reservationIndex, remainder };
  // Persist the exact intended one-row delta before either the CAS or its
  // readback recovery. A name tombstone does not set snapshotDeleted yet.
  if (!recovered) await persist(store, lease, record, prepared);
  const tombstoned: WorkerNameRetirement = { ...prepared, phase: "tombstoned", tombstonedAt: new Date(Date.now()).toISOString(), transition };
  validateWitness(tombstoned, ack); await persist(store, lease, record, tombstoned);
  reviewWindow(review.evidence, Date.now()); namespaceProof(namespace, ack, review.evidence, Date.now());
  await lease.fence();
  const before = await store.readAdmission();
  requireCheck(hash(ledgerProof(before?.state, profile)) === (recovered ? transition.afterSha256 : transition.beforeSha256) &&
    (recovered || before.etag === transition.etag), "Named retirement admission changed before its guarded CAS");
  const named = await request("GET", `/named-snapshots/${record.snapshotId}`);
  requireCheck(named.status === 404 && same(await completeInventory(request), namespace.names),
    "Named retirement alias or inventory changed before its guarded CAS");
  reviewWindow(review.evidence, Date.now()); namespaceProof(namespace, ack, review.evidence, Date.now());
  await lease.fence();
  reviewWindow(review.evidence, Date.now()); namespaceProof(namespace, ack, review.evidence, Date.now());
  // No retries and no broad releaseHostedAdmission: a conflict retains the
  // tombstone/transition for authenticated observation by a later owning lease.
  if (!recovered) await store.writeAdmission(transition.remainder, transition.etag);
  const after = await store.readAdmission();
  requireCheck(hash(ledgerProof(after?.state, profile)) === transition.afterSha256, "Named retirement admission CAS readback is unconfirmed");
  const finalName = await request("GET", `/named-snapshots/${record.snapshotId}`);
  requireCheck(finalName.status === 404 && same(await completeInventory(request), namespace.names),
    "Named retirement alias or inventory changed during admission CAS");
  await lease.fence();
  reviewWindow(review.evidence, Date.now()); namespaceProof(namespace, ack, review.evidence, Date.now());
  const committed: WorkerNameRetirement = { ...tombstoned, phase: "committed", committedAt: new Date(Date.now()).toISOString(), admissionEtag: after.etag };
  validateWitness(committed, ack); await persist(store, lease, record, committed);
  return true;
}
