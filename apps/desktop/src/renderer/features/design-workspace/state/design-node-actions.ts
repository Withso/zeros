import type { DesignOperation } from "@zeros/design-core";
import { designFrameRuntime } from "../../../platform/bridge/design-frame-runtime";
import { designLayerTopLevelSelectionIds } from "../design-layer-tree";
import { designFrameViews, isPreparedDesignFrame } from "./design-frame-view";
import { useDesignRuntimeStore } from "./design-runtime-store";
import { selectDesignFrame, selectDesignNodes } from "./design-selection";
import { applyDesignEditCached, designWorkspaceSnapshotCache } from "./design-workspace-cache";
import { captureDesignPageOwner, designWorkspaceView, isCurrentDesignPageOwner, useDesignWorkspaceUiStore } from "./design-workspace-ui";

interface NodeCommandLane {
  pending: number;
  latest: number;
  copy?: { intent: number; frame: string; selectionEvent: number | undefined; nodeIds: string[]; owner: ReturnType<typeof captureDesignPageOwner> };
}
const commands = new Map<string, NodeCommandLane>();
let sequence = 0;

/** Keyboard actions resolve semantic identity at the input boundary. React's
 * last painted frame may still be the source of a just-completed transfer. */
export async function applyDesignNodeAction(input: {
  workspaceId: string;
  folder: string;
  action: "duplicate" | "delete";
  copy?: boolean;
}): Promise<void> {
  const { workspaceId, folder, action } = input;
  const selection = designWorkspaceView(workspaceId);
  const frame = designFrameViews(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data)
    .find(candidate => candidate.file === selection.selectedFrame);
  if (!frame || !isPreparedDesignFrame(frame) || !selection.selectedNodeIds.length) return;
  const lane: NodeCommandLane = commands.get(workspaceId) ?? { pending: 0, latest: 0 };
  const tree = useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[frame.file]?.snapshot?.tree ?? [];
  const pendingCopy = action === "delete" && lane.copy?.frame === frame.file && lane.copy.selectionEvent === selection.selectionEvent &&
    isCurrentDesignPageOwner(lane.copy.owner) ? lane.copy : undefined;
  const nodeIds = pendingCopy?.nodeIds ?? designLayerTopLevelSelectionIds(tree, selection.selectedNodeIds);
  if (!nodeIds.length) return;
  const owner = captureDesignPageOwner(workspaceId);
  if (lane.pending >= 256 || (!commands.has(workspaceId) && commands.size >= 32))
    throw new Error("The pending edits are full. Let the current saves finish before adding more.");
  const intent = ++sequence;
  lane.latest = intent;
  lane.pending++;
  commands.set(workspaceId, lane);
  const duplicateNodeIds = action === "duplicate" ? nodeIds.map(id => `${id.slice(0, 210)}-copy-${crypto.randomUUID()}`) : [];
  // Until selection follows the saved copy, Delete still belongs to the copy
  // intent. Never delete the original merely because persistence is pending.
  lane.copy = action === "duplicate" ? { intent, frame: frame.file, selectionEvent: selection.selectionEvent, nodeIds: duplicateNodeIds, owner } : undefined;
  const operations: DesignOperation[] = nodeIds.map((nodeId, index) => action === "duplicate"
    ? { operationId: crypto.randomUUID(), type: "node.duplicate", nodeId, duplicateNodeId: duplicateNodeIds[index]! }
    : { operationId: crypto.randomUUID(), type: "node.delete", nodeId });
  // Retire deleted targets immediately. Another Delete cannot submit the same
  // vanished identity while persistence or runtime adoption is still pending.
  if (action === "delete") useDesignWorkspaceUiStore.getState().setSelection(workspaceId, frame.file, null, undefined, { owner });
  const event = designWorkspaceView(workspaceId).selectionEvent;
  const follows = () => lane.latest === intent && isCurrentDesignPageOwner(owner) &&
    designWorkspaceView(workspaceId).selectionEvent === event && designWorkspaceView(workspaceId).selectedFrame === frame.file;
  const transactionId = `desktop:${crypto.randomUUID()}`;
  const runtime = designFrameRuntime(workspaceId, frame.file);
  const canPreview = runtime?.sourceVersion === frame.sourceVersion && runtime.isActive?.() !== false &&
    runtime.supports("commitStructure") && runtime.supports("previewStructure") && runtime.supports("clearPreviewStructure") && runtime.previewStructure;
  // Dispatch paint before reserving persistence, but never await it outside
  // the mutation lane. The exact port orders it before generation adoption.
  const preview = canPreview ? runtime.previewStructure!({ previewId: transactionId,
    operations: nodeIds.map((nodeId, index) => action === "duplicate" ? { type: "duplicate", nodeId, duplicateNodeId: duplicateNodeIds[index]! } : { type: "delete", nodeId }),
  }).catch(() => null) : null;
  try {
    // Reserve the existing ordered mutation lane before any Foundation read.
    // Repeated commands queue here instead of disappearing behind a busy flag.
    const result = await applyDesignEditCached(workspaceId, frame, {
      schemaVersion: 1, transactionId, actor: { kind: "human", id: "desktop" },
      intent: `${action === "delete" ? "Delete" : input.copy ? "Copy" : "Duplicate"} ${nodeIds.length} selected ${nodeIds.length === 1 ? "layer" : "layers"}`,
      createdAt: Date.now(), operations,
    }, undefined, canPreview ? { structurePreviewId: transactionId } : undefined);
    if (!follows()) return;
    const current = result.snapshot?.frames.find(candidate => candidate.file === frame.file) ?? frame;
    if (action === "duplicate") void selectDesignNodes({ workspaceId, folder, frame: current, nodeIds: duplicateNodeIds, owner }).catch(() => {});
    else void selectDesignFrame(workspaceId, current, { owner }).catch(() => {});
  } catch (error) {
    if (action === "delete" && follows()) void selectDesignNodes({ workspaceId, folder, frame, nodeIds, owner }).catch(() => {});
    throw error;
  } finally {
    // Named cleanup cannot remove a newer gesture's preview. The originating
    // port owns cleanup even if this frame is now mounted somewhere else.
    if (preview) void preview.then(() => runtime?.clearPreviewStructure?.(transactionId)).catch(() => {});
    lane.pending--;
    if (!lane.pending && commands.get(workspaceId) === lane) commands.delete(workspaceId);
  }
}
