// ──────────────────────────────────────────────────────────
// Conversation pane panes — shared stores & constants
// ──────────────────────────────────────────────────────────
//
// Lives in its own module so the pane tree (conversation/pane-layout), the
// per-pane tab strip (conversation/chat-tabs) and the terminal deck
// (conversation/terminal-deck) can share state without import cycles
// (the tree imports the strip, so the strip can't import the tree).

import { create } from "zustand";

import type { PaneNode, SplitDirection } from "../../state/chat-panes";

/** dataTransfer MIME for a dragged chat tab. Presence of this type is
 *  how pane drop overlays recognize our drags vs. arbitrary content. */
export const CHAT_TAB_DRAG_MIME = "application/x-zeros-chat-tab";

/** Pixel floors a pane can never shrink below — also the gate for
 *  offering a split (a pane must fit TWO of these plus the divider).
 *  Width is the product floor for one responsive chat surface; height covers
 *  the strip + a usable slice of conversation + composer. Split availability
 *  and seam clamping both consume this value, so a new or resized split cannot
 *  make either chat narrower than the composer breakpoints are designed for. */
export const MIN_PANE_WIDTH = 360;
export const MIN_PANE_HEIGHT = 160;
/** The rendered `w-1.5` / `h-1.5` divider occupies six layout pixels. */
export const PANE_SPLITTER_PX = 6;

export interface PaneTreeMinimumSize {
  width: number;
  height: number;
}

function combinePaneMinimumSizes(
  direction: SplitDirection,
  first: PaneTreeMinimumSize,
  second: PaneTreeMinimumSize,
): PaneTreeMinimumSize {
  if (direction === "row") {
    return {
      width: first.width + PANE_SPLITTER_PX + second.width,
      height: Math.max(first.height, second.height),
    };
  }
  return {
    width: Math.max(first.width, second.width),
    height: first.height + PANE_SPLITTER_PX + second.height,
  };
}

/** The physical box required by a persisted split tree. A row adds both
 * child widths; a column only needs the wider child. Keeping this recursive
 * (instead of multiplying the total leaf count) matters for mixed layouts:
 * two vertically stacked chats beside one chat need 726px, not 1092px. */
export function paneTreeMinimumSize(node: PaneNode): PaneTreeMinimumSize {
  if (node.type === "leaf") {
    return { width: MIN_PANE_WIDTH, height: MIN_PANE_HEIGHT };
  }

  const first = paneTreeMinimumSize(node.first);
  const second = paneTreeMinimumSize(node.second);
  return combinePaneMinimumSizes(node.direction, first, second);
}

export function paneTreeHasDirection(
  node: PaneNode,
  direction: SplitDirection,
): boolean {
  return (
    node.type === "split" &&
    (node.direction === direction ||
      paneTreeHasDirection(node.first, direction) ||
      paneTreeHasDirection(node.second, direction))
  );
}

function projectPaneTreeSplit(
  node: PaneNode,
  targetPaneId: string,
  direction: SplitDirection,
): PaneNode | null {
  if (node.type === "leaf") {
    if (node.id !== targetPaneId) return null;
    return {
      type: "split",
      id: "\u0000projected-split",
      direction,
      ratio: 0.5,
      first: node,
      second: { type: "leaf", id: "\u0000projected-pane" },
    };
  }
  const first = projectPaneTreeSplit(node.first, targetPaneId, direction);
  if (first) return { ...node, first };
  const second = projectPaneTreeSplit(node.second, targetPaneId, direction);
  return second ? { ...node, second } : null;
}

function removeProjectedPane(
  node: PaneNode,
  paneId: string,
): { root: PaneNode | null; removed: boolean } {
  if (node.type === "leaf") {
    return node.id === paneId
      ? { root: null, removed: true }
      : { root: node, removed: false };
  }

  const first = removeProjectedPane(node.first, paneId);
  if (first.removed) {
    return {
      root: first.root ? { ...node, first: first.root } : node.second,
      removed: true,
    };
  }
  const second = removeProjectedPane(node.second, paneId);
  if (!second.removed) return { root: node, removed: false };
  return {
    root: second.root ? { ...node, second: second.root } : node.first,
    removed: true,
  };
}

/** Minimum outer surface after splitting one specific leaf. This evaluates the
 * hypothetical tree without mutating layout state or minting pane/split ids. */
export function paneTreeMinimumSizeAfterSplit(
  node: PaneNode,
  targetPaneId: string,
  direction: SplitDirection,
  collapsedPaneId?: string,
): PaneTreeMinimumSize | null {
  if (collapsedPaneId) {
    // A cross-pane drop can move the source pane's only tab. That source will
    // collapse in the same operation, so capacity must describe the final tree
    // rather than briefly charging for an extra phantom leaf.
    if (collapsedPaneId === targetPaneId) return null;
    const projected = projectPaneTreeSplit(node, targetPaneId, direction);
    if (!projected) return null;
    const collapsed = removeProjectedPane(projected, collapsedPaneId);
    return collapsed.removed && collapsed.root
      ? paneTreeMinimumSize(collapsed.root)
      : null;
  }
  if (node.type === "leaf") {
    if (node.id !== targetPaneId) return null;
    const leafMinimum = paneTreeMinimumSize(node);
    return combinePaneMinimumSizes(direction, leafMinimum, leafMinimum);
  }

  const first = paneTreeMinimumSizeAfterSplit(
    node.first,
    targetPaneId,
    direction,
  );
  if (first) {
    return combinePaneMinimumSizes(
      node.direction,
      first,
      paneTreeMinimumSize(node.second),
    );
  }
  const second = paneTreeMinimumSizeAfterSplit(
    node.second,
    targetPaneId,
    direction,
  );
  return second
    ? combinePaneMinimumSizes(
        node.direction,
        paneTreeMinimumSize(node.first),
        second,
      )
    : null;
}

export interface PaneTreeSplitRequest {
  root: PaneNode;
  targetPaneId: string;
  direction: SplitDirection;
  containerWidth: number;
  containerHeight: number;
  /** The widest the pane surface can BECOME without resizing the window —
   *  its current width plus the room Workbench can legitimately give up. Only
   *  the first horizontal split is allowed to consume it; omit it (or pass a
   *  non-finite value) and the current width is the only budget. */
  growableWidth?: number;
  /** A different source leaf that this split/drop will empty and collapse. */
  collapsedPaneId?: string;
}

/** Split availability is based on the whole resulting tree, not the current
 * leaf's width. The first horizontal split is the deliberate exception: the
 * conversation column may grow toward the resulting intrinsic width, borrowing
 * room from Workbench. Once any horizontal split exists, another is offered
 * only after the current conversation surface already fits the next tree.
 *
 * That exception is bounded by what is actually REACHABLE. Growth stops at
 * Workbench's own 200px floor (repository navigation is a fixed 248px and the
 * window itself floors at 840px), so an unconditional "the first right split
 * always fits" offered a split that no layout can honor: two 360px leaves plus
 * their seam need 726px, and a minimum-width window can only ever hand the
 * conversation column 392px. Accepting it produced a clipped row that
 * `clampConversationRatio` then refused to drag back. */
export function canSplitPaneTree({
  root,
  targetPaneId,
  direction,
  containerWidth,
  containerHeight,
  growableWidth,
  collapsedPaneId,
}: PaneTreeSplitRequest): boolean {
  const nextMinimum = paneTreeMinimumSizeAfterSplit(
    root,
    targetPaneId,
    direction,
    collapsedPaneId,
  );
  if (!nextMinimum) return false;
  if (direction !== "row") {
    return (
      Number.isFinite(containerHeight) && containerHeight >= nextMinimum.height
    );
  }
  const budgets = [containerWidth];
  if (!paneTreeHasDirection(root, "row")) budgets.push(growableWidth ?? NaN);
  const available = Math.max(
    ...budgets.filter((value) => Number.isFinite(value)),
  );
  return Number.isFinite(available) && available >= nextMinimum.width;
}

/** The widest the pane surface can get without resizing the window: its own
 * width plus whatever Workbench can surrender above its floor. A collapsed
 * Workbench (width 0) contributes nothing because the conversation column
 * already owns the whole row. Non-finite input yields NaN so the caller's gate
 * falls back to the measured width alone rather than an invented budget. */
export function growablePaneSurfaceWidth(
  surfaceWidth: number,
  workbenchWidth: number,
  workbenchMinWidth: number,
): number {
  if (!Number.isFinite(surfaceWidth)) return Number.NaN;
  if (!Number.isFinite(workbenchWidth) || !Number.isFinite(workbenchMinWidth)) {
    return surfaceWidth;
  }
  return surfaceWidth + Math.max(0, workbenchWidth - workbenchMinWidth);
}

export function canSplitPaneDimension(
  size: number,
  minPaneSize: number,
): boolean {
  return (
    Number.isFinite(size) &&
    Number.isFinite(minPaneSize) &&
    minPaneSize > 0 &&
    size >= minPaneSize * 2 + PANE_SPLITTER_PX
  );
}

/** Convert a pointer offset into the grow ratio for the two FLEXIBLE children.
 * The fixed divider is not part of their available width/height, so subtract
 * it before calculating both the ratio and pixel floors. */
export function clampPaneSplitRatio(
  pointerOffset: number,
  containerSize: number,
  firstMinPaneSize: number,
  secondMinPaneSize = firstMinPaneSize,
): number | null {
  if (
    !Number.isFinite(pointerOffset) ||
    !Number.isFinite(containerSize) ||
    containerSize <= PANE_SPLITTER_PX ||
    !Number.isFinite(firstMinPaneSize) ||
    firstMinPaneSize <= 0 ||
    !Number.isFinite(secondMinPaneSize) ||
    secondMinPaneSize <= 0
  ) {
    return null;
  }
  const available = containerSize - PANE_SPLITTER_PX;
  const combinedMinimum = firstMinPaneSize + secondMinPaneSize;
  if (available < combinedMinimum) {
    // CSS owns truly impossible geometry. Preserve the relative subtree
    // requirements instead of arbitrarily squeezing an asymmetric tree 50/50.
    return Math.min(0.9, Math.max(0.1, firstMinPaneSize / combinedMinimum));
  }
  const raw = (pointerOffset - PANE_SPLITTER_PX / 2) / available;
  const minRatio = Math.max(0.1, firstMinPaneSize / available);
  const maxRatio = Math.min(0.9, 1 - secondMinPaneSize / available);
  return Math.min(maxRatio, Math.max(minRatio, raw));
}

/** Both the React-owned mount point and the stable, store-owned portal host
 *  cover the pane body. They must be transparent to hit testing so an empty or
 *  inactive terminal layer cannot block the chat composer underneath; the
 *  visible terminal layer opts back in with `pointer-events-auto`. */
export const PANE_TERMINAL_HOST_CLS = "pointer-events-none absolute inset-0";

export interface TabDragState {
  chatId: string;
  fromPaneId: string;
  folder: string;
}

/** The chat tab currently being dragged (HTML5 DnD), or null. Drop
 *  overlays mount on every pane of the same workspace while set. */
export const useTabDragStore = create<{
  drag: TabDragState | null;
  setDrag: (drag: TabDragState | null) => void;
}>((set) => ({
  drag: null,
  setDrag: (drag) => set({ drag }),
}));

// Drag activation is deferred by one animation frame (see TabRow) because a
// synchronous store update during dragstart can make Chromium abort the drag.
// This non-rendering epoch lets a blur/drop/dragend invalidate that pending
// callback even when cancellation happens before the store has been populated.
let tabDragEpoch = 0;

export function armTabDrag(): number {
  tabDragEpoch += 1;
  return tabDragEpoch;
}

export function isTabDragArmCurrent(epoch: number): boolean {
  return epoch === tabDragEpoch;
}

// Safety net: clear the drag state on ANY dragend/drop reaching the
// window. The source tab's own dragend handler is the primary path,
// but it never fires when the tab was unmounted mid-drag (the browser
// targets a detached node) — without this, the full-pane drop overlays
// would keep swallowing clicks. Runs after React's own drop handling
// (root-container listeners sit below window in the bubble path), so
// the overlay reads the drag state before this wipes it.
export function clearTabDrag(): void {
  tabDragEpoch += 1;
  const store = useTabDragStore.getState();
  if (store.drag) store.setDrag(null);
}

if (typeof window !== "undefined") {
  window.addEventListener("dragend", clearTabDrag);
  window.addEventListener("drop", clearTabDrag);
  // A native-window blur can cancel Chromium's drag without delivering a
  // usable dragend to the detached source tab. Never leave the z-40 pane
  // overlays armed when the app loses focus.
  window.addEventListener("blur", clearTabDrag);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") clearTabDrag();
    });
  }
}

export interface PanePortalSlot {
  host: HTMLElement | null;
  activeChatId: string | null;
}

/** Per-pane portal registry. `host` is a store-owned DOM node rather than the
 *  React-owned mount point rendered by ChatPane: when a split reshapes the
 *  recursive tree, the replacement ChatPane reparents this SAME node into its
 *  new mount point. The terminal deck therefore keeps one portal container
 *  identity (and one xterm instance) across split/collapse churn. */
export const usePanePortalsStore = create<{
  panes: Record<string, PanePortalSlot>;
  setSlot: (paneId: string, slot: Partial<PanePortalSlot>) => void;
  getOrCreateHost: (paneId: string) => HTMLElement | null;
  clearSlot: (paneId: string) => void;
}>((set, get) => ({
  panes: {},
  setSlot: (paneId, slot) =>
    set((s) => {
      const prev = s.panes[paneId] ?? { host: null, activeChatId: null };
      return { panes: { ...s.panes, [paneId]: { ...prev, ...slot } } };
    }),
  getOrCreateHost: (paneId) => {
    const existing = get().panes[paneId]?.host;
    if (existing) return existing;
    if (typeof document === "undefined") return null;

    const host = document.createElement("div");
    host.className = PANE_TERMINAL_HOST_CLS;
    host.dataset.paneTerminalHost = "";
    get().setSlot(paneId, { host });
    return host;
  },
  clearSlot: (paneId) =>
    set((s) => {
      const existing = s.panes[paneId];
      if (!existing || existing.activeChatId === null) return s;
      // Keep the store-owned host (and its portaled transcript/xterm DOM)
      // detached while a pane/workspace is inactive. A replacement pane
      // reparents this same node on return; only visibility/activity clears.
      return {
        panes: {
          ...s.panes,
          [paneId]: { ...existing, activeChatId: null },
        },
      };
    }),
}));

/** Tear down retained portal hosts after their pane owner is permanently
 * deleted. Ordinary split collapse keeps hosts for fast restoration; owner
 * deletion is the explicit exception. */
export function destroyPanePortalSlots(paneIds: readonly string[]): void {
  const removed = new Set(paneIds.filter(Boolean));
  if (removed.size === 0) return;
  usePanePortalsStore.setState((state) => {
    const entries = Object.entries(state.panes);
    if (!entries.some(([paneId]) => removed.has(paneId))) return state;
    for (const [paneId, slot] of entries) {
      if (!removed.has(paneId)) continue;
      if (slot.host && typeof slot.host.remove === "function") {
        slot.host.remove();
      }
    }
    return {
      panes: Object.fromEntries(
        entries.filter(([paneId]) => !removed.has(paneId)),
      ),
    };
  });
}
