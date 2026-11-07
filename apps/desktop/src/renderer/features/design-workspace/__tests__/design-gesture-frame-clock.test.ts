import { expect, it } from "vitest";
import { createDesignGestureFrameClock } from "../design-gesture-frame-clock";

function frames() {
  let next = 1;
  const pending = new Map<number, FrameRequestCallback>();
  return {
    request: (callback: FrameRequestCallback) => { const id = next++; pending.set(id, callback); return id; },
    cancel: (id: number) => { pending.delete(id); },
    run() { const due = [...pending]; pending.clear(); for (const [, callback] of due) callback(0); },
    get size() { return pending.size; },
  };
}

it("requests one display frame per refresh while the gesture is live and retires itself when it ends", () => {
  const raf = frames();
  let live = true;
  const clock = createDesignGestureFrameClock(() => live, raf.request, raf.cancel);
  clock.start();
  clock.start();
  expect(raf.size).toBe(1);
  raf.run();
  raf.run();
  expect(raf.size).toBe(1);
  expect(clock.running).toBe(true);
  live = false;
  raf.run();
  expect(raf.size).toBe(0);
  expect(clock.running).toBe(false);
});

it("stops immediately on cancellation and never starts without a live gesture", () => {
  const raf = frames();
  let live = false;
  const clock = createDesignGestureFrameClock(() => live, raf.request, raf.cancel);
  clock.start();
  expect(raf.size).toBe(0);
  live = true;
  clock.start();
  clock.stop();
  expect(raf.size).toBe(0);
  expect(clock.running).toBe(false);
});
