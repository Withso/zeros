// What the inspector presents while a new selection's exact details load.
//
// Selection itself publishes immediately (click handlers never await data).
// The inspector keeps its last complete view, inert, for a short bound while
// the new selection's runtime details arrive, so a fast read swaps straight
// to the new properties instead of flashing "Nothing selected" or the minimal
// frame fallback. Past the bound it presents the real, incomplete selection.

import { useEffect, useRef, useState } from "react";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import type { DesignCanvasFrameWire } from "../../platform/bridge/design-bridge";

export const DESIGN_INSPECTOR_HOLD_MS = 200;

export interface DesignInspectorSelection {
  frame: DesignCanvasFrameWire | null;
  frameSelected: boolean;
  details: DesignRuntimeNodeDetails | null;
  selectedNodeId: string | null;
  selectedNodeIds: readonly string[];
}

/** A page view needs no details; a frame or layer needs its own. */
export function designInspectorSelectionReady(selection: DesignInspectorSelection): boolean {
  if (!selection.frame) return true;
  if (selection.selectedNodeId) return selection.details?.oid === selection.selectedNodeId;
  if (selection.frameSelected) return selection.details !== null;
  return true;
}

export function designInspectorPresented(input: {
  next: DesignInspectorSelection;
  lastReady: DesignInspectorSelection | null;
  expired: boolean;
}): { selection: DesignInspectorSelection; held: boolean } {
  if (
    input.expired ||
    !input.lastReady ||
    !input.next.frame ||
    designInspectorSelectionReady(input.next)
  ) {
    return { selection: input.next, held: false };
  }
  return { selection: input.lastReady, held: true };
}

function selectionKey(selection: DesignInspectorSelection): string {
  return JSON.stringify([
    selection.frame?.file ?? null,
    selection.frame?.sourceVersion ?? null,
    selection.frameSelected,
    selection.selectedNodeId,
    selection.selectedNodeIds,
  ]);
}

/** `owner` scopes the held view to one workspace/directory/page: a replaced
 * owner never presents the previous owner's properties. */
export function useDesignInspectorPresentation(
  owner: string,
  next: DesignInspectorSelection,
): { selection: DesignInspectorSelection; held: boolean } {
  const lastReady = useRef<{ owner: string; selection: DesignInspectorSelection } | null>(null);
  const ready = designInspectorSelectionReady(next);
  const key = `${owner}\u0000${selectionKey(next)}`;
  const [expiredKey, setExpiredKey] = useState<string | null>(null);
  if (ready) lastReady.current = { owner, selection: next };
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setExpiredKey(key), DESIGN_INSPECTOR_HOLD_MS);
    return () => clearTimeout(timer);
  }, [key, ready]);
  return designInspectorPresented({
    next,
    lastReady: lastReady.current?.owner === owner ? lastReady.current.selection : null,
    expired: expiredKey === key,
  });
}
