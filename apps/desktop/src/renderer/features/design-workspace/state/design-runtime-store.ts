// ──────────────────────────────────────────────────────────
// Live design runtime cache
// ──────────────────────────────────────────────────────────
//
// Runtime trees, computed readback, and screenshots are keyed by the exact
// workspace/frame/node identity. Confirmed same-key values survive refreshes;
// bounds keep retained canvases and large screenshot data from growing without
// limit. Durable selection identity remains in design-workspace-ui.ts.

import type {
  DesignRuntimeNodeDetails,
  DesignRuntimeScreenshot,
  DesignRuntimeSnapshot,
  DesignRuntimeTreeNode,
} from "@zeros/protocol/design-runtime";
import { create } from "zustand";

const MAX_WORKSPACES = 32;
const MAX_FRAMES_PER_WORKSPACE = 24;
const MAX_DETAILS_PER_FRAME = 32;
const MAX_SCREENSHOTS_PER_FRAME = 4;
const MAX_SCREENSHOT_BYTES = 24 * 1024 * 1024;
/** A retired document keeps its last confirmed tree and a few readbacks so
 * Layers and the inspector paint immediately when it (or its workspace) is
 * shown again. Live runtimes are bounded by admission; only retired
 * presentation is charged here, oldest retirement evicted first. */
const MAX_RETIRED_DETAILS_PER_FRAME = 8;
const MAX_RETIRED_PRESENTATION_BYTES = 8 * 1024 * 1024;

export interface DesignRuntimeScreenshotEntry extends DesignRuntimeScreenshot {
  capturedAt: number;
}

export interface DesignRuntimeFrameState {
  snapshot?: DesignRuntimeSnapshot;
  /** File mtime generation that owns every derived value in this entry. */
  sourceVersion?: string;
  detailsByNode: Record<string, DesignRuntimeNodeDetails>;
  detailOrder: string[];
  screenshotsByNode: Record<string, DesignRuntimeScreenshotEntry>;
  screenshotOrder: string[];
  updatedAt: number;
  /** Set while no runtime owns this entry: its tree and readbacks are the
   * last confirmed values for `sourceVersion`, retained within a byte budget. */
  retiredAt?: number;
}

export interface DesignRuntimeWorkspaceState {
  workspaceId: string;
  folder: string;
  frames: Record<string, DesignRuntimeFrameState>;
  frameOrder: string[];
  hoveredFrame: string | null;
  hoveredNodeId: string | null;
  updatedAt: number;
}

interface DesignRuntimeStore {
  byWorkspace: Record<string, DesignRuntimeWorkspaceState>;
  workspaceIdByFolder: Record<string, string>;
  publishSnapshot(
    workspaceId: string,
    folder: string,
    frame: string,
    snapshot: DesignRuntimeSnapshot,
    sourceVersion: string,
  ): void;
  publishNodeDetails(
    workspaceId: string,
    folder: string,
    frame: string,
    details: DesignRuntimeNodeDetails,
    sourceVersion: string,
  ): void;
  publishScreenshot(
    workspaceId: string,
    folder: string,
    frame: string,
    screenshot: DesignRuntimeScreenshot,
    sourceVersion: string,
  ): void;
  adoptFrameGeneration(
    workspaceId: string,
    frame: string,
    previousSourceVersion: string,
    nextSourceVersion: string,
    snapshot: DesignRuntimeSnapshot,
    details: DesignRuntimeNodeDetails[],
    treeUnchanged?: boolean,
    options?: {
      /** A layout-affecting change can move any box it did not re-measure;
       * those are dropped and read again rather than relabelled current. */
      dropUnrefreshed?: boolean;
    },
  ): boolean;
  setHoveredNode(
    workspaceId: string,
    frame: string | null,
    nodeId: string | null,
  ): void;
  forgetWorkspace(workspaceId: string): void;
  retireFrame(workspaceId: string, frame: string): void;
}

function nodeKey(nodeId: string | null): string {
  return nodeId ?? "";
}

function touchOrder(
  order: readonly string[],
  key: string,
  limit: number,
): string[] {
  return [...order.filter((candidate) => candidate !== key), key].slice(-limit);
}

function keepKeys<T>(
  values: Record<string, T>,
  keys: readonly string[],
): Record<string, T> {
  if (Object.keys(values).length <= keys.length) return values;
  const allowed = new Set(keys);
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => allowed.has(key)),
  );
}

function emptyFrame(now: number): DesignRuntimeFrameState {
  return {
    detailsByNode: {},
    detailOrder: [],
    screenshotsByNode: {},
    screenshotOrder: [],
    updatedAt: now,
  };
}

const treeBytesBySnapshot = new WeakMap<DesignRuntimeSnapshot, number>();
const detailBytesByValue = new WeakMap<DesignRuntimeNodeDetails, number>();

function snapshotBytes(snapshot: DesignRuntimeSnapshot): number {
  const cached = treeBytesBySnapshot.get(snapshot);
  if (cached !== undefined) return cached;
  let bytes = 256;
  const pending: DesignRuntimeTreeNode[] = [...snapshot.tree];
  while (pending.length) {
    const node = pending.pop()!;
    bytes += 96 + 2 * (node.oid.length + node.tag.length + node.name.length +
      (node.layerName?.length ?? 0) + (node.text?.length ?? 0) +
      (node.display?.length ?? 0) + (node.flexDirection?.length ?? 0));
    for (const child of node.children) pending.push(child);
  }
  bytes += detailsBytes(snapshot.frame);
  treeBytesBySnapshot.set(snapshot, bytes);
  return bytes;
}

function detailsBytes(details: DesignRuntimeNodeDetails): number {
  const cached = detailBytesByValue.get(details);
  if (cached !== undefined) return cached;
  let bytes = 512 + 2 * ((details.text?.length ?? 0) + details.selector.length);
  for (const [property, value] of Object.entries(details.styles))
    bytes += 48 + 2 * (property.length + value.length);
  for (const crumb of details.breadcrumb) bytes += 32 + 2 * crumb.length;
  detailBytesByValue.set(details, bytes);
  return bytes;
}

function retiredPresentationBytes(frame: DesignRuntimeFrameState): number {
  let bytes = frame.snapshot ? snapshotBytes(frame.snapshot) : 0;
  for (const details of Object.values(frame.detailsByNode)) bytes += detailsBytes(details);
  return bytes;
}

/** Evict the oldest retired trees/readbacks past the budget. The entry keeps
 * its exact generation and cover pixels; a later runtime boot refills it. */
function boundRetiredPresentation<
  T extends Pick<DesignRuntimeStore, "byWorkspace">,
>(state: T): T {
  const retired: Array<{ workspaceId: string; file: string; at: number; bytes: number }> = [];
  let total = 0;
  for (const [workspaceId, workspace] of Object.entries(state.byWorkspace))
    for (const [file, frame] of Object.entries(workspace.frames)) {
      if (frame.retiredAt === undefined || (!frame.snapshot && frame.detailOrder.length === 0)) continue;
      const bytes = retiredPresentationBytes(frame);
      retired.push({ workspaceId, file, at: frame.retiredAt, bytes });
      total += bytes;
    }
  if (total <= MAX_RETIRED_PRESENTATION_BYTES) return state;
  const byWorkspace = { ...state.byWorkspace };
  for (const entry of retired.sort((left, right) => left.at - right.at)) {
    if (total <= MAX_RETIRED_PRESENTATION_BYTES) break;
    const workspace = byWorkspace[entry.workspaceId]!;
    const frame = workspace.frames[entry.file]!;
    byWorkspace[entry.workspaceId] = {
      ...workspace,
      frames: {
        ...workspace.frames,
        [entry.file]: {
          ...frame,
          snapshot: undefined,
          detailsByNode: {},
          detailOrder: [],
        },
      },
    };
    total -= entry.bytes;
  }
  return { ...state, byWorkspace };
}

/** Count limits alone permit several gigabytes of base64 across retained
 * workspaces. Evict only old pixels, leaving semantic details and trees warm. */
function boundScreenshotBytes<
  T extends Pick<DesignRuntimeStore, "byWorkspace">,
>(state: T): T {
  const images: Array<{
    workspaceId: string;
    frame: string;
    key: string;
    bytes: number;
    capturedAt: number;
  }> = [];
  let total = 0;
  for (const [workspaceId, workspace] of Object.entries(state.byWorkspace))
    for (const [frame, entry] of Object.entries(workspace.frames))
      for (const [key, image] of Object.entries(entry.screenshotsByNode)) {
        const bytes = Math.max(
          image.dataUrl.length * 2,
          image.width * image.height * 4,
        );
        images.push({
          workspaceId,
          frame,
          key,
          bytes,
          capturedAt: image.capturedAt,
        });
        total += bytes;
      }
  if (total <= MAX_SCREENSHOT_BYTES) return state;
  const byWorkspace = { ...state.byWorkspace };
  for (const image of images.sort((a, b) => a.capturedAt - b.capturedAt)) {
    if (total <= MAX_SCREENSHOT_BYTES) break;
    const workspace = byWorkspace[image.workspaceId]!;
    const frame = workspace.frames[image.frame]!;
    const screenshotsByNode = { ...frame.screenshotsByNode };
    delete screenshotsByNode[image.key];
    byWorkspace[image.workspaceId] = {
      ...workspace,
      frames: {
        ...workspace.frames,
        [image.frame]: {
          ...frame,
          screenshotsByNode,
          screenshotOrder: frame.screenshotOrder.filter(
            (key) => key !== image.key,
          ),
        },
      },
    };
    total -= image.bytes;
  }
  return { ...state, byWorkspace };
}

function sameStringArray(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sameStringRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => left[key] === right[key])
  );
}

function sameNodeBox(
  left: DesignRuntimeNodeDetails["box"],
  right: DesignRuntimeNodeDetails["box"],
): boolean {
  if (!left || !right) return left === right;
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.rotation === right.rotation &&
    left.scaleX === right.scaleX &&
    left.scaleY === right.scaleY &&
    left.originX === right.originX &&
    left.originY === right.originY
  );
}

function sameNodeDetails(
  left: DesignRuntimeNodeDetails | undefined,
  right: DesignRuntimeNodeDetails,
): boolean {
  return Boolean(
    left &&
    left.sourceVersion === right.sourceVersion &&
    left.oid === right.oid &&
    left.tag === right.tag &&
    left.name === right.name &&
    left.text === right.text &&
    left.textEditable === right.textEditable &&
    left.textSizing?.width === right.textSizing?.width &&
    left.textSizing?.height === right.textSizing?.height &&
    left.textSizing?.availableWidth === right.textSizing?.availableWidth &&
    left.selector === right.selector &&
    left.visible === right.visible &&
    left.rect.x === right.rect.x &&
    left.rect.y === right.rect.y &&
    left.rect.width === right.rect.width &&
    left.rect.height === right.rect.height &&
    // Rotating a square leaves its bounding box identical, so orientation has
    // to be compared or the canvas keeps painting the previous angle.
    sameNodeBox(left.box, right.box) &&
    left.childCoordinateSpace?.length === right.childCoordinateSpace?.length &&
    (left.childCoordinateSpace?.every(
      (value, index) => value === right.childCoordinateSpace?.[index],
    ) ??
      true) &&
    left.layout?.x === right.layout?.x &&
    left.layout?.y === right.layout?.y &&
    left.layout?.parentId === right.layout?.parentId &&
    left.layout?.parentWidth === right.layout?.parentWidth &&
    left.layout?.parentHeight === right.layout?.parentHeight &&
    left.layout?.parentDisplay === right.layout?.parentDisplay &&
    left.layout?.parentPosition === right.layout?.parentPosition &&
    left.layout?.isContainingBlock === right.layout?.isContainingBlock &&
    left.childrenLayout?.count === right.childrenLayout?.count &&
    left.childrenLayout?.x === right.childrenLayout?.x &&
    left.childrenLayout?.y === right.childrenLayout?.y &&
    left.childrenLayout?.truncated === right.childrenLayout?.truncated &&
    sameStringArray(
      left.childrenLayout?.nodeIds,
      right.childrenLayout?.nodeIds,
    ) &&
    sameStringArray(left.breadcrumb, right.breadcrumb) &&
    sameStringArray(
      left.authoredStyleProperties,
      right.authoredStyleProperties,
    ) &&
    sameStringRecord(left.styles, right.styles),
  );
}

/** The runtime's revision is its semantic generation counter: a cloned
 * snapshot of the same revision, root readback and viewport is the same
 * snapshot, even though the port delivered a new object. */
function sameRuntimeSnapshot(
  left: DesignRuntimeSnapshot,
  right: DesignRuntimeSnapshot,
): boolean {
  return (
    left === right ||
    (left.sourceVersion === right.sourceVersion &&
      left.revision === right.revision &&
      left.tree.length === right.tree.length &&
      left.warnings.length === right.warnings.length &&
      left.viewport.width === right.viewport.width &&
      left.viewport.height === right.viewport.height &&
      left.viewport.scrollX === right.viewport.scrollX &&
      left.viewport.scrollY === right.viewport.scrollY &&
      sameNodeDetails(left.frame, right.frame))
  );
}

function updateWorkspace(
  state: DesignRuntimeStore,
  workspaceId: string,
  folder: string,
  frame: string,
  update: (
    current: DesignRuntimeFrameState,
    now: number,
  ) => DesignRuntimeFrameState,
): Pick<DesignRuntimeStore, "byWorkspace" | "workspaceIdByFolder"> {
  const now = Date.now();
  const currentWorkspace = state.byWorkspace[workspaceId] ?? {
    workspaceId,
    folder,
    frames: {},
    frameOrder: [],
    hoveredFrame: null,
    hoveredNodeId: null,
    updatedAt: now,
  };
  const currentFrame = currentWorkspace.frames[frame] ?? emptyFrame(now);
  const nextFrame = update(currentFrame, now);
  const frameOrder = touchOrder(
    currentWorkspace.frameOrder,
    frame,
    MAX_FRAMES_PER_WORKSPACE,
  );
  const frames = keepKeys(
    { ...currentWorkspace.frames, [frame]: nextFrame },
    frameOrder,
  );
  const nextWorkspace: DesignRuntimeWorkspaceState = {
    ...currentWorkspace,
    folder,
    frames,
    frameOrder,
    updatedAt: now,
  };
  const workspaceOrder = touchOrder(
    Object.values(state.byWorkspace)
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .map((workspace) => workspace.workspaceId),
    workspaceId,
    MAX_WORKSPACES,
  );
  const byWorkspace = keepKeys(
    { ...state.byWorkspace, [workspaceId]: nextWorkspace },
    workspaceOrder,
  );
  const retainedWorkspaceIds = new Set(Object.keys(byWorkspace));
  const workspaceIdByFolder = Object.fromEntries(
    Object.values(byWorkspace)
      .filter((workspace) => retainedWorkspaceIds.has(workspace.workspaceId))
      .map((workspace) => [workspace.folder, workspace.workspaceId]),
  );
  return { byWorkspace, workspaceIdByFolder };
}

export const useDesignRuntimeStore = create<DesignRuntimeStore>((set) => ({
  byWorkspace: {},
  workspaceIdByFolder: {},

  publishSnapshot(workspaceId, folder, frame, snapshot, sourceVersion) {
    if (snapshot.sourceVersion !== sourceVersion) return;
    set((state) => {
      const workspace = state.byWorkspace[workspaceId];
      const current = workspace?.frames[frame];
      if (
        workspace?.folder === folder &&
        current?.sourceVersion === sourceVersion &&
        current.retiredAt === undefined &&
        current.snapshot &&
        sameRuntimeSnapshot(current.snapshot, snapshot)
      ) {
        return state;
      }
      return updateWorkspace(
        state,
        workspaceId,
        folder,
        frame,
        (ownedFrame, now) => ({
          ...ownedFrame,
          snapshot,
          sourceVersion,
          updatedAt: now,
          retiredAt: undefined,
        }),
      );
    });
  },

  publishNodeDetails(workspaceId, folder, frame, details, sourceVersion) {
    if (details.sourceVersion !== sourceVersion) return;
    set((state) => {
      const existing = state.byWorkspace[workspaceId]?.frames[frame];
      const existingWorkspace = state.byWorkspace[workspaceId];
      if (
        existing &&
        existingWorkspace?.folder === folder &&
        existing.detailOrder.at(-1) === details.oid &&
        (existing.sourceVersion === undefined ||
          existing.sourceVersion === sourceVersion) &&
        sameNodeDetails(existing.detailsByNode[details.oid], details)
      ) {
        return state;
      }
      return updateWorkspace(
        state,
        workspaceId,
        folder,
        frame,
        (current, now) => {
          if (
            current.sourceVersion !== undefined &&
            current.sourceVersion !== sourceVersion
          ) {
            return current;
          }
          const detailOrder = touchOrder(
            current.detailOrder,
            details.oid,
            MAX_DETAILS_PER_FRAME,
          );
          return {
            ...current,
            sourceVersion: current.sourceVersion ?? sourceVersion,
            detailsByNode: keepKeys(
              { ...current.detailsByNode, [details.oid]: details },
              detailOrder,
            ),
            detailOrder,
            updatedAt: now,
          };
        },
      );
    });
  },

  publishScreenshot(workspaceId, folder, frame, screenshot, sourceVersion) {
    if (screenshot.sourceVersion !== sourceVersion) return;
    set((state) =>
      boundScreenshotBytes(
        updateWorkspace(state, workspaceId, folder, frame, (current, now) => {
          if (
            current.sourceVersion !== undefined &&
            current.sourceVersion !== sourceVersion
          ) {
            return current;
          }
          const key = nodeKey(screenshot.nodeId);
          const screenshotOrder = touchOrder(
            current.screenshotOrder,
            key,
            MAX_SCREENSHOTS_PER_FRAME,
          );
          return {
            ...current,
            sourceVersion: current.sourceVersion ?? sourceVersion,
            screenshotsByNode: keepKeys(
              {
                ...current.screenshotsByNode,
                [key]: { ...screenshot, capturedAt: now },
              },
              screenshotOrder,
            ),
            screenshotOrder,
            updatedAt: now,
          };
        }),
      ),
    );
  },

  adoptFrameGeneration(
    workspaceId,
    frame,
    previousSourceVersion,
    nextSourceVersion,
    snapshot,
    details,
    treeUnchanged = false,
    options = {},
  ) {
    if (
      snapshot.sourceVersion !== nextSourceVersion ||
      details.some((value) => value.sourceVersion !== nextSourceVersion)
    ) {
      return false;
    }
    let adopted = false;
    set((state) => {
      const workspace = state.byWorkspace[workspaceId];
      const current = workspace?.frames[frame];
      if (!workspace || current?.sourceVersion !== previousSourceVersion) {
        return state;
      }
      adopted = true;
      return updateWorkspace(
        state,
        workspaceId,
        workspace.folder,
        frame,
        (ownedFrame, now) => {
          const rebasedDetails: Record<string, DesignRuntimeNodeDetails> =
            options.dropUnrefreshed
              ? {}
              : Object.fromEntries(
                  Object.entries(ownedFrame.detailsByNode).map(
                    ([nodeId, value]) => [
                      nodeId,
                      { ...value, sourceVersion: nextSourceVersion },
                    ],
                  ),
                );
          let detailOrder = options.dropUnrefreshed
            ? ownedFrame.detailOrder.filter((nodeId) =>
                details.some((value) => value.oid === nodeId),
              )
            : ownedFrame.detailOrder;
          for (const value of details) {
            rebasedDetails[value.oid] = value;
            detailOrder = touchOrder(
              detailOrder,
              value.oid,
              MAX_DETAILS_PER_FRAME,
            );
          }
          return {
            ...ownedFrame,
            sourceVersion: nextSourceVersion,
            snapshot:
              treeUnchanged && ownedFrame.snapshot
                ? { ...snapshot, tree: ownedFrame.snapshot.tree }
                : snapshot,
            detailsByNode: keepKeys(rebasedDetails, detailOrder),
            detailOrder,
            updatedAt: now,
            retiredAt: undefined,
          };
        },
      );
    });
    return adopted;
  },

  setHoveredNode(workspaceId, hoveredFrame, hoveredNodeId) {
    set((state) => {
      const workspace = state.byWorkspace[workspaceId];
      if (
        !workspace ||
        (workspace.hoveredFrame === hoveredFrame &&
          workspace.hoveredNodeId === hoveredNodeId)
      ) {
        return state;
      }
      return {
        byWorkspace: {
          ...state.byWorkspace,
          [workspaceId]: {
            ...workspace,
            hoveredFrame,
            hoveredNodeId,
          },
        },
      };
    });
  },

  retireFrame(workspaceId, file) {
    set((state) => {
      const workspace = state.byWorkspace[workspaceId];
      const frame = workspace?.frames[file];
      if (!workspace || !frame) return state;
      const cover = frame.screenshotsByNode[""];
      // Readbacks are exact-generation values: keep the root and the most
      // recently read nodes (the selection), not every hovered one.
      const rootId = frame.snapshot?.frame.oid;
      const detailOrder = frame.detailOrder
        .filter((nodeId) => nodeId !== rootId)
        .slice(-MAX_RETIRED_DETAILS_PER_FRAME)
        .concat(rootId && frame.detailsByNode[rootId] ? [rootId] : []);
      const retired: DesignRuntimeFrameState = {
        ...emptyFrame(frame.updatedAt), sourceVersion: frame.sourceVersion,
        snapshot: frame.snapshot,
        detailsByNode: keepKeys(frame.detailsByNode, detailOrder), detailOrder,
        screenshotsByNode: cover ? { "": cover } : {}, screenshotOrder: cover ? [""] : [],
        retiredAt: Date.now(),
      };
      return boundRetiredPresentation({ byWorkspace: { ...state.byWorkspace, [workspaceId]: { ...workspace,
        hoveredFrame: workspace.hoveredFrame === file ? null : workspace.hoveredFrame,
        hoveredNodeId: workspace.hoveredFrame === file ? null : workspace.hoveredNodeId,
        frames: { ...workspace.frames, [file]: retired },
      } } });
    });
  },

  forgetWorkspace(workspaceId) {
    set((state) => {
      const workspace = state.byWorkspace[workspaceId];
      if (!workspace) return state;
      const byWorkspace = { ...state.byWorkspace };
      delete byWorkspace[workspaceId];
      const workspaceIdByFolder = { ...state.workspaceIdByFolder };
      if (workspaceIdByFolder[workspace.folder] === workspaceId) {
        delete workspaceIdByFolder[workspace.folder];
      }
      return { byWorkspace, workspaceIdByFolder };
    });
  },
}));

export function designRuntimeFrameState(
  workspaceId: string | null | undefined,
  frame: string | null | undefined,
): DesignRuntimeFrameState | undefined {
  if (!workspaceId || !frame) return undefined;
  return useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[
    frame
  ];
}

/** Resolve once a runtime has reported this exact frame generation (true), or
 * after `timeoutMs` (false). Used to select a new frame together with its
 * inspector data instead of through a fallback view. */
export function waitForDesignRuntimeFrame(
  workspaceId: string,
  file: string,
  sourceVersion: string,
  timeoutMs: number,
): Promise<boolean> {
  const reported = () =>
    useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[file]
      ?.snapshot?.sourceVersion === sourceVersion;
  if (reported()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const unsubscribe = useDesignRuntimeStore.subscribe(() => {
      if (reported()) finish(true);
    });
    function finish(value: boolean) {
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    }
  });
}

export function forgetDesignRuntimeWorkspace(workspaceId: string): void {
  useDesignRuntimeStore.getState().forgetWorkspace(workspaceId);
}

export function resetDesignRuntimeStoreForTests(): void {
  useDesignRuntimeStore.setState({
    byWorkspace: {},
    workspaceIdByFolder: {},
  });
}
