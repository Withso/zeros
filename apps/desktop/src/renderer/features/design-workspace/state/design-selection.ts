// ──────────────────────────────────────────────────────────
// Live design selection workflows
// ──────────────────────────────────────────────────────────
//
// Canvas, Layers, inspector, and future design integrations converge here. Visible
// frame+node identity is one atomic workspace-store update; async runtime
// readback uses a per-workspace generation so A → B races cannot republish A
// after the user has already selected B.

import { designBackgroundWork } from "./design-background-work";
import type {
  DesignRuntimeNodeDetails,
  DesignRuntimeNodeGeometry,
  DesignRuntimeHitMode,
  DesignRuntimeMotionPreview,
  DesignRuntimeRect,
  DesignRuntimeScreenshot,
  DesignRuntimeSnapshot,
  DesignRuntimeTreeNode,
} from "@zeros/protocol/design-runtime";
import {
  DESIGN_RUNTIME_DOCUMENT_BODY_ID,
  DESIGN_RUNTIME_GEOMETRY_CHILD_LIMIT,
  DESIGN_SELECTION_NODE_LIMIT,
} from "@zeros/protocol/design-runtime";
import type { DesignStyleProvenance } from "@zeros/design-web";

import {
  designSetScreenshot,
  designSetSelection,
  designSetRuntimeAudit,
  designProvenance,
  type DesignCanvasFrameWire,
  type DesignWorkspaceSnapshotWire,
} from "../../../platform/git";
import {
  designFrameRuntime,
  type DesignFrameRuntimeConnection,
} from "../../../platform/bridge/design-frame-runtime";
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
import { requestDesignLayerReveal } from "./design-layer-disclosure";
import {
  resolveDesignFrameBodyTarget,
  type DesignFrameBodyIntent,
} from "../design-layer-tree";

/** Open the Layers path down to a selection in the same transition that
 * publishes it, so a canvas click can never leave its row folded away, and ask
 * the Layers panel to bring that row into view — even when the selection is
 * unchanged, so clicking the same layer again finds it again. The user stays
 * free to collapse those containers afterwards: background re-selection
 * (`reconcileDesignRuntimeSnapshot`) never reveals. Ids a tree does not hold
 * yet open when the Layers panel receives a tree that does. */
function revealDesignSelectionPath(
  workspaceId: string,
  frame: DesignCanvasFrameWire,
  nodeIds: readonly string[],
): void {
  const snapshot = designRuntimeFrameState(workspaceId, frame.file)?.snapshot;
  requestDesignLayerReveal({
    workspaceId,
    frame: frame.file,
    nodeIds,
    tree: snapshot?.tree,
    frameRowNodeId: frame.kind === "text" ? null : snapshot?.frame.oid,
  });
}

const selectionGenerationByWorkspace = new Map<string, number>();
const MAX_SELECTION_DETAIL_OWNERS = 32;
interface DesignSelectionDetailDemand {
  workspaceId: string;
  folder: string;
  directoryId: string | undefined;
  frame: DesignCanvasFrameWire;
  nodeIds: readonly string[];
  generation: number;
  runtime: DesignFrameRuntimeConnection | null;
  runtimeSourceVersion: string | undefined;
  storeSourceVersion: string | undefined;
  controller: AbortController;
  read: Promise<DesignRuntimeNodeDetails[] | null>;
  reconcileQueued: boolean;
  sourceAdvanced: boolean;
  fulfilled: boolean;
}
const selectionDetailDemandByWorkspace = new Map<
  string,
  DesignSelectionDetailDemand
>();
let readSelectionSnapshot: (
  workspaceId: string,
) => DesignWorkspaceSnapshotWire | undefined = () => undefined;

export function setDesignSelectionSnapshotReader(
  reader: typeof readSelectionSnapshot,
): void {
  readSelectionSnapshot = reader;
}

export function notifyDesignSelectionSnapshot(workspaceId: string): void {
  const demand = selectionDetailDemandByWorkspace.get(workspaceId);
  if (demand) {
    scheduleCurrentSelectionDetailDemand(demand);
    return;
  }
  const view = designWorkspaceView(workspaceId);
  const snapshot = readSelectionSnapshot(workspaceId);
  const frame = snapshot?.frames.find(
    (candidate) => candidate.file === view.selectedFrame,
  );
  const workspace = useDesignRuntimeStore.getState().byWorkspace[workspaceId];
  const runtimeFrame = frame ? workspace?.frames[frame.file] : undefined;
  if (
    !frame ||
    !workspace ||
    !runtimeFrame ||
    !view.selectedNodeId ||
    view.selectedNodeIds.length === 0 ||
    (view.directoryId !== undefined &&
      view.directoryId !== snapshot?.directoryId) ||
    designFrameRuntime(workspaceId, frame.file)?.isActive?.() === false ||
    !view.selectedNodeIds.some(
      (nodeId) =>
        runtimeFrame.detailsByNode[nodeId]?.sourceVersion !==
        frame.sourceVersion,
    )
  )
    return;
  void selectDesignNodes({
    workspaceId,
    folder: workspace.folder,
    frame,
    nodeIds: view.selectedNodeIds,
    primaryNodeId: view.selectedNodeId,
    reveal: false,
  }).catch(() => {});
}

function currentDesignSelectionFrame(
  workspaceId: string,
  frame: DesignCanvasFrameWire,
): DesignCanvasFrameWire {
  return (
    readSelectionSnapshot(workspaceId)?.frames.find(
      (candidate) => candidate.file === frame.file,
    ) ?? frame
  );
}
const hoverGenerationByWorkspace = new Map<string, number>();
interface PendingDesignHoverRead {
  input: {
    workspaceId: string;
    folder: string;
    frame: string;
    sourceVersion: string;
    nodeId: string;
  };
  generation: number;
  resolve: () => void;
}
interface DesignHoverReadQueue {
  active: boolean;
  pending: PendingDesignHoverRead | null;
}
const hoverReadQueueByWorkspace = new Map<string, DesignHoverReadQueue>();
const runtimeAuditPublicationByFrame = new Map<
  string,
  { fingerprint: string; result: Promise<boolean> }
>();
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

/** Selection persistence is exact-source optimistic metadata. A local
 * mutation can advance the frame between runtime readback and the engine
 * write; the current local selection remains authoritative and the next
 * exact-generation ready event republishes it. Other failures still surface. */
function selectionPublicationLostSourceRace(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return message.includes(
    "Design selection source changed before publication:",
  );
}

async function publishDurableDesignSelection(
  workspaceId: string,
  selection: Parameters<typeof designSetSelection>[1],
  version: number,
): Promise<void> {
  try {
    await designSetSelection(workspaceId, selection, version);
  } catch (error) {
    if (!selectionPublicationLostSourceRace(error)) throw error;
  }
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

function selectionDetailDemandIsCurrent(
  demand: DesignSelectionDetailDemand,
): boolean {
  const view = designWorkspaceView(demand.workspaceId);
  const snapshot = readSelectionSnapshot(demand.workspaceId);
  const workspace =
    useDesignRuntimeStore.getState().byWorkspace[demand.workspaceId];
  const sourceVersion = workspace?.frames[demand.frame.file]?.sourceVersion;
  return (
    selectionDetailDemandByWorkspace.get(demand.workspaceId) === demand &&
    !demand.controller.signal.aborted &&
    selectionIsCurrent(
      demand.workspaceId,
      demand.frame.file,
      demand.nodeIds[0] ?? null,
      demand.generation,
    ) &&
    (snapshot?.directoryId ?? view.directoryId) === demand.directoryId &&
    (view.directoryId === undefined ||
      view.directoryId === demand.directoryId) &&
    (!snapshot ||
      snapshot.frames.some(
        (frame) =>
          frame.file === demand.frame.file &&
          frame.sourceVersion === demand.frame.sourceVersion,
      )) &&
    view.selectedNodeIds.join("\u0000") === demand.nodeIds.join("\u0000") &&
    (!workspace || workspace.folder === demand.folder) &&
    (sourceVersion === undefined ||
      sourceVersion === demand.frame.sourceVersion) &&
    (!demand.runtime ||
      (designFrameRuntime(demand.workspaceId, demand.frame.file) ===
        demand.runtime &&
        demand.runtime.isActive?.() !== false &&
        (demand.runtime.sourceVersion === undefined ||
          demand.runtime.sourceVersion === demand.frame.sourceVersion)))
  );
}

function clearSelectionDetailDemand(workspaceId: string): void {
  const demand = selectionDetailDemandByWorkspace.get(workspaceId);
  selectionDetailDemandByWorkspace.delete(workspaceId);
  demand?.controller.abort();
}

function requestDesignSelectionDetails(input: {
  workspaceId: string;
  folder: string;
  frame: DesignCanvasFrameWire;
  nodeIds: readonly string[];
  generation: number;
  details?: readonly DesignRuntimeNodeDetails[];
  forceRuntimeRead?: boolean;
  tolerateReadErrors?: boolean;
}): DesignSelectionDetailDemand {
  clearSelectionDetailDemand(input.workspaceId);
  const runtime = designFrameRuntime(input.workspaceId, input.frame.file);
  const demand: DesignSelectionDetailDemand = {
    workspaceId: input.workspaceId,
    folder: input.folder,
    directoryId:
      readSelectionSnapshot(input.workspaceId)?.directoryId ??
      designWorkspaceView(input.workspaceId).directoryId,
    frame: input.frame,
    nodeIds: input.nodeIds,
    generation: input.generation,
    runtime,
    runtimeSourceVersion: runtime?.sourceVersion,
    storeSourceVersion: designRuntimeFrameState(
      input.workspaceId,
      input.frame.file,
    )?.sourceVersion,
    controller: new AbortController(),
    read: Promise.resolve(null),
    reconcileQueued: false,
    sourceAdvanced: false,
    fulfilled: false,
  };
  selectionDetailDemandByWorkspace.set(input.workspaceId, demand);
  while (selectionDetailDemandByWorkspace.size > MAX_SELECTION_DETAIL_OWNERS) {
    const oldest = selectionDetailDemandByWorkspace.keys().next().value;
    if (oldest === undefined) break;
    clearSelectionDetailDemand(oldest);
  }
  const supplied = new Map(
    input.details?.map((details) => [details.oid, details]),
  );
  const cached = designRuntimeFrameState(
    input.workspaceId,
    input.frame.file,
  )?.detailsByNode;
  const read = Promise.all(
    input.nodeIds.map(async (nodeId) => {
      const candidate =
        supplied.get(nodeId) ??
        (!input.forceRuntimeRead ? cached?.[nodeId] : undefined);
      if (candidate?.sourceVersion === input.frame.sourceVersion)
        return candidate;
      if (
        !demand.runtime ||
        demand.controller.signal.aborted ||
        demand.runtime.isActive?.() === false
      )
        return null;
      try {
        return await demand.runtime.getNodeDetails(
          nodeId,
          demand.controller.signal,
        );
      } catch (error) {
        if (demand.controller.signal.aborted || input.tolerateReadErrors)
          return null;
        throw error;
      }
    }),
  ).then((resolved) => {
    if (
      !selectionDetailDemandIsCurrent(demand) ||
      resolved.some(
        (details, index) =>
          !details ||
          details.oid !== input.nodeIds[index] ||
          details.sourceVersion !== input.frame.sourceVersion,
      )
    )
      return null;
    return resolved as DesignRuntimeNodeDetails[];
  });
  demand.read = new Promise((resolve, reject) => {
    const signal = demand.controller.signal;
    const cancel = () => resolve(null);
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    void read.then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    );
  });
  scheduleCurrentSelectionDetailDemand(demand);
  return demand;
}

function scheduleCurrentSelectionDetailDemand(
  demand: DesignSelectionDetailDemand,
): void {
  if (demand.reconcileQueued) return;
  demand.reconcileQueued = true;
  queueMicrotask(() => {
    demand.reconcileQueued = false;
    if (selectionDetailDemandByWorkspace.get(demand.workspaceId) !== demand)
      return;
    const view = designWorkspaceView(demand.workspaceId);
    const snapshot = readSelectionSnapshot(demand.workspaceId);
    const frame = snapshot?.frames.find(
      (candidate) => candidate.file === demand.frame.file,
    );
    const workspace =
      useDesignRuntimeStore.getState().byWorkspace[demand.workspaceId];
    const storeSourceVersion =
      workspace?.frames[demand.frame.file]?.sourceVersion;
    const sourceVersion = frame?.sourceVersion ?? storeSourceVersion;
    const runtime = designFrameRuntime(demand.workspaceId, demand.frame.file);
    const directoryId = snapshot?.directoryId ?? view.directoryId;
    const directoryChanged = directoryId !== demand.directoryId;
    const generationChanged = sourceVersion !== demand.frame.sourceVersion;
    const availabilityChanged =
      directoryChanged ||
      runtime !== demand.runtime ||
      runtime?.sourceVersion !== demand.runtimeSourceVersion ||
      storeSourceVersion !== demand.storeSourceVersion;
    if (
      !sourceVersion ||
      (snapshot && !frame) ||
      storeSourceVersion !== sourceVersion ||
      (!snapshot && generationChanged && !demand.sourceAdvanced) ||
      (!generationChanged && (demand.fulfilled || !availabilityChanged)) ||
      workspace?.folder !== demand.folder ||
      (directoryChanged && demand.directoryId !== undefined) ||
      (view.directoryId !== undefined && view.directoryId !== directoryId) ||
      !selectionIsCurrent(
        demand.workspaceId,
        demand.frame.file,
        demand.nodeIds[0] ?? null,
        demand.generation,
      ) ||
      !runtime ||
      runtime.isActive?.() === false ||
      runtime.sourceVersion !== sourceVersion
    )
      return;
    const input = {
      workspaceId: demand.workspaceId,
      folder: demand.folder,
      frame: frame ?? { ...demand.frame, sourceVersion },
      forceRuntimeRead: directoryChanged,
      reveal: false,
    };
    const recovering =
      view.selectedNodeIds.length > 1
        ? selectDesignNodes({
            ...input,
            nodeIds: view.selectedNodeIds,
            primaryNodeId: view.selectedNodeId ?? undefined,
          })
        : selectDesignNode({ ...input, nodeId: view.selectedNodeId! });
    void recovering.catch(() => {});
  });
}

useDesignRuntimeStore.subscribe((state, previous) => {
  for (const demand of selectionDetailDemandByWorkspace.values()) {
    const frame =
      state.byWorkspace[demand.workspaceId]?.frames[demand.frame.file];
    const previousFrame =
      previous.byWorkspace[demand.workspaceId]?.frames[demand.frame.file];
    if (previousFrame && !frame) {
      clearSelectionDetailDemand(demand.workspaceId);
    } else if (frame?.sourceVersion !== previousFrame?.sourceVersion) {
      if (previousFrame?.sourceVersion === demand.frame.sourceVersion)
        demand.sourceAdvanced = true;
      scheduleCurrentSelectionDetailDemand(demand);
    }
  }
});

useDesignWorkspaceUiStore.subscribe((state) => {
  for (const demand of selectionDetailDemandByWorkspace.values()) {
    const view = state.byWorkspace[demand.workspaceId];
    if (
      !view ||
      view.selectedFrame !== demand.frame.file ||
      view.selectedNodeIds.join("\u0000") !== demand.nodeIds.join("\u0000")
    )
      clearSelectionDetailDemand(demand.workspaceId);
    else {
      const directoryId =
        readSelectionSnapshot(demand.workspaceId)?.directoryId ??
        view.directoryId;
      if (directoryId !== demand.directoryId) {
        if (demand.directoryId !== undefined)
          clearSelectionDetailDemand(demand.workspaceId);
        else {
          demand.controller.abort();
          scheduleCurrentSelectionDetailDemand(demand);
        }
      }
    }
  }
});

export async function settleDesignSelectionDetails(
  workspaceId: string,
  frame: string,
  sourceVersion: string,
): Promise<void> {
  for (;;) {
    const demand = selectionDetailDemandByWorkspace.get(workspaceId);
    if (
      !demand ||
      demand.frame.file !== frame ||
      demand.frame.sourceVersion !== sourceVersion
    )
      return;
    await demand.read.catch(() => null);
    if (selectionDetailDemandByWorkspace.get(workspaceId) === demand) return;
  }
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
  if (!runtime || runtime.isActive?.() === false) return null;
  const screenshot = await designBackgroundWork.schedule(
    `capture:${workspaceId}\0${frame}\0${nodeId ?? ""}`,
    async () => {
      if (
        runtime.isActive?.() === false ||
        designFrameRuntime(workspaceId, frame) !== runtime ||
        (runtime.sourceVersion !== undefined &&
          runtime.sourceVersion !== sourceVersion)
      )
        return null;
      return runtime.captureScreenshot(nodeId, scale);
    },
  );
  if (
    !screenshot ||
    runtime.isActive?.() === false ||
    designFrameRuntime(workspaceId, frame) !== runtime
  )
    return null;
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
  // The renderer already validated the runtime generation and image payload.
  // Publish those confirmed pixels synchronously before the durable bridge
  // write so an unavoidable document navigation can use them as its cover
  // even when engine persistence is briefly back-pressured.
  useDesignRuntimeStore
    .getState()
    .publishScreenshot(workspaceId, folder, frame, screenshot, sourceVersion);
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
  return screenshot;
}

/** Make a frame the workspace's active frame, clearing any node selection.
 * `options.selected` marks the frame itself as the selection target (label
 * click, Layers row, Escape from a root child); without it the frame is only
 * activated — the Figma-like "nothing selected" resting state. */
export async function selectDesignFrame(
  workspaceId: string,
  frame: DesignCanvasFrameWire | null,
  options?: {
    selected?: boolean;
    /** A user gesture on the canvas: bring the frame's Layers row into view.
     * Off by default, because the resting activation republishes on every
     * snapshot and must not pull the list away from where the user left it. */
    reveal?: boolean;
  },
): Promise<void> {
  clearSelectionDetailDemand(workspaceId);
  nextGeneration(selectionGenerationByWorkspace, workspaceId);
  const version = nextSelectionVersion();
  if (!frame) {
    if (designWorkspaceView(workspaceId).selectedFrame !== null) {
      useDesignWorkspaceUiStore.getState().setSelectedFrame(workspaceId, null);
    }
    await designSetSelection(workspaceId, null, version);
    return;
  }
  const frameSelected = options?.selected === true;
  const current = designWorkspaceView(workspaceId);
  if (
    current.selectedFrame !== frame.file ||
    current.selectedNodeId !== null ||
    current.frameSelected !== frameSelected
  ) {
    useDesignWorkspaceUiStore
      .getState()
      .setSelection(workspaceId, frame.file, null, undefined, {
        frameSelected,
      });
  }
  if (options?.reveal) revealDesignSelectionPath(workspaceId, frame, []);
  await publishDurableDesignSelection(
    workspaceId,
    frameSelection(frame),
    version,
  );
}

export async function selectDesignNode(input: {
  workspaceId: string;
  folder: string;
  frame: DesignCanvasFrameWire;
  nodeId: string;
  details?: DesignRuntimeNodeDetails;
  /** Runtime revisions can change computed values without changing source. */
  forceRuntimeRead?: boolean;
  /** Exact-source local selection is ready; engine persistence may still wait. */
  onLocalSelection?: (details: DesignRuntimeNodeDetails) => void;
  /** Open and scroll to the Layers row (default). Background re-selection of
   * an unchanged node passes false so the user's folds and scroll survive. */
  reveal?: boolean;
}): Promise<DesignRuntimeNodeDetails | null> {
  const { workspaceId, folder, nodeId } = input;
  const frame = currentDesignSelectionFrame(workspaceId, input.frame);
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
  if (input.reveal !== false) {
    revealDesignSelectionPath(workspaceId, frame, [nodeId]);
  }

  const demand = requestDesignSelectionDetails({
    workspaceId,
    folder,
    frame,
    nodeIds: [nodeId],
    generation,
    ...(input.details ? { details: [input.details] } : {}),
    forceRuntimeRead: input.forceRuntimeRead,
  });
  const details = (await demand.read)?.[0];
  if (
    !details ||
    details.sourceVersion !== frame.sourceVersion ||
    !selectionIsCurrent(workspaceId, frame.file, nodeId, generation) ||
    !selectionDetailDemandIsCurrent(demand)
  ) {
    return null;
  }

  demand.fulfilled = true;
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
  input.onLocalSelection?.(details);
  await publishDurableDesignSelection(
    workspaceId,
    elementSelection(frame, details),
    version,
  );
  if (
    !selectionIsCurrent(workspaceId, frame.file, nodeId, generation) ||
    !selectionDetailDemandIsCurrent(demand)
  ) {
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
  /** Open and scroll to the primary Layers row (default); see selectDesignNode. */
  reveal?: boolean;
}): Promise<DesignRuntimeNodeDetails[] | null> {
  const frame = currentDesignSelectionFrame(input.workspaceId, input.frame);
  const unique = [...new Set(input.nodeIds.filter(isValidDesignNodeId))];
  const primary =
    (input.primaryNodeId && unique.includes(input.primaryNodeId)
      ? input.primaryNodeId
      : unique[0]) ?? null;
  if (!primary) {
    await selectDesignFrame(input.workspaceId, frame);
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
    .setSelection(input.workspaceId, frame.file, primary, nodeIds);
  if (input.reveal !== false) {
    revealDesignSelectionPath(input.workspaceId, frame, nodeIds);
  }

  const demand = requestDesignSelectionDetails({
    ...input,
    frame,
    nodeIds,
    generation,
    tolerateReadErrors: true,
  });
  const resolved = await demand.read;
  const current = designWorkspaceView(input.workspaceId);
  if (
    !resolved ||
    !selectionDetailDemandIsCurrent(demand) ||
    selectionGenerationByWorkspace.get(input.workspaceId) !== generation ||
    current.selectedFrame !== frame.file ||
    current.selectedNodeId !== primary ||
    current.selectedNodeIds.join("\u0000") !== nodeIds.join("\u0000") ||
    resolved.some(
      (details) => !details || details.sourceVersion !== frame.sourceVersion,
    )
  ) {
    return null;
  }
  const details = resolved as DesignRuntimeNodeDetails[];
  demand.fulfilled = true;
  for (const candidate of details) {
    useDesignRuntimeStore
      .getState()
      .publishNodeDetails(
        input.workspaceId,
        input.folder,
        frame.file,
        candidate,
        frame.sourceVersion,
      );
    clearDesignLivePreview(input.workspaceId, frame.file, candidate.oid);
  }
  await publishDurableDesignSelection(
    input.workspaceId,
    multiElementSelection(frame, details),
    version,
  );
  if (
    selectionGenerationByWorkspace.get(input.workspaceId) !== generation ||
    !selectionDetailDemandIsCurrent(demand)
  ) {
    return null;
  }
  void captureDesignRuntimeScreenshot(
    input.workspaceId,
    input.folder,
    frame.file,
    frame.sourceVersion,
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

/** Canvas body selection shares the generation used by Layers, frame labels,
 * and outside clicks. A late hit can never reopen a selection they replaced.
 * Entering a frame is synchronous; only explicit nested intent needs a hit. */
export async function selectDesignFrameBodyAtLocation(
  input: {
    workspaceId: string;
    folder: string;
    frame: DesignCanvasFrameWire;
    x: number;
    y: number;
    intent: DesignFrameBodyIntent;
    additive?: boolean;
    /** Single-node entry can open its editor before selection persistence. */
    onLocalSelection?: (details: DesignRuntimeNodeDetails) => void;
  },
  retries = 2,
): Promise<DesignRuntimeNodeDetails | null> {
  const { workspaceId, frame } = input;
  const current = designWorkspaceView(workspaceId);
  const selectedNodeId =
    current.selectedFrame === frame.file ? current.selectedNodeId : null;
  const labeledFrame = frame.kind !== "text";
  const selectFrame = async () => {
    // Empty-space Shift-click must not replace an existing group of layers.
    if (input.additive && current.selectedNodeIds.length > 0) return null;
    const selected = !(
      input.additive &&
      current.selectedFrame === frame.file &&
      current.frameSelected
    );
    // A click on the frame is a user gesture: bring its Layers row into view,
    // even when the frame was already the selection.
    await selectDesignFrame(workspaceId, frame, { selected, reveal: selected });
    return null;
  };
  if (labeledFrame && input.intent === "plain" && !selectedNodeId) {
    return selectFrame();
  }
  const generation = nextGeneration(
    selectionGenerationByWorkspace,
    workspaceId,
  );
  const runtime = designFrameRuntime(workspaceId, frame.file);
  if (!runtime) return selectFrame();
  const isCurrent = () => {
    const state = designRuntimeFrameState(workspaceId, frame.file);
    return (
      selectionGenerationByWorkspace.get(workspaceId) === generation &&
      designFrameRuntime(workspaceId, frame.file) === runtime &&
      (runtime.sourceVersion
        ? runtime.sourceVersion === frame.sourceVersion
        : !state?.sourceVersion || state.sourceVersion === frame.sourceVersion)
    );
  };
  const retryAdoptedClick = () => {
    if (
      retries > 0 &&
      selectionGenerationByWorkspace.get(workspaceId) === generation &&
      designFrameRuntime(workspaceId, frame.file) === runtime &&
      runtime.sourceVersion &&
      runtime.sourceVersion !== frame.sourceVersion
    ) {
      return selectDesignFrameBodyAtLocation(
        { ...input, frame: { ...frame, sourceVersion: runtime.sourceVersion } },
        retries - 1,
      );
    }
    return Promise.resolve(null);
  };
  if (runtime.sourceVersion && runtime.sourceVersion !== frame.sourceVersion)
    return retryAdoptedClick();
  try {
    let details = await runtime.getElementAtLoc(input.x, input.y, {
      mode: "deepest",
    });
    if (
      !isCurrent() ||
      (details && details.sourceVersion !== frame.sourceVersion)
    ) {
      return retryAdoptedClick();
    }
    if (!details) return selectFrame();
    const snapshot = designRuntimeFrameState(workspaceId, frame.file)?.snapshot;
    const exactSnapshot =
      snapshot?.sourceVersion === frame.sourceVersion ? snapshot : null;
    const isFrameOwner = (candidate: DesignRuntimeNodeDetails) =>
      labeledFrame &&
      (candidate.oid === exactSnapshot?.frame.oid ||
        candidate.oid === DESIGN_RUNTIME_DOCUMENT_BODY_ID ||
        candidate.tag === "body" ||
        candidate.tag === "html");
    if (isFrameOwner(details)) return selectFrame();
    const intent = input.intent;
    const target = exactSnapshot
      ? resolveDesignFrameBodyTarget({
          nodes: exactSnapshot.tree,
          deepestNodeId: details.oid,
          deepestRect: details.rect,
          selectedNodeId,
          intent,
          frameSize: frame,
          rootRect: exactSnapshot.frame.rect,
          labeledFrame,
          frameRootId: exactSnapshot.frame.oid,
        })
      : { kind: "unresolved" as const };
    if (target.kind === "frame") return selectFrame();
    if (target.kind === "node" && target.nodeId !== details.oid) {
      details = await runtime.getNodeDetails(target.nodeId);
    } else if (target.kind === "unresolved" && intent !== "deepest") {
      // A semantic frame selection has no selected node. Give fallback descent
      // its runtime owner so a bounded tree cannot trap entry on that same root.
      details = await runtime.getElementAtLoc(input.x, input.y, {
        mode: intent === "plain" ? "preserve" : "descend",
        selectedNodeId:
          selectedNodeId ??
          (labeledFrame && intent === "descend"
            ? exactSnapshot?.frame.oid
            : null),
      });
    }
    if (
      !isCurrent() ||
      (details && details.sourceVersion !== frame.sourceVersion)
    ) {
      return retryAdoptedClick();
    }
    if (!details || isFrameOwner(details)) return selectFrame();
    if (input.additive) {
      const selection = await toggleDesignNodeSelection({
        ...input,
        nodeId: details.oid,
        details,
      });
      return (
        selection?.find((candidate) => candidate.oid === details.oid) ?? null
      );
    }
    return selectDesignNode({ ...input, nodeId: details.oid, details });
  } catch (error) {
    // An in-place commit may advance the port while this hit response travels
    // back. Retry only that exact live frame; a newer selection always wins.
    if (runtime.sourceVersion && runtime.sourceVersion !== frame.sourceVersion)
      return retryAdoptedClick();
    throw error;
  }
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
  const runtimeSourceVersion =
    runtime.sourceVersion ?? input.frame.sourceVersion;
  const details = await runtime.getElementsInRect(
    input.rect,
    input.scopeNodeId,
  );
  return details.filter(
    (candidate) => candidate.sourceVersion === runtimeSourceVersion,
  );
}

/** Everything one gesture frame paints from, in one round trip.
 *
 * The overlay, its padding hatches and its gap affordances are the only things a
 * drag repaints, and they read a dozen values. Asking for a node's whole
 * computed catalog sixty times a second is what left the element trailing the
 * outline that describes it, so gestures ask for this instead — and get an
 * answer measured in the same task the styles were applied in, with no
 * animation frame in between.
 *
 * A document painted by an older engine build has no `previewGeometry`; the
 * fallback below produces the identical shape from the calls it does have, so
 * every caller has exactly one code path. */
export async function previewDesignNodeGeometry(input: {
  workspaceId: string;
  frame: DesignCanvasFrameWire;
  nodeId: string;
  /** Omitted or null measures without authoring anything. */
  styles?: Record<string, string | null> | null;
  children?: boolean;
}): Promise<DesignRuntimeNodeGeometry> {
  if (input.styles) designBackgroundWork.touch();
  const runtime = designFrameRuntime(input.workspaceId, input.frame.file);
  if (!runtime) throw new Error("The design frame is not ready.");
  const geometry = runtime.supports("previewGeometry")
    ? await runtime.previewGeometry(input.nodeId, input.styles ?? null, {
        children: input.children === true,
      })
    : await legacyDesignNodeGeometry(runtime, input);
  if (
    designFrameRuntime(input.workspaceId, input.frame.file) !== runtime ||
    geometry.sourceVersion !==
      (runtime.sourceVersion ?? input.frame.sourceVersion)
  ) {
    throw new Error("The design frame changed before the preview was applied.");
  }
  return geometry;
}

/** The pre-`previewGeometry` shape of the same answer. */
async function legacyDesignNodeGeometry(
  runtime: NonNullable<ReturnType<typeof designFrameRuntime>>,
  input: {
    workspaceId: string;
    frame: DesignCanvasFrameWire;
    nodeId: string;
    styles?: Record<string, string | null> | null;
    children?: boolean;
  },
): Promise<DesignRuntimeNodeGeometry> {
  const details = input.styles
    ? await runtime.previewStyles(input.nodeId, input.styles)
    : await runtime.getNodeDetails(input.nodeId);
  const children = input.children
    ? await runtime.getElementsInRect(
        designNodeChildInspectionRect(details.rect),
        input.nodeId,
      )
    : [];
  return designNodeGeometryFromDetails(details, children);
}

/** Over-scan a container's own box so a child placed outside it (a negative
 * margin, an overflowing grid item) is still measured. */
export function designNodeChildInspectionRect(rect: DesignRuntimeRect) {
  const overscan = Math.max(
    256,
    Math.min(25_000, Math.max(rect.width, rect.height)),
  );
  const width = Math.min(100_000, rect.width + overscan * 2);
  const height = Math.min(100_000, rect.height + overscan * 2);
  return {
    x: rect.x - (width - rect.width) / 2,
    y: rect.y - (height - rect.height) / 2,
    width,
    height,
  };
}

/** Narrow full details down to the gesture shape, so the fallback path and the
 * lean path are indistinguishable to every caller. */
export function designNodeGeometryFromDetails(
  details: DesignRuntimeNodeDetails,
  children: readonly DesignRuntimeNodeDetails[] = [],
): DesignRuntimeNodeGeometry {
  return {
    sourceVersion: details.sourceVersion,
    oid: details.oid,
    rect: details.rect,
    box: details.box ?? {
      x: details.rect.x,
      y: details.rect.y,
      width: details.rect.width,
      height: details.rect.height,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      originX: 0.5,
      originY: 0.5,
    },
    styles: details.styles,
    children: children
      .filter(
        (child) =>
          child.visible && child.rect.width > 0 && child.rect.height > 0,
      )
      .slice(0, DESIGN_RUNTIME_GEOMETRY_CHILD_LIMIT)
      .map((child) => ({
        oid: child.oid,
        rect: child.rect,
        name: child.name,
        styles: child.styles,
      })),
  };
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
  if (!nodeId) {
    const queue = hoverReadQueueByWorkspace.get(workspaceId);
    if (queue?.pending) {
      queue.pending.resolve();
      queue.pending = null;
    }
    return;
  }
  const cachedCandidate = designRuntimeFrameState(workspaceId, frame)
    ?.detailsByNode[nodeId];
  const cached =
    cachedCandidate?.sourceVersion === input.sourceVersion
      ? cachedCandidate
      : undefined;
  const suppliedDetails = input.details ?? cached;
  if (!suppliedDetails) {
    return new Promise<void>((resolve) => {
      const entry: PendingDesignHoverRead = {
        input: {
          workspaceId,
          folder,
          frame,
          sourceVersion: input.sourceVersion,
          nodeId,
        },
        generation,
        resolve,
      };
      const queue = hoverReadQueueByWorkspace.get(workspaceId) ?? {
        active: false,
        pending: null,
      };
      hoverReadQueueByWorkspace.set(workspaceId, queue);
      if (queue.active) {
        // Pointer traversal only cares about the newest unopened row. Resolve a
        // superseded waiter immediately and retain one latest pending read.
        queue.pending?.resolve();
        queue.pending = entry;
        return;
      }
      queue.active = true;
      const drain = async (first: PendingDesignHoverRead) => {
        let current: PendingDesignHoverRead | null = first;
        while (current) {
          const request = current;
          let details: DesignRuntimeNodeDetails | null = null;
          const runtime = designFrameRuntime(
            request.input.workspaceId,
            request.input.frame,
          );
          if (runtime) {
            try {
              details = await runtime.getNodeDetails(request.input.nodeId);
            } catch {
              // Hover is speculative. A mutation may remove a row between
              // pointer entry and readback; the newest queued hover still runs.
            }
          }
          const runtimeWorkspace =
            useDesignRuntimeStore.getState().byWorkspace[
              request.input.workspaceId
            ];
          if (
            details?.sourceVersion === request.input.sourceVersion &&
            hoverGenerationByWorkspace.get(request.input.workspaceId) ===
              request.generation &&
            runtimeWorkspace?.hoveredFrame === request.input.frame &&
            runtimeWorkspace.hoveredNodeId === request.input.nodeId
          ) {
            useDesignRuntimeStore
              .getState()
              .publishNodeDetails(
                request.input.workspaceId,
                request.input.folder,
                request.input.frame,
                details,
                request.input.sourceVersion,
              );
          }
          request.resolve();
          current = queue.pending;
          queue.pending = null;
        }
      };
      void drain(entry).finally(() => {
        queue.active = false;
        if (!queue.pending) hoverReadQueueByWorkspace.delete(workspaceId);
      });
    });
  }
  const details = suppliedDetails;
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
  // The painted document is the connected generation. While a replacement
  // iframe loads, the workspace snapshot already names the newer one, and
  // rejecting on that difference would report a landed write as a failure.
  const runtimeSourceVersion = runtime.sourceVersion ?? input.sourceVersion;
  const details = await runtime.setNodeVisibility(input.nodeId, input.visible);
  if (details.sourceVersion !== runtimeSourceVersion) {
    throw new Error("The design frame changed before visibility was updated.");
  }
  useDesignRuntimeStore
    .getState()
    .publishNodeDetails(
      input.workspaceId,
      input.folder,
      input.frame,
      details,
      runtimeSourceVersion,
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
  const runtimeSourceVersion = runtime.sourceVersion ?? input.sourceVersion;
  const publication = publishDesignLivePreviewStyles(
    input.workspaceId,
    input.frame,
    input.nodeId,
    input.styles,
  );
  try {
    const details = await runtime.previewStyles(input.nodeId, input.styles);
    if (details.sourceVersion !== runtimeSourceVersion) {
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

/** Live text stays inside the opaque runtime and intentionally bypasses the
 * React store. The uncontrolled editor already owns the draft; publishing each
 * keystroke would rerender the canvas and inspector for no semantic change. */
export async function previewDesignNodeTextTransient(input: {
  workspaceId: string;
  frame: string;
  sourceVersion: string;
  nodeId: string;
  text: string;
}): Promise<DesignRuntimeNodeDetails> {
  const runtime = designFrameRuntime(input.workspaceId, input.frame);
  if (!runtime) throw new Error("The design frame is not ready.");
  const runtimeSourceVersion = runtime.sourceVersion ?? input.sourceVersion;
  const details = await runtime.previewText(input.nodeId, input.text);
  if (details.sourceVersion !== runtimeSourceVersion) {
    throw new Error("The design frame changed before text was previewed.");
  }
  return details;
}

export async function clearDesignNodeTextPreviewTransient(input: {
  workspaceId: string;
  frame: string;
  sourceVersion: string;
  nodeId: string;
}): Promise<DesignRuntimeNodeDetails> {
  const runtime = designFrameRuntime(input.workspaceId, input.frame);
  if (!runtime) throw new Error("The design frame is not ready.");
  const runtimeSourceVersion = runtime.sourceVersion ?? input.sourceVersion;
  const details = await runtime.clearPreviewText(input.nodeId);
  if (details.sourceVersion !== runtimeSourceVersion) {
    throw new Error(
      "The design frame changed before text preview was cleared.",
    );
  }
  return details;
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
  if (
    designFrameRuntime(input.workspaceId, input.frame) !== runtime ||
    details.sourceVersion !== (runtime.sourceVersion ?? input.sourceVersion)
  ) {
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
  void persistDesignRuntimeAuditSnapshot({
    workspaceId,
    frame: frame.file,
    sourceVersion: frame.sourceVersion,
    warnings: snapshot.warnings,
  });
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
        reveal: false,
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
      reveal: false,
    }).catch(() => {
      // Last confirmed exact-key details remain visible during revalidation.
    });
  }
}

/** Share one exact-generation runtime-audit publication between ready events,
 * mutation events, and the post-adoption idle reconciliation. Failed,
 * deterministic payloads remain memoized so an observer cannot turn them into
 * an unbounded bridge loop. */
export function persistDesignRuntimeAuditSnapshot(input: {
  workspaceId: string;
  frame: string;
  sourceVersion: string;
  warnings: DesignRuntimeSnapshot["warnings"];
}): Promise<boolean> {
  const key = `${input.workspaceId}\u0000${input.frame}`;
  const fingerprint = `${input.sourceVersion}\u0000${JSON.stringify(input.warnings)}`;
  const existing = runtimeAuditPublicationByFrame.get(key);
  if (existing?.fingerprint === fingerprint) return existing.result;
  const result = designSetRuntimeAudit(input.workspaceId, {
    frame: input.frame,
    sourceVersion: input.sourceVersion,
    warnings: input.warnings,
  }).then(
    () => true,
    () => false,
  );
  runtimeAuditPublicationByFrame.delete(key);
  runtimeAuditPublicationByFrame.set(key, { fingerprint, result });
  while (runtimeAuditPublicationByFrame.size > 256) {
    const oldest = runtimeAuditPublicationByFrame.keys().next().value as
      | string
      | undefined;
    if (!oldest) break;
    runtimeAuditPublicationByFrame.delete(oldest);
  }
  return result;
}

export function resetDesignSelectionWorkflowsForTests(): void {
  designBackgroundWork.reset();
  for (const workspaceId of selectionDetailDemandByWorkspace.keys()) {
    clearSelectionDetailDemand(workspaceId);
  }
  selectionGenerationByWorkspace.clear();
  hoverGenerationByWorkspace.clear();
  for (const queue of hoverReadQueueByWorkspace.values()) {
    queue.pending?.resolve();
  }
  hoverReadQueueByWorkspace.clear();
  runtimeAuditPublicationByFrame.clear();
  selectionVersion = 0;
}
