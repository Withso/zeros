import { useLayoutEffect, useRef, type RefObject } from "react";

// Several independently mounted surfaces can switch in the same commit. One
// epoch per root extends suppression until the newest switch has painted and
// prevents an older requestAnimationFrame callback from removing it early.
const switchEpochByRoot = new WeakMap<HTMLElement, number>();

/** Suppress layout/color transitions for exactly the paint that replaces one
 * complete application context with another. Opacity/transform interactions
 * resume immediately afterward; persisted panel sizes therefore snap to their
 * target workspace instead of tweening the whole layout through stale values. */
function suppressContextTransitions(root: HTMLElement): void {
  const epoch = (switchEpochByRoot.get(root) ?? 0) + 1;
  switchEpochByRoot.set(root, epoch);
  root.classList.add("zeros-instant-context-switch");
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (switchEpochByRoot.get(root) !== epoch) return;
      root.classList.remove("zeros-instant-context-switch");
    });
  });
}

/** Apply one-paint transition suppression whenever a semantic view key changes.
 * Pass the smallest stable surface root available: descendant-wide CSS on the
 * document root would make a file click recalculate styles for every retained
 * transcript, terminal, and settings form. */
export function useInstantViewSwitch(
  identity: string,
  scopeRef?: RefObject<HTMLElement | null>,
): void {
  // Tracks the last committed context; initial mount is not a user switch.
  const previousIdentityRef = useRef(identity);
  useLayoutEffect(() => {
    if (previousIdentityRef.current === identity) return;
    previousIdentityRef.current = identity;
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }
    suppressContextTransitions(scopeRef?.current ?? document.documentElement);
  }, [identity, scopeRef]);
}
