// Pointer or focus intent toward one frame. A frame the pointer rests on is
// the likely next selection, so its editing runtime can start booting before
// the click; selecting it then paints Layers and the inspector from ready
// data instead of a fallback view. One latest frame per workspace owner,
// published only when it changes, so pointer movement never re-renders React.

import { useCallback, useSyncExternalStore } from "react";

export const DESIGN_FRAME_INTENT_DWELL_MS = 120;
const MAX_INTENT_OWNERS = 8;

const intentByWorkspace = new Map<string, string>();
const pendingByWorkspace = new Map<string, { file: string; timer: ReturnType<typeof setTimeout> }>();
const pointerByWorkspace = new Map<string, DesignPointerPoint>();
const listeners = new Set<() => void>();

function publish(workspaceId: string, file: string | null): void {
  if ((intentByWorkspace.get(workspaceId) ?? null) === file) return;
  intentByWorkspace.delete(workspaceId);
  if (file) intentByWorkspace.set(workspaceId, file);
  while (intentByWorkspace.size > MAX_INTENT_OWNERS) {
    const oldest = intentByWorkspace.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    intentByWorkspace.delete(oldest);
  }
  for (const listener of listeners) listener();
}

function cancelPending(workspaceId: string): void {
  const pending = pendingByWorkspace.get(workspaceId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingByWorkspace.delete(workspaceId);
}

export interface DesignPointerPoint { x: number; y: number }

/** Where the pointer last moved over this workspace's canvas. */
export function noteDesignPointerMoved(workspaceId: string, at: DesignPointerPoint): void {
  pointerByWorkspace.delete(workspaceId);
  pointerByWorkspace.set(workspaceId, { x: at.x, y: at.y });
  while (pointerByWorkspace.size > MAX_INTENT_OWNERS) {
    const oldest = pointerByWorkspace.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    pointerByWorkspace.delete(oldest);
  }
}

/** The pointer is over `file` (or over empty canvas, `null`). Empty canvas
 * keeps the last intent: crossing a gap between frames is not leaving. A
 * pointer `at` the point it last moved to did not move: the camera moved
 * content under it, which is not intent. */
export function noteDesignFrameIntent(workspaceId: string, file: string | null, at?: DesignPointerPoint): void {
  const last = at && pointerByWorkspace.get(workspaceId);
  if (!file || (at && last && last.x === at.x && last.y === at.y)) {
    cancelPending(workspaceId);
    return;
  }
  if (intentByWorkspace.get(workspaceId) === file) {
    cancelPending(workspaceId);
    return;
  }
  if (pendingByWorkspace.get(workspaceId)?.file === file) return;
  cancelPending(workspaceId);
  const timer = setTimeout(() => {
    pendingByWorkspace.delete(workspaceId);
    publish(workspaceId, file);
  }, DESIGN_FRAME_INTENT_DWELL_MS);
  pendingByWorkspace.set(workspaceId, { file, timer });
}

/** The camera moved: the title a pointer was resting on moved away from it.
 * The current intent stays; only the dwell toward a new frame ends. */
export function cancelDesignFrameIntentDwell(workspaceId: string): void {
  cancelPending(workspaceId);
}

/** A frame that is about to be selected (just created): warm it at once. */
export function primeDesignFrameIntent(workspaceId: string, file: string): void {
  cancelPending(workspaceId);
  publish(workspaceId, file);
}

/** The pointer left the canvas, the surface deactivated or its owner changed. */
export function clearDesignFrameIntent(workspaceId: string): void {
  cancelPending(workspaceId);
  pointerByWorkspace.delete(workspaceId);
  publish(workspaceId, null);
}

export function designFrameIntent(workspaceId: string | null | undefined): string | null {
  return workspaceId ? (intentByWorkspace.get(workspaceId) ?? null) : null;
}

export function subscribeDesignFrameIntent(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDesignFrameIntent(workspaceId: string | null | undefined): string | null {
  const read = useCallback(() => designFrameIntent(workspaceId), [workspaceId]);
  return useSyncExternalStore(subscribeDesignFrameIntent, read, read);
}

export function resetDesignFrameIntentForTests(): void {
  for (const pending of pendingByWorkspace.values()) clearTimeout(pending.timer);
  pendingByWorkspace.clear();
  intentByWorkspace.clear();
  pointerByWorkspace.clear();
}
