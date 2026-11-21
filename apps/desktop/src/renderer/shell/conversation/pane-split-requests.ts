// The header's ⋯ menu splits the focused pane; the pane layout owns the split.

export type PaneSplitDirection = "right" | "down";
/** A split direction, or "merge" to fold the focused pane into another. */
export type PaneSplitRequest = PaneSplitDirection | "merge";

const listeners = new Set<(dir: PaneSplitRequest) => void>();

export function requestFocusedPaneSplit(dir: PaneSplitRequest): void {
  for (const listener of listeners) listener(dir);
}

export function onFocusedPaneSplitRequest(listener: (dir: PaneSplitRequest) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
