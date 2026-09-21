import { describe, expect, it } from "vitest";
import {
  planManagedComputeCredit,
  type ComputeCreditPlanInput,
} from "./compute-credit-plan.js";

const NOW = Date.parse("2026-09-19T00:00:00Z");
const input = (
  changes: Partial<ComputeCreditPlanInput> = {},
): ComputeCreditPlanInput => ({
  nowMs: NOW,
  allocationStartedAtMs: NOW,
  secondsPerDollar: 100000,
  weightNumerator: 1,
  weightDenominator: 1,
  minimumTtlSeconds: 60,
  maximumTtlSeconds: 3600,
  requestMarginSeconds: 60,
  periods: [
    {
      id: "current",
      startsAtMs: NOW - 3600_000,
      endsAtMs: NOW + 7200_000,
      availableMicroUsd: 40000,
    },
  ],
  ...changes,
});
describe("funded finite compute leases", () => {
  it("funds the provider request margin and caps the maximum TTL", () => {
    const result = planManagedComputeCredit(input())!;
    expect(result.ttlSeconds).toBe(3600);
    expect(result.fundedUntil.getTime()).toBe(NOW + 3660_000);
    expect(result.allocations).toEqual([
      {
        periodId: "current",
        meterSince: new Date(NOW),
        coveredUntil: new Date(NOW + 3660_000),
        authorizationMicroUsd: 36600,
      },
    ]);
  });
  it("shortens the lease to the exact affordable whole second", () => {
    const options = input();
    options.periods[0]!.availableMicroUsd = 20000;
    const result = planManagedComputeCredit(options)!;
    expect(result.ttlSeconds).toBe(1940);
    expect(result.allocations[0]!.authorizationMicroUsd).toBe(20000);
    options.periods[0]!.availableMicroUsd = 1199;
    expect(planManagedComputeCredit(options)).toBeNull();
  });
  it("never assumes a future grant or bridges an unfunded time gap", () => {
    expect(planManagedComputeCredit(input({ periods: [] }))).toBeNull();
    expect(
      planManagedComputeCredit(
        input({
          periods: [
            {
              id: "later",
              startsAtMs: NOW + 1,
              endsAtMs: NOW + 7200_000,
              availableMicroUsd: 40000,
            },
          ],
        }),
      ),
    ).toBeNull();
    const options = input();
    options.periods[0]!.endsAtMs = NOW + 119000;
    expect(planManagedComputeCredit(options)).toBeNull();
  });
  it("reserves adjacent periods together and clamps each metering window", () => {
    const options = input({
      periods: [
        {
          id: "first",
          startsAtMs: NOW - 3600_000,
          endsAtMs: NOW + 1800_000,
          availableMicroUsd: 18000,
        },
        {
          id: "next",
          startsAtMs: NOW + 1800_000,
          endsAtMs: NOW + 7200_000,
          availableMicroUsd: 18600,
        },
      ],
    });
    const result = planManagedComputeCredit(options)!;
    expect(result.ttlSeconds).toBe(3600);
    expect(
      result.allocations.map((a) => [
        a.periodId,
        a.meterSince.getTime(),
        a.coveredUntil.getTime(),
        a.authorizationMicroUsd,
      ]),
    ).toEqual([
      ["first", NOW, NOW + 1800_000, 18000],
      ["next", NOW + 1800_000, NOW + 3660_000, 18600],
    ]);
  });
  it("preserves a prior hold without reserving it a second time", () => {
    const options = input({ allocationStartedAtMs: NOW - 500000 });
    options.periods[0]!.availableMicroUsd = 0;
    options.periods[0]!.reservation = {
      meterSinceMs: NOW - 500000,
      meterThroughMs: NOW,
      billableSeconds: 500,
      actualMicroUsd: 5000,
      debitedMicroUsd: 5000,
      authorizedMicroUsd: 10000,
      coveredUntilMs: NOW + 500000,
    };
    const result = planManagedComputeCredit(options)!;
    expect(result.ttlSeconds).toBe(440);
    expect(result.allocations[0]!.authorizationMicroUsd).toBe(10000);
  });
  it("does not reclaim historical platform exposure from a customer's fresh credit", () => {
    const options = input({
      allocationStartedAtMs: NOW - 20000,
      minimumTtlSeconds: 60,
      maximumTtlSeconds: 60,
      requestMarginSeconds: 5,
    });
    options.periods[0]!.availableMicroUsd = 650;
    options.periods[0]!.reservation = {
      meterSinceMs: NOW - 20000,
      meterThroughMs: NOW,
      billableSeconds: 20,
      actualMicroUsd: 200,
      debitedMicroUsd: 100,
      authorizedMicroUsd: 100,
      coveredUntilMs: NOW - 10000,
    };
    expect(
      planManagedComputeCredit(options)?.allocations[0]?.authorizationMicroUsd,
    ).toBe(750);
  });
  it("uses exact arithmetic for fractional resource weights and cumulative rounding", () => {
    const options = input({
      weightDenominator: 2,
      minimumTtlSeconds: 60,
      maximumTtlSeconds: 61,
      requestMarginSeconds: 5,
    });
    options.periods[0]!.availableMicroUsd = 330;
    expect(planManagedComputeCredit(options)?.ttlSeconds).toBe(61);
    options.periods[0]!.availableMicroUsd = 329;
    expect(planManagedComputeCredit(options)).toBeNull();
  });
  it.each([
    { weightNumerator: 0 },
    { secondsPerDollar: 0 },
    { requestMarginSeconds: 0 },
    { minimumTtlSeconds: 0 },
    { maximumTtlSeconds: 3601 },
    { allocationStartedAtMs: NOW + 1 },
  ])("rejects unsafe forecast parameters: %j", (changes) => {
    expect(() => planManagedComputeCredit(input(changes))).toThrow();
  });
  it("rejects overlapping periods and inconsistent prior meter totals", () => {
    const options = input();
    options.periods.push({ ...options.periods[0]!, id: "overlap" });
    expect(() => planManagedComputeCredit(options)).toThrow();
    const bad = input();
    bad.periods[0]!.reservation = {
      meterSinceMs: NOW,
      meterThroughMs: NOW,
      billableSeconds: 10,
      actualMicroUsd: 0,
      debitedMicroUsd: 0,
      authorizedMicroUsd: 100,
      coveredUntilMs: NOW + 1000,
    };
    expect(() => planManagedComputeCredit(bad)).toThrow();
  });
});
