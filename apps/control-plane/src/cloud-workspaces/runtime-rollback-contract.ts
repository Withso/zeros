import { createHash } from "node:crypto";
import { z } from "zod";
import { CloudActiveRuntimeSchema, RuntimeDescriptorSchema } from "./runtime-contract.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const runtimeId = z.string().regex(/^r1-[a-f0-9]{64}$/);
const baseId = z.string().regex(/^bc1-[a-f0-9]{64}$/);
export const RuntimeRollbackScopeSchema = z.object({
  workspaceId: z.string().uuid(), organizationId: z.string().uuid(), generation: z.number().int().min(1).max(2 ** 31 - 1),
  providerResourceId: z.string().regex(/^bx_[A-Za-z0-9_-]{1,128}$/),
  authorityEpoch: z.string().regex(/^[0-9]{1,18}$/), intentId: z.string().uuid(),
}).strict();
export type RuntimeRollbackScope = z.infer<typeof RuntimeRollbackScopeSchema>;
const offer = z.object({
  runtime: RuntimeDescriptorSchema, baseCompatibilityId: baseId, scope: RuntimeRollbackScopeSchema,
  currentRuntimeId: runtimeId, bootId: z.string().uuid(), diskEpoch: z.number().int().positive().safe(),
  installerReceipt: z.string().regex(/^[A-Za-z0-9_-]{1,5462}$/), installerReceiptSha256: digest,
}).strict();
const receipt = z.object({ schema: z.literal("zeros.runtime-install-receipt/v1"), runtimeId, manifestSha256: digest,
  archiveSha256: digest, baseCompatibilityId: baseId, bootstrapVersion: z.literal(1),
  expandedBytes: z.number().int().positive().max(4 * 1024 ** 3), fileCount: z.number().int().min(1).max(100_000),
  installedAt: z.string().datetime({ offset: true }),
}).strict();
export const RuntimeRollbackOfferSchema = offer.refine(value => {
  try {
    const bytes = Buffer.from(value.installerReceipt, "base64url");
    if (bytes.length > 4096 || bytes.toString("base64url") !== value.installerReceipt ||
      createHash("sha256").update(bytes).digest("hex") !== value.installerReceiptSha256) return false;
    const proof = receipt.parse(JSON.parse(bytes.toString("utf8")));
    return value.currentRuntimeId !== value.runtime.runtimeId && proof.runtimeId === value.runtime.runtimeId &&
      proof.manifestSha256 === value.runtime.manifestSha256 && proof.archiveSha256 === value.runtime.archiveSha256 &&
      proof.expandedBytes === value.runtime.expandedBytes && proof.baseCompatibilityId === value.baseCompatibilityId;
  } catch { return false; }
});
export type RuntimeRollbackOffer = z.infer<typeof RuntimeRollbackOfferSchema>;
export function parseRuntimeRollbackOffer(value: unknown): RuntimeRollbackOffer {
  const result = RuntimeRollbackOfferSchema.safeParse(value);
  if (!result.success) throw new Error("Runtime rollback proof is invalid");
  return result.data;
}
export const RuntimeRollbackInputSchema = z.object({ schema: z.literal("zeros.runtime-rollback-cache/v1"),
  operation: z.literal("evict"), fence: z.string().uuid(), scope: RuntimeRollbackScopeSchema,
  current: CloudActiveRuntimeSchema, expiresAt: z.string().datetime({ offset: true }),
}).strict();
export type RuntimeRollbackInput = z.infer<typeof RuntimeRollbackInputSchema>;
export const RuntimeRollbackRestoreSchema = z.object({
  retentionId: z.string().uuid(), deadline: z.string().datetime({ offset: true }),
  installerReceiptSha256: digest,
}).strict();
export type RuntimeRollbackRestore = z.infer<typeof RuntimeRollbackRestoreSchema>;
