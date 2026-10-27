import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearDesignFrameIntent,
  DESIGN_FRAME_INTENT_DWELL_MS,
  designFrameIntent,
  noteDesignFrameIntent,
  resetDesignFrameIntentForTests,
  subscribeDesignFrameIntent,
} from "../state/design-frame-intent";

beforeEach(() => {
  vi.useFakeTimers();
  resetDesignFrameIntentForTests();
});
afterEach(() => vi.useRealTimers());

it("warms a frame only after the pointer rests on it, latest frame wins", () => {
  const notified: Array<string | null> = [];
  const off = subscribeDesignFrameIntent(() => notified.push(designFrameIntent("ws_a")));
  noteDesignFrameIntent("ws_a", "a.html");
  vi.advanceTimersByTime(DESIGN_FRAME_INTENT_DWELL_MS - 1);
  noteDesignFrameIntent("ws_a", "b.html");
  vi.advanceTimersByTime(DESIGN_FRAME_INTENT_DWELL_MS - 1);
  expect(designFrameIntent("ws_a")).toBeNull();
  // Continuous movement over the same frame does not restart its dwell.
  noteDesignFrameIntent("ws_a", "b.html");
  vi.advanceTimersByTime(1);
  expect(designFrameIntent("ws_a")).toBe("b.html");
  expect(notified).toEqual(["b.html"]);
  // Repeated notes for the current intent publish nothing.
  noteDesignFrameIntent("ws_a", "b.html");
  vi.advanceTimersByTime(DESIGN_FRAME_INTENT_DWELL_MS * 2);
  expect(notified).toEqual(["b.html"]);
  off();
});

it("keeps the last intent while the pointer crosses empty canvas, and clears it on leave", () => {
  noteDesignFrameIntent("ws_a", "a.html");
  vi.advanceTimersByTime(DESIGN_FRAME_INTENT_DWELL_MS);
  noteDesignFrameIntent("ws_a", null);
  vi.advanceTimersByTime(DESIGN_FRAME_INTENT_DWELL_MS * 4);
  expect(designFrameIntent("ws_a")).toBe("a.html");
  clearDesignFrameIntent("ws_a");
  expect(designFrameIntent("ws_a")).toBeNull();
});

it("scopes intent by workspace owner and bounds retained owners", () => {
  noteDesignFrameIntent("ws_personal", "a.html");
  noteDesignFrameIntent("ws_org", "a.html");
  vi.advanceTimersByTime(DESIGN_FRAME_INTENT_DWELL_MS);
  expect(designFrameIntent("ws_personal")).toBe("a.html");
  expect(designFrameIntent("ws_org")).toBe("a.html");
  clearDesignFrameIntent("ws_org");
  expect(designFrameIntent("ws_personal")).toBe("a.html");
  for (let index = 0; index < 20; index++) {
    noteDesignFrameIntent(`ws_${index}`, "a.html");
    vi.advanceTimersByTime(DESIGN_FRAME_INTENT_DWELL_MS);
  }
  expect(designFrameIntent("ws_personal")).toBeNull();
  expect(designFrameIntent("ws_19")).toBe("a.html");
});
