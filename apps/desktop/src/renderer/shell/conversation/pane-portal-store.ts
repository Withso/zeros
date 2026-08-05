// ──────────────────────────────────────────────────────────
// Conversation pane panes — shared stores & constants
// ──────────────────────────────────────────────────────────
//
// Lives in its own module so the pane tree (conversation/pane-layout), the
// per-pane tab strip (conversation/chat-tabs) and the terminal deck
// (conversation/terminal-deck) can share state without import cycles
// (the tree imports the strip, so the strip can't import the tree).

import { create } from "zustand";

/** dataTransfer MIME for a dragged chat tab. Presence of this type is
 *  how pane drop overlays recognize our drags vs. arbitrary content. */
export const CHAT_TAB_DRAG_MIME = "application/x-zeros-chat-tab";

/** Pixel floors a pane can never shrink below — also the gate for
 *  offering a split (a pane must fit TWO of these plus the divider).
 *  Width covers the strip's fixed controls + one min-width tab; height
 *  covers the strip + a usable slice of conversation + composer. */
export const MIN_PANE_WIDTH = 200;
export const MIN_PANE_HEIGHT = 160;

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
