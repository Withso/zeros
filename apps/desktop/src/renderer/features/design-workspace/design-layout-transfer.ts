import {
  DESIGN_RUNTIME_DOCUMENT_BODY_ID,
  type DesignRuntimeNodeDetails,
} from "@zeros/protocol/design-runtime";
import type { DesignCanvasFrameWire } from "../../platform/git";
import {
  designFrameRuntime,
  waitForDesignFrameRuntime,
} from "../../platform/bridge/design-frame-runtime";
import {
  designWorkspaceSnapshotCache,
  transferDesignNodeCached,
} from "./state/design-workspace-cache";
import { selectDesignFrame, selectDesignNode } from "./state/design-selection";
import { designFrameViews, isPreparedDesignFrame, type DesignFrameView } from "./state/design-frame-view";
import { designLayoutDrop } from "./design-layout-drag";
import {
  designFrameRelocation,
  designNodeRelocation,
} from "./design-movement-geometry";
import {
  captureDesignPageOwner,
  designWorkspaceView,
  isCurrentDesignPageOwner,
  useDesignWorkspaceUiStore,
} from "./state/design-workspace-ui";

type CanvasFrameGeometry = Pick<DesignCanvasFrameWire, "file" | "pageId" | "kind" | "x" | "y" | "width" | "height" | "z">;

export function designCanvasDropTargetFrame<T extends CanvasFrameGeometry>(
  source: string,
  frames: readonly T[],
  rect: { x: number; y: number; width: number; height: number },
): T | undefined {
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const pageId = frames.find((frame) => frame.file === source)?.pageId;
  return frames
    .filter(
      (candidate) =>
        candidate.file !== source &&
        (!pageId || candidate.pageId === pageId) &&
        center.x >= candidate.x &&
        center.y >= candidate.y &&
        center.x <= candidate.x + candidate.width &&
        center.y <= candidate.y + candidate.height &&
        candidate.width * candidate.height > rect.width * rect.height,
    )
    .reduce<
      T | undefined
    >((top, candidate) => (!top || candidate.z >= top.z ? candidate : top), undefined);
}

/** The frame under a canvas point that a dragged frame or layer would join,
 * as in a design tool: the topmost one, never the dragged frame itself, and
 * never a text frame, which holds no layers. */
export function designCanvasFrameAt<T extends CanvasFrameGeometry>(
  source: string,
  frames: readonly T[],
  point: { x: number; y: number },
): T | undefined {
  const pageId = frames.find((frame) => frame.file === source)?.pageId;
  return frames
    .filter(
      (candidate) =>
        candidate.file !== source &&
        (!pageId || candidate.pageId === pageId) &&
        candidate.kind !== "text" &&
        point.x >= candidate.x &&
        point.y >= candidate.y &&
        point.x <= candidate.x + candidate.width &&
        point.y <= candidate.y + candidate.height,
    )
    .reduce<
      T | undefined
    >((top, candidate) => (!top || candidate.z >= top.z ? candidate : top), undefined);
}

/** How long a release waits for a destination frame that just went live. */
const DESTINATION_READY_MS = 2_000;

/** Metadata reserves the drop target while its source prepares. A retained
 * runtime or cover alone can never turn that target into editable authority. */
async function preparedDropDestination(workspaceId: string, frame: DesignFrameView, isCurrent: () => boolean): Promise<DesignCanvasFrameWire | null> {
  const initial = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
  if (!initial?.preparation) return isPreparedDesignFrame(frame) ? frame : null;
  const read = () => {
    const snapshot = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
    if (!isCurrent() || !snapshot || snapshot.directoryId !== initial.directoryId ||
      snapshot.preparation?.epoch !== initial.preparation!.epoch) return null;
    const current = designFrameViews(snapshot).find((candidate) => candidate.file === frame.file);
    if (!current || snapshot.preparation.errors[frame.file]) return null;
    return isPreparedDesignFrame(current) ? current : undefined;
  };
  const ready = read();
  if (ready !== undefined) return ready;
  return new Promise((resolve) => {
    const finish = (value: DesignCanvasFrameWire | null) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const unsubscribe = designWorkspaceSnapshotCache.subscribe(workspaceId, () => {
      const current = read();
      if (current !== undefined) finish(current);
    });
    const timer = setTimeout(() => finish(null), DESTINATION_READY_MS);
  });
}

/** One layer released outside its frame, as in a design tool: over another
 * frame it joins that frame at the pointer; over empty canvas it becomes a
 * frame of its own. The frame under the pointer is found among the frames
 * confirmed at release, never those the gesture started with; `nest`
 * outlines it (and makes it live) while the move saves. */
export async function transferDesignLayerAtRelease(
  input: Omit<Parameters<typeof transferDesignLayerOnCanvas>[0], "frames" | "detach" | "destination" | "pointer"> & {
    pointer: { x: number; y: number };
    nest?: (file: string | null) => void;
  },
): Promise<boolean> {
  const { nest, ...transfer } = input;
  const frames = designFrameViews(designWorkspaceSnapshotCache.peekSnapshot(input.workspaceId).data);
  const destination = designCanvasFrameAt(input.frame.file, frames, input.pointer);
  if (destination) nest?.(destination.file);
  try {
    return await transferDesignLayerOnCanvas({
      ...transfer,
      frames,
      detach: true,
      ...(destination ? { destination } : {}),
    });
  } finally {
    if (destination) nest?.(null);
  }
}

export async function transferDesignLayerOnCanvas(input: {
  workspaceId: string;
  folder: string;
  frame: DesignCanvasFrameWire;
  frames: readonly DesignFrameView[];
  details: DesignRuntimeNodeDetails;
  duplicateNodeId?: string;
  origin: { x: number; y: number };
  detach: boolean;
  isCurrent?: () => boolean;
  canWrite?: () => boolean;
  requireRelocation?: boolean;
  presented?: (frame: DesignCanvasFrameWire) => Promise<void>;
  /** The canvas point under the pointer at release. The destination is the
   * frame under it and the drop slot is resolved at it, as in a design tool. */
  pointer?: { x: number; y: number };
  /** The destination the gesture already highlighted, kept at release. */
  destination?: DesignFrameView;
}): Promise<boolean> {
  const { workspaceId, folder, frame, details, origin } = input;
  const owner = captureDesignPageOwner(workspaceId);
  const initialSelection = designWorkspaceView(workspaceId);
  const hasIntent = () =>
    isCurrentDesignPageOwner(owner) &&
    designWorkspaceView(workspaceId).selectionEvent ===
      initialSelection.selectionEvent &&
    input.isCurrent?.() !== false;
  const center = input.pointer ?? {
    x: origin.x + details.rect.width / 2,
    y: origin.y + details.rect.height / 2,
  };
  const describedDestination =
    input.destination ??
    (input.pointer
      ? designCanvasFrameAt(frame.file, input.frames, input.pointer)
      : designCanvasDropTargetFrame(frame.file, input.frames, {
          ...origin,
          width: details.rect.width,
          height: details.rect.height,
        }));
  if (!describedDestination && !input.detach) return false;
  const destination = describedDestination
    ? await preparedDropDestination(workspaceId, describedDestination, hasIntent)
    : null;
  if (!hasIntent() || input.canWrite?.() === false) return false;
  const stillLoading = () => new Error(`${describedDestination!.title} is still loading. Try the move again in a moment.`);
  if (describedDestination && !destination) throw stillLoading();
  const destinationScope = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
  const destinationEpoch = destinationScope?.preparation?.epoch;
  const destinationDirectoryId = destinationScope?.directoryId;
  // A small frame paints a picture until the gesture asks for it; give its
  // document a moment to become ready before resolving the drop inside it.
  const outgoingRuntime = destination ? designFrameRuntime(workspaceId, destination.file) : null;
  const targetRuntime = destination
    ? outgoingRuntime?.sourceVersion === destination.sourceVersion
      ? outgoingRuntime
      : await waitForDesignFrameRuntime(workspaceId, destination.file, DESTINATION_READY_MS, { sourceVersion: destination.sourceVersion })
    : null;
  if (!hasIntent() || input.canWrite?.() === false) return false;
  if (destination && (!targetRuntime || targetRuntime.sourceVersion !== destination.sourceVersion))
    throw stillLoading();
  const destinationIsCurrent = () => {
    if (!destination) return true;
    if (designFrameRuntime(workspaceId, destination.file) !== targetRuntime) return false;
    const snapshot = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
    if (destinationEpoch !== undefined && (!snapshot || snapshot.directoryId !== destinationDirectoryId ||
      snapshot.preparation?.epoch !== destinationEpoch)) return false;
    if (!snapshot?.preparation) return true;
    const current = designFrameViews(snapshot).find((candidate) => candidate.file === destination.file);
    return !!current && isPreparedDesignFrame(current) &&
      current.sourceVersion === destination.sourceVersion && current.frameId === destination.frameId &&
      current.x === destination.x && current.y === destination.y &&
      current.width === destination.width && current.height === destination.height && current.z === destination.z;
  };
  const targets = targetRuntime?.supports("getLayoutTargets")
    ? await targetRuntime.getLayoutTargets()
    : [];
  if (!hasIntent() || input.canWrite?.() === false) return false;
  if (!destinationIsCurrent()) throw stillLoading();
  // The moving layer is not in the destination's tree; its id must not
  // match one there (every frame's body shares the body id).
  const drop = destination
    ? designLayoutDrop(
        { ...details, oid: "\u0000moving-layer", layout: undefined },
        targets,
        { x: center.x - destination.x, y: center.y - destination.y },
        { x: origin.x - destination.x, y: origin.y - destination.y },
      )
    : null;
  if (destination && !drop) return false;
  const sourceRuntime = designFrameRuntime(workspaceId, frame.file);
  if (input.requireRelocation && !details.relocationContext)
    throw new Error(
      "This runtime cannot measure inherited appearance for safe layer relocation.",
    );
  const destinationParent = targets.find(
    (target) => target.oid === drop?.parentId,
  );
  // The drop parent, its frame's body and that frame's styles decide what
  // the layer inherits there; measure the parent so only the differences
  // travel. A new frame copies the source's head.
  const destinationContext =
    destination && details.relocationContext && drop && targetRuntime
      ? await Promise.resolve()
          .then(() => targetRuntime.getNodeDetails(drop.parentId, undefined, { relocation: true }))
          .then((parent) => parent?.relocationContext ?? null, () => null)
      : destination
        ? null
        : undefined;
  if (!hasIntent() || input.canWrite?.() === false) return false;
  if (!destinationIsCurrent()) throw stillLoading();
  // A body-rooted frame moves whole: its content keeps the frame's size.
  const wholeFrame = details.oid === DESIGN_RUNTIME_DOCUMENT_BODY_ID;
  if (wholeFrame && !destination) return false;
  const relocation = !details.relocationContext
    ? undefined
    : wholeFrame
      ? designFrameRelocation(
          details,
          { width: frame.width, height: frame.height },
          { x: origin.x - destination!.x, y: origin.y - destination!.y },
          destinationParent?.childCoordinateSpace,
          destinationContext,
        )
      : designNodeRelocation(
          details,
          destination
            ? { x: origin.x - destination.x, y: origin.y - destination.y }
            : { x: 0, y: 0 },
          destination ? destinationParent?.childCoordinateSpace : undefined,
          destinationContext,
        );
  const background = wholeFrame ? details.styles?.backgroundColor : undefined;
  const frameBackground =
    background && !/^(?:transparent|rgba\([^)]*,\s*0\))$/.test(background)
      ? background
      : undefined;
  if (relocation && destination && !destinationParent?.childCoordinateSpace)
    throw new Error("The destination's editable coordinates are unavailable.");
  // An absolutely placed layer needs a positioned parent; a static one
  // becomes relative in the same move, as a same-frame move does.
  const parentStyles =
    relocation &&
    destinationParent &&
    destinationParent.tag !== "body" &&
    destinationParent.styles.position === "static"
      ? { position: "relative" as const }
      : undefined;
  if (relocation && sourceRuntime?.sourceVersion !== details.sourceVersion)
    throw new Error("The source frame changed before the layer move.");
  const transfer: Parameters<typeof transferDesignNodeCached>[1] = {
    frame: frame.file,
    pageId: owner.pageId,
    sourceVersion: relocation
      ? details.sourceVersion
      : (sourceRuntime?.sourceVersion ?? frame.sourceVersion),
    ...(relocation
      ? {
          relocation,
          movementGuard: {
            sourceVersion: details.sourceVersion,
            geometry: {
              x: frame.x,
              y: frame.y,
              w: frame.width,
              h: frame.height,
              z: frame.z,
            },
          },
        }
      : {}),
    nodeId: details.oid,
    ...(input.duplicateNodeId ? { duplicateNodeId: input.duplicateNodeId } : {}),
    ...(destination && drop
      ? {
          destinationFrame: destination.file,
          destinationSourceVersion:
            targetRuntime?.sourceVersion ?? destination.sourceVersion,
          parentId: drop.parentId,
          beforeId: drop.beforeId,
          styles: drop.styles,
          ...(parentStyles ? { parentStyles } : {}),
          ...(frameBackground ? { frameBackground } : {}),
          ...(relocation
            ? {
                destinationMovementGuard: {
                  sourceVersion:
                    targetRuntime?.sourceVersion ?? destination.sourceVersion,
                  geometry: {
                    x: destination.x,
                    y: destination.y,
                    w: destination.width,
                    h: destination.height,
                    z: destination.z,
                  },
                },
              }
            : {}),
        }
      : {}),
    x: relocation ? origin.x : Math.round(origin.x),
    y: relocation ? origin.y : Math.round(origin.y),
    w: Math.max(
      1,
      relocation ? details.rect.width : Math.round(details.rect.width),
    ),
    h: Math.max(
      1,
      relocation ? details.rect.height : Math.round(details.rect.height),
    ),
    z: Math.max(0, ...input.frames.map((candidate) => candidate.z + 1)),
  };
  // The selection follows the move in the same render that publishes it. A
  // whole frame leaves its page there; were the selection published after,
  // page binding would first see it missing and the canvas reveal another.
  let followedEvent: number | undefined;
  const followTransfer = (reply: { frame: string; nodeId: string }) => {
    const current = designWorkspaceView(workspaceId);
    if (
      !isCurrentDesignPageOwner(owner) ||
      current.selectionEvent !== initialSelection.selectionEvent ||
      input.isCurrent?.() === false ||
      current.selectedFrame !== initialSelection.selectedFrame ||
      current.selectedNodeId !== initialSelection.selectedNodeId ||
      current.frameSelected !== initialSelection.frameSelected
    )
      return;
    useDesignWorkspaceUiStore
      .getState()
      .setSelection(
        workspaceId,
        reply.frame,
        destination ? reply.nodeId : null,
        undefined,
        { frameSelected: !destination, owner },
      );
    followedEvent = designWorkspaceView(workspaceId).selectionEvent;
  };
  const result = await transferDesignNodeCached(
    workspaceId,
    transfer,
    relocation || destinationEpoch !== undefined
      ? () => hasIntent() && input.canWrite?.() !== false && destinationIsCurrent()
      : undefined,
    followTransfer,
  );
  const nextFrame = result.snapshot.frames.find(
    (candidate) => candidate.file === result.frame,
  );
  if (nextFrame) {
    // Selecting the destination makes it a live-frame priority. Its old
    // document cannot inspect the newly transferred node; wait for presentation.
    if (followedEvent === undefined) return true;
    await input.presented?.(nextFrame);
    const selected = designWorkspaceView(workspaceId);
    if (
      !isCurrentDesignPageOwner(owner) ||
      selected.selectionEvent !== followedEvent ||
      input.isCurrent?.() === false ||
      selected.selectedFrame !== nextFrame.file ||
      selected.selectedNodeId !== (destination ? result.nodeId : null)
    )
      return true;
    if (destination)
      await selectDesignNode({
        workspaceId,
        folder,
        frame: nextFrame,
        nodeId: result.nodeId,
        owner,
      });
    else
      await selectDesignFrame(workspaceId, nextFrame, {
        selected: true,
        owner,
      });
  }
  return true;
}
