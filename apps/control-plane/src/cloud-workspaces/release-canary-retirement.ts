import { createHash } from "node:crypto";
import { z } from "zod";
import { NativeCanaryPhysicalCleanupSchema, NativeCanaryStorageRetirementSchema, NativeCanaryStorageAuditSchema, ReleaseCanaryAdmissionSchema, ReleaseCanaryBindingsSchema,
  type ReleaseCanaryRetirement, type ReleaseCanaryRetirementAudit } from "./release-canary-contract.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const timestamp = z.string().datetime({ offset: true }), sha = z.string().regex(/^[a-f0-9]{40}$/), digest = z.string().regex(/^[a-f0-9]{64}$/);
const snapshot = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), counter = z.string().regex(/^[1-9]\d*$/);
const candidate = z.object({ snapshotId: snapshot, sourceCommit: sha, buildSha256: digest,
  architecture: z.literal("linux/amd64"), storageMiB: z.number().int().positive() }).strict();
const scope = z.object({ repository: z.string(), channel: z.enum(["alpha", "beta", "production"]), runId: counter, runAttempt: counter,
  sourceSha: sha, inputsSha256: digest, owner: z.string().regex(/^[a-f0-9]{24}$/), generation: z.string().uuid(),
  accountBinding: digest, protectedBaseSnapshot: snapshot }).strict();
const builderBody = z.object({ type: z.enum(["small", "default", "large", "xlarge"]), from: snapshot,
  ttlSeconds: z.literal(3600), noEnv: z.literal(true), env: z.object({}).strict() }).strict();
const provenance = z.object({ version: z.literal(1), purpose: z.literal("release-worker"), scope, candidate,
  creation: z.object({ sandboxId: z.string().regex(/^bx_[a-z0-9]+$/), key: z.string().uuid(), requestedAt: timestamp,
    body: builderBody, bodySha256: digest, billingOrgConfirmed: z.literal(true) }).passthrough(),
  snapshot: z.object({ name: snapshot, sourceSandboxId: z.string(), sourceCommit: sha, buildSha256: digest }).passthrough(),
  source: z.object({ commit: sha, parent: sha, exactMergedCommit: z.literal(true) }).passthrough(),
  attestation: z.object({ qualified: z.literal(true), secureSetup: z.literal(true), sourceCommit: sha, buildSha256: digest }).passthrough(),
}).passthrough();
const nativeBody = z.object({ type: z.literal("default"), from: snapshot, ttlSeconds: z.number().int().min(60).max(2700),
  noEnv: z.literal(true), env: z.object({}).strict(), snapshots: z.boolean().optional() }).strict();
function reject(): never { throw new Error("Release canary retirement journal proof is unconfirmed"); }
function requireProof(condition: unknown): asserts condition { if (!condition) reject(); }

export function releaseCanaryRetirementJournal(state: any, ledger: any, profile: any, audit: ReleaseCanaryRetirementAudit,
  input: ReleaseCanaryRetirement, organizationId: string, now = Date.now()) {
  const owner = createHash("sha256").update(`zeros-release-worker:${audit.channel}`).digest("hex").slice(0, 24);
  const account = [profile.boat?.accountScope, profile.boat?.billingOrg, profile.railway?.projectId,
    profile.planetscale?.organization, profile.planetscale?.database, profile.cloudflare?.accountId];
  requireProof(account.every(value => typeof value === "string" && value.length > 0));
  const accountBinding = hash(account);
  requireProof(state?.version === 2 && state.owner === owner && state.identity === hash(["release-worker", audit.repository, audit.channel]) &&
    z.string().uuid().safeParse(state.generation).success && state.lease?.token === input.leaseToken &&
    Number.isFinite(state.lease.expiresAt) && state.lease.expiresAt > now &&
    Array.isArray(state.releaseRuns) && state.releaseRuns.length <= 100 && Array.isArray(state.resources?.images) && state.resources.images.length <= 5000 &&
    ledger?.version === 1 && ledger.owner === "account-admission" && ledger.account === accountBinding && Array.isArray(ledger.reservations));
  const runs = state.releaseRuns.filter((run: any) => run.runId === audit.runId);
  requireProof(runs.length === 1);
  const run = runs[0], bindings = ReleaseCanaryBindingsSchema.safeParse(run.releaseCanaryBindings);
  const binding = bindings.success ? bindings.data.find(row => row.kind === audit.kind) : undefined;
  const sameBinding = (value: any) => value && ["kind", "credentialId", "credentialRevision", "designationId", "model"].every(key => value[key] === audit[key]);
  requireProof(run.actorUserId === audit.allowanceOwnerUserId && run.sourceSha === audit.sourceSha && run.qualificationProfile === audit.qualificationProfile &&
    sameBinding(binding) && Array.isArray(run.canaries) && run.canaries.length <= 3);
  const jobs = run.canaries.filter((job: any) => job.id === audit.operationId), rows = state.resources.images.filter((row: any) => row.agentQualificationId === audit.operationId);
  requireProof(jobs.length === 1 && rows.length === 1);
  const job = jobs[0], row = rows[0], image = /^boat:([^@]+)@sha256:([a-f0-9]{64})$/.exec(audit.imageRef)!;
  const snapshotId = image[1]!, buildSha256 = image[2]!;
  requireProof(sameBinding(job) && job.qualificationProfile === audit.qualificationProfile && ["starting", "running", "completed"].includes(job.phase) &&
    job.image?.snapshotId === snapshotId && job.image.sourceCommit === audit.sourceSha && job.image.buildSha256 === buildSha256 &&
    row.purpose === "native-agent-qualification" && row.sourceCommit === audit.sourceSha && row.sourceImage === snapshotId &&
    row.inputsSha256 === createHash("sha256").update(`native-agent:${audit.operationId}`).digest("hex") &&
    row.builder?.id === audit.targetId && row.builder.deleteRequested === true && row.builder.deletionOperationId === input.deletionOperationId &&
    row.builderIntent?.key === audit.operationId && Number.isFinite(row.builderIntent.at) && row.builderCreate?.phase === "acknowledged" &&
    row.machineAttestationStarted === true && row.nativeDispatchStarted === true);
  const body = nativeBody.safeParse(row.builderIntent.body);
  requireProof(body.success && body.data.from === snapshotId &&
    (row.snapshotPolicyVersion === undefined || row.snapshotPolicyVersion === 1 && body.data.snapshots === false));
  const original = job.admissionRequest ?? (audit.channel === "alpha" ? { version: 1, ownerUserId: audit.allowanceOwnerUserId, organizationId,
    channel: audit.channel, sourceSha: audit.sourceSha, repository: audit.repository, qualificationProfile: audit.qualificationProfile,
    operationId: audit.operationId, runId: audit.runId, runAttempt: audit.runAttempt, branch: "main", kind: audit.kind,
    credentialId: audit.credentialId, credentialRevision: audit.credentialRevision, designationId: audit.designationId, model: audit.model,
    target: { id: audit.targetId, attempt: audit.operationId, snapshotId, sourceCommit: audit.sourceSha, buildSha256 } } : null);
  const request = ReleaseCanaryAdmissionSchema.safeParse(original);
  requireProof(request.success && hash(request.data) === audit.requestSha256 && request.data.ownerUserId === audit.allowanceOwnerUserId &&
    request.data.organizationId === organizationId && request.data.channel === audit.channel && request.data.sourceSha === audit.sourceSha &&
    request.data.repository === audit.repository && request.data.operationId === audit.operationId && request.data.runId === audit.runId &&
    request.data.runAttempt === audit.runAttempt && request.data.qualificationProfile === audit.qualificationProfile && sameBinding(request.data) &&
    request.data.target.id === audit.targetId && request.data.target.attempt === audit.operationId && request.data.target.snapshotId === snapshotId &&
    request.data.target.sourceCommit === audit.sourceSha && request.data.target.buildSha256 === buildSha256 &&
    (audit.channel === "alpha" ? request.data.branch === "main" : /^release\/\d+\.\d+\.\d+$/.test(request.data.branch)));
  const parents = state.resources.images.filter((record: any) => record.purpose === "release-worker" && record.releaseRunId === audit.runId);
  requireProof(parents.length === 1);
  const parent = parents[0], raw = parent.builderProvenance ?? parent.builder?.cleanup?.provenance, certificate = provenance.safeParse(raw);
  const parentCandidate = candidate.safeParse(parent.candidate);
  requireProof(certificate.success && parentCandidate.success);
  const proof = certificate.data;
  requireProof(proof.scope.owner === owner && proof.scope.generation === state.generation && proof.scope.accountBinding === accountBinding &&
    proof.scope.repository === audit.repository && proof.scope.channel === audit.channel && proof.scope.runId === audit.runId &&
    proof.scope.sourceSha === audit.sourceSha && proof.scope.inputsSha256 === run.inputsSha256 &&
    BigInt(proof.scope.runAttempt) <= BigInt(audit.runAttempt) && hash(proof.scope) === hash(parent.builderIntent?.scope) &&
    proof.creation.key === parent.builderIntent?.key && Date.parse(proof.creation.requestedAt) === parent.builderIntent?.at &&
    proof.creation.sandboxId === parent.builder?.id && proof.creation.sandboxId !== audit.targetId &&
    proof.creation.body.from === proof.scope.protectedBaseSnapshot && proof.creation.bodySha256 === hash(proof.creation.body) &&
    hash(proof.creation.body) === hash(parent.builderIntent?.body) &&
    proof.candidate.snapshotId === snapshotId && proof.candidate.sourceCommit === audit.sourceSha && proof.candidate.buildSha256 === buildSha256 &&
    proof.snapshot.name === snapshotId && proof.snapshot.sourceSandboxId === proof.creation.sandboxId && proof.snapshot.sourceCommit === audit.sourceSha &&
    proof.snapshot.buildSha256 === buildSha256 && proof.source.commit === audit.sourceSha && proof.source.parent === audit.sourceSha &&
    proof.attestation.sourceCommit === audit.sourceSha && proof.attestation.buildSha256 === buildSha256 &&
    parent.sourceCommit === audit.sourceSha && parent.inputsSha256 === run.inputsSha256 && parent.snapshotId === snapshotId &&
    hash(parentCandidate.data) === hash(proof.candidate) && parent.qualified === true && parent.snapshotRequested === true && parent.snapshotCreate?.phase === "acknowledged" &&
    (parent.builderProvenance || parent.builder.cleanup?.provenanceSha256 === hash(raw)));
  requireProof(!state.resources.images.some((other: any) => other !== row && other.builder?.id === audit.targetId));
  const physical = NativeCanaryPhysicalCleanupSchema.safeParse(row.builder.physicalCleanup);
  const storage = NativeCanaryStorageRetirementSchema.safeParse(row.builder.storageRetirement);
  const cleanup = physical.success ? physical : storage;
  requireProof(cleanup.success && cleanup.data.operationId === audit.operationId && cleanup.data.targetId === audit.targetId &&
    cleanup.data.operation.id === input.deletionOperationId && cleanup.data.snapshotId === snapshotId && cleanup.data.sourceCommit === audit.sourceSha &&
    cleanup.data.buildSha256 === buildSha256 && cleanup.data.accountBinding === accountBinding && cleanup.data.billingOrg === profile.boat.billingOrg &&
    cleanup.data.creationIntentSha256 === hash(row.builderIntent) && Date.parse(cleanup.data.operation.requestedAt) >= row.builderIntent.at &&
    Date.parse(cleanup.data.unavailableObservedAt) <= now);
  if (!physical.success) requireProof(row.builder.physicalCleanup === undefined && row.builder.deleted !== true && row.deleted !== true &&
    storage.success && row.snapshotPolicyVersion === 1 && body.data.snapshots === false &&
    hash(row.snapshotPolicyObserved) === hash(storage.data.snapshotsOff) && Date.parse(storage.data.snapshotsOff.observedAt) >= row.builderIntent.at);
  const holds = ledger.reservations.filter((reservation: any) => reservation.computeId === `canary:${audit.operationId}`);
  requireProof(holds.length <= 1 && holds.every((reservation: any) => reservation.kind === "builder" && reservation.owner === owner &&
    reservation.generation === state.generation && reservation.snapshotName === undefined));
  const provenanceSha256 = hash({ request: request.data, creation: row.builderIntent, parent: raw, accountBinding, generation: state.generation });
  if (!physical.success && holds.length === 1) requireProof(holds[0].releasedAt === undefined);
  const acknowledgment = NativeCanaryStorageAuditSchema.safeParse(audit.retirement);
  if (!physical.success && holds.length === 0) requireProof(job.auditRetired?.version === 2 && job.auditRetired.storagePending === true &&
    job.auditRetired.operationId === audit.operationId && job.auditRetired.deletionOperationId === input.deletionOperationId &&
    job.retired === true && Number.isFinite(Date.parse(row.builder.retiredAt)) && acknowledgment.success &&
    acknowledgment.data.deletionOperationId === input.deletionOperationId && acknowledgment.data.provenanceSha256 === provenanceSha256);
  return { targetId: audit.targetId, intentAt: row.builderIntent.at as number,
    physicalCleanup: physical.success ? physical.data : undefined, storageRetirement: !physical.success && storage.success ? storage.data : undefined,
    provenanceSha256 };
}
