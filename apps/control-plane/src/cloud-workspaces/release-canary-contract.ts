import { z } from "zod";
import { DevCanaryTargetSchema } from "./dev-native-canary.js";

export const RELEASE_CANARY_KINDS = ["claude-setup-token", "codex-chatgpt", "cursor-api-key"] as const;
export const RELEASE_CANARY_SMOKE_MODELS = { claude: "claude-haiku-4-5", codex: "gpt-5.6-luna", cursor: "composer-2.5" } as const;
export const RELEASE_CANARY_MODELS = {
  "claude-setup-token": RELEASE_CANARY_SMOKE_MODELS.claude,
  "codex-chatgpt": RELEASE_CANARY_SMOKE_MODELS.codex,
  "cursor-api-key": RELEASE_CANARY_SMOKE_MODELS.cursor,
} as const;
export const ReleaseCanaryConnectionSchema = z.object({
  kind: z.enum(RELEASE_CANARY_KINDS), credentialId: z.string().uuid(), credentialRevision: z.number().int().positive().safe(),
  designationId: z.string().regex(/^[1-9]\d*$/), model: z.string().max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\[1m\])?$/),
}).strict();
export const ReleaseCanaryBindingsSchema = z.array(ReleaseCanaryConnectionSchema).length(3).refine(rows =>
  new Set(rows.map(row => row.kind)).size === 3 && new Set(rows.map(row => row.credentialId)).size === 3,
"Release canary bindings must identify the exact three distinct designated connections");
export type ReleaseCanaryConnection = z.infer<typeof ReleaseCanaryConnectionSchema>;

const uuid = z.string().uuid(), sha = z.string().regex(/^[a-f0-9]{40}$/), counter = z.string().regex(/^[1-9]\d*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/), timestamp = z.string().datetime({ offset: true });
const sandboxId = z.string().regex(/^bx_[a-z0-9]+$/), deletionId = z.string().regex(/^bdop_[a-f0-9]{32}$/);
const snapshot = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
export const ReleaseCanaryIdentitySchema = z.object({ version: z.literal(1), ownerUserId: uuid, organizationId: uuid,
  channel: z.enum(["alpha", "beta", "production"]), sourceSha: sha, repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  qualificationProfile: z.enum(["smoke", "full"]) }).strict();
export const ReleaseCanaryAdmissionSchema = ReleaseCanaryIdentitySchema.extend({ operationId: uuid, runId: counter, runAttempt: counter,
  branch: z.string(), ...ReleaseCanaryConnectionSchema.shape, target: DevCanaryTargetSchema }).strict();
export const ReleaseCanaryRetirementSchema = z.object({ version: z.literal(1), operationId: uuid, deletionOperationId: deletionId, leaseToken: uuid }).strict();
export const ReleaseCanaryRetirementAuditSchema = ReleaseCanaryConnectionSchema.extend({ operationId: uuid, requestSha256: digest,
  qualificationProfile: z.enum(["smoke", "full"]), channel: z.enum(["alpha", "beta", "production"]), sourceSha: sha,
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), runId: counter, runAttempt: counter, targetId: sandboxId,
  imageRef: z.string().regex(/^boat:[a-z0-9][a-z0-9-]{0,62}@sha256:[a-f0-9]{64}$/), allowanceOwnerUserId: uuid }).passthrough();
export const NativeCanaryDeletionOperationSchema = z.object({ id: deletionId, kind: z.literal("sandbox"), targetId: sandboxId,
  status: z.literal("completed"), requestedAt: timestamp, completedAt: timestamp }).strict().refine(value =>
  Date.parse(value.requestedAt) <= Date.parse(value.completedAt));
export const NativeCanaryPhysicalCleanupSchema = z.object({ version: z.literal(1), operationId: uuid, targetId: sandboxId,
  snapshotId: snapshot, sourceCommit: sha, buildSha256: digest, creationIntentSha256: digest, accountBinding: digest, billingOrg: z.string().min(1),
  operation: NativeCanaryDeletionOperationSchema, operationObservedAt: timestamp, unavailableObservedAt: timestamp }).strict().refine(value =>
  value.targetId === value.operation.targetId && Date.parse(value.operation.completedAt) <= Date.parse(value.operationObservedAt) &&
  Date.parse(value.operationObservedAt) <= Date.parse(value.unavailableObservedAt));
export const NativeCanaryStorageOperationSchema = z.object({ id: deletionId, kind: z.literal("sandbox"), targetId: sandboxId,
  status: z.literal("blocked"), stage: z.enum(["waiting_for_uploads", "kept_for_newer_snapshots", "waiting_for_restore"]),
  requestedAt: timestamp, expectedBy: timestamp.nullable() }).strict().refine(value => value.stage !== "waiting_for_uploads" ||
  value.expectedBy !== null && Date.parse(value.expectedBy) >= Date.parse(value.requestedAt));
export const NativeCanaryStorageProgressSchema = z.object({ id: deletionId, kind: z.literal("sandbox"), targetId: sandboxId,
  status: z.enum(["pending", "processing"]), stage: z.enum(["removing", "retrying"]), requestedAt: timestamp }).strict();
export const NativeCanaryStorageAuditSchema = z.object({ version: z.literal(2), deletionOperationId: deletionId, targetId: sandboxId,
  operation: NativeCanaryStorageOperationSchema, operationObservedAt: timestamp, unavailableObservedAt: timestamp, provenanceSha256: digest,
  storage: z.object({ status: z.literal("pending"), physicalBytes: z.literal("unmeasured") }).strict(),
  progress: z.object({ operation: NativeCanaryStorageProgressSchema, operationObservedAt: timestamp }).strict().optional() }).strict().refine(value =>
  value.deletionOperationId === value.operation.id && value.targetId === value.operation.targetId &&
  Date.parse(value.operation.requestedAt) <= Date.parse(value.operationObservedAt) && Date.parse(value.operationObservedAt) <= Date.parse(value.unavailableObservedAt) &&
  (!value.progress || value.progress.operation.id === value.operation.id && value.progress.operation.targetId === value.targetId &&
    value.progress.operation.requestedAt === value.operation.requestedAt && Date.parse(value.operationObservedAt) <= Date.parse(value.progress.operationObservedAt) &&
    Date.parse(value.progress.operationObservedAt) <= Date.parse(value.unavailableObservedAt)));
export const NativeCanaryStorageRetirementSchema = z.object({ version: z.literal(1), kind: z.literal("storage-pending"),
  operationId: uuid, targetId: sandboxId, snapshotId: snapshot, sourceCommit: sha, buildSha256: digest,
  creationIntentSha256: digest, accountBinding: digest, billingOrg: z.string().min(1), operation: NativeCanaryStorageOperationSchema,
  snapshotsOff: z.object({ version: z.literal(1), targetId: sandboxId, snapshots: z.literal(false), observedAt: timestamp }).strict(),
  operationObservedAt: timestamp, unavailableObservedAt: timestamp }).strict().refine(value =>
  value.targetId === value.operation.targetId && value.snapshotsOff.targetId === value.targetId &&
  Date.parse(value.snapshotsOff.observedAt) <= Date.parse(value.operation.requestedAt) &&
  Date.parse(value.operation.requestedAt) <= Date.parse(value.operationObservedAt) &&
  Date.parse(value.operationObservedAt) <= Date.parse(value.unavailableObservedAt) &&
  (value.operation.expectedBy === null || Date.parse(value.operation.expectedBy) <= Date.parse(value.operationObservedAt) + 6 * 3600_000 + 5000));
export const NativeCanaryCleanupSchema = z.union([NativeCanaryPhysicalCleanupSchema, NativeCanaryStorageRetirementSchema]);
export const ReleaseCanaryPrelaunchFailureSchema = z.object({ version: z.literal(1), stage: z.literal("private-input-upload"),
  classification: z.literal("forbidden"), status: z.literal(403) }).strict();
export const RELEASE_CANARY_UPLOAD_FORBIDDEN = "Release canary private input upload is forbidden; Boat file.write authority is required";
export type ReleaseCanaryRetirementAudit = z.infer<typeof ReleaseCanaryRetirementAuditSchema>;
export type ReleaseCanaryRetirement = z.infer<typeof ReleaseCanaryRetirementSchema>;
