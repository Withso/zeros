import { z } from "zod";

const uuid = z.string().uuid();
const counter = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const request = { challenge: uuid, organizationId: uuid, workspaceId: uuid, generation: counter,
  engineInstanceId: uuid, hostId: uuid, fence: counter, expiresAtMs: counter };
/** Mirrored from the cloud engine. Only the pinned root adapter may supply
 * these receipts; renderer/engine-facing HTTP is never a proof channel. */
export const CloudRuntimeHandoffRequestSchema = z.object(request).strict();
export const CloudRuntimeHandoffReceiptSchema = z.object({ ...request, version: z.literal(1),
  phase: z.literal("fenced"), activityRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
export const CloudResidentWitnessSchema = z.object({
  hostId: uuid, organizationId: uuid, workspaceId: uuid, protocol: z.literal("zeros.resident-pty/v1"),
  runtimeId: z.string().regex(/^r1-[a-f0-9]{64}$/), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  bootId: uuid, supervisorSessionId: uuid,
  scope: z.string(), fence: counter, engineId: uuid.nullable(), generation: counter.nullable(),
}).strict().refine(value => value.runtimeId === `r1-${value.manifestSha256}` &&
  value.scope === `/sys/fs/cgroup/system.slice/zeros-host.service/engine-workload-${value.hostId}` &&
  (value.engineId === null) === (value.generation === null));
export type CloudRuntimeHandoffRequest = z.infer<typeof CloudRuntimeHandoffRequestSchema>;
export type CloudRuntimeHandoffReceipt = z.infer<typeof CloudRuntimeHandoffReceiptSchema>;
export type CloudResidentWitness = z.infer<typeof CloudResidentWitnessSchema>;
export const sameHandoff = (left: CloudRuntimeHandoffRequest, right: CloudRuntimeHandoffRequest): boolean =>
  Object.keys(request).every(key => left[key as keyof CloudRuntimeHandoffRequest] === right[key as keyof CloudRuntimeHandoffRequest]);
/** Detached authority increments once. Runtime/host/boot/scope remain exact. */
export function detachedResident(source: CloudResidentWitness, value: CloudResidentWitness): boolean {
  return source.engineId !== null && value.engineId === null && value.generation === null && value.fence === source.fence + 1 &&
    sameResidentHost(source, value);
}
export function sameResidentHost(left: CloudResidentWitness, right: CloudResidentWitness): boolean {
  return (["hostId", "organizationId", "workspaceId", "protocol", "runtimeId", "manifestSha256", "bootId",
    "supervisorSessionId", "scope"] as const).every(key => left[key] === right[key]);
}
