import { computeMicroUsd } from "./provider-compute.js";
import type { ComputeCreditAllocation } from "./compute-credits.js";

export type ComputeCreditPlanningPeriod = {
  id: string;
  startsAtMs: number;
  endsAtMs: number;
  availableMicroUsd: number;
  reservation?: {
    meterSinceMs: number;
    meterThroughMs: number;
    billableSeconds: number;
    actualMicroUsd: number;
    debitedMicroUsd: number;
    authorizedMicroUsd: number;
    coveredUntilMs: number;
  };
};
export type ComputeCreditPlanInput = {
  nowMs: number;
  allocationStartedAtMs: number;
  periods: ComputeCreditPlanningPeriod[];
  secondsPerDollar: number;
  weightNumerator: number;
  weightDenominator: number;
  minimumTtlSeconds: number;
  maximumTtlSeconds: number;
  requestMarginSeconds: number;
};
export type ComputeCreditPlan = {
  ttlSeconds: number;
  fundedUntil: Date;
  allocations: ComputeCreditAllocation[];
};

function validInteger(
  value: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function weightedSeconds(
  ms: number,
  numerator: number,
  denominator: number,
): number {
  const divisor = BigInt(denominator) * 1000n;
  const result = (BigInt(ms) * BigInt(numerator) + divisor - 1n) / divisor;
  if (result > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Invalid compute forecast");
  return Number(result);
}

/** Forecast only allocates existing seat credit. Future grants are never
 * presumed. A smaller funded lease can use a remaining balance without silently
 * turning that balance into an overage or cancelling another reservation. */
export function planManagedComputeCredit(
  input: ComputeCreditPlanInput,
): ComputeCreditPlan | null {
  if (
    !validInteger(input.nowMs, 0) ||
    !validInteger(input.allocationStartedAtMs, 0, input.nowMs) ||
    !validInteger(input.secondsPerDollar, 1, 1_000_000_000_000) ||
    !validInteger(input.weightNumerator, 1, 16) ||
    !validInteger(input.weightDenominator, 1, 16) ||
    !validInteger(input.minimumTtlSeconds, 60, 3600) ||
    !validInteger(input.maximumTtlSeconds, input.minimumTtlSeconds, 3600) ||
    !validInteger(input.requestMarginSeconds, 5, 1800) ||
    input.periods.length > 16
  )
    throw new Error("Invalid compute forecast");
  const periods = [...input.periods].sort(
    (a, b) => a.startsAtMs - b.startsAtMs,
  );
  let previousEnd = 0;
  for (const p of periods) {
    if (
      !validInteger(p.startsAtMs, previousEnd) ||
      !validInteger(p.endsAtMs, p.startsAtMs + 1) ||
      !validInteger(p.availableMicroUsd, 0, 1_000_000_000_000)
    )
      throw new Error("Invalid compute credit period");
    previousEnd = p.endsAtMs;
    const r = p.reservation;
    if (
      r &&
      (!validInteger(r.meterSinceMs, p.startsAtMs, p.endsAtMs - 1) ||
        !validInteger(r.meterThroughMs, r.meterSinceMs, p.endsAtMs) ||
        !validInteger(r.coveredUntilMs, r.meterSinceMs + 1, p.endsAtMs) ||
        !validInteger(r.billableSeconds, 0) ||
        !validInteger(r.actualMicroUsd, 0) ||
        !validInteger(r.debitedMicroUsd, 0, r.actualMicroUsd) ||
        !validInteger(
          r.authorizedMicroUsd,
          r.debitedMicroUsd,
          1_000_000_000_000,
        ) ||
        computeMicroUsd(r.billableSeconds, input.secondsPerDollar) !==
          r.actualMicroUsd)
    )
      throw new Error("Invalid compute reservation forecast");
  }
  const forecast = (ttlSeconds: number): ComputeCreditPlan | null => {
    const horizon =
      input.nowMs + (ttlSeconds + input.requestMarginSeconds) * 1000;
    const allocations: ComputeCreditAllocation[] = [];
    let covered = input.nowMs;
    for (const p of periods) {
      if (p.endsAtMs <= input.nowMs || p.startsAtMs >= horizon) continue;
      if (p.startsAtMs > covered) return null;
      const prior = p.reservation;
      const since =
        prior?.meterSinceMs ??
        Math.max(input.allocationStartedAtMs, p.startsAtMs);
      const through = prior?.meterThroughMs ?? since;
      const until = Math.max(
        prior?.coveredUntilMs ?? 0,
        Math.min(p.endsAtMs, horizon),
      );
      const seconds = weightedSeconds(
        Math.max(0, until - through),
        input.weightNumerator,
        input.weightDenominator,
      );
      const estimate = computeMicroUsd(
        (prior?.billableSeconds ?? 0) + seconds,
        input.secondsPerDollar,
      );
      // Previously observed platform exposure never becomes a retroactive
      // customer debit when fresh funds arrive.
      const required =
        (prior?.debitedMicroUsd ?? 0) + estimate - (prior?.actualMicroUsd ?? 0);
      const authorized = Math.max(prior?.authorizedMicroUsd ?? 0, required, 1);
      if (
        authorized > 1_000_000_000_000 ||
        authorized - (prior?.authorizedMicroUsd ?? 0) > p.availableMicroUsd
      )
        return null;
      allocations.push({
        periodId: p.id,
        meterSince: new Date(since),
        coveredUntil: new Date(until),
        authorizationMicroUsd: authorized,
      });
      covered = Math.min(p.endsAtMs, horizon);
    }
    return covered === horizon
      ? { ttlSeconds, fundedUntil: new Date(horizon), allocations }
      : null;
  };
  if (!forecast(input.minimumTtlSeconds)) return null;
  let low = input.minimumTtlSeconds,
    high = input.maximumTtlSeconds;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (forecast(middle)) low = middle;
    else high = middle - 1;
  }
  return forecast(low);
}
