import { createHash } from "node:crypto";
import { z } from "zod";
import { NativeCanaryDeletionOperationSchema, NativeCanaryPhysicalCleanupSchema, ReleaseCanaryAdmissionSchema,
  ReleaseCanaryBindingsSchema, RELEASE_CANARY_MODELS } from "../../apps/control-plane/src/cloud-workspaces/release-canary-contract";
import { imageContractSha256 } from "../cloud-workspace-validation/config";
import { nativeRuntimeEvidence } from "../dev-environment/native-agent-canary.mjs";
import { requireCheck } from "./contracts";
import { workerOwner } from "./worker-admission";
import { WorkerBuilderCleanupSchema, WorkerBuilderProvenanceSchema, WorkerCandidateSchema } from "./worker-builder-retirement";
import { fixedCanaryOutcome } from "./worker-canary";
import { RetentionSubjectSchema, type RetentionSubject } from "./worker-retention-resume";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const uuid = z.string().uuid();
const nativeBody = z.object({ type: z.literal("default"), from: z.string(), ttlSeconds: z.number().int().min(60).max(2700),
  noEnv: z.literal(true), env: z.object({}).strict(), snapshots: z.boolean().optional() }).strict();
const terminal = z.object({ version: z.literal(1), operationId: uuid, deletionOperationId: z.string().regex(/^bdop_[a-f0-9]{32}$/) }).strict();
type Document = { state: any; etag: string };
type Context = { env: NodeJS.ProcessEnv; profile: any; inputsSha256: string; failedAt: number; now?: () => number;
  documents(): Promise<{ registry: Document | null; admission: Document | null }>;
  originalWorker(attempt: string): Promise<{ startedAt: number; finishedAt: number }>;
  request(method: string, route: string): Promise<any> };

function inspectJournal(subject: RetentionSubject, context: Context, registry: Document | null, admission: Document | null, now: number) {
  const { env, profile } = context, state = registry?.state, ledger = admission?.state;
  const values = [profile.boat?.accountScope, profile.boat?.billingOrg, profile.railway?.projectId,
    profile.planetscale?.organization, profile.planetscale?.database, profile.cloudflare?.accountId];
  requireCheck(values.every(value => typeof value === "string" && value.length > 0), "Observer account binding is unconfirmed");
  const account = hash(values);
  requireCheck(registry && admission && [registry.etag, admission.etag].every(value => typeof value === "string" && value.length > 0 && value.length <= 256) &&
    state?.version === 2 && state.owner === workerOwner(subject.channel) && state.identity === hash(["release-worker", subject.repository, subject.channel]) &&
    uuid.safeParse(state.generation).success && ["provisioning", "ready"].includes(state.status) &&
    Array.isArray(state.releaseRuns) && state.releaseRuns.length <= 100 && Array.isArray(state.resources?.images) && state.resources.images.length <= 5000 &&
    ledger?.version === 1 && ledger.owner === "account-admission" && ledger.account === account &&
    Array.isArray(ledger.reservations) && ledger.reservations.length <= 5000,
    "Authenticated worker or admission inventory is unconfirmed");
  requireCheck(state.lease === undefined || uuid.safeParse(state.lease?.token).success && Number.isFinite(state.lease.expiresAt) && state.lease.expiresAt <= now,
    "Worker registry has an active or malformed lease");
  const runs = state.releaseRuns.filter((run: any) => run.runId === subject.runId);
  requireCheck(runs.length === 1, "Original worker run is missing or ambiguous");
  const run = runs[0], bindings = ReleaseCanaryBindingsSchema.safeParse(run.releaseCanaryBindings);
  requireCheck(run.sourceSha === subject.sourceSha && run.inputsSha256 === context.inputsSha256 && run.actorUserId === env.RUNTIME_QUALIFICATION_ACTOR_USER_ID &&
    uuid.safeParse(run.actorUserId).success && uuid.safeParse(run.operationId).success && uuid.safeParse(env.WORKER_CANARY_ORGANIZATION_ID).success &&
    ["smoke", "full"].includes(run.qualificationProfile) && bindings.success && Array.isArray(run.canaries) && run.canaries.length > 0 && run.canaries.length <= 3 &&
    Number.isFinite(run.maxUsedHours) && run.maxUsedHours > 0 &&
    [run.receipt, run.completedAt, run.evidence, run.approvalRequest, run.role].every(value => value === undefined),
    "Original worker native run is not a pending qualification");
  requireCheck(state.releaseRuns.every((other: any) => other === run || Array.isArray(other.canaries) && other.canaries.length <= 3 &&
    other.canaries.every((job: any) => job.retired === true)), "Another historical native operation remains unresolved");
  const parents = state.resources.images.filter((row: any) => row.purpose === "release-worker" && row.releaseRunId === run.runId);
  requireCheck(parents.length === 1, "Worker builder provenance is missing or ambiguous");
  const parent = parents[0], raw = parent.builderProvenance ?? parent.builder?.cleanup?.provenance;
  const certificate = WorkerBuilderProvenanceSchema.safeParse(raw), candidate = WorkerCandidateSchema.safeParse(parent.candidate);
  const cleanup = WorkerBuilderCleanupSchema.safeParse(parent.builder?.cleanup);
  requireCheck(certificate.success && candidate.success && cleanup.success, "Worker builder certificate or cleanup boundary is unconfirmed");
  const proof = certificate.data, scope = proof.scope;
  requireCheck(scope.repository === subject.repository && scope.channel === subject.channel && scope.runId === subject.runId &&
    scope.sourceSha === subject.sourceSha && scope.inputsSha256 === run.inputsSha256 && scope.owner === state.owner && scope.generation === state.generation &&
    scope.accountBinding === account && scope.protectedBaseSnapshot === profile.boat.baseSnapshot && Number(scope.runAttempt) <= Number(subject.failedAttempt) &&
    hash(scope) === hash(parent.builderIntent?.scope) && proof.creation.key === parent.builderIntent?.key &&
    Date.parse(proof.creation.requestedAt) === parent.builderIntent?.at && hash(proof.creation.body) === hash(parent.builderIntent?.body) &&
    proof.creation.sandboxId === parent.builder?.id && proof.generation.contract === imageContractSha256() &&
    hash(candidate.data) === hash(proof.candidate) && parent.sourceCommit === subject.sourceSha && parent.inputsSha256 === run.inputsSha256 &&
    parent.snapshotId === candidate.data.snapshotId && parent.buildSha256 === candidate.data.buildSha256 && parent.qualified === true &&
    parent.snapshotRequested === true && parent.snapshotCreate?.phase === "acknowledged" && parent.builderCreate?.phase === "acknowledged" &&
    parent.builder.deleteRequested === true && cleanup.data.sandboxId === parent.builder.id &&
    cleanup.data.deletionOperationId === parent.builder.deletionOperationId && Date.parse(cleanup.data.unavailableObservedAt) <= now &&
    (cleanup.data.kind === "physically-deleted" ? parent.builder.deleted === true :
      parent.builder.deleted !== true && cleanup.data.provenanceSha256 === hash(proof)), "Worker builder original source/account boundary changed");
  const namedHolds = ledger.reservations.filter((row: any) => row.snapshotName === parent.snapshotId);
  requireCheck(namedHolds.length === 1 && namedHolds[0].kind === "builder" && namedHolds[0].owner === state.owner &&
    namedHolds[0].generation === state.generation && namedHolds[0].computeId === `snapshot:${parent.snapshotId}` &&
    namedHolds[0].snapshotReleasedAt === undefined && parent.snapshotDeleted !== true, "Original named-image admission hold is unconfirmed");
  const seen = new Set<string>(), pending: any[] = [], jobs: any[] = [];
  for (const job of run.canaries) {
    const binding = bindings.data.find(row => row.kind === job.kind), request = ReleaseCanaryAdmissionSchema.safeParse(job.admissionRequest);
    const rows = state.resources.images.filter((row: any) => row.agentQualificationId === job.id);
    requireCheck(binding && rows.length === 1 && !seen.has(job.kind) && uuid.safeParse(job.id).success && request.success &&
      ["credentialId", "credentialRevision", "designationId", "model"].every(key => binding[key as keyof typeof binding] === job[key]) &&
      job.qualificationProfile === run.qualificationProfile && job.phase === "completed" && Number.isFinite(job.startedAt) && job.startedAt <= now &&
      job.prelaunchFailure === undefined && job.image?.snapshotId === candidate.data.snapshotId && job.image.sourceCommit === subject.sourceSha &&
      job.image.buildSha256 === candidate.data.buildSha256, "Native outcome/admission ownership is unconfirmed");
    seen.add(job.kind);
    const row = rows[0], original = request.data, body = nativeBody.safeParse(row.builderIntent?.body);
    requireCheck(original.ownerUserId === run.actorUserId && original.organizationId === env.WORKER_CANARY_ORGANIZATION_ID &&
      original.channel === subject.channel && original.sourceSha === subject.sourceSha && original.repository === subject.repository &&
      original.runId === subject.runId && Number(original.runAttempt) <= Number(subject.failedAttempt) && original.branch === subject.branch &&
      original.qualificationProfile === run.qualificationProfile && original.operationId === job.id &&
      ["kind", "credentialId", "credentialRevision", "designationId", "model"].every(key => original[key as keyof typeof original] === job[key]) &&
      original.target.id === row.builder?.id && original.target.attempt === job.id && original.target.snapshotId === candidate.data.snapshotId &&
      original.target.sourceCommit === subject.sourceSha && original.target.buildSha256 === candidate.data.buildSha256 &&
      row.purpose === "native-agent-qualification" && row.sourceCommit === subject.sourceSha && row.sourceImage === candidate.data.snapshotId &&
      row.inputsSha256 === createHash("sha256").update(`native-agent:${job.id}`).digest("hex") && row.snapshotId === undefined &&
      row.builderIntent?.key === job.id && Number.isFinite(row.builderIntent.at) && row.builderIntent.at >= job.startedAt && row.builderIntent.at <= now &&
      body.success && body.data.from === candidate.data.snapshotId && row.builderCreate?.phase === "acknowledged" &&
      row.machineAttestationStarted === true && row.nativeDispatchStarted === true && row.builder?.deleteRequested === true &&
      /^bdop_[a-f0-9]{32}$/.test(row.builder.deletionOperationId ?? "") && row.builder.id !== parent.builder.id &&
      !state.resources.images.some((other: any) => other !== row && other.builder?.id === row.builder.id), "Native original dispatch/deletion intent is unconfirmed");
    if (row.snapshotPolicyVersion !== undefined) requireCheck(row.snapshotPolicyVersion === 1 && body.data.snapshots === false &&
      row.snapshotPolicyObserved?.version === 1 && row.snapshotPolicyObserved.targetId === row.builder.id && row.snapshotPolicyObserved.snapshots === false &&
      Number.isFinite(Date.parse(row.snapshotPolicyObserved.observedAt)) && Date.parse(row.snapshotPolicyObserved.observedAt) >= row.builderIntent.at &&
      Date.parse(row.snapshotPolicyObserved.observedAt) <= now, "Native snapshots-off observation is unconfirmed");
    requireCheck(hash(job.outcome) === hash(fixedCanaryOutcome(job.outcome, { kind: job.kind, model: job.model, image: candidate.data })) &&
      job.outcome?.errorKind === undefined && job.outcome?.report?.failureKind === undefined &&
      (run.qualificationProfile !== "smoke" || job.model === RELEASE_CANARY_MODELS[job.kind as keyof typeof RELEASE_CANARY_MODELS]),
      "Native fixed result is malformed or rate-limited");
    nativeRuntimeEvidence(candidate.data, { ...binding, qualificationProfile: run.qualificationProfile }, job.outcome, job.startedAt, now);
    if (run.qualificationProfile === "full") requireCheck((job.kind === "codex-chatgpt"
      ? ["nativeGoals", "nativeFork", "transcriptFork", "nativeReview", "nativeApps", "nativeMultiAgent"] : ["transcriptFork"])
      .every(check => job.outcome.report.checks.includes(check)), "Native FULL capabilities are incomplete");
    if (job.retired === true || job.auditRetired !== undefined) {
      const marker = terminal.safeParse(job.auditRetired), physical = NativeCanaryPhysicalCleanupSchema.safeParse(row.builder.physicalCleanup);
      requireCheck(job.retired === true && marker.success && physical.success && row.builder.deleted === true &&
        marker.data.operationId === job.id && marker.data.deletionOperationId === row.builder.deletionOperationId &&
        physical.data.operationId === job.id && physical.data.targetId === row.builder.id && physical.data.operation.id === marker.data.deletionOperationId &&
        physical.data.accountBinding === account && physical.data.billingOrg === profile.boat.billingOrg &&
        physical.data.snapshotId === candidate.data.snapshotId && physical.data.sourceCommit === subject.sourceSha &&
        physical.data.buildSha256 === candidate.data.buildSha256 && physical.data.creationIntentSha256 === hash(row.builderIntent) &&
        Date.parse(physical.data.unavailableObservedAt) <= now, "Earlier native terminal proof is unconfirmed");
    } else {
      requireCheck(job.retired === undefined || job.retired === false, "Native retirement marker is malformed");
      requireCheck(row.builder.deleted !== true && row.builder.physicalCleanup === undefined && row.builder.retiredAt === undefined && row.deleted !== true,
        "Native physical cleanup is already settled or contradictory");
      const holds = ledger.reservations.filter((hold: any) => hold.computeId === `canary:${job.id}`);
      requireCheck(holds.length === 1 && holds[0].kind === "builder" && holds[0].owner === state.owner && holds[0].generation === state.generation &&
        holds[0].snapshotName === undefined && holds[0].releasedAt === undefined, "Native exact compute admission hold is unconfirmed");
      pending.push({ job, row });
    }
    jobs.push({ job, row, attempt: original.runAttempt });
  }
  requireCheck(pending.length === 1 && pending[0].job === run.canaries.at(-1), "Only one final successful native cleanup may await resumption");
  return { state, ledger, run, parent, candidate: candidate.data, jobs, pending: pending[0], account };
}

export async function readRetentionCompletion(subject: RetentionSubject, context: Context) {
  RetentionSubjectSchema.parse(subject);
  const now = (context.now ?? Date.now)();
  requireCheck(Number.isFinite(context.failedAt) && context.failedAt <= now, "Failed worker completion time is unconfirmed");
  const documents = await context.documents(), journal = inspectJournal(subject, context, documents.registry, documents.admission, now);
  for (const { job, row, attempt } of journal.jobs) {
    const worker = await context.originalWorker(attempt), qualifiedAt = Date.parse(job.outcome.report.qualifiedAt);
    requireCheck(Number.isFinite(worker.startedAt) && Number.isFinite(worker.finishedAt) && worker.startedAt <= worker.finishedAt &&
      job.startedAt >= worker.startedAt && job.startedAt <= worker.finishedAt && row.builderIntent.at <= worker.finishedAt &&
      qualifiedAt >= worker.startedAt - 5000 && qualifiedAt <= worker.finishedAt + 5000,
      "Retained native result is not bound to its original worker producing attempt");
  }
  const { job, row } = journal.pending;
  const meter = await context.request("GET", `/limits?org=${encodeURIComponent(context.profile.boat.billingOrg)}`);
  requireCheck(meter.status === 200 && Number.isFinite(meter.body?.creditUsedSeconds) && meter.body.creditUsedSeconds >= 0 &&
    meter.body.creditUsedSeconds / 3600 < journal.run.maxUsedHours, "Original worker account budget is unavailable or exhausted");
  const named = await context.request("GET", `/named-snapshots/${journal.candidate.snapshotId}`);
  requireCheck(named.status === 200 && named.body?.snapshot?.name === journal.candidate.snapshotId && named.body.snapshot.status === "ready" &&
    named.body.snapshot.sourceSandboxId === journal.parent.builder.id, "Original candidate named image is unavailable or changed");
  const response = await context.request("GET", `/deletion-operations/${row.builder.deletionOperationId}`), raw = response.body?.operation;
  const operation = NativeCanaryDeletionOperationSchema.safeParse(raw && { id: raw.id, kind: raw.kind, targetId: raw.targetId,
    status: raw.status, requestedAt: raw.requestedAt, completedAt: raw.completedAt });
  requireCheck(response.status === 200 && operation.success && operation.data.id === row.builder.deletionOperationId && operation.data.targetId === row.builder.id &&
    (raw.stage === undefined || raw.stage === "completed") && Date.parse(operation.data.requestedAt) >= row.builderIntent.at &&
    Date.parse(operation.data.requestedAt) <= context.failedAt && Date.parse(operation.data.completedAt) > context.failedAt &&
    Date.parse(operation.data.completedAt) <= (context.now ?? Date.now)(), "Original native physical deletion is not newly completed");
  const sandbox = await context.request("GET", `/sandboxes/${row.builder.id}`);
  requireCheck(sandbox.status === 404, "Completed native deletion still has an available sandbox");
  return { completedAt: operation.data.completedAt, sha256: hash({ registry: documents.registry!.etag, admission: documents.admission!.etag,
    subject, intent: row.builderIntent, admissionRequest: job.admissionRequest, outcome: job.outcome,
    builder: journal.parent.builderProvenance ?? journal.parent.builder.cleanup.provenance, operation: operation.data }) };
}
