import { describe, expect, it } from "vitest";

import { DesignGpuRasterGate } from "../gpu/design-gpu-raster-gate";

describe("Design GPU raster gate", () => {
  it("sends nothing while the worker's context is lost and resumes at once when it returns", () => {
    const gate = new DesignGpuRasterGate();
    expect(gate.open(0)).toBe(true);
    gate.context(true);
    // A burst into a lost context fails at once; without the gate every
    // failure repainted and sent the next one in a tight loop.
    expect(gate.open(10_000)).toBe(false);
    gate.failed(10_000);
    gate.context(false);
    expect(gate.open(10_001)).toBe(true);
  });

  it("waits longer after each failed burst, within its bound, and resets on success", () => {
    const gate = new DesignGpuRasterGate(250, 4_000);
    expect(gate.failed(0)).toBe(250);
    expect(gate.open(249)).toBe(false);
    expect(gate.open(250)).toBe(true);
    expect([gate.failed(250), gate.failed(750), gate.failed(1_750), gate.failed(3_750), gate.failed(7_750)])
      .toEqual([500, 1_000, 2_000, 4_000, 4_000]);
    gate.succeeded();
    expect(gate.open(7_751)).toBe(true);
    expect(gate.failed(8_000)).toBe(250);
  });
});
