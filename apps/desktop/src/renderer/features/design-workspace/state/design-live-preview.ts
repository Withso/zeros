import { create } from "zustand";

const MAX_LIVE_NODES = 96;
let publicationSequence = 0;
const latestPublicationByOwner = new Map<string, number>();

interface DesignLivePreviewEntry {
  workspaceId: string;
  frame: string;
  nodeId: string;
  styles: Readonly<Record<string, string | null>>;
}

interface DesignLivePreviewStore {
  byOwner: Record<string, DesignLivePreviewEntry>;
  ownerOrder: string[];
}

function ownerKey(workspaceId: string, frame: string, nodeId: string): string {
  return JSON.stringify([workspaceId, frame, nodeId]);
}

function sameStyles(
  left: Readonly<Record<string, string | null>>,
  right: Readonly<Record<string, string | null>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => left[key] === right[key])
  );
}

export const useDesignLivePreviewStore = create<DesignLivePreviewStore>(() => ({
  byOwner: {},
  ownerOrder: [],
}));

export function publishDesignLivePreviewStyles(
  workspaceId: string,
  frame: string,
  nodeId: string,
  styles: Readonly<Record<string, string | null>>,
): number {
  const key = ownerKey(workspaceId, frame, nodeId);
  const publication = ++publicationSequence;
  latestPublicationByOwner.set(key, publication);
  useDesignLivePreviewStore.setState((state) => {
    const current = state.byOwner[key];
    const nextStyles = current
      ? { ...current.styles, ...styles }
      : { ...styles };
    if (current && sameStyles(current.styles, nextStyles)) return state;
    const ownerOrder = [
      ...state.ownerOrder.filter((candidate) => candidate !== key),
      key,
    ].slice(-MAX_LIVE_NODES);
    const retained = new Set(ownerOrder);
    return {
      byOwner: Object.fromEntries(
        Object.entries({
          ...state.byOwner,
          [key]: { workspaceId, frame, nodeId, styles: nextStyles },
        }).filter(([candidate]) => retained.has(candidate)),
      ),
      ownerOrder,
    };
  });
  const retained = new Set(useDesignLivePreviewStore.getState().ownerOrder);
  for (const candidate of latestPublicationByOwner.keys()) {
    if (!retained.has(candidate)) latestPublicationByOwner.delete(candidate);
  }
  return publication;
}

export function clearDesignLivePreview(
  workspaceId: string,
  frame: string,
  nodeId: string,
  expectedPublication?: number,
): void {
  const key = ownerKey(workspaceId, frame, nodeId);
  if (
    expectedPublication !== undefined &&
    latestPublicationByOwner.get(key) !== expectedPublication
  ) {
    return;
  }
  latestPublicationByOwner.delete(key);
  useDesignLivePreviewStore.setState((state) => {
    if (!state.byOwner[key]) return state;
    const byOwner = { ...state.byOwner };
    delete byOwner[key];
    return {
      byOwner,
      ownerOrder: state.ownerOrder.filter((candidate) => candidate !== key),
    };
  });
}

export function designLivePreviewValue(
  workspaceId: string,
  frame: string,
  nodeId: string,
  property: string,
): string | null | undefined {
  return useDesignLivePreviewStore.getState().byOwner[
    ownerKey(workspaceId, frame, nodeId)
  ]?.styles[property];
}

export function useDesignLivePreviewValue(
  workspaceId: string,
  frame: string,
  nodeId: string,
  property: string,
): string | null | undefined {
  const key = ownerKey(workspaceId, frame, nodeId);
  return useDesignLivePreviewStore(
    (state) => state.byOwner[key]?.styles[property],
  );
}

export function resetDesignLivePreviewForTests(): void {
  publicationSequence = 0;
  latestPublicationByOwner.clear();
  useDesignLivePreviewStore.setState({ byOwner: {}, ownerOrder: [] });
}
