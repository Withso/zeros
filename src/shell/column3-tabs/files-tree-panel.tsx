// ──────────────────────────────────────────────────────────
// FilesTreePanel — the collapsed File tab's tree + search POPUP
// ──────────────────────────────────────────────────────────
//
// Collapsed mode gives the open file the full tab width, so browsing needs
// a transient surface: a popup under the header row, left-aligned to the
// tab (80% of its width), hosting the same gitignore-aware workspace tree
// the expanded sidebar shows behind a quick-open-style filter row.
//
// A POPUP, not a pane: it wears the popover recipe (bg3 + border2 +
// rounded-lg + --shadow-dropdown — the quick-open menu's surface, with the
// tree re-based onto it via surface="overlay"), floats inset from the tab's
// edges with the list padded on all sides, and its height is captured ONCE
// from the tab body at open time (treePanelHeight) — resizing the column
// while it is up must not reflow it, so the trigger measures and the result
// rides in as a fixed `height`.
//
// It is a LAUNCHER, not a second sidebar: the tree runs in deselectAfterOpen
// mode with no selection mirror, so every row click — including a re-click
// of the file that is already open — fires onOpenFile, and the parent closes
// the panel immediately on any open.
//
// The filter input OWNS focus for the popup's lifetime: tree clicks have
// their focus steal cancelled at mousedown (except on the virtualized
// scroller itself, where cancelling would kill scrollbar drags), and any
// focus that still lands inside the panel — or drops to nowhere — bounces
// back to the input (shouldRestoreTreePanelFocus). Focus leaving for a real
// outside surface is respected; those interactions dismiss the popup anyway.
//
// Dismissal: Escape (a live filter clears first; the next Escape dismisses
// and returns focus to the trigger), the transparent backdrop over the tab's
// content band, or any pointerdown outside the panel (the trigger is exempt
// so its own click stays a toggle). Pointer dismissals do NOT restore
// trigger focus — the pointer already said where focus goes next. FilesTab's
// render gate + effect also close it when the real tree expands, the file
// closes, or the tab changes.
// ──────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";

import {
  shouldRestoreTreePanelFocus,
  TREE_PANEL_TOP_OFFSET,
} from "./files-tab-layout";
import {
  WorkspaceFileTree,
  type WorkspaceFileTreeHandle,
} from "./workspace-file-tree";

/** How a dismissal was driven — keyboard dismissals restore trigger focus in
 *  the parent, pointer dismissals leave focus where the pointer put it. */
export type TreePanelDismissSource = "keyboard" | "pointer";

interface FilesTreePanelProps {
  /** Workspace/worktree folder whose files to list. */
  cwd: string | undefined;
  /** Shared live-refresh generation (the parent tab's git refresh bus). */
  reloadKey: number;
  /** The popup's fixed height, measured from the tab body when the trigger
   *  fired (treePanelHeight). Frozen for this open — that is what makes it a
   *  popup rather than a pane tracking the column. */
  height: number;
  /** Elements exempt from outside-pointerdown dismissal (the header trigger,
   *  so its own click toggles instead of dismiss-then-reopen). */
  dismissIgnoreRef?: { readonly current: HTMLElement | null };
  /** A FILE row was activated — the parent routes it and closes the panel. */
  onOpenFile: (path: string) => void;
  /** Context-menu "Open in new tab" — the parent routes it and closes. */
  onOpenInNewTab: (path: string) => void;
  /** Backdrop / outside pointerdown ("pointer") or Escape with an empty
   *  filter ("keyboard" — the parent restores focus to the trigger). */
  onDismiss: (source: TreePanelDismissSource) => void;
}

/** Is `node` inside `root`, crossing open shadow boundaries? `contains()`
 *  alone answers false for shadow-interior nodes, and blur/focusout related
 *  targets are only retargeted to the host when the browser says so. */
function nodeWithin(root: Element, node: Node | null): boolean {
  for (let current: Node | null = node; current; ) {
    if (current === root) return true;
    current =
      current.parentNode ??
      (current instanceof ShadowRoot ? current.host : null);
  }
  return false;
}

export function FilesTreePanel({
  cwd,
  reloadKey,
  height,
  dismissIgnoreRef,
  onOpenFile,
  onOpenInNewTab,
  onDismiss,
}: FilesTreePanelProps) {
  // Ephemeral to this open — the panel always starts unfiltered, at the
  // tree's root, with the filter input focused (no scroll memory either:
  // it's a quick-open surface, not a browsing position to restore).
  const [search, setSearch] = useState("");
  const treeRef = useRef<WorkspaceFileTreeHandle | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /** Drive the tree's stable model directly — typing never re-lists. */
  const handleSearchChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = event.currentTarget.value;
      setSearch(value);
      treeRef.current?.setSearch(value);
    },
    [],
  );

  /** Enter advances through matches (Shift+Enter reverses) — the same
   *  bridge the expanded sidebar's header search uses. */
  const handleSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (event.shiftKey) treeRef.current?.focusPreviousSearchMatch();
      else treeRef.current?.focusNextSearchMatch();
    },
    [],
  );

  /** One Escape clears a live filter; on an empty filter it dismisses.
   *  Handled on the panel (keyboard events compose out of the tree's
   *  shadow root), so Escape works from the rows too. */
  const handlePanelKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (search) {
        setSearch("");
        treeRef.current?.setSearch("");
        return;
      }
      onDismiss("keyboard");
    },
    [search, onDismiss],
  );

  // A popup dismisses on ANY pointerdown outside itself — including the
  // header band above the backdrop and surfaces beyond this tab. Capture
  // phase, so the panel is gone before the outside target reacts; the
  // trigger is exempt or its toggle click would dismiss-then-reopen.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      const path = event.composedPath();
      if (path.includes(panel)) return;
      const exempt = dismissIgnoreRef?.current;
      if (exempt && path.includes(exempt)) return;
      onDismissRef.current("pointer");
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [dismissIgnoreRef]);

  /** Keep the filter input focused through tree clicks by cancelling the
   *  mousedown focus steal at the source — no blur, no ring flicker. The
   *  one exception is the virtualized scroller element itself: a scrollbar
   *  hit targets it directly, and preventing THAT default kills scrollbar
   *  dragging (the focusout recovery below covers its focus drop instead). */
  const handleTreeMouseDownCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.nativeEvent.composedPath()[0];
      if (
        target instanceof Element &&
        target.hasAttribute("data-file-tree-virtualized-scroll")
      )
        return;
      event.preventDefault();
    },
    [],
  );

  /** Focusout recovery: bounce focus back to the input unless it left for a
   *  real surface outside the panel (deferred a frame so the browser finishes
   *  its own transfer first — fighting it mid-flight is unreliable). */
  const handlePanelBlur = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      const panel = panelRef.current;
      if (!panel) return;
      const related = event.relatedTarget as Node | null;
      const relatedInside =
        related === null ? null : nodeWithin(panel, related);
      if (!shouldRestoreTreePanelFocus(relatedInside)) return;
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [],
  );

  return (
    <>
      {/* Backdrop over the rest of the content band: swallows in-tab clicks
          so a dismissal can't also land in the editor underneath. Transparent:
          the file content stays readable behind the popup. */}
      <div
        data-testid="files-tree-panel-backdrop"
        className="absolute inset-x-0 top-9 bottom-0 z-30"
        onPointerDown={() => onDismiss("pointer")}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        data-testid="files-tree-panel"
        role="dialog"
        aria-label="Search workspace files"
        onKeyDown={handlePanelKeyDown}
        onBlur={handlePanelBlur}
        style={{ top: TREE_PANEL_TOP_OFFSET, height }}
        className="bg-bg3 border-border2 absolute left-2 z-40 flex w-4/5 max-w-[calc(100%-16px)] min-w-[240px] flex-col overflow-hidden rounded-lg border shadow-[var(--shadow-dropdown)]"
      >
        {/* The quick-open menu's search row: icon + borderless input over a
            full-width separator (the CommandInput recipe). */}
        <div className="border-border2 flex h-9 shrink-0 items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 opacity-50" />
          <input
            ref={inputRef}
            autoFocus
            aria-label="Search workspace files"
            placeholder="Search…"
            value={search}
            onChange={handleSearchChange}
            onKeyDown={handleSearchKeyDown}
            className="placeholder:text-fg2 text-fg1 h-full min-w-0 flex-1 bg-transparent text-xs outline-hidden"
          />
        </div>
        <div
          className="min-h-0 flex-1 p-1"
          onMouseDownCapture={handleTreeMouseDownCapture}
        >
          <WorkspaceFileTree
            ref={treeRef}
            cwd={cwd}
            reloadKey={reloadKey}
            surface="overlay"
            deselectAfterOpen
            onOpenFile={onOpenFile}
            onOpenInNewTab={onOpenInNewTab}
          />
        </div>
      </div>
    </>
  );
}
