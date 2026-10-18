import { useCallback, useLayoutEffect, useRef } from "react";

/** A function with one identity for the component's lifetime that calls the
 *  newest `fn`. For event handlers carried through memoized props or renderer
 *  context: they run after the render that produced them has committed, so
 *  they see the same values the old per-render closure did, without making
 *  every memoized consumer re-render when the owner re-renders. */
export function useLatestCallback<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
