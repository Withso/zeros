// The header's ⋯ menu splits the focused pane; the pane layout owns the split.

export type PaneSplitDirection = "right" | "down";

const listeners = new Set<(dir: PaneSplitDirection) => void>();

export function requestFocusedPaneSplit(dir: PaneSplitDirection): void {
  for (const listener of listeners) listener(dir);
}

export function onFocusedPaneSplitRequest(listener: (dir: PaneSplitDirection) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
