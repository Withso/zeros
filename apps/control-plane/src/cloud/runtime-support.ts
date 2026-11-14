import { z } from "zod";
import { RuntimeReleaseSchema, type RuntimeRelease } from "./runtime-release.js";

export const RuntimeSupportSchema = z.object({
  version: z.literal(1),
  currentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  releases: z.array(RuntimeReleaseSchema).min(1).max(3),
}).strict().refine(value => value.releases[0]!.sha256 === value.currentSha256 &&
  new Set(value.releases.map(release => release.sha256)).size === value.releases.length);
export type RuntimeSupport = z.infer<typeof RuntimeSupportSchema>;

/** Absence keeps the exact legacy pin. A recorded previous pin alone is not
 * permission to execute it against the serving control plane. */
export function loadRuntimeSupport(raw: string | undefined, current: { sha256: string; release?: RuntimeRelease }): readonly string[] {
  if (!raw?.trim()) return [current.sha256];
  try {
    if (raw.length > 16_384) throw new Error();
    const support = RuntimeSupportSchema.parse(JSON.parse(raw));
    const release = RuntimeReleaseSchema.parse(current.release);
    if (support.currentSha256 !== current.sha256 || JSON.stringify(support.releases[0]) !== JSON.stringify(release)) throw new Error();
    return support.releases.map(value => value.sha256);
  } catch { throw new Error("Invalid environment: CLOUD_V2_RUNTIME_SUPPORT"); }
}
