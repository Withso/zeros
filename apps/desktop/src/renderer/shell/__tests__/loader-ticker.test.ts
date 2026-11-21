import { describe, expect, it } from "vitest";
import { LOADER_TICK_DWELL_MS, loaderTickDelay } from "@/renderer/shared/ui/loading/loader-ticker";

/** Replays subjects arriving at given times through the dwell rule, the way
 * LoaderTicker does: a pending subject is re-checked when its wait ends, and
 * whatever is newest then is shown. */
function replay(arrivals: [number, string][], until: number, immediate = (key: string) => key === "timer") {
  let shown = { key: arrivals[0][1], at: arrivals[0][0] };
  const shownLog: [number, string][] = [[shown.at, shown.key]];
  let incoming = shown.key;
  let next = 1;
  let wakeAt = Infinity;
  for (let now = arrivals[0][0]; now <= until; now++) {
    let changed = false;
    while (next < arrivals.length && arrivals[next][0] === now) { incoming = arrivals[next++][1]; changed = true; }
    if (!changed && now < wakeAt) continue;
    const delay = loaderTickDelay(shown, incoming, now, immediate(incoming));
    if (incoming !== shown.key && delay === 0) {
      shown = { key: incoming, at: now };
      shownLog.push([now, incoming]);
      wakeAt = Infinity;
    } else if (delay > 0) wakeAt = now + delay;
  }
  return shownLog;
}

describe("loader line dwell", () => {
  it("shows a subject that arrives after the dwell at once", () => {
    expect(loaderTickDelay({ key: "a", at: 0 }, "b", LOADER_TICK_DWELL_MS, false)).toBe(0);
    expect(loaderTickDelay({ key: "a", at: 0 }, "a", 10, false)).toBe(0);
  });

  it("holds the current subject for the rest of its dwell", () => {
    expect(loaderTickDelay({ key: "a", at: 1_000 }, "b", 1_100, false)).toBe(LOADER_TICK_DWELL_MS - 100);
  });

  it("skips subjects that came and went inside one dwell, and never lags the newest by more than it", () => {
    // Rapid parallel calls: b, c and d all arrive within a's dwell.
    const log = replay([[0, "a"], [100, "b"], [200, "c"], [300, "d"], [2_000, "e"]], 3_000);
    expect(log).toEqual([[0, "a"], [LOADER_TICK_DWELL_MS, "d"], [2_000, "e"]]);
  });

  it("returns to the timer at once when the run closes", () => {
    expect(loaderTickDelay({ key: "a", at: 0 }, "timer", 10, true)).toBe(0);
    expect(replay([[0, "a"], [50, "timer"]], 1_000)).toEqual([[0, "a"], [50, "timer"]]);
  });
});
