import { describe, expect, it } from "vitest";

import {
  boundaryParityRestrictions,
  hasKernelExecutionBoundary,
  newTerritoryGeneration,
} from "../status";

describe("execution boundary status contract", () => {
  it("mints an opaque generation for every admission", () => {
    const firstGeneration = newTerritoryGeneration();
    const secondGeneration = newTerritoryGeneration();
    expect(secondGeneration).not.toBe(firstGeneration);
    for (const generation of [firstGeneration, secondGeneration]) {
      expect(generation).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
      );
    }
  });

  it("distinguishes host process supervision from a kernel execution boundary", () => {
    expect(
      hasKernelExecutionBoundary({
        status: { backend: "none", state: "not-required" },
      }),
    ).toBe(false);
    expect(
      hasKernelExecutionBoundary({
        status: { backend: "none", state: "ready" },
      }),
    ).toBe(false);
    expect(
      hasKernelExecutionBoundary({
        status: { backend: "zeros-srt", state: "ready" },
      }),
    ).toBe(true);
    expect(
      hasKernelExecutionBoundary({
        status: { backend: "cloud-worker", state: "ready" },
      }),
    ).toBe(true);
    expect(hasKernelExecutionBoundary(undefined)).toBe(false);
  });

  it("reports an expected container CLI as restricted without a private worker", () => {
    expect(
      boundaryParityRestrictions({ containerWorkflowExpected: true }),
    ).toEqual(["container-workflows-unavailable"]);
    expect(
      boundaryParityRestrictions(
        { containerWorkflowExpected: true },
        { containerWorkflowAvailable: true },
      ),
    ).toEqual([]);
    expect(boundaryParityRestrictions({})).toEqual([]);
  });
});
