import { describe, expect, it } from "vitest";
import { READER_INPUT_WINDOW_MS, glideAttribution, SOFT_EASE, SOFT_ENTER_DELAY_MS, SOFT_EXIT_MS, SOFT_ENTER_MS, SOFT_SETTLE_CAP_PX, SOFT_SETTLE_MS, followGlide, glideOffset, settleFrom } from "@/renderer/shared/ui/motion/soft-motion";
import { LOADER_TICK_DWELL_MS } from "@/renderer/shared/ui/loading/loader-ticker";

describe("live tail glide", () => {
  it("does not move a tail the scroller keeps in place (pinned: only growth above it)", () => {
    // A message above the line grew by a wrapped line and a header arrived:
    // the line's distance to the content's bottom is unchanged.
    expect(glideOffset({ inContainer: 100, toBottom: 40 }, { inContainer: 160, toBottom: 40 }, true)).toBe(0);
  });

  it("glides a followed tail that really moved (a transcript too short to scroll)", () => {
    // A 36px header pushed the line down; the content bottom did not move.
    expect(glideOffset({ inContainer: 0, toBottom: 300 }, { inContainer: 36, toBottom: 264 }, true)).toBe(-36);
  });

  it("glides an unpinned tail back from where it was, minus any scroll the browser applied", () => {
    expect(glideOffset({ inContainer: 100, toBottom: 900 }, { inContainer: 124, toBottom: 900 }, false)).toBe(-24);
    // Scroll anchoring scrolled 24px to hold the line still: no glide.
    expect(glideOffset({ inContainer: 100, toBottom: 900 }, { inContainer: 124, toBottom: 900 }, false, 24)).toBe(0);
  });

  it("never shows a move: it starts at most the cap away and retargets within it", () => {
    // A 36px header pushed the line down a row: it is drawn 5px above its new
    // place, not 36px.
    expect(settleFrom(0, -36)).toBe(-SOFT_SETTLE_CAP_PX);
    expect(settleFrom(0, 3)).toBe(3);
    // Another line arrives mid-settle: continue from where it is drawn, capped.
    expect(settleFrom(-2, -24)).toBe(-SOFT_SETTLE_CAP_PX);
    expect(settleFrom(-2, 1)).toBe(-1);
  });

  it("keeps the motion language consistent", () => {
    expect(SOFT_EXIT_MS).toBeLessThan(SOFT_ENTER_MS);
    // A hand-off finishes before the dwell lets the next one start.
    expect(SOFT_ENTER_DELAY_MS + SOFT_ENTER_MS).toBeLessThanOrEqual(LOADER_TICK_DWELL_MS);
    expect(SOFT_SETTLE_MS).toBeGreaterThanOrEqual(180);
    expect(SOFT_SETTLE_MS).toBeLessThanOrEqual(240);
    expect(SOFT_SETTLE_CAP_PX).toBeGreaterThanOrEqual(4);
    expect(SOFT_SETTLE_CAP_PX).toBeLessThanOrEqual(6);
  });
});

/** The shared ease, evaluated like the browser does (Newton on x, then y). */
function ease(x: number): number {
  const [x1, y1, x2, y2] = SOFT_EASE.match(/[\d.]+/g)!.map(Number);
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  let t = x;
  for (let i = 0; i < 8; i++) t -= (((ax * t + bx) * t + cx) * t - x) / ((3 * ax * t + 2 * bx) * t + cx);
  return ((ay * t + by) * t + cy) * t;
}

describe("a swap reads as one dissolve", () => {
  it("never leaves the line empty, and never shows two solid labels", () => {
    let minSum = 2, maxBoth = 0;
    for (let t = 0; t <= SOFT_ENTER_DELAY_MS + SOFT_ENTER_MS; t += 2) {
      const out = t >= SOFT_EXIT_MS ? 0 : 1 - ease(t / SOFT_EXIT_MS);
      const enter = t < SOFT_ENTER_DELAY_MS ? 0 : ease(Math.min(1, (t - SOFT_ENTER_DELAY_MS) / SOFT_ENTER_MS));
      minSum = Math.min(minSum, out + enter);
      maxBoth = Math.max(maxBoth, Math.min(out, enter));
    }
    expect(minSum).toBeGreaterThanOrEqual(0.45);
    expect(maxBoth).toBeLessThanOrEqual(0.3);
  });
});

describe("pinned tail growth", () => {
  it("glides the content above a still line when the scroller absorbs the growth", () => {
    // A 36px header above the line; the line kept its distance to the bottom.
    expect(followGlide({ inContainer: 0, toBottom: 40 }, { inContainer: 36, toBottom: 40 })).toEqual({ content: 36, line: -36 });
  });

  it("glides only the line when the transcript is too short to scroll", () => {
    const glide = followGlide({ inContainer: 0, toBottom: 300 }, { inContainer: 36, toBottom: 264 });
    expect(glide.content).toBe(0);
    expect(glide.line).toBe(-36);
  });

  it("splits a partly absorbed growth: the line shows only its real move", () => {
    const glide = followGlide({ inContainer: 0, toBottom: 300 }, { inContainer: 36, toBottom: 286 });
    expect(glide.content + glide.line).toBe(-14);
  });
});

describe("who moved the layout", () => {
  it("glides only for the agent's growth at the live tail", () => {
    expect(glideAttribution({ agentGrowth: true, sinceReaderInputMs: Infinity, resized: false })).toBe("glide");
    // A reader opening a group, a row's details, show more, zoom or fonts: in place.
    expect(glideAttribution({ agentGrowth: false, sinceReaderInputMs: Infinity, resized: false })).toBe("silent");
  });

  it("resolves a reader input landing with agent growth to no motion", () => {
    expect(glideAttribution({ agentGrowth: true, sinceReaderInputMs: 16, resized: false })).toBe("silent");
    expect(glideAttribution({ agentGrowth: true, sinceReaderInputMs: READER_INPUT_WINDOW_MS + 1, resized: false })).toBe("glide");
  });

  it("lets growth inside a live group the reader opened simply appear", () => {
    expect(glideAttribution({ agentGrowth: true, sinceReaderInputMs: Infinity, resized: false, readerOwned: true })).toBe("silent");
    expect(glideAttribution({ agentGrowth: true, sinceReaderInputMs: Infinity, resized: false, readerOwned: false })).toBe("glide");
  });

  it("never glides a resize of the pane or chat width", () => {
    expect(glideAttribution({ agentGrowth: true, sinceReaderInputMs: Infinity, resized: true })).toBe("silent");
  });
});
