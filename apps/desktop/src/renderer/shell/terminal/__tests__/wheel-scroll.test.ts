// The terminal intercepts `wheel` in the capture phase (so scrollback works
// while a mouse-tracking TUI is running), which means it owns the arithmetic
// xterm's own viewport used to do. These cover the two ways the previous
// `Math.round(deltaY / 20)` silently broke scrolling.

import { describe, it, expect } from "vitest";
import {
  DELTA_MODE_LINE,
  DELTA_MODE_PAGE,
  DELTA_MODE_PIXEL,
  WheelLineAccumulator,
} from "../wheel-scroll";

const px = (deltaY: number) => ({ deltaY, deltaMode: DELTA_MODE_PIXEL });

describe("WheelLineAccumulator", () => {
  it("a slow trackpad gesture eventually scrolls instead of vanishing", () => {
    const acc = new WheelLineAccumulator();
    // macOS emits a stream of small pixel deltas. Rounding each independently
    // floored every one of them to zero — while the handler still called
    // preventDefault(), so the native viewport couldn't rescue it either. The
    // pane was simply unscrollable by trackpad.
    const emitted = [3, 3, 3, 3, 3, 3, 3].map((d) => acc.lines(px(d)));
    expect(emitted.some((n) => n !== 0)).toBe(true);
    expect(emitted.reduce((a, b) => a + b, 0)).toBe(1); // 21px ≈ 1 row
  });

  it("carries the sub-line remainder across events (no drift, no lost pixels)", () => {
    const acc = new WheelLineAccumulator(18);
    let total = 0;
    for (let i = 0; i < 12; i++) total += acc.lines(px(9)); // 108px = 6 rows
    expect(total).toBe(6);
  });

  it("reports 0 while still sub-line, so the caller lets the event through", () => {
    const acc = new WheelLineAccumulator(18);
    expect(acc.lines(px(4))).toBe(0);
  });

  it("a mouse notch scrolls immediately in both directions", () => {
    const acc = new WheelLineAccumulator(18);
    expect(acc.lines(px(120))).toBeGreaterThan(0);
    expect(acc.lines(px(-120))).toBeLessThan(0);
  });

  it("reversing direction responds at once instead of paying off old residue", () => {
    const acc = new WheelLineAccumulator(18);
    expect(acc.lines(px(17))).toBe(0); // banks +0.94 rows, still sub-line
    // Without the sign reset this whole row would be spent cancelling that
    // residue (0.94 − 1 = −0.06 → 0 lines), so the first flick back would feel
    // dead. With it, a full row up scrolls a full row up.
    expect(acc.lines(px(-18))).toBe(-1);
  });

  it("a JITTERING slow gesture still scrolls — micro-reversals must not reset", () => {
    // Regression on the fix itself. A real trackpad gesture is not monotonic:
    // a hesitant slow drag arrives as `+4, -1, +4, -1, …`. Resetting the bank on
    // ANY sign flip threw away every `+4`, so 60px of finger travel scrolled
    // nothing at all — the exact symptom this class exists to remove, and
    // unrescuable because the handler still calls preventDefault().
    const acc = new WheelLineAccumulator(18);
    let total = 0;
    // 40 events: 20×(+4px) and 20×(−1px) = +60px net ≈ 3.3 rows of travel.
    for (let i = 0; i < 40; i++) total += acc.lines(px(i % 2 === 0 ? 4 : -1));
    expect(total).toBe(3); // was 0 — every +4 was discarded by the next −1
  });

  it("a DECISIVE reversal still resets, so it does not feel laggy", () => {
    // The other half of the trade: a full row (or more) the other way is a real
    // reversal and must not spend itself paying off the old direction's residue.
    const acc = new WheelLineAccumulator(18);
    expect(acc.lines(px(17))).toBe(0); // banks +0.94
    expect(acc.lines(px(-36))).toBe(-2); // not -1
  });

  it("honors deltaMode: LINE deltas are lines, not pixels", () => {
    const acc = new WheelLineAccumulator(18);
    // Firefox/Linux report notches as DOM_DELTA_LINE. Dividing 3 by 18 as if it
    // were pixels turned a full notch into 0.17 of a row.
    expect(acc.lines({ deltaY: 3, deltaMode: DELTA_MODE_LINE })).toBe(3);
  });

  it("honors deltaMode: a PAGE delta scrolls one viewport", () => {
    const acc = new WheelLineAccumulator(18, 30);
    expect(acc.lines({ deltaY: 1, deltaMode: DELTA_MODE_PAGE }, 42)).toBe(42);
  });

  it("ignores a non-finite delta rather than scrolling to NaN", () => {
    const acc = new WheelLineAccumulator();
    expect(acc.lines(px(Number.NaN))).toBe(0);
    expect(acc.lines(px(36))).toBe(2); // still healthy afterwards
  });

  it("reset() drops pending residue", () => {
    const acc = new WheelLineAccumulator(18);
    acc.lines(px(17));
    acc.reset();
    expect(acc.lines(px(1))).toBe(0);
  });
});
