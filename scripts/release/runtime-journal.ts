import { z } from "zod";
import { RuntimeCanaryClaimsSchema } from "../../apps/control-plane/src/cloud/runtime-canary";
import { RuntimeReleaseSchema } from "../../apps/control-plane/src/cloud/runtime-release";
import { RuntimeSupportSchema } from "../../apps/control-plane/src/cloud/runtime-support";
import { RuntimeReleaseConfigSchema, type RuntimeReleaseConfig } from "./runtime-contracts";
import { RuntimeDatabaseJournalSchema } from "./runtime-database";
import { requireCheck } from "./contracts";

const pin = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), release: RuntimeReleaseSchema.nullable() }).strict()
  .refine(value => value.release === null || value.release.sha256 === value.sha256);
const lease = z.object({ version: z.literal(1), id: z.string().uuid(), runId: z.string(),
  liveCpSha: z.string().regex(/^[a-f0-9]{40}$/), priorRuntimeSha256: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.string().datetime() }).strict();
const deploymentId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const support = z.object({ previous: RuntimeSupportSchema.nullable(), next: RuntimeSupportSchema }).strict().optional();
export const RuntimeProviderIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stage"), phase: z.enum(["requested", "confirmed"]), previous: pin, retainedPrevious: pin.nullable(), next: pin, lease, servingDeploymentId: deploymentId, support }).strict(),
  z.object({ kind: z.literal("restore"), phase: z.enum(["requested", "confirmed"]), previous: pin, retainedPrevious: pin.nullable(), next: pin, lease, servingDeploymentId: deploymentId, support }).strict(),
  z.object({ kind: z.literal("deploy"), phase: z.enum(["requested", "confirmed", "ready"]), cpSha: z.string().regex(/^[a-f0-9]{40}$/),
    next: pin, lease, deploymentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable() }).strict(),
]);
export type RuntimeProviderIntent = z.infer<typeof RuntimeProviderIntentSchema>;
export type RuntimeProviderRecovery = { stage: Extract<RuntimeProviderIntent, { kind: "stage" }>;
  deploy?: Extract<RuntimeProviderIntent, { kind: "deploy" }> };
const detail = z.union([
  RuntimeProviderIntentSchema,
  z.object({ kind: z.literal("database"), journal: RuntimeDatabaseJournalSchema }).strict(),
  z.object({ kind: z.literal("canary"), claims: RuntimeCanaryClaimsSchema, keyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    grantSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ kind: z.literal("canary-cleanup"), grantId: z.string().uuid(), workspaceId: z.string().uuid().nullable(), deleted: z.literal(true) }).strict(),
  z.object({ kind: z.literal("drain"), phase: z.enum(["requested", "acquired", "ended"]), lease: lease.nullable() }).strict()
    .refine(value => value.phase === "requested" ? value.lease === null : value.lease !== null),
]);
export const RuntimeEventSchema = z.object({ version: z.literal(1), source: RuntimeReleaseConfigSchema,
  sequence: z.number().int().min(1).max(1000), at: z.string().datetime(), cleanup: z.literal(true).optional(), detail }).strict();
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;
export type RuntimeEventDetail = RuntimeEvent["detail"];

export function runtimeJournal(config: RuntimeReleaseConfig, save: (event: RuntimeEvent) => Promise<void>, options: { cleanup?: true; sequence?: number } = {}) {
  let sequence = options.sequence ?? 0;
  return async (value: RuntimeEventDetail): Promise<void> => {
    const parsed = RuntimeEventSchema.safeParse({ version: 1, source: config, sequence: ++sequence, at: new Date().toISOString(),
      ...(options.cleanup ? { cleanup: true } : {}), detail: value });
    requireCheck(parsed.success, "Runtime recovery record is invalid; details withheld");
    await save(parsed.data);
  };
}
