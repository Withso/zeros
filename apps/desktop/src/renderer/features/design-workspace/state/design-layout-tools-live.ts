import { useCallback, useSyncExternalStore } from "react";

import type { DesignCanvasRect } from "../design-canvas-math";

/** Live geometry and interaction state for one selected layout owner's canvas
 * tools (padding bands, gaps, grid tracks).
 *
 * A spacing drag, a container resize or an inspector scrub changes the owner's
 * layout many times a second, long before the runtime publishes new details.
 * The tools render from React either way; this tiny keyed store lets exactly
 * the one tools island re-render from the latest measurement instead of the
 * whole canvas, and without a second imperative painter that could disagree
 * with the resting render. */

export interface DesignLayoutToolsLiveChild {
  oid: string;
  name: string;
  rect: DesignCanvasRect;
  local?: DesignCanvasRect;
  styles: Record<string, string>;
}

export interface DesignLayoutToolsLiveGeometry {
  rect: DesignCanvasRect;
  box?: {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    scaleX: number;
    scaleY: number;
    originX: number;
    originY: number;
  };
  styles: Record<string, string>;
  /** Omitted when a paint changed only the owner (the children keep the last
   * measurement). */
  children?: readonly DesignLayoutToolsLiveChild[];
}

export interface DesignLayoutToolsLiveInteraction {
  /** The padding property or gap key a drag or entry owns. */
  active: string;
  /** The CSS property being edited; outlives a gap key that reflow removes. */
  property: string;
  /** Local tick center the gesture started from; keeps a readout on screen
   * when reflow removes every space of the edited property. */
  anchor?: { x: number; y: number };
  /** Other padding sides following the active one (Option / Shift+Option). */
  mirrored: readonly string[];
  /** Immediate readouts by property, ahead of the measurement they cause. */
  values: Readonly<Record<string, number>>;
}

export interface DesignLayoutToolsLiveState {
  geometry?: DesignLayoutToolsLiveGeometry;
  interaction?: DesignLayoutToolsLiveInteraction;
  /** A gesture owns the entry; resting props must not clear it. */
  pinned: boolean;
}

const states = new Map<string, DesignLayoutToolsLiveState>();
const listeners = new Map<string, Set<() => void>>();

export function designLayoutToolsKey(
  workspaceId: string,
  frame: string,
  nodeId: string,
): string {
  return `${workspaceId}\u0000${frame}\u0000${nodeId}`;
}

function notify(key: string) {
  for (const listener of listeners.get(key) ?? []) listener();
}

export function publishDesignLayoutToolsLive(
  key: string,
  patch: Partial<DesignLayoutToolsLiveState>,
): void {
  const current = states.get(key);
  states.set(key, {
    pinned: false,
    ...current,
    ...patch,
  });
  notify(key);
}

/** Drop live state. `keepGeometry` holds the last measurement after a commit
 * until the owner's confirmed details replace it, so the tools never flash
 * back to the pre-edit layout between release and publication. */
export function releaseDesignLayoutToolsLive(
  key: string,
  options: { keepGeometry?: boolean } = {},
): void {
  const current = states.get(key);
  if (!current) return;
  if (options.keepGeometry && current.geometry) {
    states.set(key, { geometry: current.geometry, pinned: false });
  } else {
    states.delete(key);
  }
  notify(key);
}

/** Resting details changed: an unpinned measurement is now older than them. */
export function settleDesignLayoutToolsLive(key: string): void {
  const current = states.get(key);
  if (!current || current.pinned) return;
  states.delete(key);
  notify(key);
}

export function readDesignLayoutToolsLive(
  key: string,
): DesignLayoutToolsLiveState | undefined {
  return states.get(key);
}

export function useDesignLayoutToolsLive(
  key: string,
): DesignLayoutToolsLiveState | undefined {
  const subscribe = useCallback(
    (listener: () => void) => {
      let owners = listeners.get(key);
      if (!owners) {
        owners = new Set();
        listeners.set(key, owners);
      }
      owners.add(listener);
      return () => {
        owners!.delete(listener);
        if (owners!.size === 0) listeners.delete(key);
      };
    },
    [key],
  );
  return useSyncExternalStore(
    subscribe,
    () => states.get(key),
    () => undefined,
  );
}
