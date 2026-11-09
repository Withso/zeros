import { describe, expect, it } from "vitest";

import { DesignGpuDemandClock } from "../gpu/design-gpu-demand-clock";

function clock(settleMs = 200) {
  let now = 0;
  const timers: Array<{ at: number; callback: () => void; cleared: boolean }> = [];
  const asks: number[] = [];
  const demand = new DesignGpuDemandClock(() => asks.push(now), settleMs, {
    set: (callback, ms) => { const timer = { at: now + ms, callback, cleared: false }; timers.push(timer); return timer; },
    clear: (handle) => { (handle as { cleared: boolean }).cleared = true; },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers) if (!timer.cleared && timer.at <= now) { timer.cleared = true; timer.callback(); }
  };
  return { demand, asks, advance };
}

describe("Design GPU demand clock", () => {
  it("asks for a new scene's recordings as soon as its camera has a size, whatever paints come first", () => {
    const { demand, asks, advance } = clock();
    // Mounting: the scene's frames arrive before any camera, then the camera
    // paints at 0 × 0 and again once the viewport is measured.
    demand.input(false);
    demand.camera(false);
    advance(50);
    expect(asks).toEqual([]);
    demand.camera(true);
    advance(0);
    expect(asks).toEqual([50]);
  });

  it("never lets a camera move postpone an ask for changed input, but settles camera moves", () => {
    const { demand, asks, advance } = clock();
    demand.input(true);
    demand.camera(true);
    advance(0);
    expect(asks).toEqual([0]);
    demand.camera(true);
    advance(150);
    demand.camera(true);
    advance(150);
    expect(asks).toEqual([0]);
    advance(50);
    expect(asks).toEqual([0, 350]);
    // A camera without a size keeps the current demand.
    demand.camera(false);
    advance(1_000);
    expect(asks).toEqual([0, 350]);
    demand.dispose();
    demand.input(true);
    advance(0);
    expect(asks).toEqual([0, 350]);
  });
});
