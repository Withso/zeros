import { create } from "zustand";

interface DesignCanvasItemSelection {
  owner: string;
  id: string;
}

const store = create<{ selection: DesignCanvasItemSelection | null }>(() => ({ selection: null }));

export function designCanvasItemOwner(workspaceId: string, directoryId: string | undefined, pageId: string): string {
  return `${workspaceId}\0${directoryId ?? ""}\0${pageId}`;
}

export function designCanvasItemSelection(owner: string): string | null {
  const selection = store.getState().selection;
  return selection?.owner === owner ? selection.id : null;
}

export function setDesignCanvasItemSelection(owner: string, id: string | null): void {
  const current = store.getState().selection;
  if (id === null && current?.owner !== owner) return;
  const selection = id === null ? null : { owner, id };
  if (current === selection || (current?.owner === selection?.owner && current?.id === selection?.id)) return;
  store.setState({ selection });
}

export function useDesignCanvasItemSelection(owner: string): string | null {
  return store(state => state.selection?.owner === owner ? state.selection.id : null);
}
