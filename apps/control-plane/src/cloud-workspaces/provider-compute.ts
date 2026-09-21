/** Provider metering counts allocated machine time, not workload CPU usage.
 * Monetary values use integer micro-US dollars; never sum floating prices. */
import type { CloudProviderCreateInput, CloudProviderResource } from "./provider.js";

export type CloudProviderComputeUsage = {
  resourceId: string;
  since: string;
  until: string;
  billableSeconds: number;
  secondsPerDollar: number;
  listPriceMicroUsd: number;
  running: boolean;
};
export interface CloudWorkspaceComputeProvider {
  computeWeight(profile: Pick<CloudProviderCreateInput,"cpuMillicores" | "memoryMiB">): { numerator: number; denominator: number };
  /** Finite, explicitly funded lease; it must be applied in the same provider
   * request that allocates/resumes compute, including idempotent retries. */
  createWithComputeLease(input: CloudProviderCreateInput, ttlSeconds: number): Promise<CloudProviderResource>;
  startWithComputeLease(resourceId: string, ttlSeconds: number): Promise<CloudProviderResource>;
  readComputeUsage(resourceId: string, window?: { since: Date; until?: Date }): Promise<CloudProviderComputeUsage>;
  /** Extend provider-side auto-stop only after the coordinator reserves credit. */
  renewComputeLease(resourceId: string, ttlSeconds: number): Promise<{ expiresAt: string }>;
}

export function computeMicroUsd(seconds: number, secondsPerDollar: number): number {
  if (!Number.isSafeInteger(seconds) || seconds < 0 ||
      !Number.isSafeInteger(secondsPerDollar) || secondsPerDollar < 1)
    throw new Error('Invalid compute meter');
  const divisor = BigInt(secondsPerDollar);
  // Round a cumulative watermark once; per-poll rounding would overcharge.
  const result = (BigInt(seconds) * 1_000_000n + divisor - 1n) / divisor;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Compute meter exceeds supported range');
  return Number(result);
}
