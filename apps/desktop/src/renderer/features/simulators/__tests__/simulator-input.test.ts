import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { SimulatorInput, SimulatorTouch } from "@zeros/protocol/simulators";

import { SimulatorFinger, SimulatorInputQueue, WheelSwipeGatherer } from "../simulator-input";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SimulatorInputQueue", () => {
  it("sends one input at a time, in order, joining text typed while one is out", async () => {
    const sent: SimulatorInput[] = [];
    const pending: Array<ReturnType<typeof deferred>> = [];
    const queue = new SimulatorInputQueue(
      (input) => {
        sent.push(input);
        const next = deferred();
        pending.push(next);
        return next.promise;
      },
      vi.fn(),
    );
    queue.push({ kind: "tap", at: { x: 10, y: 20 } });
    queue.push({ kind: "text", text: "h" });
    queue.push({ kind: "text", text: "i" });
    queue.push({ kind: "key", key: "enter" });
    queue.push({ kind: "text", text: "!" });
    expect(sent).toEqual([{ kind: "tap", at: { x: 10, y: 20 } }]);

    pending[0]!.resolve();
    await flush();
    expect(sent.at(-1)).toEqual({ kind: "text", text: "hi" });
    pending[1]!.resolve();
    await flush();
    expect(sent.at(-1)).toEqual({ kind: "key", key: "enter" });
    pending[2]!.resolve();
    await flush();
    expect(sent.at(-1)).toEqual({ kind: "text", text: "!" });
    expect(sent).toHaveLength(4);
  });

  it("reports a failure once and drops what was waiting on it", async () => {
    const onError = vi.fn();
    const first = deferred();
    const send = vi.fn((input: SimulatorInput) =>
      input.kind === "tap" ? first.promise : Promise.resolve(),
    );
    const queue = new SimulatorInputQueue(send, onError);
    queue.push({ kind: "tap", at: { x: 1, y: 1 } });
    queue.push({ kind: "key", key: "tab" });
    first.reject(new Error("That didn't reach iPhone 17."));
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);

    queue.push({ kind: "key", key: "escape" });
    await flush();
    expect(send).toHaveBeenLastCalledWith({ kind: "key", key: "escape" });
  });

  it("stops sending once disposed", async () => {
    const first = deferred();
    const send = vi.fn(() => first.promise);
    const queue = new SimulatorInputQueue(send, vi.fn());
    queue.push({ kind: "button", button: "home" });
    queue.push({ kind: "key", key: "enter" });
    queue.dispose();
    first.resolve();
    await flush();
    queue.push({ kind: "key", key: "tab" });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("SimulatorFinger", () => {
  const at = (x: number, y: number) => ({ x, y });
  let now: number;
  let touches: Array<[string, SimulatorTouch]>;
  let pushed: SimulatorInput[];
  let onError: Mock<(error: unknown) => void>;
  let touch: Mock<(viewId: string, step: SimulatorTouch) => Promise<void>>;
  let finger: SimulatorFinger;

  beforeEach(() => {
    now = 0;
    touches = [];
    pushed = [];
    onError = vi.fn();
    touch = vi.fn(async (viewId: string, step: SimulatorTouch) => {
      touches.push([viewId, step]);
    });
    finger = new SimulatorFinger({
      touch,
      push: (input) => pushed.push(input),
      // The other finger mirrors the pointer through a 402 × 874 screen's center.
      mirror: (point) => at(402 - point.x, 874 - point.y),
      onError,
      now: () => now,
    });
  });

  it("streams each step of a press to the live view as it happens", () => {
    finger.down(1, "view-1", at(10, 20), false);
    expect(finger.holds(1)).toBe(true);
    finger.move(1, at(10, 20));
    finger.move(1, at(10, 40));
    finger.up(1, at(10, 60));
    expect(finger.holds(1)).toBe(false);
    expect(touches).toEqual([
      ["view-1", { phase: "down", at: at(10, 20) }],
      ["view-1", { phase: "move", at: at(10, 40) }],
      ["view-1", { phase: "up", at: at(10, 60) }],
    ]);
    expect(pushed).toEqual([]);
  });

  it("streams an Option-drag pinch with the mirrored finger", () => {
    finger.down(1, "view-1", at(151, 437), true);
    expect(finger.pinching).toBe(true);
    finger.move(1, at(101, 437));
    finger.up(1, at(101, 437));
    expect(finger.pinching).toBe(false);
    expect(touches.map(([, step]) => step)).toEqual([
      { phase: "down", at: at(151, 437), second: at(251, 437) },
      { phase: "move", at: at(101, 437), second: at(301, 437) },
      { phase: "up", at: at(101, 437), second: at(301, 437) },
    ]);
  });

  it("sends the whole press once it ends when no live view is open", () => {
    finger.down(1, null, at(100, 100), false);
    now = 120;
    finger.up(1, at(102, 101));
    finger.down(1, null, at(100, 100), false);
    finger.move(1, at(100, 200));
    now += 240;
    finger.up(1, at(100, 300));
    finger.down(1, null, at(100, 100), false);
    now += 800;
    finger.up(1, at(100, 100));
    finger.down(2, null, at(151, 437), true);
    finger.up(2, at(101, 437));
    finger.down(2, null, at(151, 437), true);
    finger.up(2, at(152, 437));
    expect(touch).not.toHaveBeenCalled();
    expect(pushed).toEqual([
      { kind: "tap", at: at(100, 100) },
      { kind: "drag", from: at(100, 100), to: at(100, 300), durationMs: 240 },
      { kind: "drag", from: at(100, 100), to: at(100, 100), durationMs: 800 },
      { kind: "pinch", scale: 2 },
    ]);
  });

  it("lifts a cancelled finger without the press counting", () => {
    finger.down(1, "view-1", at(5, 5), false);
    finger.move(1, at(5, 30));
    finger.cancel();
    finger.up(1, at(5, 40));
    expect(touches.map(([, step]) => step)).toEqual([
      { phase: "down", at: at(5, 5) },
      { phase: "move", at: at(5, 30) },
      { phase: "cancel", at: at(5, 30) },
    ]);
    finger.down(1, null, at(5, 5), false);
    finger.cancel();
    finger.up(1, at(5, 5));
    expect(pushed).toEqual([]);
  });

  it("follows only the pointer that pressed", () => {
    finger.down(1, "view-1", at(5, 5), false);
    finger.down(2, "view-1", at(50, 50), false);
    finger.move(2, at(60, 60));
    finger.up(2, at(60, 60));
    expect(finger.holds(2)).toBe(false);
    expect(touches.map(([, step]) => step.phase)).toEqual(["down"]);
  });

  it("reports a step that didn't reach the device", async () => {
    touch.mockRejectedValueOnce(new Error("iPhone 17 isn't running."));
    finger.down(1, "view-1", at(5, 5), false);
    await flush();
    expect(onError).toHaveBeenCalledWith(new Error("iPhone 17 isn't running."));
  });

  it("lifts a finger left down when disposed, then sends nothing", () => {
    finger.down(1, "view-1", at(5, 5), false);
    expect(finger.pressed).toBe(true);
    finger.dispose();
    expect(finger.pressed).toBe(false);
    finger.move(1, at(5, 50));
    finger.up(1, at(5, 50));
    finger.cancel();
    finger.down(1, null, at(5, 5), false);
    finger.up(1, at(5, 5));
    expect(touches.map(([, step]) => step.phase)).toEqual(["down", "cancel"]);
    expect(pushed).toEqual([]);
  });
});

describe("WheelSwipeGatherer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("turns a burst of wheel events into one swipe from where it started", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const gatherer = new WheelSwipeGatherer(emit, 150);
    gatherer.push({ x: 100, y: 400 }, 0, 30);
    gatherer.push({ x: 120, y: 380 }, 2, 45);
    vi.advanceTimersByTime(149);
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(emit).toHaveBeenCalledWith({ x: 100, y: 400 }, { x: 2, y: 75 });

    gatherer.push({ x: 50, y: 50 }, 0, -10);
    gatherer.dispose();
    vi.advanceTimersByTime(500);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
