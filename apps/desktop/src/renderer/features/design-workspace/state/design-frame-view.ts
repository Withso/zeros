import type { DesignCanvasFrameWire, DesignFrameDescriptionWire, DesignFrameGeometryWire, DesignWorkspaceSnapshotWire } from "../../../platform/bridge/design-bridge";

export type DesignFrameView = DesignCanvasFrameWire | (DesignFrameDescriptionWire & { previous?: DesignCanvasFrameWire });
export function isPreparedDesignFrame(frame: DesignFrameView): frame is DesignCanvasFrameWire {
  return typeof frame.sourceVersion === "string";
}
/** What a frame view presents: its prepared generation, or the last confirmed
 * one while its source revalidates. Presentation never mounts a runtime; writes
 * made from it carry that generation and remain engine-checked. */
export function designPresentedFrame(frame: DesignFrameView | null | undefined): DesignCanvasFrameWire | null {
  if (!frame) return null;
  return isPreparedDesignFrame(frame) ? frame : frame.previous ?? null;
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

const placed = new WeakMap<readonly DesignFrameView[], WeakMap<ReadonlyMap<string, DesignFrameGeometryWire>, readonly DesignFrameView[]>>();
/** Frames where Undo or Redo shows them before the engine confirms it.
 * Painting and hit testing read these; every write still checks the
 * confirmed catalog. Stable per frames and geometry, so hot selectors keep
 * their references. */
export function designFramesAtPresentedGeometry(
  frames: readonly DesignFrameView[],
  geometry: ReadonlyMap<string, DesignFrameGeometryWire> | null | undefined,
): readonly DesignFrameView[] {
  if (!geometry?.size) return frames;
  let byGeometry = placed.get(frames);
  if (!byGeometry) placed.set(frames, (byGeometry = new WeakMap()));
  const cached = byGeometry.get(geometry);
  if (cached) return cached;
  const result = frames.map((frame) => {
    const next = geometry.get(frame.file);
    if (!next) return frame;
    const place = { x: next.x, y: next.y, width: next.w, height: next.h, z: next.z };
    if (isPreparedDesignFrame(frame)) return { ...frame, ...place };
    return { ...frame, ...place, ...(frame.previous ? { previous: { ...frame.previous, ...place } } : {}) };
  });
  byGeometry.set(geometry, result);
  return result;
}
