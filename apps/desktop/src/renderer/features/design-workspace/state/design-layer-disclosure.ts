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
//
// A reveal request is the other half: when a selection is made for the user
// (a canvas click, a shortcut, a new layer), its frame and containers open in
// the same update and the Layers panel brings its row into view — once per
// request, so a repeated click scrolls again but ordinary edits never pull the
// list away from where the user scrolled. Ids the frame's tree does not hold
// yet stay pending and open as soon as a tree that contains them arrives.

import type { DesignRuntimeTreeNode } from "@zeros/protocol/design-runtime";
import { create } from "zustand";

import { designLayerRevealPaths } from "../design-layer-tree";
import { isValidDesignNodeId } from "./design-workspace-ui";

const MAX_WORKSPACES = 8;
const MAX_FRAMES_PER_WORKSPACE = 24;
/** Deep trees stay bounded; the oldest expansions fall out first. */
const MAX_EXPANDED_NODE_IDS = 512;
/** A marquee can select many layers; only this many wait for a later tree. */
const MAX_PENDING_REVEAL_NODE_IDS = 64;

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

export interface DesignLayerRevealRequest {
  /** Increases with every request, so the same selection can scroll again. */
  readonly nonce: number;
  readonly frame: string;
  /** Primary-first selection; empty brings the frame's own row into view. */
  readonly nodeIds: readonly string[];
  /** Requested ids the frame's tree did not contain yet. */
  readonly pendingNodeIds: readonly string[];
}

interface DesignLayerDisclosureStore {
  byWorkspace: Record<string, DesignWorkspaceDisclosure>;
  /** The latest reveal per workspace; bounded like `byWorkspace`. */
  revealByWorkspace: Record<string, DesignLayerRevealRequest>;
  updateFrame(
    workspaceId: string,
    frame: string,
    update: (current: DesignFrameDisclosure) => DesignFrameDisclosure,
  ): void;
  /** Open a path and publish its reveal request in one update. */
  applyReveal(
    workspaceId: string,
    frame: string,
    update: ((current: DesignFrameDisclosure) => DesignFrameDisclosure) | null,
    request: (
      current: DesignLayerRevealRequest | undefined,
    ) => DesignLayerRevealRequest | undefined,
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

/** Apply one frame's disclosure update to the workspace map, bounded per owner.
 * Returns the same map when nothing visible changes. */
function withFrameDisclosure(
  byWorkspace: Record<string, DesignWorkspaceDisclosure>,
  workspaceId: string,
  frame: string,
  update: (current: DesignFrameDisclosure) => DesignFrameDisclosure,
): Record<string, DesignWorkspaceDisclosure> {
  const workspace = byWorkspace[workspaceId];
  const current = workspace?.frames[frame] ?? EMPTY_DESIGN_FRAME_DISCLOSURE;
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
    if (workspace?.frames[frame]) return byWorkspace;
    if (isClosed(next)) return byWorkspace;
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
    ...byWorkspace,
    [workspaceId]: nextWorkspace,
  })
    .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
    .map(([id]) => id)
    .slice(-MAX_WORKSPACES);
  return keepNewest(
    { ...byWorkspace, [workspaceId]: nextWorkspace },
    workspaceOrder,
  );
}

function withRevealRequest(
  revealByWorkspace: Record<string, DesignLayerRevealRequest>,
  workspaceId: string,
  request: DesignLayerRevealRequest | undefined,
): Record<string, DesignLayerRevealRequest> {
  const current = revealByWorkspace[workspaceId];
  if (current === request) return revealByWorkspace;
  if (!request) {
    if (!current) return revealByWorkspace;
    const next = { ...revealByWorkspace };
    delete next[workspaceId];
    return next;
  }
  const next = { ...revealByWorkspace, [workspaceId]: request };
  const newest = Object.entries(next)
    .sort((left, right) => left[1].nonce - right[1].nonce)
    .map(([id]) => id)
    .slice(-MAX_WORKSPACES);
  return keepNewest(next, newest);
}

export const useDesignLayerDisclosureStore = create<DesignLayerDisclosureStore>(
  (set) => ({
    byWorkspace: {},
    revealByWorkspace: {},

    updateFrame(workspaceId, frame, update) {
      if (!workspaceId || !frame) return;
      set((state) => {
        const byWorkspace = withFrameDisclosure(
          state.byWorkspace,
          workspaceId,
          frame,
          update,
        );
        return byWorkspace === state.byWorkspace ? state : { byWorkspace };
      });
    },

    applyReveal(workspaceId, frame, update, request) {
      if (!workspaceId || !frame) return;
      set((state) => {
        const byWorkspace = update
          ? withFrameDisclosure(state.byWorkspace, workspaceId, frame, update)
          : state.byWorkspace;
        const revealByWorkspace = withRevealRequest(
          state.revealByWorkspace,
          workspaceId,
          request(state.revealByWorkspace[workspaceId]),
        );
        if (
          byWorkspace === state.byWorkspace &&
          revealByWorkspace === state.revealByWorkspace
        ) {
          return state;
        }
        return { byWorkspace, revealByWorkspace };
      });
    },

    /** Close every frame and every container the workspace holds open. One
     * action, so the panel cannot leave a frame behind. */
    collapseWorkspace(workspaceId) {
      set((state) => {
        // A path still waiting for its tree must not reopen after Collapse all.
        const reveal = state.revealByWorkspace[workspaceId];
        const revealByWorkspace =
          reveal && reveal.pendingNodeIds.length > 0
            ? withRevealRequest(state.revealByWorkspace, workspaceId, {
                ...reveal,
                pendingNodeIds: [],
              })
            : state.revealByWorkspace;
        const workspace = state.byWorkspace[workspaceId];
        if (!workspace || Object.values(workspace.frames).every(isClosed)) {
          return revealByWorkspace === state.revealByWorkspace
            ? state
            : { revealByWorkspace };
        }
        const byWorkspace = { ...state.byWorkspace };
        delete byWorkspace[workspaceId];
        return { byWorkspace, revealByWorkspace };
      });
    },

    forgetWorkspace(workspaceId) {
      set((state) => {
        if (
          !(workspaceId in state.byWorkspace) &&
          !(workspaceId in state.revealByWorkspace)
        ) {
          return state;
        }
        const byWorkspace = { ...state.byWorkspace };
        delete byWorkspace[workspaceId];
        const revealByWorkspace = { ...state.revealByWorkspace };
        delete revealByWorkspace[workspaceId];
        return { byWorkspace, revealByWorkspace };
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
 * expansions are the ones retained when a huge tree hits the cap. Folding
 * also drops a path in this frame still waiting for its tree: until that tree
 * arrives nobody can tell whether the fold covers it, and the user's fold must
 * not be reopened behind their back. */
export function toggleDesignLayerExpanded(
  workspaceId: string,
  frame: string,
  nodeId: string,
): void {
  const folding = designFrameDisclosure(
    workspaceId,
    frame,
  ).expandedNodeIds.includes(nodeId);
  useDesignLayerDisclosureStore.getState().applyReveal(
    workspaceId,
    frame,
    (current) =>
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
    (current) =>
      folding && current?.frame === frame && current.pendingNodeIds.length > 0
        ? { ...current, pendingNodeIds: [] }
        : current,
  );
}

function openDesignLayerPath(
  current: DesignFrameDisclosure,
  ancestorNodeIds: readonly string[],
): DesignFrameDisclosure {
  const missing = ancestorNodeIds.filter(
    (nodeId) => !current.expandedNodeIds.includes(nodeId),
  );
  if (missing.length === 0 && current.treeExpanded) return current;
  return {
    treeExpanded: true,
    expandedNodeIds: [...current.expandedNodeIds, ...missing],
  };
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
    .updateFrame(workspaceId, frame, (current) =>
      openDesignLayerPath(current, ancestorNodeIds),
    );
}

let revealNonce = 0;

/** Reveal a selection made for the user — a canvas click, keyboard travel, a
 * marquee, a new or moved layer. Its frame and every container above its
 * layers open in one update, and the Layers panel brings the primary row into
 * view (see `useDesignLayerRevealRequest`). Selecting only the frame, or the
 * root that shares the frame's row, scrolls to that row without unfolding the
 * frame. Ids the tree does not hold yet wait for `settleDesignLayerReveal`. */
export function requestDesignLayerReveal(input: {
  workspaceId: string;
  frame: string;
  /** Primary first; empty reveals the frame row. */
  nodeIds: readonly string[];
  /** The frame's current runtime tree, when it has reported one. */
  tree: readonly DesignRuntimeTreeNode[] | null | undefined;
  /** The node the frame row stands for (its seeded root or body), if known. */
  frameRowNodeId?: string | null;
}): void {
  const { workspaceId, frame } = input;
  if (!workspaceId || !frame) return;
  const nodeIds = [...new Set(input.nodeIds.filter(isValidDesignNodeId))];
  const layerNodeIds = nodeIds.filter(
    (nodeId) => nodeId !== input.frameRowNodeId,
  );
  const { ancestorIds, found } = designLayerRevealPaths(
    input.tree ?? [],
    layerNodeIds,
  );
  const pendingNodeIds = layerNodeIds
    .filter((nodeId) => !found.has(nodeId))
    .slice(0, MAX_PENDING_REVEAL_NODE_IDS);
  revealNonce += 1;
  const request: DesignLayerRevealRequest = {
    nonce: revealNonce,
    frame,
    nodeIds,
    pendingNodeIds,
  };
  useDesignLayerDisclosureStore
    .getState()
    .applyReveal(
      workspaceId,
      frame,
      layerNodeIds.length > 0
        ? (current) => openDesignLayerPath(current, ancestorIds)
        : null,
      () => request,
    );
}

/** A later tree for the revealed frame opens the paths that were still
 * pending. It never republishes the request, so it cannot scroll twice. */
export function settleDesignLayerReveal(
  workspaceId: string | null | undefined,
  frame: string,
  tree: readonly DesignRuntimeTreeNode[] | null | undefined,
): void {
  if (!workspaceId || !tree) return;
  const store = useDesignLayerDisclosureStore.getState();
  const request = store.revealByWorkspace[workspaceId];
  if (
    !request ||
    request.frame !== frame ||
    request.pendingNodeIds.length === 0
  ) {
    return;
  }
  const { ancestorIds, found } = designLayerRevealPaths(
    tree,
    request.pendingNodeIds,
  );
  if (found.size === 0) return;
  store.applyReveal(
    workspaceId,
    frame,
    (current) => openDesignLayerPath(current, ancestorIds),
    (current) =>
      current?.nonce === request.nonce
        ? {
            ...current,
            pendingNodeIds: current.pendingNodeIds.filter(
              (nodeId) => !found.has(nodeId),
            ),
          }
        : current,
  );
}

/** The latest reveal request for this workspace, or null. */
export function useDesignLayerRevealRequest(
  workspaceId: string | null | undefined,
): DesignLayerRevealRequest | null {
  return useDesignLayerDisclosureStore((state) =>
    workspaceId ? (state.revealByWorkspace[workspaceId] ?? null) : null,
  );
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
 * reopening it restores the exact shape the user built. Folding also drops a
 * path still waiting for this frame's tree: the user's fold wins over it. */
export function toggleDesignFrameTreeExpanded(
  workspaceId: string,
  frame: string,
): void {
  const store = useDesignLayerDisclosureStore.getState();
  const folding = designFrameDisclosure(workspaceId, frame).treeExpanded;
  store.applyReveal(
    workspaceId,
    frame,
    (current) => ({
      ...current,
      treeExpanded: !current.treeExpanded,
    }),
    (current) =>
      folding && current?.frame === frame && current.pendingNodeIds.length > 0
        ? { ...current, pendingNodeIds: [] }
        : current,
  );
}

export function collapseAllDesignLayers(workspaceId: string): void {
  useDesignLayerDisclosureStore.getState().collapseWorkspace(workspaceId);
}

export function forgetDesignLayerDisclosure(workspaceId: string): void {
  useDesignLayerDisclosureStore.getState().forgetWorkspace(workspaceId);
}

export function resetDesignLayerDisclosureForTests(): void {
  useDesignLayerDisclosureStore.setState({
    byWorkspace: {},
    revealByWorkspace: {},
  });
}
