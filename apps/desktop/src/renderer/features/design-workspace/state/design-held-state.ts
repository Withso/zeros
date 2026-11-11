import type { DesignRuntimeNodeDetails, DesignRuntimeNodeState } from "@zeros/protocol/design-runtime";
import { create } from "zustand";

import { designFrameRuntime, type DesignFrameRuntimeConnection } from "../../../platform/bridge/design-frame-runtime";

/** One layer shown in one of its own states, view only. Its details never
 * enter the runtime store: they are the state's values, not the layer's. */
export interface DesignHeldStateKey {
  workspaceId: string;
  frame: string;
  sourceVersion: string;
  nodeId: string;
}

export interface DesignHeldStateEntry extends DesignHeldStateKey {
  state: DesignRuntimeNodeState;
  holdId: string;
  details: DesignRuntimeNodeDetails;
}

interface DesignHeldStateStore {
  byWorkspace: Record<string, DesignHeldStateEntry>;
}

export const useDesignHeldStateStore = create<DesignHeldStateStore>(() => ({ byWorkspace: {} }));

interface DesignHold extends DesignHeldStateKey {
  state: DesignRuntimeNodeState;
  holdId: string;
  runtime: DesignFrameRuntimeConnection;
}

/** The hold each workspace last asked for, answered or not. */
const holdByWorkspace = new Map<string, DesignHold>();
let holdSequence = 0;

function clearEntry(workspaceId: string): void {
  if (!useDesignHeldStateStore.getState().byWorkspace[workspaceId]) return;
  useDesignHeldStateStore.setState((store) => {
    const byWorkspace = { ...store.byWorkspace };
    delete byWorkspace[workspaceId];
    return { byWorkspace };
  });
}

function sendRelease(runtime: DesignFrameRuntimeConnection): void {
  void runtime.releaseNodeState?.().catch(() => {});
}

export function designHeldDetails(
  store: DesignHeldStateStore,
  key: DesignHeldStateKey,
): DesignRuntimeNodeDetails | null {
  const entry = store.byWorkspace[key.workspaceId];
  return entry &&
    entry.frame === key.frame &&
    entry.sourceVersion === key.sourceVersion &&
    entry.nodeId === key.nodeId
    ? entry.details
    : null;
}

/** Ask the frame to show the layer in a state. Never awaited by a click: the
 * reply publishes once, and only while it is still the latest hold for the
 * same document, generation and layer. */
export function holdDesignNodeState(input: DesignHeldStateKey & {
  state: DesignRuntimeNodeState;
  onHeld?: (details: DesignRuntimeNodeDetails) => void;
}): void {
  const { workspaceId, frame, sourceVersion, nodeId, state } = input;
  const runtime = designFrameRuntime(workspaceId, frame);
  if (!runtime?.holdNodeState || !runtime.supports("holdNodeState") || runtime.sourceVersion !== sourceVersion) return;
  const previous = holdByWorkspace.get(workspaceId);
  // A hold in another document is not replaced by this one.
  if (previous && previous.runtime !== runtime) sendRelease(previous.runtime);
  const hold: DesignHold = { workspaceId, frame, sourceVersion, nodeId, state, holdId: `hold-${++holdSequence}`, runtime };
  holdByWorkspace.set(workspaceId, hold);
  runtime.holdNodeState(nodeId, state, hold.holdId).then(
    (details) => {
      if (holdByWorkspace.get(workspaceId) !== hold) return;
      const current = designFrameRuntime(workspaceId, frame) === runtime && runtime.sourceVersion === sourceVersion;
      if (!current || details.sourceVersion !== sourceVersion || details.oid !== nodeId || details.heldState !== state) {
        holdByWorkspace.delete(workspaceId);
        clearEntry(workspaceId);
        // A retired document takes no further work.
        if (current) sendRelease(runtime);
        return;
      }
      useDesignHeldStateStore.setState((store) => ({
        byWorkspace: { ...store.byWorkspace, [workspaceId]: { workspaceId, frame, sourceVersion, nodeId, state, holdId: hold.holdId, details } },
      }));
      input.onHeld?.(details);
    },
    () => {
      if (holdByWorkspace.get(workspaceId) !== hold) return;
      holdByWorkspace.delete(workspaceId);
      clearEntry(workspaceId);
      sendRelease(runtime);
    },
  );
}

/** Back to Default. The slot clears now and the frame is told without
 * waiting; a hold still in flight is answered and then dropped. */
export function releaseDesignNodeState(workspaceId: string): boolean {
  const hold = holdByWorkspace.get(workspaceId);
  holdByWorkspace.delete(workspaceId);
  clearEntry(workspaceId);
  if (!hold) return false;
  sendRelease(hold.runtime);
  return true;
}

/** A canvas gesture is starting on this layer. Called synchronously before
 * the gesture's first request, so the release precedes it on the port. */
export function releaseDesignNodeStateOn(workspaceId: string, frame: string, nodeId: string): void {
  const hold = holdByWorkspace.get(workspaceId);
  if (hold?.frame === frame && hold.nodeId === nodeId) releaseDesignNodeState(workspaceId);
}

/** The panel now shows `shown` (null: no single layer, or a hidden
 * surface). A hold for anything else lets go: a new selection, page or
 * frame, or the surface going inactive. */
export function releaseDesignNodeStateUnless(workspaceId: string, shown: Omit<DesignHeldStateKey, "workspaceId"> | null): void {
  const hold = holdByWorkspace.get(workspaceId);
  if (!hold) return;
  if (shown && hold.frame === shown.frame && hold.nodeId === shown.nodeId && hold.sourceVersion === shown.sourceVersion) return;
  releaseDesignNodeState(workspaceId);
}

/** The frame let go of a hold by itself; it needs no reply. */
export function forgetDesignHeldStateRelease(workspaceId: string, frame: string, holdId: string): void {
  const hold = holdByWorkspace.get(workspaceId);
  if (hold?.frame !== frame || hold.holdId !== holdId) return;
  holdByWorkspace.delete(workspaceId);
  clearEntry(workspaceId);
}

export function designHeldStateHold(workspaceId: string): { frame: string; nodeId: string; state: DesignRuntimeNodeState } | null {
  const hold = holdByWorkspace.get(workspaceId);
  return hold ? { frame: hold.frame, nodeId: hold.nodeId, state: hold.state } : null;
}

export function resetDesignHeldStateForTests(): void {
  holdByWorkspace.clear();
  holdSequence = 0;
  useDesignHeldStateStore.setState({ byWorkspace: {} });
}
