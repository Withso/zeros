import { describe, expect, it } from "vitest";

import { nextPreviewLimit } from "../chat-transcript-preview";

// The hover preview mounts the transcript a step at a time and grows as the
// reader approaches the end, so the WHOLE document is reachable without paying
// for it on open (2026-07-30 founder direction: "I should be able to scroll and
// see the full transcript"). All of the arithmetic lives in one pure function
// so the growth rule is pinned here rather than inside a scroll handler.

const STEP = 400;

/** Scrolled to within `below` px of the end of a 5,000px document. */
function atDistanceFromEnd(below: number) {
  const clientHeight = 270;
  const scrollHeight = 5000;
  return {
    clientHeight,
    scrollHeight,
    scrollTop: scrollHeight - clientHeight - below,
  };
}

describe("nextPreviewLimit", () => {
  it("grows by one step when the reader nears the end", () => {
    expect(nextPreviewLimit(atDistanceFromEnd(100), 400, 5000, STEP)).toBe(800);
  });

  it("stays put while there is still runway below", () => {
    // A wheel tick at the TOP of a long transcript must not mount the next
    // 400 lines — the whole point of stepping is that the cost follows the
    // reader.
    expect(nextPreviewLimit(atDistanceFromEnd(3000), 400, 5000, STEP)).toBe(
      400,
    );
  });

  it("grows again on the next approach, so the end is always reachable", () => {
    // Seven approaches walk a 5,000-line transcript from one step to all of it.
    // There is no ceiling short of the document — that is the whole point.
    let limit = 400;
    for (let i = 0; i < 7; i++) {
      limit = nextPreviewLimit(atDistanceFromEnd(0), limit, 5000, STEP);
    }
    expect(limit).toBe(5000);
  });

  it("keeps a flat step for the first three, then accelerates", () => {
    // The realistic range — every concise transcript and most full ones — sits
    // inside the first three steps, where growth must stay a plain 400 so a
    // peek never mounts more than it has to. Past that the reader has gone
    // thousands of lines deep and is not peeking, so half-again keeps the tail
    // reachable: a flat step would need ~100 gestures to walk the 40,000 lines
    // the formatter's 2M-char document cap allows.
    const grow = (l: number) =>
      nextPreviewLimit(atDistanceFromEnd(0), l, 1_000_000, STEP);
    expect(grow(400)).toBe(800);
    expect(grow(800)).toBe(1200);
    expect(grow(1200)).toBe(1800);
    expect(grow(1800)).toBe(2700);
  });

  it("never mounts more than five steps in one commit", () => {
    // The ceiling is the whole reason this is safe. Uncapped half-again growth
    // re-creates the stall the step exists to prevent — a 20,500 → 30,750 step
    // would mount ten thousand divs in one synchronous commit, inside a hover
    // panel over the composer.
    const grow = (l: number) =>
      nextPreviewLimit(atDistanceFromEnd(0), l, 10_000_000, STEP) - l;
    expect(grow(4000)).toBe(2000);
    expect(grow(20_000)).toBe(2000);
    expect(grow(1_000_000)).toBe(2000);
    for (const l of [400, 800, 1200, 1800, 2700, 4050, 40_000]) {
      expect(grow(l)).toBeLessThanOrEqual(STEP * 5);
    }
  });

  it("reaches the formatter's worst case in a handful of gestures", () => {
    // 2,000,000 chars ÷ ~50 per line. This is the case the flat step failed:
    // 400 at a time is ~100 scroll-to-the-end gestures.
    let limit = 400;
    let gestures = 0;
    while (limit < 40_000) {
      limit = nextPreviewLimit(atDistanceFromEnd(0), limit, 40_000, STEP);
      gestures++;
    }
    expect(gestures).toBeLessThanOrEqual(25);
    expect(limit).toBe(40_000);
  });

  it("never mounts past the end of the document", () => {
    // The last step lands exactly on the line count — an over-run would render
    // `undefined` rows, and `limit > total` would keep the handler doing work
    // on every scroll event forever.
    expect(nextPreviewLimit(atDistanceFromEnd(0), 400, 550, STEP)).toBe(550);
  });

  it("is a no-op once everything is mounted", () => {
    // Identity matters, not just the value: React bails out of a re-render
    // when the reducer returns the previous state, so scrolling a
    // fully-mounted transcript costs nothing.
    expect(nextPreviewLimit(atDistanceFromEnd(0), 550, 550, STEP)).toBe(550);
    expect(nextPreviewLimit(atDistanceFromEnd(0), 400, 400, STEP)).toBe(400);
  });

  it("handles a transcript shorter than one step", () => {
    // Body fits with no overflow at all: scrollHeight === clientHeight, so
    // `below` is 0 and the guard has to be the limit >= total check, not the
    // distance.
    const noOverflow = { scrollTop: 0, scrollHeight: 270, clientHeight: 270 };
    expect(nextPreviewLimit(noOverflow, 400, 12, STEP)).toBe(400);
  });

  it("tolerates the bounce past the end that a trackpad produces", () => {
    // Overscroll makes scrollTop exceed scrollHeight - clientHeight, so
    // `below` goes negative. It must still read as "at the end".
    const bounced = { scrollTop: 4900, scrollHeight: 5000, clientHeight: 270 };
    expect(nextPreviewLimit(bounced, 400, 5000, STEP)).toBe(800);
  });
});
