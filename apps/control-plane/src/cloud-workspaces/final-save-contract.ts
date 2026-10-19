// Standalone mirror of packages/protocol/src/cloud-final-save.ts; parity tests pin the wire.
import { z } from "zod";

export const CLOUD_FINAL_SAVE_VERSION_HEADER = "x-zeros-final-save-version";
export const CLOUD_FINAL_SAVE_PATH = "/internal/v1/cloud-workspaces/engine/final-save";
export const CLOUD_FINAL_SAVE_MAX_BYTES = 8192;
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const revision = z.number().int().positive().safe();
const ordinal = z.number().int().nonnegative().max(2_147_483_647);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = { organizationId: uuid, workspaceId: uuid, generation: revision, engineInstanceId: uuid };
const finalReason = z.enum(["before_stop", "before_archive", "before_delete", "before_rebuild"]);

/** Display-only accepted operation. It cannot grant engine or provider authority. */
const acceptedOperationIdentity = { version: z.literal(1), id: uuid,
  kind: z.enum(["stop", "archive", "delete", "restart"]), sourceGeneration: revision };
export const CloudAcceptedLifecycleReceiptSchema = z.object(acceptedOperationIdentity).strict();
export type CloudAcceptedLifecycleReceipt = z.infer<typeof CloudAcceptedLifecycleReceiptSchema>;
export const CloudAcceptedLifecycleOperationSchema = z.object({
  ...acceptedOperationIdentity,
  phase: z.enum(["saving", "stopping", "archiving", "deleting", "starting", "completed"]),
  state: z.enum(["pending", "completed"]),
}).strict().refine(value => (value.state === "completed") === (value.phase === "completed") &&
  (value.phase === "saving" || value.phase === "completed" ||
    (value.phase === "stopping" && ["stop","restart"].includes(value.kind)) ||
    (value.phase === "starting" && value.kind === "restart") ||
    (value.phase === "archiving" && value.kind === "archive") || (value.phase === "deleting" && value.kind === "delete")));
export type CloudAcceptedLifecycleOperation = z.infer<typeof CloudAcceptedLifecycleOperationSchema>;
export const CloudRestartInputSchema = z.object({ version: z.literal(1), expectedGeneration: revision }).strict();

/** The CP freezes this at accepted admission. A heartbeat is not a new
 * registration, and a writer epoch is a UUID, not a numeric revision. */
export const CloudFinalSaveSourceSchema = z.object({
  ...identity, runtimeId: z.string().regex(/^r1-[a-f0-9]{64}$/), bootId: uuid, writerEpoch: uuid,
  fundingOwnerUserId: uuid, fundingOwnerEpoch: revision, authorityEpoch: revision, registeredAtMs: revision,
  allocationLeaseId: uuid.nullable(), providerResourceId: z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/),
}).strict();
export type CloudFinalSaveSource = z.infer<typeof CloudFinalSaveSourceSchema>;

export const CloudFinalSaveDirectiveSchema = z.object({
  version: z.literal(1), recoveryId: uuid, attemptOrdinal: ordinal, predecessorRequestId: uuid.nullable(),
  source: CloudFinalSaveSourceSchema, sourceSha256: digest, custodyId: uuid.nullable(), retirementId: uuid.nullable(),
}).strict().refine(value => value.attemptOrdinal === 0
  ? value.predecessorRequestId === null && value.custodyId === null && value.retirementId === null
  : value.predecessorRequestId !== null && value.custodyId !== null && value.retirementId !== null,
{ message: "Final save predecessor and custody are inconsistent" });
export type CloudFinalSaveDirective = z.infer<typeof CloudFinalSaveDirectiveSchema>;

export const CloudFinalSaveCommitSchema = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/), requestSha256: digest, bodySha256: digest,
}).strict();
export type CloudFinalSaveCommit = z.infer<typeof CloudFinalSaveCommitSchema>;
const attempt = { version: z.literal(1), recoveryId: uuid, requestId: uuid, attemptOrdinal: ordinal,
  sourceSha256: digest, custodyId: uuid };
export const CloudFinalSaveRequestSchema = z.discriminatedUnion("kind", [
  z.object({ ...identity, ...attempt, kind: z.literal("retry"), failure: z.enum(["capture_failed", "commit_ambiguous"]),
    commit: CloudFinalSaveCommitSchema.nullable() }).strict(),
  z.object({ ...identity, ...attempt, kind: z.literal("reconcile"), commit: CloudFinalSaveCommitSchema.nullable() }).strict(),
]).refine(value => value.kind !== "retry" || value.failure !== "commit_ambiguous" || value.commit !== null,
{ message: "An ambiguous commit requires its exact journal descriptor" });
export type CloudFinalSaveRequest = z.infer<typeof CloudFinalSaveRequestSchema>;

export const CloudFinalSaveResponseSchema = z.discriminatedUnion("state", [
  z.object({ ...attempt, state: z.literal("waiting"), retryAtMs: revision }).strict(),
  z.object({ ...attempt, state: z.literal("committed"), checkpoint: z.object({ checkpointId: uuid,
    contentRevision: revision, manifestSha256: digest, reason: finalReason, requestSha256: digest }).strict() }).strict(),
  z.object({ ...attempt, state: z.literal("retired"), retirementId: uuid, retryAtMs: revision }).strict(),
  z.object({ ...attempt, state: z.literal("blocked"), retryAtMs: revision,
    reason: z.enum(["authority", "custody", "journal", "scope"]) }).strict(),
]);
export type CloudFinalSaveResponse = z.infer<typeof CloudFinalSaveResponseSchema>;

/** Hash UTF-8 of this representation. Only parsed closed wire values enter it. */
export function canonicalFinalSaveJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalFinalSaveJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalFinalSaveJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function canonicalFinalSaveSource(value: unknown): string {
  return canonicalFinalSaveJson(CloudFinalSaveSourceSchema.parse(value));
}
