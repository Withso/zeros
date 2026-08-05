import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beginContinuousLayoutResize,
  isContinuousLayoutResizeActive,
  resetContinuousLayoutResizeForTests,
  subscribeContinuousLayoutResize,
} from "../continuous-layout-resize";

afterEach(() => {
  resetContinuousLayoutResizeForTests();
});

describe("continuous layout resize coordination", () => {
  it("publishes only the outer start and final finish for nested gestures", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeContinuousLayoutResize(listener);

    const finishFirst = beginContinuousLayoutResize();
    const finishSecond = beginContinuousLayoutResize();
    expect(isContinuousLayoutResizeActive()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(true);

    finishFirst();
    expect(isContinuousLayoutResizeActive()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    finishSecond();
    expect(isContinuousLayoutResizeActive()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(false);

    unsubscribe();
  });

  it("makes each finish callback idempotent", () => {
    const listener = vi.fn();
    subscribeContinuousLayoutResize(listener);
    const finish = beginContinuousLayoutResize();

    finish();
    finish();

    expect(listener.mock.calls).toEqual([[true], [false]]);
    expect(isContinuousLayoutResizeActive()).toBe(false);
  });
});
