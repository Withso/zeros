import { createHash } from "node:crypto";
import { z } from "zod";
import { z as nativeZod } from "zod/v3";
import { WorkerBuilderCleanupSchema, WorkerBuilderScopeSchema, WorkerCandidateSchema } from "./worker-builder-contracts";
import { NativeCanaryCleanupSchema, NativeCanaryDeletionOperationSchema, NativeCanaryStorageAuditSchema,
  NativeCanaryStorageOperationSchema, NativeCanaryStorageProgressSchema, ReleaseCanaryAdmissionSchema,
  ReleaseCanaryRetirementAuditSchema } from "../../apps/control-plane/src/cloud-workspaces/release-canary-contract";

const timestamp = z.string().datetime({ offset: true }), digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/), uuid = z.string().uuid();
const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), sandboxId = z.string().regex(/^bx_[a-z0-9]+$/);
const deletionId = z.string().regex(/^bdop_[a-f0-9]{32}$/), owner = z.string().regex(/^[a-f0-9]{24}$/);
const label = z.string().min(1).max(256);
// The control plane owns Zod 3 contracts while release uses Zod 4. Parse them
// through their public API; never embed one version's internals in the other.
type NativeParser<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
function nativeContract<T>(schema: NativeParser<T>): z.ZodType<Awaited<T>> {
  return z.unknown().transform((value, context): T => {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    context.addIssue({ code: "custom", message: "Invalid retained native contract" }); return z.NEVER;
  });
}
type NativeFields<Shape extends Record<string, NativeParser<unknown>>> = {
  [Key in keyof Shape]: z.ZodType<Awaited<Extract<ReturnType<Shape[Key]["safeParse"]>, { success: true }>["data"]>>;
};
function nativeFields<Shape extends Record<string, NativeParser<unknown>>>(shape: Shape): NativeFields<Shape> {
  // Object.fromEntries loses the association between each field and its output
  // type. Every field still invokes its owning parser, preserving its checks.
  return Object.fromEntries(Object.entries(shape).map(([key, schema]) => [key, nativeContract(schema)])) as NativeFields<Shape>;
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
/** New named-retirement digests are order independent. Existing certificate and
 * admission-request digests retain their original JSON serialization contract. */
export const workerNamedRetirementSha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

type Projection = null | boolean | number | string | Projection[] | { [key: string]: Projection };
function boundedProjection(value: unknown, depth = 0): value is Projection {
  if (depth > 12) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 4096;
  if (Array.isArray(value)) return value.length <= 5000 && value.every(row => boundedProjection(row, depth + 1));
  return typeof value === "object" && Object.keys(value).length <= 5000 && Object.entries(value)
    .every(([key, row]) => key.length <= 256 && boundedProjection(row, depth + 1));
}
// The separately reviewed collector retains its complete, non-secret domain
// projections here. A digest or an unbound "reviewed" flag is not a projection.
const projection = z.custom<Record<string, Projection>>(value => value !== null && typeof value === "object" &&
  !Array.isArray(value) && Object.keys(value).length > 0 && boundedProjection(value) && Buffer.byteLength(JSON.stringify(value)) <= 96 * 1024);
const retainedProjection = { projection, projectionSha256: digest };

const nativeTimestamp = nativeContract(nativeZod.string().datetime({ offset: true }));
const physicalAudit = z.object({ version: z.literal(1), deletionOperationId: deletionId,
  targetId: sandboxId, operation: nativeContract(NativeCanaryDeletionOperationSchema),
  operationObservedAt: nativeTimestamp, unavailableObservedAt: nativeTimestamp, provenanceSha256: digest }).strict()
  .refine(value => value.deletionOperationId === value.operation.id && value.targetId === value.operation.targetId &&
    Date.parse(value.operation.completedAt) <= Date.parse(value.operationObservedAt) && Date.parse(value.operationObservedAt) <= Date.parse(value.unavailableObservedAt));
export const WorkerNamedNativeAuditSubjectSchema = z.object({ ...nativeFields(ReleaseCanaryRetirementAuditSchema.shape),
  beforeVersion: nativeContract(nativeZod.number().int().positive().safe().optional()),
  retirement: z.union([nativeContract(NativeCanaryStorageAuditSchema), physicalAudit]),
}).strict();
export const WorkerNamedNativeAuditSchema = z.object({ id: z.string().regex(/^[1-9]\d*$/), databaseKey: label,
  action: z.enum(["cloud.release_canary.storage_retired", "cloud.release_canary.retired"]), organizationId: uuid, actorUserId: uuid,
  createdAt: timestamp, observedAt: timestamp, primary: z.literal(true), policyVisible: z.literal(true), latestAcrossAllPhases: z.literal(true),
  subject: WorkerNamedNativeAuditSubjectSchema }).strict();
const nativeMarker = z.union([
  z.object({ version: z.literal(1), operationId: uuid, deletionOperationId: deletionId }).strict(),
  z.object({ version: z.literal(2), operationId: uuid, deletionOperationId: deletionId, storagePending: z.literal(true) }).strict(),
]);
export const WorkerNamedNativeEvidenceSchema = z.object({ admissionRequest: nativeContract(ReleaseCanaryAdmissionSchema),
  creation: z.object({ key: uuid, at: z.number().int().positive().safe(), body: z.object({ type: z.literal("default"), from: name,
    ttlSeconds: z.number().int().min(60).max(2700), noEnv: z.literal(true), env: z.object({}).strict(), snapshots: z.boolean().optional() }).strict() }).strict(),
  cleanup: nativeContract(NativeCanaryCleanupSchema), marker: nativeMarker, audit: WorkerNamedNativeAuditSchema }).strict();

export const WORKER_NAMED_REFERENCE_DOMAINS = ["configurations", "deployments", "registries", "archives", "application", "primary-audits", "reference-writers"] as const;
const authority = z.object({ namespace: label, accountBinding: digest, identitySha256: digest, authenticated: z.literal(true), policyVisible: z.literal(true),
  ...retainedProjection, records: z.array(z.object({ key: label, referenceCount: z.literal(0), unresolvedCount: z.literal(0),
    references: z.array(label).max(0), disposition: z.literal("unreferenced") }).strict()).min(1).max(5000) }).strict();
export const WorkerNamedReviewEvidenceSchema = z.object({ version: z.literal(1), scope: WorkerBuilderScopeSchema,
  builder: WorkerBuilderCleanupSchema, creates: z.object({ builderSha256: digest, snapshotSha256: digest }).strict(),
  audit: z.object({ natives: z.array(WorkerNamedNativeEvidenceSchema).max(3) }).strict(),
  bundle: z.object({ sourceSha: sha, treeSha: sha, actionSha256: digest, collectorSha256: digest, reviewArtifactSha256: digest,
    reviewerId: uuid, reviewedAt: timestamp }).strict(),
  observedAt: timestamp, expiresAt: timestamp,
  inventory: z.object({ complete: z.literal(true), observedAt: timestamp, names: z.array(name).min(1).max(10) }).strict(),
  references: z.array(z.object({ domain: z.enum(WORKER_NAMED_REFERENCE_DOMAINS), observedAt: timestamp, complete: z.literal(true),
    authorities: z.array(authority).min(1).max(100) }).strict()).length(WORKER_NAMED_REFERENCE_DOMAINS.length),
  exclusion: z.object({ id: uuid, accountBinding: digest, startedAt: timestamp, expiresAt: timestamp, owners: z.array(owner).min(1).max(100),
    namespaces: z.array(label).min(1).max(700), controllers: z.array(z.object({ identitySha256: digest,
      oldAndDrainingWritersCovered: z.literal(true), inFlightWritersCovered: z.literal(true), excluded: z.literal(true),
      ...retainedProjection }).strict()).min(1).max(100) }).strict(),
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value)) <= 192 * 1024, "Named retirement evidence exceeds its bound");
export type WorkerNamedReviewEvidence = z.infer<typeof WorkerNamedReviewEvidenceSchema>;

export const WorkerNamedReservationSchema = z.object({ kind: z.literal("builder"), owner, generation: uuid, computeId: z.string().regex(/^snapshot:/),
  snapshotName: name, createdAt: timestamp, releasedAt: timestamp, legacy: z.boolean().optional() }).strict()
  .refine(value => value.computeId === `snapshot:${value.snapshotName}`);
const target = z.object({ provider: z.literal("boat"), name, sourceSandboxId: sandboxId, candidate: WorkerCandidateSchema }).strict();
export const WorkerNamedDeleteAcknowledgementSchema = z.object({ version: z.literal(2), kind: z.literal("release-owned-named-deletion"),
  consumed: z.literal(true), phase: z.literal("acknowledged"),
  intent: z.object({ phase: z.literal("intent-saved"), id: uuid, savedAt: timestamp, leaseToken: uuid, target,
    namedSnapshot: z.object({ name, sourceSandboxId: sandboxId, status: z.literal("ready"), observedAt: timestamp }).strict(),
    reservation: WorkerNamedReservationSchema, review: WorkerNamedReviewEvidenceSchema }).strict(),
  dispatch: z.object({ phase: z.literal("dispatching"), intentSha256: digest, intentFencedAt: timestamp, savedAt: timestamp, fencedAt: timestamp, leaseToken: uuid }).strict(),
  acknowledgedAt: timestamp,
  response: z.object({ status: z.literal(200), type: z.literal("snapshot.named.deleted"), name, statusText: z.literal("deleted") }).strict(),
}).strict();
export type WorkerNamedDeleteAcknowledgement = z.infer<typeof WorkerNamedDeleteAcknowledgementSchema>;
export const WorkerNamedRetirementReviewSchema = z.object({ version: z.literal(1), kind: z.literal("release-owned-name-retirement-review"),
  acknowledgementSha256: digest, evidence: WorkerNamedReviewEvidenceSchema }).strict();

const reservation = z.object({ kind: z.enum(["generation", "builder"]), owner, generation: uuid, createdAt: timestamp,
  computeId: z.string().max(128).optional(), snapshotName: name.optional(), capacityClass: z.literal("custom").optional(),
  releasedAt: timestamp.optional(), snapshotReleasedAt: timestamp.optional(), legacy: z.boolean().optional() }).strict();
export const WorkerNamedAdmissionLedgerSchema = z.object({ version: z.literal(1), owner: z.literal("account-admission"), account: digest,
  reservations: z.array(reservation).max(5000), policy: z.object({ maxActiveGenerations: z.number().int().positive(),
    maxGenerationsPerOwner: z.number().int().positive(), maxBuilders: z.number().int().positive(), maxBuildersPerOwner: z.number().int().positive(),
    maxNamedSnapshots: z.number().int().positive().max(10), snapshotHeadroom: z.number().int().nonnegative() }).strict().optional() }).strict();
const namespace = z.object({ nameObservedAt: timestamp, inventoryObservedAt: timestamp, names: z.array(name).min(1).max(10),
  builder: WorkerBuilderCleanupSchema, natives: z.array(z.object({ operationId: uuid,
    operation: z.union([nativeContract(NativeCanaryDeletionOperationSchema), nativeContract(NativeCanaryStorageOperationSchema),
      nativeContract(NativeCanaryStorageProgressSchema)]),
    operationObservedAt: timestamp, unavailableObservedAt: timestamp }).strict()).max(3) }).strict();
const transition = z.object({ etag: z.string().min(1).max(1024), beforeSha256: digest, afterSha256: digest, reservationSha256: digest,
  reservationIndex: z.number().int().nonnegative(), remainder: WorkerNamedAdmissionLedgerSchema }).strict();
const witness = { version: z.literal(1), kind: z.literal("release-owned-name-retirement"), acknowledgementSha256: digest, reviewSha256: digest,
  review: WorkerNamedRetirementReviewSchema, scope: WorkerBuilderScopeSchema, target, reservation: WorkerNamedReservationSchema, preparedAt: timestamp, namespace };
export const WorkerNameRetirementSchema = z.discriminatedUnion("phase", [
  z.object({ ...witness, phase: z.literal("prepared") }).strict(),
  z.object({ ...witness, phase: z.literal("tombstoned"), tombstonedAt: timestamp, transition }).strict(),
  z.object({ ...witness, phase: z.literal("committed"), tombstonedAt: timestamp, transition, committedAt: timestamp,
    admissionEtag: z.string().min(1).max(1024) }).strict(),
]);
export type WorkerNameRetirement = z.infer<typeof WorkerNameRetirementSchema>;
