import { useMemo } from "react";
import { normalizeDesignPagesSnapshot } from "@zeros/protocol/design-pages";
import type {
  DesignCanvasFrameWire,
  DesignWorkspaceSnapshotWire,
} from "../../../platform/git";

/** One directory read supplies all pages. Cache by confirmed input and retain
 * a page's frame array when only another page or directory-wide data changes. */
export function createDesignPageProjection() {
  const normalizedBySnapshot = new WeakMap<
    DesignWorkspaceSnapshotWire,
    DesignWorkspaceSnapshotWire
  >();
  const projections = new WeakMap<
    DesignWorkspaceSnapshotWire,
    Map<string, DesignWorkspaceSnapshotWire>
  >();
  const recentFrames = new Map<string, DesignCanvasFrameWire[]>();
  return (
    snapshot: DesignWorkspaceSnapshotWire | undefined,
    activePageId?: string,
  ): DesignWorkspaceSnapshotWire | undefined => {
    if (!snapshot) return undefined;
    let normalized = normalizedBySnapshot.get(snapshot);
    if (!normalized) {
      normalized = normalizeDesignPagesSnapshot(snapshot);
      normalizedBySnapshot.set(snapshot, normalized);
    }
    const page =
      normalized.pages!.find((candidate) => candidate.id === activePageId) ??
      normalized.pages![0];
    const cached = projections.get(snapshot)?.get(page.id);
    if (cached) return cached;
    const key = JSON.stringify([
      normalized.directoryId,
      normalized.directory,
      page.id,
    ]);
    const selected = normalized.frames.filter(
      (frame) => frame.pageId === page.id,
    );
    const previous = recentFrames.get(key);
    const frames =
      previous &&
      previous.length === selected.length &&
      previous.every((frame, index) => frame === selected[index])
        ? previous
        : selected.length === normalized.frames.length
          ? normalized.frames
          : selected;
    recentFrames.delete(key);
    recentFrames.set(key, frames);
    if (recentFrames.size > 64)
      recentFrames.delete(recentFrames.keys().next().value!);
    const result =
      frames === normalized.frames ? normalized : { ...normalized, frames };
    const byPage =
      projections.get(snapshot) ??
      new Map<string, DesignWorkspaceSnapshotWire>();
    byPage.set(page.id, result);
    projections.set(snapshot, byPage);
    return result;
  };
}

export function useDesignPageSnapshot(
  snapshot: DesignWorkspaceSnapshotWire | undefined,
  activePageId?: string,
) {
  const project = useMemo(createDesignPageProjection, []);
  return project(snapshot, activePageId);
}
