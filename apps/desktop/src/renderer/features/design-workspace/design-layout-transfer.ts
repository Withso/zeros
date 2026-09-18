import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import type { DesignCanvasFrameWire } from "../../platform/git";
import { designFrameRuntime } from "../../platform/bridge/design-frame-runtime";
import { transferDesignNodeCached } from "./state/design-workspace-cache";
import { selectDesignFrame, selectDesignNode } from "./state/design-selection";
import { designLayoutDrop } from "./design-layout-drag";
import {
  designWorkspaceView,
  useDesignWorkspaceUiStore,
} from "./state/design-workspace-ui";

export async function transferDesignLayerOnCanvas(input: {
  workspaceId: string;
  folder: string;
  frame: DesignCanvasFrameWire;
  frames: readonly DesignCanvasFrameWire[];
  details: DesignRuntimeNodeDetails;
  origin: { x: number; y: number };
  detach: boolean;
  presented?: (frame: DesignCanvasFrameWire) => Promise<void>;
}): Promise<boolean> {
  const { workspaceId, folder, frame, details, origin } = input;
  const initialSelection = designWorkspaceView(workspaceId);
  const center = {
    x: origin.x + details.rect.width / 2,
    y: origin.y + details.rect.height / 2,
  };
  const destination = input.frames
    .filter(
      (candidate) =>
        candidate.file !== frame.file &&
        center.x >= candidate.x &&
        center.y >= candidate.y &&
        center.x <= candidate.x + candidate.width &&
        center.y <= candidate.y + candidate.height &&
        candidate.width * candidate.height >
          details.rect.width * details.rect.height,
    )
    // Match canvas painting: higher z wins; later siblings win ties.
    .reduce<DesignCanvasFrameWire | undefined>(
      (top, candidate) => !top || candidate.z >= top.z ? candidate : top,
      undefined,
    );
  if (!destination && !input.detach) return false;
  const targetRuntime = destination
    ? designFrameRuntime(workspaceId, destination.file)
    : null;
  const targets = targetRuntime?.supports("getLayoutTargets")
    ? await targetRuntime.getLayoutTargets()
    : [];
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
  const result = await transferDesignNodeCached(workspaceId, {
    frame: frame.file,
    sourceVersion: sourceRuntime?.sourceVersion ?? frame.sourceVersion,
    nodeId: details.oid,
    ...(destination && drop
      ? {
          destinationFrame: destination.file,
          destinationSourceVersion:
            targetRuntime?.sourceVersion ?? destination.sourceVersion,
          parentId: drop.parentId,
          beforeId: drop.beforeId,
          styles: drop.styles,
        }
      : {}),
    x: Math.round(origin.x),
    y: Math.round(origin.y),
    w: Math.max(1, Math.round(details.rect.width)),
    h: Math.max(1, Math.round(details.rect.height)),
    z: Math.max(0, ...input.frames.map((candidate) => candidate.z + 1)),
  });
  const nextFrame = result.snapshot.frames.find(
    (candidate) => candidate.file === result.frame,
  );
  if (nextFrame) {
    const current = designWorkspaceView(workspaceId);
    const followsTransfer =
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
          { frameSelected: !destination },
        );
    // Selecting the destination makes it a live-frame priority. Its old
    // document cannot inspect the newly transferred node; wait for presentation.
    await input.presented?.(nextFrame);
    const selected = designWorkspaceView(workspaceId);
    if (
      !followsTransfer ||
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
      });
    else await selectDesignFrame(workspaceId, nextFrame, { selected: true });
  }
  return true;
}
