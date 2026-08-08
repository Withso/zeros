// ──────────────────────────────────────────────────────────
// Live design selection workflows
// ──────────────────────────────────────────────────────────
//
// Canvas, Layers, inspector, and future design integrations converge here. Visible
// frame+node identity is one atomic workspace-store update; async runtime
// readback uses a per-workspace generation so A → B races cannot republish A
// after the user has already selected B.

import type {
  DesignRuntimeNodeDetails,
  DesignRuntimeHitMode,
  DesignRuntimeMotionPreview,
  DesignRuntimeScreenshot,
  DesignRuntimeSnapshot,
  DesignRuntimeTreeNode,
} from "@zeros/protocol/design-runtime";
import { DESIGN_SELECTION_NODE_LIMIT } from "@zeros/protocol/design-runtime";
import type { DesignStyleProvenance } from "@zeros/design-web";

import {
  designSetScreenshot,
  designSetSelection,
  designSetRuntimeAudit,
  designProvenance,
  type DesignCanvasFrameWire,
} from "../../../platform/git";
import { designFrameRuntime } from "../../../platform/bridge/design-frame-runtime";
import {
  designRuntimeFrameState,
  useDesignRuntimeStore,
} from "./design-runtime-store";
import {
  clearDesignLivePreview,
  publishDesignLivePreviewStyles,
} from "./design-live-preview";
import {
  designWorkspaceView,
  isValidDesignNodeId,
  useDesignWorkspaceUiStore,
} from "./design-workspace-ui";

const selectionGenerationByWorkspace = new Map<string, number>();
const hoverGenerationByWorkspace = new Map<string, number>();
const runtimeAuditFingerprintByFrame = new Map<string, string>();
const MAX_PERSISTED_KEY_STYLES = 64;
const PERSISTED_KEY_STYLE_PRIORITY = [
  "position",
  "left",
  "top",
  "right",
  "bottom",
  "width",
  "height",
  "minWidth",
  "minHeight",
  "maxWidth",
  "maxHeight",
  "boxSizing",
  "zIndex",
  "display",
  "visibility",
  "overflow",
  "flexDirection",
  "flexWrap",
  "flexGrow",
  "flexShrink",
  "flexBasis",
  "order",
  "gap",
  "rowGap",
  "columnGap",
  "alignItems",
  "alignSelf",
  "alignContent",
  "justifyContent",
  "justifyItems",
  "justifySelf",
  "gridTemplateColumns",
  "gridTemplateRows",
  "gridAutoFlow",
  "gridColumn",
  "gridRow",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "backgroundColor",
  "backgroundImage",
  "backgroundPosition",
  "backgroundSize",
  "backgroundRepeat",
  "borderWidth",
  "borderStyle",
  "borderColor",
  "borderRadius",
  "color",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "textAlign",
  "opacity",
  "boxShadow",
  "transform",
  "animationName",
] as const;
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

function frameSelection(frame: DesignCanvasFrameWire) {
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

/** Selection is persisted across the engine trust boundary, whose compact
 * context contract is intentionally capped at 64 properties. The inspector
 * keeps the complete runtime details locally; this projection only chooses a
 * stable, useful summary for integrations and session restoration. */
function persistedKeyStyles(styles: Record<string, string>) {
  const projected: Record<string, string> = {};
  let count = 0;
  for (const property of PERSISTED_KEY_STYLE_PRIORITY) {
    if (count >= MAX_PERSISTED_KEY_STYLES) break;
    const value = styles[property];
    if (value === undefined) continue;
    projected[property] = value;
    count += 1;
  }
  for (const [property, value] of Object.entries(styles)) {
    if (count >= MAX_PERSISTED_KEY_STYLES) break;
    if (Object.hasOwn(projected, property)) continue;
    projected[property] = value;
    count += 1;
  }
  return projected;
}

function elementSelection(
  frame: DesignCanvasFrameWire,
  details: DesignRuntimeNodeDetails,
) {
  return {
    frame: frame.file,
    sourceVersion: frame.sourceVersion,
    updatedAt: Date.now(),
    nodeIds: [details.oid],
    breadcrumb: details.breadcrumb,
    rects: [details.rect],
    keyComputedStyles: persistedKeyStyles(details.styles),
  };
}

function multiElementSelection(
  frame: DesignCanvasFrameWire,
  details: readonly DesignRuntimeNodeDetails[],
) {
  const primary = details[0]!;
  const keyComputedStyles = persistedKeyStyles(primary.styles);
  for (const property of Object.keys(keyComputedStyles)) {
    if (
      details.some(
        (candidate) => candidate.styles[property] !== primary.styles[property],
      )
    ) {
      delete keyComputedStyles[property];
    }
  }
  return {
    frame: frame.file,
    sourceVersion: frame.sourceVersion,
    updatedAt: Date.now(),
    nodeIds: details.map((candidate) => candidate.oid),
    breadcrumb: primary.breadcrumb,
    rects: details.map((candidate) => candidate.rect),
    keyComputedStyles,
  };
}

function screenshotBase64(screenshot: DesignRuntimeScreenshot): string | null {
  const match = /^data:[^;]+;base64,([A-Za-z0-9+/]+={0,2})$/.exec(
    screenshot.dataUrl,
  );
  return match?.[1] ?? null;
}

/** Capture real rendered pixels once and share the same immutable image with
 * future design integrations and screenshot tooling. */
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
  frame: DesignCanvasFrameWire | null,
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
  frame: DesignCanvasFrameWire;
  nodeId: string;
  details?: DesignRuntimeNodeDetails;
  /** Runtime revisions can change computed values without changing source. */
  forceRuntimeRead?: boolean;
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
    current.selectedNodeId !== nodeId ||
    current.selectedNodeIds.length !== 1 ||
    current.selectedNodeIds[0] !== nodeId
  ) {
    useDesignWorkspaceUiStore
      .getState()
      .setSelection(workspaceId, frame.file, nodeId);
  }

  const cachedCandidate = designRuntimeFrameState(workspaceId, frame.file)
    ?.detailsByNode[nodeId];
  const cached =
    !input.forceRuntimeRead &&
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
  clearDesignLivePreview(workspaceId, frame.file, nodeId);
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

/** Publish a primary-first additive selection as one renderer+engine state
 * transition. A valid requested primary is retained when the group exceeds the
 * shared limit; overflow is removed from the tail of the remaining members.
 * Runtime reads resolve in parallel and the existing generation guard prevents
 * an older group from replacing a newer click. */
export async function selectDesignNodes(input: {
  workspaceId: string;
  folder: string;
  frame: DesignCanvasFrameWire;
  nodeIds: readonly string[];
  primaryNodeId?: string;
  details?: readonly DesignRuntimeNodeDetails[];
  /** Runtime revisions can change computed values without changing source. */
  forceRuntimeRead?: boolean;
}): Promise<DesignRuntimeNodeDetails[] | null> {
  const unique = [...new Set(input.nodeIds.filter(isValidDesignNodeId))];
  const primary =
    (input.primaryNodeId && unique.includes(input.primaryNodeId)
      ? input.primaryNodeId
      : unique[0]) ?? null;
  if (!primary) {
    await selectDesignFrame(input.workspaceId, input.frame);
    return [];
  }
  const nodeIds = [
    primary,
    ...unique
      .filter((nodeId) => nodeId !== primary)
      .slice(0, DESIGN_SELECTION_NODE_LIMIT - 1),
  ];
  const generation = nextGeneration(
    selectionGenerationByWorkspace,
    input.workspaceId,
  );
  const version = nextSelectionVersion();
  useDesignWorkspaceUiStore
    .getState()
    .setSelection(input.workspaceId, input.frame.file, primary, nodeIds);

  const supplied = new Map(
    input.details?.map((details) => [details.oid, details]) ?? [],
  );
  const runtime = designFrameRuntime(input.workspaceId, input.frame.file);
  const cached = designRuntimeFrameState(
    input.workspaceId,
    input.frame.file,
  )?.detailsByNode;
  const resolved = await Promise.all(
    nodeIds.map(async (nodeId) => {
      const candidate =
        supplied.get(nodeId) ??
        (!input.forceRuntimeRead ? cached?.[nodeId] : undefined);
      if (candidate?.sourceVersion === input.frame.sourceVersion) {
        return candidate;
      }
      if (!runtime) return null;
      try {
        return await runtime.getNodeDetails(nodeId);
      } catch {
        return null;
      }
    }),
  );
  const current = designWorkspaceView(input.workspaceId);
  if (
    selectionGenerationByWorkspace.get(input.workspaceId) !== generation ||
    current.selectedFrame !== input.frame.file ||
    current.selectedNodeId !== primary ||
    current.selectedNodeIds.join("\u0000") !== nodeIds.join("\u0000") ||
    resolved.some(
      (details) =>
        !details || details.sourceVersion !== input.frame.sourceVersion,
    )
  ) {
    return null;
  }
  const details = resolved as DesignRuntimeNodeDetails[];
  for (const candidate of details) {
    useDesignRuntimeStore
      .getState()
      .publishNodeDetails(
        input.workspaceId,
        input.folder,
        input.frame.file,
        candidate,
        input.frame.sourceVersion,
      );
    clearDesignLivePreview(input.workspaceId, input.frame.file, candidate.oid);
  }
  await designSetSelection(
    input.workspaceId,
    multiElementSelection(input.frame, details),
    version,
  );
  if (selectionGenerationByWorkspace.get(input.workspaceId) !== generation) {
    return null;
  }
  void captureDesignRuntimeScreenshot(
    input.workspaceId,
    input.folder,
    input.frame.file,
    input.frame.sourceVersion,
    primary,
    1,
  ).catch(() => {});
  return details;
}

export async function toggleDesignNodeSelection(input: {
  workspaceId: string;
  folder: string;
  frame: DesignCanvasFrameWire;
  nodeId: string;
  details?: DesignRuntimeNodeDetails;
}): Promise<DesignRuntimeNodeDetails[] | null> {
  const current = designWorkspaceView(input.workspaceId);
  const existing =
    current.selectedFrame === input.frame.file ? current.selectedNodeIds : [];
  const wasSelected = existing.includes(input.nodeId);
  const nextIds = wasSelected
    ? existing.filter((nodeId) => nodeId !== input.nodeId)
    : [...existing, input.nodeId];
  if (nextIds.length === 0) {
    await selectDesignFrame(input.workspaceId, input.frame);
    return [];
  }
  const primary = wasSelected
    ? current.selectedNodeId && nextIds.includes(current.selectedNodeId)
      ? current.selectedNodeId
      : nextIds[0]
    : input.nodeId;
  return selectDesignNodes({
    workspaceId: input.workspaceId,
    folder: input.folder,
    frame: input.frame,
    nodeIds: nextIds,
    primaryNodeId: primary,
    ...(input.details ? { details: [input.details] } : {}),
  });
}

export async function selectDesignNodeAtLocation(input: {
  workspaceId: string;
  folder: string;
  frame: DesignCanvasFrameWire;
  x: number;
  y: number;
  mode?: DesignRuntimeHitMode;
  selectedNodeId?: string | null;
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
  const details = await runtime.getElementAtLoc(input.x, input.y, {
    mode: input.mode,
    selectedNodeId: input.selectedNodeId,
  });
  if (selectionGenerationByWorkspace.get(input.workspaceId) !== generation) {
    return null;
  }
  if (!details) {
    await selectDesignFrame(input.workspaceId, input.frame);
    return null;
  }
  return selectDesignNode({ ...input, nodeId: details.oid, details });
}

/** Read the deepest hit for context-stack tooling without mutating selection. */
export async function inspectDesignNodeAtLocation(input: {
  workspaceId: string;
  frame: DesignCanvasFrameWire;
  x: number;
  y: number;
  mode?: DesignRuntimeHitMode;
  selectedNodeId?: string | null;
}): Promise<DesignRuntimeNodeDetails | null> {
  const runtime = designFrameRuntime(input.workspaceId, input.frame.file);
  if (!runtime) return null;
  const details = await runtime.getElementAtLoc(input.x, input.y, {
    mode: input.mode ?? "deepest",
    selectedNodeId: input.selectedNodeId,
  });
  return details?.sourceVersion === input.frame.sourceVersion ? details : null;
}

export async function inspectDesignNode(input: {
  workspaceId: string;
  frame: DesignCanvasFrameWire;
  nodeId: string;
}): Promise<DesignRuntimeNodeDetails | null> {
  const runtime = designFrameRuntime(input.workspaceId, input.frame.file);
  if (!runtime) return null;
  const details = await runtime.getNodeDetails(input.nodeId);
  return details.sourceVersion === input.frame.sourceVersion ? details : null;
}

export async function inspectDesignNodesInRect(input: {
  workspaceId: string;
  frame: DesignCanvasFrameWire;
  rect: { x: number; y: number; width: number; height: number };
  scopeNodeId?: string | null;
}): Promise<DesignRuntimeNodeDetails[]> {
  const runtime = designFrameRuntime(input.workspaceId, input.frame.file);
  if (!runtime) return [];
  const details = await runtime.getElementsInRect(
    input.rect,
    input.scopeNodeId,
  );
  return details.filter(
    (candidate) => candidate.sourceVersion === input.frame.sourceVersion,
  );
}

/** Resolve canvas hover through the same opaque runtime without changing the
 * durable selection. Newer pointer samples invalidate older async readback. */
export async function hoverDesignNodeAtLocation(input: {
  workspaceId: string;
  folder: string;
  frame: DesignCanvasFrameWire;
  x: number;
  y: number;
}): Promise<void> {
  const generation = nextGeneration(
    hoverGenerationByWorkspace,
    input.workspaceId,
  );
  const runtime = designFrameRuntime(input.workspaceId, input.frame.file);
  if (!runtime) return;
  let details: DesignRuntimeNodeDetails | null = null;
  try {
    details = await runtime.getElementAtLoc(input.x, input.y, {
      mode: "deepest",
    });
  } catch {
    return;
  }
  if (hoverGenerationByWorkspace.get(input.workspaceId) !== generation) return;
  useDesignRuntimeStore
    .getState()
    .setHoveredNode(
      input.workspaceId,
      details ? input.frame.file : null,
      details?.oid ?? null,
    );
  if (!details || details.sourceVersion !== input.frame.sourceVersion) return;
  useDesignRuntimeStore
    .getState()
    .publishNodeDetails(
      input.workspaceId,
      input.folder,
      input.frame.file,
      details,
      input.frame.sourceVersion,
    );
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

/** Gesture-only preview. It intentionally avoids Zustand publication so raw
 * pointer movement cannot rerender Layers/inspector; the canvas paints its one
 * overlay directly and publishes only the committed transaction. */
export async function previewDesignNodeStylesTransient(input: {
  workspaceId: string;
  frame: string;
  sourceVersion: string;
  nodeId: string;
  styles: Record<string, string | null>;
}): Promise<DesignRuntimeNodeDetails> {
  const runtime = designFrameRuntime(input.workspaceId, input.frame);
  if (!runtime) throw new Error("The design frame is not ready.");
  const publication = publishDesignLivePreviewStyles(
    input.workspaceId,
    input.frame,
    input.nodeId,
    input.styles,
  );
  try {
    const details = await runtime.previewStyles(input.nodeId, input.styles);
    if (details.sourceVersion !== input.sourceVersion) {
      throw new Error(
        "The design frame changed before the preview was applied.",
      );
    }
    return details;
  } catch (error) {
    clearDesignLivePreview(
      input.workspaceId,
      input.frame,
      input.nodeId,
      publication,
    );
    throw error;
  }
}

export async function previewDesignNodeMotionTransient(input: {
  workspaceId: string;
  frame: string;
  sourceVersion: string;
  nodeId: string;
  motion: DesignRuntimeMotionPreview;
}): Promise<DesignRuntimeNodeDetails> {
  const runtime = designFrameRuntime(input.workspaceId, input.frame);
  if (!runtime) throw new Error("The design frame is not ready.");
  const details = await runtime.previewMotion(input.nodeId, input.motion);
  if (details.sourceVersion !== input.sourceVersion) {
    throw new Error("The design frame changed before motion was previewed.");
  }
  return details;
}

export async function clearDesignNodeStylePreviewTransient(input: {
  workspaceId: string;
  frame: string;
  sourceVersion: string;
  nodeId: string;
}): Promise<DesignRuntimeNodeDetails> {
  clearDesignLivePreview(input.workspaceId, input.frame, input.nodeId);
  const runtime = designFrameRuntime(input.workspaceId, input.frame);
  if (!runtime) throw new Error("The design frame is not ready.");
  const details = await runtime.clearPreviewStyles(input.nodeId);
  if (details.sourceVersion !== input.sourceVersion) {
    throw new Error("The design frame changed before the preview was cleared.");
  }
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

/** Correlate browser-observed matched rules with exact authored source. CSSOM
 * does not expose a trustworthy cascade winner, so the source adapter keeps
 * ambiguity explicit instead of guessing from enumeration order. */
export async function inspectDesignNodeStyleProvenance(input: {
  workspaceId: string;
  frame: string;
  sourceVersion: string;
  expectedRevision: string;
  nodeId: string;
  property: string;
  computedValue?: string | null;
  signal?: AbortSignal;
}): Promise<DesignStyleProvenance> {
  const runtime = designFrameRuntime(input.workspaceId, input.frame);
  const runtimeStyles = runtime
    ? await runtime.getMatchedStyles(input.nodeId, input.property, input.signal)
    : null;
  if (runtimeStyles && runtimeStyles.sourceVersion !== input.sourceVersion) {
    throw new Error("The design frame changed before provenance was resolved.");
  }
  if (input.signal?.aborted) {
    throw input.signal.reason ?? new Error("Provenance inspection cancelled.");
  }
  return designProvenance(input.workspaceId, {
    frame: input.frame,
    nodeId: input.nodeId,
    property: runtimeStyles?.property ?? input.property,
    expectedRevision: input.expectedRevision,
    computedValue: runtimeStyles?.computedValue ?? input.computedValue ?? null,
    ...(runtimeStyles ? { matched: runtimeStyles.matched } : {}),
  });
}

/** Apply one authoritative runtime tree without clearing same-key readback.
 * A remembered node is invalid only after this exact frame snapshot proves it
 * absent; surviving selections are re-read so geometry/styles follow mutations. */
export function reconcileDesignRuntimeSnapshot(input: {
  workspaceId: string;
  folder: string;
  frame: DesignCanvasFrameWire;
  snapshot: DesignRuntimeSnapshot;
}): void {
  const { workspaceId, folder, frame, snapshot } = input;
  if (snapshot.sourceVersion !== frame.sourceVersion) return;
  const previousRuntimeRevision = designRuntimeFrameState(
    workspaceId,
    frame.file,
  )?.snapshot?.revision;
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
    const survivingNodeIds = view.selectedNodeIds.filter(
      (candidate) =>
        candidate === snapshot.frame.oid ||
        treeContainsOid(snapshot.tree, candidate),
    );
    if (survivingNodeIds.length > 1) {
      void selectDesignNodes({
        workspaceId,
        folder,
        frame,
        nodeIds: survivingNodeIds,
        primaryNodeId: nodeId,
        ...(nodeId === snapshot.frame.oid ? { details: [snapshot.frame] } : {}),
        forceRuntimeRead: previousRuntimeRevision !== snapshot.revision,
      }).catch(() => {
        // Last confirmed exact-key group remains visible during revalidation.
      });
      return;
    }
    void selectDesignNode({
      workspaceId,
      folder,
      frame,
      nodeId,
      ...(nodeId === snapshot.frame.oid ? { details: snapshot.frame } : {}),
      forceRuntimeRead: previousRuntimeRevision !== snapshot.revision,
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
