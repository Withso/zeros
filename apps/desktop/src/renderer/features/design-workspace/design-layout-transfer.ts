import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import type { DesignCanvasFrameWire } from "../../platform/git";
import { designFrameRuntime } from "../../platform/bridge/design-frame-runtime";
import { transferDesignNodeCached } from "./state/design-workspace-cache";
import { selectDesignFrame, selectDesignNode } from "./state/design-selection";
import { designLayoutDrop } from "./design-layout-drag";
import { designNodeRelocation } from "./design-movement-geometry";
import {
  captureDesignPageOwner,
  designWorkspaceView,
  isCurrentDesignPageOwner,
  useDesignWorkspaceUiStore,
} from "./state/design-workspace-ui";

export function designCanvasDropTargetFrame(
  source: string,
  frames: readonly DesignCanvasFrameWire[],
  rect: { x: number; y: number; width: number; height: number },
): DesignCanvasFrameWire | undefined {
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  return frames
    .filter(
      (candidate) =>
        candidate.file !== source &&
        center.x >= candidate.x &&
        center.y >= candidate.y &&
        center.x <= candidate.x + candidate.width &&
        center.y <= candidate.y + candidate.height &&
        candidate.width * candidate.height > rect.width * rect.height,
    )
    .reduce<
      DesignCanvasFrameWire | undefined
    >((top, candidate) => (!top || candidate.z >= top.z ? candidate : top), undefined);
}

export async function transferDesignLayerOnCanvas(input: {
  workspaceId: string;
  folder: string;
  frame: DesignCanvasFrameWire;
  frames: readonly DesignCanvasFrameWire[];
  details: DesignRuntimeNodeDetails;
  origin: { x: number; y: number };
  detach: boolean;
  isCurrent?: () => boolean;
  canWrite?: () => boolean;
  requireRelocation?: boolean;
  presented?: (frame: DesignCanvasFrameWire) => Promise<void>;
}): Promise<boolean> {
  const { workspaceId, folder, frame, details, origin } = input;
  const owner = captureDesignPageOwner(workspaceId);
  const initialSelection = designWorkspaceView(workspaceId);
  const hasIntent = () =>
    isCurrentDesignPageOwner(owner) &&
    designWorkspaceView(workspaceId).selectionEvent ===
      initialSelection.selectionEvent &&
    input.isCurrent?.() !== false;
  const center = {
    x: origin.x + details.rect.width / 2,
    y: origin.y + details.rect.height / 2,
  };
  const destination = designCanvasDropTargetFrame(frame.file, input.frames, {
    ...origin,
    width: details.rect.width,
    height: details.rect.height,
  });
  if (!destination && !input.detach) return false;
  const targetRuntime = destination
    ? designFrameRuntime(workspaceId, destination.file)
    : null;
  const targets = targetRuntime?.supports("getLayoutTargets")
    ? await targetRuntime.getLayoutTargets()
    : [];
  if (!hasIntent() || input.canWrite?.() === false) return false;
  const drop = destination
    ? designLayoutDrop(
        { ...details, layout: undefined },
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
  const relocation = details.relocationContext
    ? designNodeRelocation(
        details,
        destination
          ? { x: origin.x - destination.x, y: origin.y - destination.y }
          : { x: 0, y: 0 },
        destination
          ? targets.find((target) => target.oid === drop?.parentId)
              ?.childCoordinateSpace
          : undefined,
      )
    : undefined;
  if (
    relocation &&
    destination &&
    !targets.find((target) => target.oid === drop?.parentId)
      ?.childCoordinateSpace
  )
    throw new Error("The destination's editable coordinates are unavailable.");
  const destinationParent = targets.find(
    (target) => target.oid === drop?.parentId,
  );
  if (
    relocation &&
    destinationParent?.tag !== "body" &&
    destinationParent?.styles.position === "static"
  )
    throw new Error(
      "This destination does not provide a positioned container. Move the layer into an independent frame instead.",
    );
  if (relocation && sourceRuntime?.sourceVersion !== details.sourceVersion)
    throw new Error("The source frame changed before the layer move.");
  const result = await transferDesignNodeCached(
    workspaceId,
    {
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
      ...(destination && drop
        ? {
            destinationFrame: destination.file,
            destinationSourceVersion:
              targetRuntime?.sourceVersion ?? destination.sourceVersion,
            parentId: drop.parentId,
            beforeId: drop.beforeId,
            styles: drop.styles,
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
    },
    ...(relocation
      ? ([() => hasIntent() && input.canWrite?.() !== false] as const)
      : []),
  );
  const nextFrame = result.snapshot.frames.find(
    (candidate) => candidate.file === result.frame,
  );
  if (nextFrame) {
    const current = designWorkspaceView(workspaceId);
    const followsTransfer =
      isCurrentDesignPageOwner(owner) &&
      current.selectionEvent === initialSelection.selectionEvent &&
      input.isCurrent?.() !== false &&
      current.selectedFrame === initialSelection.selectedFrame &&
      current.selectedNodeId === initialSelection.selectedNodeId &&
      current.frameSelected === initialSelection.frameSelected;
    if (followsTransfer)
      useDesignWorkspaceUiStore
        .getState()
        .setSelection(
          workspaceId,
          nextFrame.file,
          destination ? result.nodeId : null,
          undefined,
          { frameSelected: !destination, owner },
        );
    // Selecting the destination makes it a live-frame priority. Its old
    // document cannot inspect the newly transferred node; wait for presentation.
    if (!followsTransfer) return true;
    const followedEvent = designWorkspaceView(workspaceId).selectionEvent;
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
