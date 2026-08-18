import { useEffect, useRef } from "react";

const NATIVE_SURFACE_OVERLAY_INTENT_EVENT =
  "zeros-native-surface-overlay-intent";

const activeOverlayIntents = new Set<symbol>();
let publishedAggregateState = false;

function dispatchNativeSurfaceOverlayState(active: boolean): void {
  if (typeof document === "undefined") {
    return;
  }
  if (active === publishedAggregateState) return;
  publishedAggregateState = active;
  document.dispatchEvent(
    new CustomEvent(NATIVE_SURFACE_OVERLAY_INTENT_EVENT, {
      detail: { active },
    }),
  );
}

/** Native Electron child views composite above renderer DOM. Shared overlay
 * primitives announce their open transition before mounting a portal so any
 * active native surface can park itself before the first overlay paint. */
export function publishNativeSurfaceOverlayIntent(
  active: boolean,
  id: symbol = LEGACY_OVERLAY_INTENT,
): void {
  if (active) activeOverlayIntents.add(id);
  else activeOverlayIntents.delete(id);
  dispatchNativeSurfaceOverlayState(activeOverlayIntents.size > 0);
}

const LEGACY_OVERLAY_INTENT = Symbol("native-surface-overlay-legacy");

/** Create one idempotent overlay lifecycle. The aggregate remains active when
 * a tooltip, nested menu, or toast closes while another portal is still open,
 * preventing an attach/park compositor flash between overlapping surfaces. */
export function createNativeSurfaceOverlayIntent(): (
  active: boolean,
) => void {
  const id = Symbol("native-surface-overlay");
  let active = false;
  return (next) => {
    if (active === next) return;
    active = next;
    publishNativeSurfaceOverlayIntent(next, id);
  };
}

/** React wrapper that releases its lifecycle token on unmount, including a
 * controlled Radix root disappearing without an onOpenChange(false) callback. */
export function useNativeSurfaceOverlayIntent(): (active: boolean) => void {
  const intentRef = useRef<((active: boolean) => void) | null>(null);
  if (!intentRef.current) {
    intentRef.current = createNativeSurfaceOverlayIntent();
  }
  useEffect(() => {
    const intent = intentRef.current;
    return () => intent?.(false);
  }, []);
  return intentRef.current;
}

export function listenForNativeSurfaceOverlayIntent(
  listener: (active: boolean) => void,
): () => void {
  if (typeof document === "undefined") return () => undefined;
  // A replaced renderer document cannot contain any portals from the prior
  // document. Reset module-level bookkeeping before subscribing its surface.
  if (activeOverlayIntents.size === 0) publishedAggregateState = false;
  const handle = (event: Event) => {
    listener(
      Boolean((event as CustomEvent<{ active?: unknown }>).detail?.active),
    );
  };
  document.addEventListener(NATIVE_SURFACE_OVERLAY_INTENT_EVENT, handle);
  return () =>
    document.removeEventListener(NATIVE_SURFACE_OVERLAY_INTENT_EVENT, handle);
}
