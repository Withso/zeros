import { z } from "zod";
import { cloudAccountRequest } from "../../platform/cloud-workspaces";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";

export const releaseCanaryDefaultModels: Readonly<Record<string, string>> = {
  "claude-setup-token": "claude-haiku-4-5",
  "codex-chatgpt": "gpt-5.6-luna",
  "cursor-api-key": "composer-2.5",
};
export function releaseCanaryDefaultModel(kind: string): string | null {
  return Object.hasOwn(releaseCanaryDefaultModels, kind) ? releaseCanaryDefaultModels[kind]! : null;
}
const model = z.string().max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\[1m\])?$/);
const designation = z.object({ designationId: z.string().regex(/^(?:0|[1-9]\d*)$/), credentialRevision: z.number().int().positive().safe(),
  enabled: z.boolean(), models: z.array(model).max(3), lastUsedAt: z.string().datetime().nullable().optional().default(null) }).strict();
const change = z.object({ operationId: z.string().uuid(), expectedDesignationId: z.string().regex(/^(?:0|[1-9]\d*)$/),
  credentialRevision: z.number().int().positive().safe(), enabled: z.boolean(), models: z.array(model).min(1).max(3) }).strict();
const identity = z.tuple([z.string().uuid(), z.string().uuid(), z.string().uuid(), z.number().int().positive().safe()]);
const prefix = "release-canary:";
export type ReleaseCanaryDesignation = z.infer<typeof designation>;
export type ReleaseCanaryChange = z.infer<typeof change>;
export const releaseCanaryDesignationsCache = new KeyedAsyncCache<ReleaseCanaryDesignation>(64);
export function clearReleaseCanaryDesignations(): void {
  for (const key of releaseCanaryDesignationsCache.keys()) releaseCanaryDesignationsCache.forget(key);
}
export function releaseCanaryDesignationKey(userId: string, organizationId: string, credentialId: string, revision: number): string {
  return `${prefix}${JSON.stringify(identity.parse([userId, organizationId, credentialId, revision]))}`;
}
export async function readReleaseCanaryDesignationKey(key: string): Promise<ReleaseCanaryDesignation> {
  if (!key.startsWith(prefix)) throw new Error("Invalid release check identity");
  const selected = identity.parse(JSON.parse(key.slice(prefix.length)));
  return cloudAccountRequest(`/v1/cloud-agent-credentials/${selected[2]}/release-canary`, designation);
}
export function changeReleaseCanaryDesignation(credentialId: string, input: ReleaseCanaryChange) {
  const body = change.parse(input);
  return cloudAccountRequest(`/v1/cloud-agent-credentials/${z.string().uuid().parse(credentialId)}/release-canary`,
    z.object({ designationId: z.string().regex(/^[1-9]\d*$/), enabled: z.boolean() }).strict(),
    { method: "PUT", body, idempotencyKey: body.operationId });
}
