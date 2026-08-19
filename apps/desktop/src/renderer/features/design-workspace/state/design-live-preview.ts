import { create } from "zustand";

const MAX_LIVE_NODES = 96;
let publicationSequence = 0;
const latestPublicationByProperty = new Map<string, number>();

export type DesignLivePreviewPublication = Readonly<Record<string, number>>;

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

function propertyKey(owner: string, property: string): string {
  return `${owner}\u0000${property}`;
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
): DesignLivePreviewPublication {
  const key = ownerKey(workspaceId, frame, nodeId);
  const publication = Object.fromEntries(
    Object.keys(styles).map((property) => {
      const sequence = ++publicationSequence;
      latestPublicationByProperty.set(propertyKey(key, property), sequence);
      return [property, sequence];
    }),
  );
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
  for (const candidate of latestPublicationByProperty.keys()) {
    const separator = candidate.lastIndexOf("\u0000");
    if (!retained.has(candidate.slice(0, separator))) {
      latestPublicationByProperty.delete(candidate);
    }
  }
  return publication;
}

const GESTURE_PUBLICATION_INTERVAL_MS = 100;
const MAX_GESTURE_PUBLICATION_OWNERS = 32;
const gesturePublishedAt = new Map<string, number>();

/** Mirror a running gesture's authored values into the inspector at a readable
 * rate rather than on every frame.
 *
 * The canvas paints its own overlay, so nothing on the surface the user is
 * dragging needs this store; only the inspector reads it, and a publication per
 * frame re-renders every open field for numbers being read at a glance. Ten a
 * second is indistinguishable from sixty and costs a sixth as much.
 *
 * `settle` always publishes: the value the inspector is left showing has to be
 * exactly the one the commit will prune, or a speculative number outlives the
 * gesture that produced it. */
export function publishDesignGestureLivePreview(
  workspaceId: string,
  frame: string,
  nodeId: string,
  styles: Readonly<Record<string, string | null>>,
  options: { settle?: boolean } = {},
): void {
  const key = ownerKey(workspaceId, frame, nodeId);
  const now = Date.now();
  if (
    !options.settle &&
    now - (gesturePublishedAt.get(key) ?? 0) < GESTURE_PUBLICATION_INTERVAL_MS
  ) {
    return;
  }
  if (options.settle) gesturePublishedAt.delete(key);
  else {
    if (gesturePublishedAt.size >= MAX_GESTURE_PUBLICATION_OWNERS) {
      gesturePublishedAt.clear();
    }
    gesturePublishedAt.set(key, now);
  }
  publishDesignLivePreviewStyles(workspaceId, frame, nodeId, styles);
}

export function clearDesignLivePreview(
  workspaceId: string,
  frame: string,
  nodeId: string,
  expectedPublication?: DesignLivePreviewPublication,
): void {
  const key = ownerKey(workspaceId, frame, nodeId);
  useDesignLivePreviewStore.setState((state) => {
    const current = state.byOwner[key];
    if (!current) return state;
    const styles = { ...current.styles };
    let changed = false;
    for (const property of expectedPublication
      ? Object.keys(expectedPublication)
      : Object.keys(styles)) {
      if (
        expectedPublication &&
        latestPublicationByProperty.get(propertyKey(key, property)) !==
          expectedPublication[property]
      ) {
        continue;
      }
      if (!(property in styles)) continue;
      delete styles[property];
      latestPublicationByProperty.delete(propertyKey(key, property));
      changed = true;
    }
    if (!changed) return state;
    if (Object.keys(styles).length > 0) {
      return {
        ...state,
        byOwner: {
          ...state.byOwner,
          [key]: { ...current, styles },
        },
      };
    }
    const byOwner = { ...state.byOwner };
    delete byOwner[key];
    return {
      byOwner,
      ownerOrder: state.ownerOrder.filter((candidate) => candidate !== key),
    };
  });
}

/** Remove only values now represented by an authoritative source commit.
 * A different property or a newer value can remain speculative while the
 * workspace mutation queue persists earlier input. */
export function clearCommittedDesignLivePreviewStyles(
  workspaceId: string,
  frame: string,
  nodeId: string,
  committedStyles: Readonly<Record<string, string | null>>,
): void {
  const key = ownerKey(workspaceId, frame, nodeId);
  useDesignLivePreviewStore.setState((state) => {
    const current = state.byOwner[key];
    if (!current) return state;
    const styles = { ...current.styles };
    let changed = false;
    for (const [property, value] of Object.entries(committedStyles)) {
      if (!(property in styles) || styles[property] !== value) continue;
      delete styles[property];
      latestPublicationByProperty.delete(propertyKey(key, property));
      changed = true;
    }
    if (!changed) return state;
    if (Object.keys(styles).length > 0) {
      return {
        ...state,
        byOwner: {
          ...state.byOwner,
          [key]: { ...current, styles },
        },
      };
    }
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
  latestPublicationByProperty.clear();
  gesturePublishedAt.clear();
  useDesignLivePreviewStore.setState({ byOwner: {}, ownerOrder: [] });
}
