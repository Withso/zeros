import { createHash } from "node:crypto";
import { z } from "zod";
import { CloudAgentRuntimeSchema } from "../../../../apps/control-plane/src/cloud-workspaces/runtime-contract";

// Script-only fixtures consume the real shared schemas. The standalone CP
// mirrors those schemas; importing this fixture from an app is forbidden.
export const ScopeSchema = z.object({ workspaceId: z.uuid(), organizationId: z.uuid(),
  generation: z.number().int().safe().positive(), engineInstanceId: z.uuid() }).strict();
export const RegistrationSchema = ScopeSchema.extend({ setupRunId: z.uuid(), executionFence: z.number().int().safe().positive(),
  protocolVersion: z.number().int().min(1).max(65_535), actorProtocolVersion: z.literal(2).optional(),
  agentCustomizationVersion: z.literal(3).optional(), agentRuntime: z.unknown().refine(value => CloudAgentRuntimeSchema.safeParse(value).success).optional() }).strict();
export const HeartbeatSchema = ScopeSchema.extend({
  observedPorts: z.array(z.object({ port: z.number().int().min(1024).max(65535), protocol: z.literal("tcp") }).strict()).max(128).optional(),
  repositoryCredentialRefresh: z.object({ generation: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/), requestedAtMs: z.number().int().safe().positive(),
    ownerSubjectSha256: z.string().regex(/^[a-f0-9]{64}$/), method: z.literal("github-app"), reason: z.literal("credential-invalid") }).strict().optional(),
}).strict();
export const ActorAdmissionSchema = ScopeSchema.extend({ grantToken: z.string().regex(/^zwa_[A-Za-z0-9_-]{43}$/), renew: z.boolean().optional() }).strict();
export type RuntimeAttestation = Readonly<{ profile: "zeros-cloud-worker-v4"; runtimeId: string; manifestSha256: string;
  baseCompatibilityId: string; installerReceiptSha256: string; bootId: string; supervisorSessionId: string }>;
export function parse<T>(schema: { safeParse(value: unknown): { success: boolean; data?: T } }, value: unknown, code: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new FixtureRefusal(code, 422);
  return result.data as T;
}
export class FixtureRefusal extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
export const clone = <T>(value: T): T => structuredClone(value);
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown, depth = 0): string {
  if (depth > 24) throw new FixtureRefusal("invalid_command", 422);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => {
    if (["__proto__", "prototype", "constructor"].includes(key) || key.length > 256) throw new FixtureRefusal("invalid_command", 422);
    return `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`;
  }).join(",")}}`;
}
