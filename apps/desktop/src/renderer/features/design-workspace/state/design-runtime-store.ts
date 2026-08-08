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
} from "@zeros/protocol/design-runtime";
import { create } from "zustand";

const MAX_WORKSPACES = 32;
const MAX_FRAMES_PER_WORKSPACE = 24;
const MAX_DETAILS_PER_FRAME = 32;
const MAX_SCREENSHOTS_PER_FRAME = 4;

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
  setHoveredNode(
    workspaceId: string,
    frame: string | null,
    nodeId: string | null,
  ): void;
  forgetWorkspace(workspaceId: string): void;
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
    left.selector === right.selector &&
    left.visible === right.visible &&
    left.rect.x === right.rect.x &&
    left.rect.y === right.rect.y &&
    left.rect.width === right.rect.width &&
    left.rect.height === right.rect.height &&
    sameStringArray(left.breadcrumb, right.breadcrumb) &&
    sameStringArray(
      left.authoredStyleProperties,
      right.authoredStyleProperties,
    ) &&
    sameStringRecord(left.styles, right.styles),
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
    set((state) =>
      updateWorkspace(state, workspaceId, folder, frame, (current, now) => ({
        ...current,
        snapshot,
        sourceVersion,
        updatedAt: now,
      })),
    );
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
    );
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

export function forgetDesignRuntimeWorkspace(workspaceId: string): void {
  useDesignRuntimeStore.getState().forgetWorkspace(workspaceId);
}

export function resetDesignRuntimeStoreForTests(): void {
  useDesignRuntimeStore.setState({
    byWorkspace: {},
    workspaceIdByFolder: {},
  });
}
