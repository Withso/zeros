import { describe, expect, it } from "vitest";

import { DesignGpuStats, designGpuSeries } from "../gpu/design-gpu-stats";

const visible = (counts: Partial<Record<"frames" | "crisp" | "finer" | "stretched" | "missing" | "failed" | "live" | "stale", number>>) =>
  ({ frames: 0, crisp: 0, finer: 0, stretched: 0, missing: 0, failed: 0, live: 0, stale: 0, ...counts });

describe("Design GPU bench stats", () => {
  it("marks an open crisp once every drawable visible frame is at its exact density, at rest", () => {
    const stats = new DesignGpuStats();
    stats.open("page-6");
    stats.composite(visible({ frames: 10, crisp: 4, missing: 6 }), true, true);
    stats.composite(visible({ frames: 10, crisp: 9, stretched: 1 }), true, true);
    stats.composite(visible({ frames: 10, crisp: 10 }), true, false);
    let snapshot = stats.snapshot({ gpu: { pages: 0, units: 0, bytes: 0, budget: 0, evictedPages: 0 },
      chunks: { count: 0, bytes: 0, budget: 0, received: 0, receivedBytes: 0, rejected: 0, evicted: 0 }, requests: {}, worker: null });
    // Drawn, but not crisp while the camera moved.
    expect(snapshot.firstFrameDrawnAt).not.toBeNull();
    expect(snapshot.allVisibleCrispAt).toBeNull();
    // Frames that failed to record and live documents are reported, not waited for.
    stats.composite(visible({ frames: 10, crisp: 7, failed: 2, live: 1 }), true, true);
    snapshot = stats.snapshot({ gpu: { pages: 0, units: 0, bytes: 0, budget: 0, evictedPages: 0 },
      chunks: { count: 0, bytes: 0, budget: 0, received: 0, receivedBytes: 0, rejected: 0, evicted: 0 }, requests: {}, worker: null });
    expect(snapshot.allVisibleCrispMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.visible).toMatchObject({ failed: 2, live: 1 });
    // A page of only unrecordable frames never reads as crisp.
    stats.open("page-7");
    stats.composite(visible({ frames: 3, failed: 3 }), false, true);
    expect(stats.snapshot({ gpu: { pages: 0, units: 0, bytes: 0, budget: 0, evictedPages: 0 },
      chunks: { count: 0, bytes: 0, budget: 0, received: 0, receivedBytes: 0, rejected: 0, evicted: 0 }, requests: {}, worker: null })
      .allVisibleCrispAt).toBeNull();
  });

  it("starts a new open for a newly mounted canvas on the same page, but not for an update of the same one", () => {
    let now = 1_000;
    const clock = performance.now;
    performance.now = () => now;
    try {
      const stats = new DesignGpuStats();
      const empty = { gpu: { pages: 0, units: 0, bytes: 0, budget: 0, evictedPages: 0 },
        chunks: { count: 0, bytes: 0, budget: 0, received: 0, receivedBytes: 0, rejected: 0, evicted: 0 }, requests: {}, worker: null };
      stats.restart("page-6");
      const first = stats.snapshot(empty).openedAt;
      now += 50;
      stats.open("page-6");
      expect(stats.snapshot(empty).openedAt).toBe(first);
      stats.composite(visible({ frames: 1, crisp: 1 }), true, true);
      now += 50;
      stats.restart("page-6");
      const again = stats.snapshot(empty);
      expect(again.openedAt).toBe(first! + 100);
      expect(again.allVisibleCrispAt).toBeNull();
    } finally { performance.now = clock; }
  });

  it("restarts the current open in place on reset, so the gesture after it is timed to crisp", () => {
    let now = 1_000;
    const clock = performance.now;
    performance.now = () => now;
    try {
      const stats = new DesignGpuStats();
      const empty = { gpu: { pages: 0, units: 0, bytes: 0, budget: 0, evictedPages: 0 },
        chunks: { count: 0, bytes: 0, budget: 0, received: 0, receivedBytes: 0, rejected: 0, evicted: 0 }, requests: {}, worker: null };
      stats.open("page-6");
      stats.composite(visible({ frames: 4, crisp: 4 }), true, true);
      stats.record("draw", 3);
      now += 500;
      stats.reset();
      let snapshot = stats.snapshot(empty);
      expect(snapshot).toMatchObject({ open: "page-6", openedAt: performance.timeOrigin + 1_500, allVisibleCrispAt: null,
        firstFrameDrawnAt: null });
      expect(snapshot.draw.count).toBe(0);
      // The camera change re-rasters; only the settled, crisp composite completes the restarted open.
      now += 40;
      stats.composite(visible({ frames: 4, crisp: 1, stretched: 3 }), true, true);
      now += 60;
      stats.composite(visible({ frames: 4, crisp: 4 }), true, true);
      snapshot = stats.snapshot(empty);
      expect(snapshot.firstFrameDrawnMs).toBe(40);
      expect(snapshot.allVisibleCrispMs).toBe(100);
      // A same-page update after the reset doesn't restart it again.
      stats.open("page-6");
      expect(stats.snapshot(empty).allVisibleCrispMs).toBe(100);
    } finally { performance.now = clock; }
  });

  it("summarizes only the request replies that ended in the current open", () => {
    const clock = performance.now;
    performance.now = () => 1_000;
    try {
      const stats = new DesignGpuStats();
      const at = (ms: number) => performance.timeOrigin + ms;
      stats.open("page-6");
      const snapshot = stats.snapshot({ gpu: { pages: 0, units: 0, bytes: 0, budget: 0, evictedPages: 0 },
        chunks: { count: 0, bytes: 0, budget: 0, received: 0, receivedBytes: 0, rejected: 0, evicted: 0 }, requests: {}, worker: null,
        replies: { read: [{ at: at(900), ms: 50 }, { at: at(1_200), ms: 30 }], render: [], adopt: [{ at: at(1_210), ms: 4 }] } });
      expect(snapshot.replies.read).toMatchObject({ count: 1, p50: 30 });
      expect(snapshot.replies.adopt).toMatchObject({ count: 1, max: 4 });
      expect(snapshot.replies.render.count).toBe(0);
    } finally { performance.now = clock; }
  });

  it("summarizes a series by its nearest-rank percentiles", () => {
    expect(designGpuSeries([])).toEqual({ count: 0, p50: 0, p95: 0, max: 0, totalMs: 0 });
    expect(designGpuSeries([5, 1, 3, 2, 4])).toEqual({ count: 5, p50: 3, p95: 5, max: 5, totalMs: 15 });
  });
});
