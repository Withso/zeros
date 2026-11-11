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
  /** Null while the hold waits for its reply; the frame may already show it. */
  details: DesignRuntimeNodeDetails | null;
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

/** A layer whose reply the runtime store refused because it was read while
 * a state was held on it or an ancestor. The store supplies its own check
 * and publish, so this module does not depend on it. */
export interface DesignHeldReplyRefusal {
  workspaceId: string;
  frame: string;
  sourceVersion: string;
  nodeId: string;
  /** Whether the store already has this layer's Default details. */
  hasDefault: () => boolean;
  publish: (details: DesignRuntimeNodeDetails) => void;
}

const MAX_HELD_REFUSALS = 8;
const refusalsByWorkspace = new Map<string, DesignHeldReplyRefusal[]>();
/** Rereads on their way, so several refused replies of one layer cost one. */
const rereading = new Set<string>();

function rereadRefused(refusal: DesignHeldReplyRefusal): void {
  if (refusal.hasDefault()) return;
  const runtime = designFrameRuntime(refusal.workspaceId, refusal.frame);
  if (!runtime || runtime.sourceVersion !== refusal.sourceVersion) return;
  const key = `${refusal.workspaceId}\u0000${refusal.frame}\u0000${refusal.sourceVersion}\u0000${refusal.nodeId}`;
  if (rereading.has(key)) return;
  rereading.add(key);
  void runtime
    .getNodeDetails(refusal.nodeId)
    .then((details) => {
      // A replaced document or a later generation owns the frame now.
      if (designFrameRuntime(refusal.workspaceId, refusal.frame) !== runtime || runtime.sourceVersion !== refusal.sourceVersion) return;
      refusal.publish(details);
    }, () => {})
    .finally(() => rereading.delete(key));
}

/** Read each layer refused during the hold that just ended. Its release is
 * already on the port, so the replies are Default. */
function rereadAfterRelease(workspaceId: string): void {
  const refused = refusalsByWorkspace.get(workspaceId);
  if (!refused) return;
  refusalsByWorkspace.delete(workspaceId);
  for (const refusal of refused) rereadRefused(refusal);
}

/** A selected layer inside a held one, such as its child, gets a reply the
 * store refuses; the selection change then lets the hold go. Read it again
 * once nothing is held: now when the hold has already gone (the read was
 * sent before the release), otherwise when it is let go. A layer that keeps
 * Default details from before the hold costs no read. */
export function noteDesignHeldReplyRefused(refusal: DesignHeldReplyRefusal): void {
  if (!holdByWorkspace.has(refusal.workspaceId)) {
    rereadRefused(refusal);
    return;
  }
  const refused = (refusalsByWorkspace.get(refusal.workspaceId) ?? []).filter(
    (entry) => entry.frame !== refusal.frame || entry.nodeId !== refusal.nodeId,
  );
  refused.push(refusal);
  refusalsByWorkspace.set(refusal.workspaceId, refused.slice(-MAX_HELD_REFUSALS));
}

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

/** The hold on exactly this layer, answered or still in flight. */
export function designHeldStateEntry(
  store: DesignHeldStateStore,
  key: DesignHeldStateKey,
): DesignHeldStateEntry | null {
  const entry = store.byWorkspace[key.workspaceId];
  return entry &&
    entry.frame === key.frame &&
    entry.sourceVersion === key.sourceVersion &&
    entry.nodeId === key.nodeId
    ? entry
    : null;
}

export function designHeldDetails(
  store: DesignHeldStateStore,
  key: DesignHeldStateKey,
): DesignRuntimeNodeDetails | null {
  return designHeldStateEntry(store, key)?.details ?? null;
}

/** Whether a write to these layers would meet a held state, including one
 * whose reply has not arrived. Read at the moment of the write. */
export function designHeldStateHolds(workspaceId: string, frame: string, nodeIds: readonly string[]): boolean {
  const hold = holdByWorkspace.get(workspaceId);
  return Boolean(hold && hold.frame === frame && nodeIds.includes(hold.nodeId));
}

/** For an edit that awaits reads before it writes: a hold can begin after
 * its admission check, and a read inside a held layer comes back marked.
 * Pass each read through `read`, then ask `blocked` before writing. */
export function designHeldStateWatch(
  workspaceId: string,
  frame: string,
  nodeIds: readonly string[],
): { read: (details: DesignRuntimeNodeDetails) => DesignRuntimeNodeDetails; blocked: () => boolean } {
  let heldRead = false;
  return {
    read(details) {
      if (details.heldState !== undefined) heldRead = true;
      return details;
    },
    blocked: () => heldRead || designHeldStateHolds(workspaceId, frame, nodeIds),
  };
}

/** A layer measured for an edit after its preview (the frame root a resize
 * fits to): read through the edit's watch, and null once a hold has met the
 * edit, so a held size is never written as Default. */
export async function measureDesignNodeUnheld(
  runtime: Pick<DesignFrameRuntimeConnection, "getNodeDetails">,
  nodeId: string,
  watch: ReturnType<typeof designHeldStateWatch>,
): Promise<DesignRuntimeNodeDetails | null> {
  const measured = watch.read(await runtime.getNodeDetails(nodeId));
  return watch.blocked() ? null : measured;
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
  useDesignHeldStateStore.setState((store) => ({
    byWorkspace: { ...store.byWorkspace, [workspaceId]: { workspaceId, frame, sourceVersion, nodeId, state, holdId: hold.holdId, details: null } },
  }));
  runtime.holdNodeState(nodeId, state, hold.holdId).then(
    (details) => {
      if (holdByWorkspace.get(workspaceId) !== hold) return;
      const current = designFrameRuntime(workspaceId, frame) === runtime && runtime.sourceVersion === sourceVersion;
      if (!current || details.sourceVersion !== sourceVersion || details.oid !== nodeId || details.heldState !== state) {
        holdByWorkspace.delete(workspaceId);
        clearEntry(workspaceId);
        // A retired document takes no further work.
        if (current) sendRelease(runtime);
        rereadAfterRelease(workspaceId);
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
      rereadAfterRelease(workspaceId);
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
  rereadAfterRelease(workspaceId);
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
  rereadAfterRelease(workspaceId);
}

export function designHeldStateHold(workspaceId: string): { frame: string; nodeId: string; state: DesignRuntimeNodeState } | null {
  const hold = holdByWorkspace.get(workspaceId);
  return hold ? { frame: hold.frame, nodeId: hold.nodeId, state: hold.state } : null;
}

export function resetDesignHeldStateForTests(): void {
  holdByWorkspace.clear();
  refusalsByWorkspace.clear();
  rereading.clear();
  holdSequence = 0;
  useDesignHeldStateStore.setState({ byWorkspace: {} });
}
