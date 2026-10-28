import { designBackgroundWork } from "./design-background-work";
import { create } from "zustand";
import { useMemo } from "react";
import {
  designHistoryPresentation,
  useDesignHistoryPresentation,
  type DesignHistoryPresentation,
} from "./design-history-presentation";

const MAX_LIVE_NODES = 96;
let publicationSequence = 0;
const latestPublicationByProperty = new Map<string, number>();

/** Capture at history input, before either the mutation lane or runtime reply. */
export function designLivePreviewSequence(): number {
  return publicationSequence;
}

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

function historyCutoff(
  history: DesignHistoryPresentation | null,
  frame: string,
  nodeId: string,
): number | undefined {
  const inverse = history?.runtime.get(frame);
  return inverse && (inverse.frame.oid === nodeId || inverse.details.has(nodeId))
    ? inverse.livePreviewSequence
    : undefined;
}

function supersededByHistory(key: string, property: string, cutoff: number | undefined): boolean {
  return cutoff !== undefined &&
    (latestPublicationByProperty.get(propertyKey(key, property)) ?? Infinity) <= cutoff;
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
  discardPendingGesture(key, styles);
  const cutoff = historyCutoff(designHistoryPresentation(workspaceId), frame, nodeId);
  // Re-entering the same value after Undo is new input even though its raw
  // scalar is unchanged. Notify once when it becomes visible over the inverse.
  const supersedesHistory = Object.keys(styles).some(property => supersededByHistory(key, property, cutoff));
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
    if (current && !supersedesHistory && sameStyles(current.styles, nextStyles)) return state;
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
const pendingGestures = new Map<
  string,
  {
    workspaceId: string;
    frame: string;
    nodeId: string;
    styles: Record<string, string | null>;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function discardPendingGesture(
  key: string,
  properties?: Readonly<Record<string, string | null>>,
  matchingValuesOnly = false,
): void {
  const pending = pendingGestures.get(key);
  if (!pending) return;
  if (properties) {
    for (const [property, value] of Object.entries(properties)) {
      if (!matchingValuesOnly || pending.styles[property] === value)
        delete pending.styles[property];
    }
    if (Object.keys(pending.styles).length > 0) return;
  }
  clearTimeout(pending.timer);
  pendingGestures.delete(key);
}

function rememberGesturePublication(key: string, now: number): void {
  if (gesturePublishedAt.size >= MAX_GESTURE_PUBLICATION_OWNERS)
    gesturePublishedAt.clear();
  gesturePublishedAt.set(key, now);
}

function flushPendingGesture(key: string): void {
  const pending = pendingGestures.get(key);
  if (!pending) return;
  discardPendingGesture(key);
  rememberGesturePublication(key, Date.now());
  publishDesignLivePreviewStyles(
    pending.workspaceId,
    pending.frame,
    pending.nodeId,
    pending.styles,
  );
}

/** Mirror a running gesture's authored values into the inspector at a readable
 * rate rather than on every frame.
 *
 * The canvas paints its own overlay, so nothing on the surface the user is
 * dragging needs this store; only the inspector reads it, and a publication per
 * frame re-renders every open field for numbers being read at a glance. Ten a
 * second is indistinguishable from sixty and costs a sixth as much. Retain one
 * trailing publication per owner so pausing the pointer cannot lose its last
 * value. Cancellation and settlement discard that pending publication.
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
  designBackgroundWork.touch();
  const key = ownerKey(workspaceId, frame, nodeId);
  const now = Date.now();
  const elapsed = now - (gesturePublishedAt.get(key) ?? 0);
  if (!options.settle && elapsed < GESTURE_PUBLICATION_INTERVAL_MS) {
    const pending = pendingGestures.get(key);
    if (pending) Object.assign(pending.styles, styles);
    else {
      if (pendingGestures.size >= MAX_GESTURE_PUBLICATION_OWNERS)
        flushPendingGesture(pendingGestures.keys().next().value!);
      pendingGestures.set(key, {
        workspaceId,
        frame,
        nodeId,
        styles: { ...styles },
        timer: setTimeout(
          () => flushPendingGesture(key),
          GESTURE_PUBLICATION_INTERVAL_MS - elapsed,
        ),
      });
    }
    return;
  }
  const pendingStyles = pendingGestures.get(key)?.styles;
  const latest = pendingStyles ? { ...pendingStyles, ...styles } : styles;
  discardPendingGesture(key);
  if (options.settle) gesturePublishedAt.delete(key);
  else rememberGesturePublication(key, now);
  publishDesignLivePreviewStyles(workspaceId, frame, nodeId, latest);
}

export function clearDesignLivePreview(
  workspaceId: string,
  frame: string,
  nodeId: string,
  expectedPublication?: DesignLivePreviewPublication,
): void {
  const key = ownerKey(workspaceId, frame, nodeId);
  if (!expectedPublication) {
    discardPendingGesture(key);
    gesturePublishedAt.delete(key);
  }
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
  discardPendingGesture(key, committedStyles, true);
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
  const key = ownerKey(workspaceId, frame, nodeId);
  const cutoff = historyCutoff(designHistoryPresentation(workspaceId), frame, nodeId);
  return supersededByHistory(key, property, cutoff)
    ? undefined
    : useDesignLivePreviewStore.getState().byOwner[key]?.styles[property];
}

export function useDesignLivePreviewStyles(
  workspaceId: string,
  frame: string,
  nodeId: string,
) {
  const key = ownerKey(workspaceId, frame, nodeId);
  const entry = useDesignLivePreviewStore((state) => state.byOwner[key]);
  const history = useDesignHistoryPresentation(workspaceId);
  const cutoff = historyCutoff(history, frame, nodeId);
  return useMemo(() => {
    if (!entry || cutoff === undefined) return entry?.styles;
    const styles = Object.entries(entry.styles);
    const visible = styles.filter(([property]) => !supersededByHistory(key, property, cutoff));
    if (visible.length === styles.length) return entry.styles;
    return visible.length ? Object.fromEntries(visible) : undefined;
  }, [entry, key, cutoff]);
}

export function useDesignLivePreviewValue(
  workspaceId: string,
  frame: string,
  nodeId: string,
  property: string,
): string | null | undefined {
  const key = ownerKey(workspaceId, frame, nodeId);
  const history = useDesignHistoryPresentation(workspaceId);
  const cutoff = historyCutoff(history, frame, nodeId);
  return useDesignLivePreviewStore(
    (state) => supersededByHistory(key, property, cutoff) ? undefined : state.byOwner[key]?.styles[property],
  );
}

export function resetDesignLivePreviewForTests(): void {
  publicationSequence = 0;
  latestPublicationByProperty.clear();
  for (const key of pendingGestures.keys()) discardPendingGesture(key);
  gesturePublishedAt.clear();
  useDesignLivePreviewStore.setState({ byOwner: {}, ownerOrder: [] });
}
