import type { DesignOperation } from "@zeros/design-core";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import { designFrameRuntime } from "../../../platform/bridge/design-frame-runtime";
import { designLayerTopLevelSelectionIds } from "../design-layer-tree";
import { designFrameViews, isPreparedDesignFrame } from "./design-frame-view";
import { DesignComponentPartWriteError, isDesignComponentPartNodeId } from "./design-component-parts";
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

/** The last duplicate per workspace: its copies and where their originals
 * stood, so duplicating a moved copy again repeats that move (Figma). */
const duplicates = new Map<string, {
  frame: string;
  owner: ReturnType<typeof captureDesignPageOwner>;
  copies: readonly string[];
  sourcesAt: readonly ({ x: number; y: number } | null)[];
}>();

/** A free layer's next copy steps by the offset its copy moved from the
 * original; an unmoved or in-flow copy duplicates in place. */
export function designRepeatedDuplicatePlacement(
  sourceAt: { x: number; y: number } | null,
  copy: DesignRuntimeNodeDetails | undefined,
): Record<string, string> | null {
  if (!sourceAt || !copy?.layout || copy.styles.position !== "absolute") return null;
  const dx = Math.round(copy.layout.x - sourceAt.x), dy = Math.round(copy.layout.y - sourceAt.y);
  const left = Number.parseFloat(copy.styles.left ?? ""), top = Number.parseFloat(copy.styles.top ?? "");
  if ((!dx && !dy) || !Number.isFinite(left) || !Number.isFinite(top) ||
    !/px$/.test(copy.styles.left ?? "") || !/px$/.test(copy.styles.top ?? "")) return null;
  return { left: `${Math.round(left + dx)}px`, top: `${Math.round(top + dy)}px`, right: "auto", bottom: "auto" };
}

/** A deletion a person is asked to confirm: the layers it would delete and
 * everything that must still stand for Delete to mean them. */
export interface DesignPendingDeletion {
  owner: ReturnType<typeof captureDesignPageOwner>;
  frame: string;
  sourceVersion: string;
  selectionEvent: number | undefined;
  nodeIds: readonly string[];
}

/** The current selection's deletion, captured when a person is asked. */
export function captureDesignPendingDeletion(workspaceId: string): DesignPendingDeletion | null {
  const selection = designWorkspaceView(workspaceId);
  const frame = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.frames.find(candidate => candidate.file === selection.selectedFrame);
  if (!frame || typeof frame.sourceVersion !== "string" || !selection.selectedNodeIds.length) return null;
  return { owner: captureDesignPageOwner(workspaceId), frame: frame.file, sourceVersion: frame.sourceVersion,
    selectionEvent: selection.selectionEvent, nodeIds: [...selection.selectedNodeIds] };
}

/** A pending deletion a canvas showing `workspaceId` may confirm: asked in
 * that workspace, and still current there. */
export function designPendingDeletionFor(pending: DesignPendingDeletion, workspaceId: string | null | undefined): boolean {
  return !!workspaceId && pending.owner.workspaceId === workspaceId && designPendingDeletionCurrent(pending);
}

/** Whether the owner, frame, generation and selection a pending deletion
 * was asked about all still stand. */
export function designPendingDeletionCurrent(pending: DesignPendingDeletion): boolean {
  const { workspaceId } = pending.owner;
  const selection = designWorkspaceView(workspaceId);
  const frame = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.frames.find(candidate => candidate.file === pending.frame);
  return isCurrentDesignPageOwner(pending.owner) && selection.selectedFrame === pending.frame && frame?.sourceVersion === pending.sourceVersion &&
    selection.selectionEvent === pending.selectionEvent && selection.selectedNodeIds.length === pending.nodeIds.length &&
    selection.selectedNodeIds.every((nodeId, index) => nodeId === pending.nodeIds[index]);
}

/** Keyboard actions resolve semantic identity at the input boundary. React's
 * last painted frame may still be the source of a just-completed transfer. */
export async function applyDesignNodeAction(input: {
  workspaceId: string;
  folder: string;
  action: "duplicate" | "delete";
  copy?: boolean;
  /** A confirmed deletion: it deletes exactly these layers, or nothing once
   * anything it was asked about changed. */
  expect?: DesignPendingDeletion;
}): Promise<void> {
  const { workspaceId, folder, action } = input;
  if (input.expect && !designPendingDeletionFor(input.expect, workspaceId)) return;
  const selection = designWorkspaceView(workspaceId);
  // Before any preview: an instance's part is read only.
  if (selection.selectedNodeIds.some(isDesignComponentPartNodeId)) throw new DesignComponentPartWriteError();
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
  // Duplicating the copies just made, after moving them, repeats the move.
  const known = useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[frame.file]?.detailsByNode;
  const fresh = (nodeId: string) => known?.[nodeId]?.sourceVersion === frame.sourceVersion ? known[nodeId] : undefined;
  const last = duplicates.get(workspaceId);
  const repeating = action === "duplicate" && last?.frame === frame.file && isCurrentDesignPageOwner(last.owner) &&
    last.copies.length === nodeIds.length && last.copies.every((id, index) => id === nodeIds[index]);
  const placements = new Map<string, Record<string, string>>();
  if (repeating) nodeIds.forEach((nodeId, index) => {
    const styles = designRepeatedDuplicatePlacement(last.sourcesAt[index] ?? null, fresh(nodeId));
    if (styles) placements.set(duplicateNodeIds[index]!, styles);
  });
  for (const [nodeId, styles] of placements) operations.push({ operationId: crypto.randomUUID(), type: "node.set-styles", nodeId, styles,
    scope: "inline", responsiveContext: "base", stateContext: "default" });
  if (action === "duplicate" && !duplicates.has(workspaceId) && duplicates.size >= 32) duplicates.delete(duplicates.keys().next().value!);
  if (action === "duplicate") duplicates.set(workspaceId, { frame: frame.file, owner, copies: duplicateNodeIds,
    sourcesAt: nodeIds.map(nodeId => { const layout = fresh(nodeId)?.layout; return layout ? { x: layout.x, y: layout.y } : null; }) });
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
  // The copy paints at its repeated offset at once, not after the save.
  const placed = preview && placements.size ? preview.then(painted => painted && Promise.all([...placements].map(([nodeId, styles]) =>
    runtime!.previewStyles(nodeId, styles).catch(() => null)))) : null;
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
    if (placed) void placed.then(() => Promise.all([...placements.keys()].map(nodeId => runtime!.clearPreviewStyles(nodeId)))).catch(() => {});
    if (preview) void preview.then(() => runtime?.clearPreviewStructure?.(transactionId)).catch(() => {});
    lane.pending--;
    if (!lane.pending && commands.get(workspaceId) === lane) commands.delete(workspaceId);
  }
}
