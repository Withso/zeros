import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const RuntimeCanaryReceiptSchema = z.object({
  version: z.literal(1), channel: z.literal("alpha"),
  cpSourceSha: z.string().regex(/^[a-f0-9]{40}$/), previousRuntimeSha256: digest,
  runtimeSha256: digest, sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
  runId: z.string().regex(/^[1-9][0-9]{0,19}$/), runAttempt: z.number().int().min(1).max(10_000),
  grantId: z.string().uuid(), workspaceId: z.string().uuid(),
  creatorUserId: z.string().uuid(), organizationId: z.string().uuid(),
  repositoryId: z.string().regex(/^[1-9][0-9]{0,15}$/).refine(value => Number.isSafeInteger(Number(value))),
  agents: z.tuple([z.literal("codex"), z.literal("claude"), z.literal("cursor")]),
  deleted: z.literal(true), completedAt: z.string().datetime(),
}).strict();
export type RuntimeCanaryReceipt = z.infer<typeof RuntimeCanaryReceiptSchema>;
export const RuntimeReleaseSchema = z.object({
  version: z.literal(1),
  sha256: digest,
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
  sourceSha256: digest,
  qualification: z.object({
    channel: z.literal("alpha"),
    runId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    runAttempt: z.number().int().min(1).max(10_000),
    completedAt: z.string().datetime(),
    receiptSha256: digest,
    deleted: z.literal(true),
  }).strict(),
}).strict();
export type RuntimeRelease = z.infer<typeof RuntimeReleaseSchema>;

export function loadRuntimeRelease(raw: string | undefined): RuntimeRelease | undefined {
  if (!raw?.trim()) return undefined;
  try {
    if (raw.length > 4096) throw new Error();
    return RuntimeReleaseSchema.parse(JSON.parse(raw));
  } catch { throw new Error("Invalid environment: CLOUD_V2_RUNTIME_RELEASE_METADATA"); }
}

export function runtimeReleaseIdentity(runtime: { sha256: string; release?: RuntimeRelease } | undefined) {
  if (!runtime || !digest.safeParse(runtime.sha256).success) return { worker: null, workerQualified: false };
  const parsed = RuntimeReleaseSchema.safeParse(runtime.release);
  const release = parsed.success && parsed.data.sha256 === runtime.sha256 ? parsed.data : undefined;
  return {
    worker: { sha256: runtime.sha256, sourceSha: release?.sourceSha ?? null, sourceSha256: release?.sourceSha256 ?? null,
      qualification: release?.qualification ?? null },
    workerQualified: !!release,
  };
}
