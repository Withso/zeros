import { z } from "zod";

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
