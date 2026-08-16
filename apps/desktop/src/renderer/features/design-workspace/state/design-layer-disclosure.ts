// ──────────────────────────────────────────────────────────
// Design layer disclosure — per-frame Layers tree expansion
// ──────────────────────────────────────────────────────────
//
// Expansion belongs to the frame, not to the panel that renders it and not to
// whichever frame happens to be selected. Every frame can stand open at once,
// each stays exactly as the user left it while they work in another frame, and
// only its own chevron (or a selection revealing a path inside it) changes that.
// The map is keyed by workspace and frame, bounded per owner, and pruned when
// its workspace is deleted.
//
// Everything defaults to closed: the sets name what is open, which keeps a
// twenty-thousand-node document cheap and makes new frames and nodes arrive
// folded instead of dumping a whole document into the panel.
//
// It stays in memory on purpose. Node ids follow authored document structure,
// and a persisted set would keep re-opening branches that a later edit removed.

import { create } from "zustand";

import { isValidDesignNodeId } from "./design-workspace-ui";

const MAX_WORKSPACES = 8;
const MAX_FRAMES_PER_WORKSPACE = 24;
/** Deep trees stay bounded; the oldest expansions fall out first. */
const MAX_EXPANDED_NODE_IDS = 512;

export interface DesignFrameDisclosure {
  /** True when the frame row is open, showing the frame's own layer tree. */
  treeExpanded: boolean;
  /** Container ids whose children are shown. Anything absent stays folded. */
  expandedNodeIds: readonly string[];
}

interface DesignWorkspaceDisclosure {
  frames: Record<string, DesignFrameDisclosure>;
  /** Least-recently-touched frame first. */
  frameOrder: readonly string[];
  updatedAt: number;
}

interface DesignLayerDisclosureStore {
  byWorkspace: Record<string, DesignWorkspaceDisclosure>;
  updateFrame(
    workspaceId: string,
    frame: string,
    update: (current: DesignFrameDisclosure) => DesignFrameDisclosure,
  ): void;
  collapseWorkspace(workspaceId: string): void;
  forgetWorkspace(workspaceId: string): void;
}

/** One frozen identity for every unopened frame keeps panel selectors stable. */
export const EMPTY_DESIGN_FRAME_DISCLOSURE: DesignFrameDisclosure =
  Object.freeze({
    treeExpanded: false,
    expandedNodeIds: Object.freeze([]) as readonly string[],
  });

const EMPTY_DESIGN_FRAME_DISCLOSURES: Readonly<
  Record<string, DesignFrameDisclosure>
> = Object.freeze({});

function sameDisclosure(
  left: DesignFrameDisclosure,
  right: DesignFrameDisclosure,
): boolean {
  return (
    left.treeExpanded === right.treeExpanded &&
    left.expandedNodeIds.length === right.expandedNodeIds.length &&
    left.expandedNodeIds.every(
      (nodeId, index) => nodeId === right.expandedNodeIds[index],
    )
  );
}

function isClosed(disclosure: DesignFrameDisclosure): boolean {
  return !disclosure.treeExpanded && disclosure.expandedNodeIds.length === 0;
}

function boundExpanded(nodeIds: readonly string[]): readonly string[] {
  return nodeIds.length <= MAX_EXPANDED_NODE_IDS
    ? nodeIds
    : nodeIds.slice(nodeIds.length - MAX_EXPANDED_NODE_IDS);
}

function keepNewest<T>(
  values: Record<string, T>,
  keys: readonly string[],
): Record<string, T> {
  if (Object.keys(values).length <= keys.length) return values;
  const allowed = new Set(keys);
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => allowed.has(key)),
  );
}

function touchOrder(
  order: readonly string[],
  key: string,
  limit: number,
): string[] {
  return [...order.filter((candidate) => candidate !== key), key].slice(-limit);
}

export const useDesignLayerDisclosureStore = create<DesignLayerDisclosureStore>(
  (set) => ({
    byWorkspace: {},

    updateFrame(workspaceId, frame, update) {
      if (!workspaceId || !frame) return;
      set((state) => {
        const workspace = state.byWorkspace[workspaceId];
        const current =
          workspace?.frames[frame] ?? EMPTY_DESIGN_FRAME_DISCLOSURE;
        const updated = update(current);
        const next: DesignFrameDisclosure = {
          treeExpanded: updated.treeExpanded,
          expandedNodeIds: boundExpanded(
            updated.expandedNodeIds.filter(isValidDesignNodeId),
          ),
        };
        // An update that asks for nothing must not allocate a frame slot, or
        // every root-level selection would evict a frame the user still has
        // open and rerender the panel for no change at all.
        if (sameDisclosure(current, next)) {
          if (workspace?.frames[frame]) return state;
          if (isClosed(next)) return state;
        }
        const frameOrder = touchOrder(
          workspace?.frameOrder ?? [],
          frame,
          MAX_FRAMES_PER_WORKSPACE,
        );
        const nextWorkspace: DesignWorkspaceDisclosure = {
          frames: keepNewest(
            { ...(workspace?.frames ?? {}), [frame]: next },
            frameOrder,
          ),
          frameOrder,
          updatedAt: Date.now(),
        };
        const workspaceOrder = Object.entries({
          ...state.byWorkspace,
          [workspaceId]: nextWorkspace,
        })
          .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
          .map(([id]) => id)
          .slice(-MAX_WORKSPACES);
        return {
          byWorkspace: keepNewest(
            { ...state.byWorkspace, [workspaceId]: nextWorkspace },
            workspaceOrder,
          ),
        };
      });
    },

    /** Close every frame and every container the workspace holds open. One
     * action, so the panel cannot leave a frame behind. */
    collapseWorkspace(workspaceId) {
      set((state) => {
        const workspace = state.byWorkspace[workspaceId];
        if (!workspace) return state;
        if (Object.values(workspace.frames).every(isClosed)) return state;
        const byWorkspace = { ...state.byWorkspace };
        delete byWorkspace[workspaceId];
        return { byWorkspace };
      });
    },

    forgetWorkspace(workspaceId) {
      set((state) => {
        if (!(workspaceId in state.byWorkspace)) return state;
        const byWorkspace = { ...state.byWorkspace };
        delete byWorkspace[workspaceId];
        return { byWorkspace };
      });
    },
  }),
);

export function designFrameDisclosure(
  workspaceId: string | null | undefined,
  frame: string | null | undefined,
): DesignFrameDisclosure {
  if (!workspaceId || !frame) return EMPTY_DESIGN_FRAME_DISCLOSURE;
  return (
    useDesignLayerDisclosureStore.getState().byWorkspace[workspaceId]?.frames[
      frame
    ] ?? EMPTY_DESIGN_FRAME_DISCLOSURE
  );
}

/** Every frame's disclosure in one stable read: the panel renders each frame's
 * own tree, so it must not subscribe per frame. */
export function useDesignWorkspaceDisclosure(
  workspaceId: string | null | undefined,
): Readonly<Record<string, DesignFrameDisclosure>> {
  return useDesignLayerDisclosureStore((state) =>
    workspaceId
      ? (state.byWorkspace[workspaceId]?.frames ??
        EMPTY_DESIGN_FRAME_DISCLOSURES)
      : EMPTY_DESIGN_FRAME_DISCLOSURES,
  );
}

/** Anything open anywhere in this workspace, including containers inside a
 * frame the user has since folded. Drives the Collapse all affordance. */
export function designWorkspaceHasExpandedLayers(
  disclosures: Readonly<Record<string, DesignFrameDisclosure>>,
  frames?: readonly string[],
): boolean {
  const entries = frames
    ? frames.map((frame) => disclosures[frame])
    : Object.values(disclosures);
  return entries.some((disclosure) => !!disclosure && !isClosed(disclosure));
}

/** Toggle one container. Opening keeps insertion order so the newest
 * expansions are the ones retained when a huge tree hits the cap. */
export function toggleDesignLayerExpanded(
  workspaceId: string,
  frame: string,
  nodeId: string,
): void {
  useDesignLayerDisclosureStore
    .getState()
    .updateFrame(workspaceId, frame, (current) =>
      current.expandedNodeIds.includes(nodeId)
        ? {
            ...current,
            expandedNodeIds: current.expandedNodeIds.filter(
              (candidate) => candidate !== nodeId,
            ),
          }
        : {
            ...current,
            expandedNodeIds: [...current.expandedNodeIds, nodeId],
          },
    );
}

/** Publish a selection's path in the same transition that selects it: a canvas
 * click must never leave its layer row hidden inside a folded frame or branch,
 * and the user stays free to collapse those containers afterwards. */
export function revealDesignLayerPath(
  workspaceId: string,
  frame: string,
  ancestorNodeIds: readonly string[],
): void {
  useDesignLayerDisclosureStore
    .getState()
    .updateFrame(workspaceId, frame, (current) => {
      const missing = ancestorNodeIds.filter(
        (nodeId) => !current.expandedNodeIds.includes(nodeId),
      );
      if (missing.length === 0 && current.treeExpanded) return current;
      return {
        treeExpanded: true,
        expandedNodeIds: [...current.expandedNodeIds, ...missing],
      };
    });
}

export function setDesignFrameTreeExpanded(
  workspaceId: string,
  frame: string,
  treeExpanded: boolean,
): void {
  useDesignLayerDisclosureStore
    .getState()
    .updateFrame(workspaceId, frame, (current) =>
      current.treeExpanded === treeExpanded
        ? current
        : { ...current, treeExpanded },
    );
}

/** Fold or unfold one frame without touching its inner containers, so
 * reopening it restores the exact shape the user built. */
export function toggleDesignFrameTreeExpanded(
  workspaceId: string,
  frame: string,
): void {
  useDesignLayerDisclosureStore
    .getState()
    .updateFrame(workspaceId, frame, (current) => ({
      ...current,
      treeExpanded: !current.treeExpanded,
    }));
}

export function collapseAllDesignLayers(workspaceId: string): void {
  useDesignLayerDisclosureStore.getState().collapseWorkspace(workspaceId);
}

export function forgetDesignLayerDisclosure(workspaceId: string): void {
  useDesignLayerDisclosureStore.getState().forgetWorkspace(workspaceId);
}

export function resetDesignLayerDisclosureForTests(): void {
  useDesignLayerDisclosureStore.setState({ byWorkspace: {} });
}
