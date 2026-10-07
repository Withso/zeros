import { z } from "zod";
import { refuseRetiredReleaseWorker } from "./release-worker-retirement.js";

export const DevCanaryTargetSchema = z.object({
  id: z.string().regex(/^bx_[a-z0-9]+$/), attempt: z.string().uuid(),
  snapshotId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  sourceCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  buildSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type DevCanaryTarget = z.infer<typeof DevCanaryTargetSchema>;
export type DevCanaryTransport = {
  command(script: string): Promise<string>;
  upload(path: string, contents: Buffer): Promise<void>;
};
export type DevRenewalProof = { accountBinding: true; accessChanged: true; cachePublished: true; consentPreserved: true };

/** The old native image canary is retired. Keep its target schema for stored
 * cleanup/receipt identities and refuse before commands or private uploads. */
export async function startNativeDevCanary(_transport: DevCanaryTransport, _value: DevCanaryTarget, _input: unknown, _renewal?: DevRenewalProof, _options: { deadlineSeconds?: number } = {}): Promise<void> {
  refuseRetiredReleaseWorker();
}
