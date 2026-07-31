// ──────────────────────────────────────────────────────────
// Live design selection workflows
// ──────────────────────────────────────────────────────────
//
// Canvas, Layers, inspector, composer, and MCP all converge here. Visible
// frame+node identity is one atomic workspace-store update; async runtime
// readback uses a per-workspace generation so A → B races cannot republish A
// after the user has already selected B.

import type {
  DesignRuntimeNodeDetails,
  DesignRuntimeScreenshot,
  DesignRuntimeSnapshot,
  DesignRuntimeTreeNode,
} from "@zeros/core/design-runtime";

import {
  designSetScreenshot,
  designSetSelection,
  designSetRuntimeAudit,
  type DesignFrameDocumentWire,
} from "../../native/git";
import { designFrameRuntime } from "../bridge/design-frame-runtime";
import {
  designRuntimeFrameState,
  useDesignRuntimeStore,
} from "./design-runtime-store";
import {
  designWorkspaceView,
  useDesignWorkspaceUiStore,
} from "./design-workspace-ui";

const selectionGenerationByWorkspace = new Map<string, number>();
const hoverGenerationByWorkspace = new Map<string, number>();
const runtimeAuditFingerprintByFrame = new Map<string, string>();
let selectionVersion = 0;

function nextGeneration(map: Map<string, number>, workspaceId: string): number {
  const generation = (map.get(workspaceId) ?? 0) + 1;
  map.set(workspaceId, generation);
  return generation;
}

/** Monotonic across concurrent bridge requests and newer than a renderer
 * reload's prior values under the shared desktop clock. */
function nextSelectionVersion(): number {
  selectionVersion = Math.max(selectionVersion + 1, Date.now() * 1_024);
  return selectionVersion;
}

function treeContainsOid(
  nodes: readonly DesignRuntimeTreeNode[],
  oid: string,
): boolean {
  for (const node of nodes) {
    if (node.oid === oid || treeContainsOid(node.children, oid)) return true;
  }
  return false;
}

function selectionIsCurrent(
  workspaceId: string,
  frame: string,
  nodeId: string | null,
  generation: number,
): boolean {
  const view = designWorkspaceView(workspaceId);
  return (
    selectionGenerationByWorkspace.get(workspaceId) === generation &&
    view.selectedFrame === frame &&
    view.selectedNodeId === nodeId
  );
}

function frameSelection(frame: DesignFrameDocumentWire) {
  return {
    frame: frame.file,
    sourceVersion: frame.sourceVersion,
    updatedAt: Date.now(),
    nodeIds: [],
    breadcrumb: [frame.title],
    rects: [
      {
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
      },
    ],
    keyComputedStyles: {},
  };
}

function elementSelection(
  frame: DesignFrameDocumentWire,
  details: DesignRuntimeNodeDetails,
) {
  return {
    frame: frame.file,
    sourceVersion: frame.sourceVersion,
    updatedAt: Date.now(),
    nodeIds: [details.oid],
    breadcrumb: details.breadcrumb,
    rects: [details.rect],
    keyComputedStyles: details.styles,
  };
}

function screenshotBase64(screenshot: DesignRuntimeScreenshot): string | null {
  const match = /^data:[^;]+;base64,([A-Za-z0-9+/]+={0,2})$/.exec(
    screenshot.dataUrl,
  );
  return match?.[1] ?? null;
}

/** Capture real rendered pixels once and share the same immutable image with
 * composer chips and the engine-held screenshot_frame MCP tool. */
export async function captureDesignRuntimeScreenshot(
  workspaceId: string,
  folder: string,
  frame: string,
  sourceVersion: string,
  nodeId: string | null,
  scale: number,
): Promise<DesignRuntimeScreenshot | null> {
  const runtime = designFrameRuntime(workspaceId, frame);
  if (!runtime) return null;
  const screenshot = await runtime.captureScreenshot(nodeId, scale);
  if (screenshot.sourceVersion !== sourceVersion) return null;
  const data = screenshotBase64(screenshot);
  if (!data) return null;
  const currentFrame = designRuntimeFrameState(workspaceId, frame);
  if (
    currentFrame?.sourceVersion !== undefined &&
    currentFrame.sourceVersion !== sourceVersion
  ) {
    return null;
  }
  const capturedAt = Date.now();
  await designSetScreenshot(workspaceId, {
    frame,
    nodeId,
    mimeType: screenshot.mimeType,
    data,
    width: screenshot.width,
    height: screenshot.height,
    scale: screenshot.scale,
    capturedAt,
    sourceVersion,
  });
  useDesignRuntimeStore
    .getState()
    .publishScreenshot(workspaceId, folder, frame, screenshot, sourceVersion);
  return screenshot;
}

export async function selectDesignFrame(
  workspaceId: string,
  frame: DesignFrameDocumentWire | null,
): Promise<void> {
  nextGeneration(selectionGenerationByWorkspace, workspaceId);
  const version = nextSelectionVersion();
  if (!frame) {
    if (designWorkspaceView(workspaceId).selectedFrame !== null) {
      useDesignWorkspaceUiStore.getState().setSelectedFrame(workspaceId, null);
    }
    await designSetSelection(workspaceId, null, version);
    return;
  }
  const current = designWorkspaceView(workspaceId);
  if (current.selectedFrame !== frame.file || current.selectedNodeId !== null) {
    useDesignWorkspaceUiStore
      .getState()
      .setSelection(workspaceId, frame.file, null);
  }
  await designSetSelection(workspaceId, frameSelection(frame), version);
}

export async function selectDesignNode(input: {
  workspaceId: string;
  folder: string;
  frame: DesignFrameDocumentWire;
  nodeId: string;
  details?: DesignRuntimeNodeDetails;
}): Promise<DesignRuntimeNodeDetails | null> {
  const { workspaceId, folder, frame, nodeId } = input;
  const generation = nextGeneration(
    selectionGenerationByWorkspace,
    workspaceId,
  );
  const version = nextSelectionVersion();
  const current = designWorkspaceView(workspaceId);
  if (
    current.selectedFrame !== frame.file ||
    current.selectedNodeId !== nodeId
  ) {
    useDesignWorkspaceUiStore
      .getState()
      .setSelection(workspaceId, frame.file, nodeId);
  }

  const cachedCandidate = designRuntimeFrameState(workspaceId, frame.file)
    ?.detailsByNode[nodeId];
  const cached =
    cachedCandidate?.sourceVersion === frame.sourceVersion
      ? cachedCandidate
      : undefined;
  const details =
    input.details ??
    cached ??
    (await designFrameRuntime(workspaceId, frame.file)?.getNodeDetails(nodeId));
  if (
    !details ||
    details.sourceVersion !== frame.sourceVersion ||
    !selectionIsCurrent(workspaceId, frame.file, nodeId, generation)
  ) {
    return null;
  }

  useDesignRuntimeStore
    .getState()
    .publishNodeDetails(
      workspaceId,
      folder,
      frame.file,
      details,
      frame.sourceVersion,
    );
  await designSetSelection(
    workspaceId,
    elementSelection(frame, details),
    version,
  );
  if (!selectionIsCurrent(workspaceId, frame.file, nodeId, generation)) {
    return null;
  }
  void captureDesignRuntimeScreenshot(
    workspaceId,
    folder,
    frame.file,
    frame.sourceVersion,
    nodeId,
    1,
  ).catch(() => {
    // Selection and computed readback remain useful when raster capture fails.
  });
  return details;
}

export async function selectDesignNodeAtLocation(input: {
  workspaceId: string;
  folder: string;
  frame: DesignFrameDocumentWire;
  x: number;
  y: number;
}): Promise<DesignRuntimeNodeDetails | null> {
  const runtime = designFrameRuntime(input.workspaceId, input.frame.file);
  if (!runtime) {
    await selectDesignFrame(input.workspaceId, input.frame);
    return null;
  }
  const generation = nextGeneration(
    selectionGenerationByWorkspace,
    input.workspaceId,
  );
  const details = await runtime.getElementAtLoc(input.x, input.y);
  if (selectionGenerationByWorkspace.get(input.workspaceId) !== generation) {
    return null;
  }
  if (!details) {
    await selectDesignFrame(input.workspaceId, input.frame);
    return null;
  }
  return selectDesignNode({ ...input, nodeId: details.oid, details });
}

export async function hoverDesignNode(input: {
  workspaceId: string;
  folder: string;
  frame: string;
  sourceVersion: string;
  nodeId: string | null;
  details?: DesignRuntimeNodeDetails;
}): Promise<void> {
  const { workspaceId, folder, frame, nodeId } = input;
  const generation = nextGeneration(hoverGenerationByWorkspace, workspaceId);
  useDesignRuntimeStore
    .getState()
    .setHoveredNode(workspaceId, nodeId ? frame : null, nodeId);
  if (!nodeId) return;
  const cachedCandidate = designRuntimeFrameState(workspaceId, frame)
    ?.detailsByNode[nodeId];
  const cached =
    cachedCandidate?.sourceVersion === input.sourceVersion
      ? cachedCandidate
      : undefined;
  let details = input.details ?? cached;
  if (!details) {
    const runtime = designFrameRuntime(workspaceId, frame);
    if (!runtime) return;
    try {
      details = await runtime.getNodeDetails(nodeId);
    } catch {
      // Hover is speculative. A source reload or mutation may remove the node
      // between pointer entry and readback; the next hover/runtime event wins.
      return;
    }
  }
  const runtimeWorkspace =
    useDesignRuntimeStore.getState().byWorkspace[workspaceId];
  if (
    !details ||
    details.sourceVersion !== input.sourceVersion ||
    hoverGenerationByWorkspace.get(workspaceId) !== generation ||
    runtimeWorkspace?.hoveredFrame !== frame ||
    runtimeWorkspace.hoveredNodeId !== nodeId
  ) {
    return;
  }
  useDesignRuntimeStore
    .getState()
    .publishNodeDetails(
      workspaceId,
      folder,
      frame,
      details,
      input.sourceVersion,
    );
}

export async function setDesignNodeVisibility(input: {
  workspaceId: string;
  folder: string;
  frame: string;
  sourceVersion: string;
  nodeId: string;
  visible: boolean;
}): Promise<DesignRuntimeNodeDetails> {
  const runtime = designFrameRuntime(input.workspaceId, input.frame);
  if (!runtime) throw new Error("The design frame is not ready.");
  const details = await runtime.setNodeVisibility(input.nodeId, input.visible);
  if (details.sourceVersion !== input.sourceVersion) {
    throw new Error("The design frame changed before visibility was updated.");
  }
  useDesignRuntimeStore
    .getState()
    .publishNodeDetails(
      input.workspaceId,
      input.folder,
      input.frame,
      details,
      input.sourceVersion,
    );
  return details;
}

export async function previewDesignNodeStyles(input: {
  workspaceId: string;
  folder: string;
  frame: string;
  sourceVersion: string;
  nodeId: string;
  styles: Record<string, string | null>;
}): Promise<DesignRuntimeNodeDetails> {
  const runtime = designFrameRuntime(input.workspaceId, input.frame);
  if (!runtime) throw new Error("The design frame is not ready.");
  const details = await runtime.previewStyles(input.nodeId, input.styles);
  if (details.sourceVersion !== input.sourceVersion) {
    throw new Error("The design frame changed before the preview was applied.");
  }
  useDesignRuntimeStore
    .getState()
    .publishNodeDetails(
      input.workspaceId,
      input.folder,
      input.frame,
      details,
      input.sourceVersion,
    );
  return details;
}

export async function clearDesignNodeStylePreview(input: {
  workspaceId: string;
  folder: string;
  frame: string;
  sourceVersion: string;
  nodeId: string;
}): Promise<DesignRuntimeNodeDetails> {
  const runtime = designFrameRuntime(input.workspaceId, input.frame);
  if (!runtime) throw new Error("The design frame is not ready.");
  const details = await runtime.clearPreviewStyles(input.nodeId);
  if (details.sourceVersion !== input.sourceVersion) {
    throw new Error("The design frame changed before the preview was cleared.");
  }
  useDesignRuntimeStore
    .getState()
    .publishNodeDetails(
      input.workspaceId,
      input.folder,
      input.frame,
      details,
      input.sourceVersion,
    );
  return details;
}

/** Apply one authoritative runtime tree without clearing same-key readback.
 * A remembered node is invalid only after this exact frame snapshot proves it
 * absent; surviving selections are re-read so geometry/styles follow mutations. */
export function reconcileDesignRuntimeSnapshot(input: {
  workspaceId: string;
  folder: string;
  frame: DesignFrameDocumentWire;
  snapshot: DesignRuntimeSnapshot;
}): void {
  const { workspaceId, folder, frame, snapshot } = input;
  if (snapshot.sourceVersion !== frame.sourceVersion) return;
  useDesignRuntimeStore
    .getState()
    .publishSnapshot(
      workspaceId,
      folder,
      frame.file,
      snapshot,
      frame.sourceVersion,
    );
  const auditKey = `${workspaceId}\u0000${frame.file}`;
  const auditFingerprint = `${snapshot.sourceVersion}\u0000${JSON.stringify(snapshot.warnings)}`;
  if (runtimeAuditFingerprintByFrame.get(auditKey) !== auditFingerprint) {
    runtimeAuditFingerprintByFrame.delete(auditKey);
    runtimeAuditFingerprintByFrame.set(auditKey, auditFingerprint);
    while (runtimeAuditFingerprintByFrame.size > 256) {
      const oldest = runtimeAuditFingerprintByFrame.keys().next().value as
        | string
        | undefined;
      if (!oldest) break;
      runtimeAuditFingerprintByFrame.delete(oldest);
    }
    void designSetRuntimeAudit(workspaceId, {
      frame: frame.file,
      sourceVersion: frame.sourceVersion,
      warnings: snapshot.warnings,
    }).catch(() => {
      // Keep the attempted exact fingerprint. A deterministic validation
      // failure must not turn every runtime snapshot into another bridge
      // request; a changed source/warning set naturally produces a new key.
    });
  }
  const view = designWorkspaceView(workspaceId);
  if (view.selectedFrame !== frame.file) return;
  const nodeId = view.selectedNodeId;
  if (
    nodeId &&
    nodeId !== snapshot.frame.oid &&
    !treeContainsOid(snapshot.tree, nodeId)
  ) {
    void selectDesignFrame(workspaceId, frame).catch(() => {
      // The local authoritative fallback remains valid if engine publication
      // is briefly unavailable; the next ready event republishes it.
    });
    return;
  }
  if (nodeId) {
    void selectDesignNode({
      workspaceId,
      folder,
      frame,
      nodeId,
      ...(nodeId === snapshot.frame.oid ? { details: snapshot.frame } : {}),
    }).catch(() => {
      // Last confirmed exact-key details remain visible during revalidation.
    });
  }
}

export function resetDesignSelectionWorkflowsForTests(): void {
  selectionGenerationByWorkspace.clear();
  hoverGenerationByWorkspace.clear();
  runtimeAuditFingerprintByFrame.clear();
  selectionVersion = 0;
}
