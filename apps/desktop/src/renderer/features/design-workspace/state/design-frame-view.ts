import type { DesignCanvasFrameWire, DesignFrameDescriptionWire, DesignWorkspaceSnapshotWire } from "../../../platform/bridge/design-bridge";

export type DesignFrameView = DesignCanvasFrameWire | (DesignFrameDescriptionWire & { previous?: DesignCanvasFrameWire });
export function isPreparedDesignFrame(frame: DesignFrameView): frame is DesignCanvasFrameWire {
  return typeof frame.sourceVersion === "string";
}
const EMPTY: readonly DesignFrameView[] = Object.freeze([]);
const views = new WeakMap<DesignWorkspaceSnapshotWire, readonly DesignFrameView[]>();
const authority = new WeakMap<DesignWorkspaceSnapshotWire, DesignWorkspaceSnapshotWire>();
/** Only current prepared generations authorize runtime reads and writes.
 * Last-confirmed covers never enter the selection-detail workflow. */
export function preparedDesignSnapshot(snapshot: DesignWorkspaceSnapshotWire | undefined): DesignWorkspaceSnapshotWire | undefined {
  if (!snapshot?.preparation) return snapshot;
  let result = authority.get(snapshot);
  if (!result) {
    result = { ...snapshot, frames: designFrameViews(snapshot).filter(isPreparedDesignFrame) };
    authority.set(snapshot, result);
  }
  return result;
}
/** Descriptors discover/select/position frames. Only a validated source version
 * can mount a runtime or authorize a node edit. Previous pixels are advisory. */
export function designFrameViews(snapshot: DesignWorkspaceSnapshotWire | undefined): readonly DesignFrameView[] {
  if (!snapshot) return EMPTY;
  if (!snapshot.preparation) return snapshot.frames;
  const cached = views.get(snapshot);
  if (cached) return cached;
  const prepared = new Map(snapshot.frames.map((frame) => [frame.file, frame]));
  const current = new Set(snapshot.preparation.current);
  const result = snapshot.preparation.descriptions.map((description) => {
    const frame = prepared.get(description.file);
    return frame && current.has(description.file) ? frame : { ...description, ...(frame ? { previous: frame } : {}) };
  });
  views.set(snapshot, result);
  return result;
}
