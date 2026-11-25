import { describe, expect, it } from "vitest";

import { assessNativeDesignEdits, summarizeNativeDesignEdit } from "../design-native-edits.mjs";

const counters = (admitted: number) => ({ sourceVectorBuffers: { current: 0, peak: 0, admitted }, frameSurfaces: { current: 0, peak: 0, admitted: 4 } });
const raw = (overrides: Record<string, unknown> = {}) => ({
  before: ["a.html", "b.html", "c.html"], after: ["a.html", "b.html", "c.html", "d.html"],
  replaced: [], blanked: [], swapped: [], remounted: [], moved: [], touched: ["a.html", "d.html"], longFrames: [12, 60],
  counters: { before: counters(10), after: counters(11) }, ...overrides,
});

describe("native edit observation", () => {
  it("separates the operation's own frames from every other frame", () => {
    const summary = summarizeNativeDesignEdit(raw({ replaced: ["a.html", "b.html"], touched: ["a.html", "b.html", "d.html"] }),
      { name: "duplicate-frame", subjects: ["a.html"], visibleMs: 40, settledMs: 90 });
    expect(summary).toMatchObject({ name: "duplicate-frame", added: ["d.html"], removed: [], visibleMs: 40, settledMs: 90,
      admitted: { sourceVectorBuffers: 1 }, mainThread: { longFrames: 2, totalMs: 72, maxMs: 60 }, contained: false });
    expect(summary.others.replaced).toEqual({ count: 1, frames: ["b.html"] });
    expect(summary.others.touched).toEqual({ count: 1, frames: ["b.html"] });
  });

  it("is contained when only its own frames changed", () => {
    const summary = summarizeNativeDesignEdit(raw({ after: ["a.html", "c.html"], blanked: ["b.html"], remounted: ["b.html"] }),
      { name: "delete-frame", subjects: ["b.html"], visibleMs: 30, settledMs: 30 });
    expect(summary.removed).toEqual(["b.html"]);
    expect(summary.contained).toBe(true);
  });

  it("reports a same-generation level-of-detail swap and a source handed back to the DOM without failing them", () => {
    const summary = summarizeNativeDesignEdit(raw({ leveled: ["b.html"], restored: ["c.html"] }),
      { name: "duplicate-frame", subjects: ["a.html"], visibleMs: 40, settledMs: 90 });
    expect(summary.others.leveled).toEqual({ count: 1, frames: ["b.html"] });
    expect(summary.others.restored).toEqual({ count: 1, frames: ["c.html"] });
    expect(summary.contained).toBe(true);
  });

  it("fails an operation that touched another frame or was slow, and a run that skipped operations", () => {
    const edit = (name: string, contained: boolean, visibleMs: number) => ({ name, contained, visibleMs, settledMs: visibleMs,
      others: { replaced: { count: contained ? 0 : 3, frames: [] } }, admitted: {}, mainThread: { longFrames: 0, totalMs: 0, maxMs: 0 } });
    const result = assessNativeDesignEdits({ edits: [edit("duplicate-frame", false, 40), edit("undo-duplicate", true, 900)] });
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(["edit-coverage", "duplicate-frame-touched-other-frames", "undo-duplicate-visible-time"]);
    expect(result.edits[0]).toMatchObject({ name: "duplicate-frame", others: { replaced: 3 } });
  });
});
