// Column 2 share-of-row math — the pure clamp/sanitize behind the
// col-2/col-3 seam drag (proportional columns).

import { describe, expect, it, vi } from "vitest";

import {
  clampColumn2Ratio,
  flushPendingColumn2RatioPaint,
  sanitizeColumn2Ratio,
} from "../column2-ratio";

describe("flushPendingColumn2RatioPaint", () => {
  it("cancels and paints the latest ratio before pointer-up persists it", () => {
    const calls: string[] = [];
    const cancel = (id: number) => calls.push(`cancel:${id}`);
    const paint = () => calls.push("paint");

    expect(flushPendingColumn2RatioPaint(42, cancel, paint)).toBe(true);
    expect(calls).toEqual(["cancel:42", "paint"]);
  });

  it("does nothing after the latest ratio has already painted", () => {
    const cancel = vi.fn();
    const paint = vi.fn();

    expect(flushPendingColumn2RatioPaint(null, cancel, paint)).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(paint).not.toHaveBeenCalled();
  });
});

describe("sanitizeColumn2Ratio", () => {
  it("passes through an in-range ratio", () => {
    expect(sanitizeColumn2Ratio(0.5)).toBe(0.5);
  });

  it("clamps to the global bounds", () => {
    expect(sanitizeColumn2Ratio(0)).toBe(0.1);
    expect(sanitizeColumn2Ratio(1)).toBe(0.7);
  });

  it("falls back to the default for a malformed persisted value", () => {
    expect(sanitizeColumn2Ratio(Number.NaN)).toBe(0.5);
    expect(sanitizeColumn2Ratio(Number.POSITIVE_INFINITY)).toBe(0.5);
  });
});

describe("clampColumn2Ratio", () => {
  it("passes through an in-range drag ratio", () => {
    expect(clampColumn2Ratio(0.5, 1600)).toBe(0.5);
  });

  it("floors at col 2's 320px share of the row", () => {
    // 1600px row: 320px floor = 0.2.
    expect(clampColumn2Ratio(0.05, 1600)).toBeCloseTo(0.2);
  });

  it("reserves col 3's 200px floor when tighter than the 70% cap", () => {
    // 600px row: (600 - 200) / 600 ≈ 0.667 beats the 0.7 share cap.
    expect(clampColumn2Ratio(0.9, 600)).toBeCloseTo(400 / 600);
  });

  it("caps at the 70% share on ordinary rows", () => {
    expect(clampColumn2Ratio(0.9, 1600)).toBe(0.7);
  });

  it("caps at 2400px on very wide rows", () => {
    // 5000px row: 70% would be 3500px — the pixel ceiling wins (0.48).
    expect(clampColumn2Ratio(0.69, 5000)).toBeCloseTo(2400 / 5000);
  });

  it("stays persistable when the row can't fit both floors", () => {
    // 400px row: col 2's floor share (0.8) exceeds the persistable 0.7
    // ceiling — the clamp pins there instead, so the live drag value
    // and the stored value never diverge (CSS min-widths own the
    // squeeze at this size either way).
    expect(clampColumn2Ratio(0.5, 400)).toBe(0.7);
  });

  it("survives a degenerate row width", () => {
    expect(clampColumn2Ratio(0.5, 0)).toBe(0.5);
    expect(clampColumn2Ratio(0.9, Number.NaN)).toBe(0.7);
  });
});
