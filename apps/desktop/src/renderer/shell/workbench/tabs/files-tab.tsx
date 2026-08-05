// ──────────────────────────────────────────────────────────
// FilesTab — workbench file surface: All-Files sidebar + viewer
// ──────────────────────────────────────────────────────────
//
// A workbench File tab is a shared header over an optional two-pane surface:
//   Header: tree toggle + search + working folders + file breadcrumb + viewer
//           controls in one continuous chrome row.
//   Left:  the gitignore-aware workspace file tree (WorkspaceFileTree). Its
//          selection MIRRORS the tab's open file, and
//          clicking another file navigates THIS tab in place (via
//          useOpenFileInWorkbench, so dirty-draft protection and the active-tab
//          policy hold). Right-click → "Open in new tab" spawns a separate
//          File tab.
//   Seam:  a full-height 1px divider (it splits the header band too, aligned
//          with the tree column's edge) that doubles as a drag handle; the
//          width is one shared, persisted preference (files-sidebar-width).
//   Right: FileViewer — the file's content (Edit / Preview / Diff).
// Blank tabs omit the viewer and seam entirely, leaving a full-width tree.
// Collapsed tabs swap the header controls to a tree toggle + a Search
// trigger that floats a transient tree/filter POPUP over the full-width
// content (files-tree-panel) — quick file jumps without re-expanding — and
// keep the working-folders picker alongside them: sparse-checkout rewrites the
// whole worktree, so it is a workspace action, not a tree-only affordance.
//
// Clean tabs can be reused in place; a tab with an unsaved editor is
// retained separately so switching to another File/Terminal/Browser cannot
// destroy its draft.
// ──────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useRef, useState } from "react";
import { FolderTree, Search } from "lucide-react";

import { useActiveWorkspace } from "@/renderer/state/use-active-workspace";
import { isLocalMainWorkspace } from "@/renderer/state/local-main-workspace";
import { useWorkspaceDispatch } from "@/renderer/state/store";
import { Button, Input, Tooltip } from "@/renderer/shared/ui/primitives";
import { cn } from "@/renderer/shared/ui/cn";
import { useChatCwd } from "../../use-chat-cwd";
import { useGitRefreshKey } from "../../use-git-refresh-key";
import { useOpenFileInWorkbench } from "../use-open-file";
import { createFilesTab, type WorkbenchTab } from "../tab-model";
import { useFilesSidebarFraction } from "./files-sidebar-width";
import { useSidebarResizeDrag } from "./use-sidebar-drag";
import { useResizeHint } from "../../use-resize-hint";
import { FileViewer } from "./file-viewer";
import {
  FilesTreePanel,
  type TreePanelDismissSource,
} from "./files-tree-panel";
import { resolveFilesTabLayout, treePanelHeight } from "./files-tab-layout";
import {
  WorkspaceFileTree,
  type WorkspaceFileTreeHandle,
} from "./workspace-file-tree";
import {
  canPickWorkingDirectories,
  WorkingDirectoriesPopover,
} from "./working-directories-popover";
import { treeSelectionMirrorTarget } from "./tree-paths";

interface TabBodyProps {
  tab: WorkbenchTab;
  active: boolean;
  scope?: string;
}

// Memoised: the workbench body switch re-renders on unrelated tab/store changes;
// FileViewer's read effect is deps-guarded so it won't re-read, but this also
// skips the wasted render work. (React.memo does NOT block context updates, so
// the workspace/cwd hooks below still see live changes.)
export const FilesTab = React.memo(function FilesTab({
  tab,
  active,
  scope,
}: TabBodyProps) {
  const cwd = useChatCwd();
  // The git target for the Diff view: a real worktree diffs by its id; the
  // read-only Local-main trunk diffs by its repoRoot (matches useSourceTarget).
  const { workspace } = useActiveWorkspace();
  // Local main (the trunk) resolves to the primary checkout's working tree and
  // is now a first-class EDITABLE target (the engine's TRUNK_READ_ONLY gate was
  // removed) — so it gets a git workspaceId like any worktree and is never
  // read-only: Discard works on main too.
  const isTrunk = !!workspace && isLocalMainWorkspace(workspace);
  const workspaceId = workspace
    ? isTrunk
      ? (workspace.repoRoot ?? null)
      : workspace.id
    : null;

  const dispatch = useWorkspaceDispatch();
  // Single source of truth for "open a file in workbench": follows the ACTIVE tab
  // (this one, when its sidebar is clicked) — reuse it in place unless that
  // would destroy another path's unsaved draft (then focus/open separately).
  const openInWorkbench = useOpenFileInWorkbench();
  // The shared live refresh bus: agent turn-end / git writes / editor
  // saves invalidate the cached listing, then bump — so the sidebar picks up
  // created/deleted files without a manual refresh.
  const gitRefresh = useGitRefreshKey(cwd, workspaceId);

  // ── Sidebar geometry ──
  // Committed share of the two-pane container — shared across every File
  // tab + persisted (one preference, not per-tab state). Rendered as a
  // percentage width so the tree and the viewer scale together when
  // workbench itself resizes.
  const sidebarFraction = useFilesSidebarFraction();
  // Root two-pane container: the drag measures its rect once per gesture.
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Sidebar element: the live drag writes its width directly (no React
  // re-render per pointer tick); the commit on release re-syncs the store.
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  // The Files header owns the tree's filter so it can share one chrome row
  // with the open file and viewer controls. Search is ephemeral to this mount.
  const [treeSearch, setTreeSearch] = useState("");
  // Imperative bridge to @pierre/trees' stable model; typing never re-reads or
  // rematerializes the workspace file collection.
  const treeRef = useRef<WorkspaceFileTreeHandle | null>(null);

  const filePath = tab.filePath ?? "";
  // Blank tabs are always tree-only and full width. A filled tab restores its
  // own persisted visibility synchronously from the tab object.
  const layout = resolveFilesTabLayout(tab.filePath, tab.fileTreeVisible);
  const { fileTreeVisible } = layout;

  // A sidebar click navigates THIS tab. The same-path guard makes the
  // selection mirror's programmatic echo (and a re-click on the already-open
  // row) inert — without it, re-opening would clear the tab's entry-point
  // intent (e.g. flip a Changes-opened Diff view back to Edit). Opens carry
  // the All Files intent: source view, no Discard affordance.
  const handleOpenFile = useCallback(
    (p: string) => {
      if (p === filePath) return;
      openInWorkbench(p, { diff: false, diffScope: "all", discardable: false });
    },
    [filePath, openInWorkbench],
  );

  // Right-click → "Open in new tab": the explicit escape hatch that spawns a
  // separate, always-new File tab (bypasses the active-tab reuse; may
  // duplicate a file already open elsewhere in workbench).
  const handleOpenInNewTab = useCallback(
    (p: string) => {
      dispatch({ type: "ADD_WORKBENCH_TAB", tab: createFilesTab(p) });
    },
    [dispatch],
  );

  /** Apply the shared-header filter to the existing virtual tree model. */
  const handleTreeSearchChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = event.currentTarget.value;
      setTreeSearch(value);
      treeRef.current?.setSearch(value);
    },
    [],
  );

  /** Enter advances through matches; Escape returns to the unfiltered tree. */
  const handleTreeSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (event.shiftKey) treeRef.current?.focusPreviousSearchMatch();
        else treeRef.current?.focusNextSearchMatch();
        return;
      }
      if (event.key === "Escape" && treeSearch) {
        event.preventDefault();
        setTreeSearch("");
        treeRef.current?.setSearch("");
      }
    },
    [treeSearch],
  );

  /** Persist visibility on this File tab only. Collapsing also clears its
   * ephemeral filter so reopening never shows a filtered tree with no query. */
  const toggleFileTree = useCallback(() => {
    if (fileTreeVisible) {
      setTreeSearch("");
      treeRef.current?.setSearch("");
    }
    dispatch({
      type: "UPDATE_WORKBENCH_TAB",
      id: tab.id,
      scope,
      updates: { fileTreeVisible: !fileTreeVisible },
    });
  }, [dispatch, fileTreeVisible, scope, tab.id]);

  // ── Seam drag (mirrors the repository panel resizer) ──
  // Shared with the Changes tab's sidebar (use-sidebar-drag): both resize the
  // same committed width preference, so the gesture and clamps are identical.
  const onResizePointerDown = useSidebarResizeDrag(containerRef, sidebarRef);
  const { hintHandlers, hint } = useResizeHint("Drag to resize");

  // ── Floating tree panel (the collapsed state's quick file switcher) ──
  // Transient, per-mount UI over THIS tab's content. A POPUP: its height is
  // measured from the tab body once, when the trigger fires, and stays frozen
  // for that open — resizing the column doesn't reflow an open popup.
  // Expanding the real tree, closing the file (blank tabs show the full tree
  // already), or leaving the tab all invalidate it.
  const [treePanel, setTreePanel] = useState<{ height: number } | null>(null);
  const treePanelOpen = treePanel !== null;
  const treePanelTriggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!active || fileTreeVisible || !layout.hasFile) setTreePanel(null);
  }, [active, fileTreeVisible, layout.hasFile]);

  const toggleTreePanel = useCallback(() => {
    setTreePanel((open) =>
      open
        ? null
        : { height: treePanelHeight(containerRef.current?.clientHeight ?? 0) },
    );
  }, []);

  /** A panel row click: dismiss first, then navigate THIS tab in place (the
   * same-path guard keeps a re-click of the open file a pure dismiss). The
   * tab stays collapsed — direct opens keep the content full width. */
  const handlePanelOpenFile = useCallback(
    (p: string) => {
      setTreePanel(null);
      if (p === filePath) return;
      openInWorkbench(p, { diff: false, diffScope: "all", discardable: false });
    },
    [filePath, openInWorkbench],
  );

  const handlePanelOpenInNewTab = useCallback(
    (p: string) => {
      setTreePanel(null);
      dispatch({ type: "ADD_WORKBENCH_TAB", tab: createFilesTab(p) });
    },
    [dispatch],
  );

  /** Keyboard dismissal (Escape) returns focus to the header trigger; a
   * pointer dismissal already chose where focus goes next, so it only
   * closes. */
  const handlePanelDismiss = useCallback((source: TreePanelDismissSource) => {
    setTreePanel(null);
    if (source === "keyboard") treePanelTriggerRef.current?.focus();
  }, []);

  // One quiet fg2 glyph for BOTH states — the visible tree itself is the state
  // indicator, so the toggle never latches a pressed fill or fg1 flip.
  const treeToggle = layout.toggleVisible ? (
    <Tooltip label={fileTreeVisible ? "Hide file tree" : "Show file tree"}>
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-fg2 shrink-0"
        aria-label={fileTreeVisible ? "Hide file tree" : "Show file tree"}
        onClick={toggleFileTree}
      >
        <FolderTree className="size-3.5" />
      </Button>
    </Tooltip>
  ) : null;

  // Collapsed-only companion to the toggle: opens the floating tree popup so
  // the user can jump files without giving up the full-width content. While
  // the popup is up the trigger latches its selected fill (the ghost recipe's
  // hover step, like every data-[state=open] popover trigger).
  const treeSearchTrigger =
    layout.toggleVisible && !fileTreeVisible ? (
      <Tooltip label="Search files">
        <Button
          ref={treePanelTriggerRef}
          variant="ghost"
          size="icon-sm"
          className={cn(
            "text-fg2 shrink-0",
            treePanelOpen && "bg-bg2-hover text-fg1",
          )}
          aria-label="Search files"
          aria-haspopup="dialog"
          aria-expanded={treePanelOpen}
          onClick={toggleTreePanel}
        >
          <Search className="size-3.5" />
        </Button>
      </Tooltip>
    ) : null;

  // The sparse-checkout folder picker, hoisted so BOTH header states render the
  // same control: the feature acts on the worktree (the agent, the terminal and
  // the user's editor all stop seeing an unchecked folder), so collapsing the
  // tree must not be the thing that hides it. Gated on
  // canPickWorkingDirectories because the component returns null off the native
  // runtime — a bare element would still make its flex row reserve the gap.
  const workingDirectoriesPicker = canPickWorkingDirectories(cwd) ? (
    <WorkingDirectoriesPopover cwd={cwd} workspaceId={workspaceId} />
  ) : null;

  // Blank File tabs are intentional tree-only entry points: there is no empty
  // content column, divider, viewer header, or selection placeholder to paint.
  return (
    <div
      ref={containerRef}
      data-testid="files-tab"
      className="bg-bg1 relative flex h-full min-h-0 overflow-hidden"
    >
      {fileTreeVisible && (
        <div
          ref={sidebarRef}
          className={cn(
            "flex h-full min-h-0 flex-col overflow-hidden",
            layout.treeUsesSharedWidth
              ? "max-w-[70%] min-w-[140px] shrink-0"
              : "min-w-0 flex-1",
          )}
          style={
            layout.treeUsesSharedWidth
              ? { width: `${sidebarFraction * 100}%` }
              : undefined
          }
        >
          {/* Shared Files chrome: toggle + search + working-directory picker
              line up with the viewer's slug and Preview/Edit controls. */}
          <div
            data-testid="files-tree-header"
            className="flex h-9 shrink-0 items-center gap-1 px-2"
          >
            {treeToggle}
            <Input
              aria-label="Search workspace files"
              placeholder="Search…"
              value={treeSearch}
              onChange={handleTreeSearchChange}
              onKeyDown={handleTreeSearchKeyDown}
              className="border-border2 h-6 min-w-0 flex-1"
            />
            {workingDirectoriesPicker}
          </div>
          <div className="min-h-0 flex-1">
            <WorkspaceFileTree
              ref={treeRef}
              cwd={cwd}
              reloadKey={gitRefresh}
              // Pre-focus the tab's file on mount; then MIRROR it while this
              // tab is visible. Hidden dirty tabs suspend the mirror until
              // re-activation, when it heals any diverted selection.
              initialSelectedPath={tab.filePath}
              // `undefined` suspends a hidden tab; `null` explicitly clears an
              // active blank tab's prior tree selection.
              selectedPath={treeSelectionMirrorTarget(active, tab.filePath)}
              scrollMemoryKey={JSON.stringify([
                "files-tree",
                cwd ?? "",
                tab.id,
              ])}
              onOpenFile={handleOpenFile}
              onOpenInNewTab={handleOpenInNewTab}
            />
          </div>
        </div>
      )}

      {layout.seamVisible && (
        // Full-height seam: the divider runs through the header band too, so
        // the tree chrome (toggle + search + directories) reads as the tree
        // column's own header, separated from the viewer's slug + controls on
        // the exact line the two columns split on.
        <div
          data-testid="files-sidebar-seam"
          className="bg-border1 relative w-px shrink-0"
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize files sidebar"
            className="absolute -inset-x-[3px] inset-y-0 z-20 cursor-ew-resize select-none"
            onPointerDown={onResizePointerDown}
            onMouseDown={(e) => e.preventDefault()}
            {...hintHandlers}
          />
          {hint}
        </div>
      )}

      {layout.viewerVisible && (
        <div
          data-testid="files-viewer-pane"
          className="h-full min-h-0 min-w-0 flex-1 overflow-hidden"
        >
          <FileViewer
            tabId={tab.id}
            active={active}
            cwd={cwd}
            path={filePath}
            workspaceId={workspaceId}
            diff={tab.diff ?? false}
            diffScope={tab.diffScope}
            diffSha={tab.diffSha}
            turnChatId={tab.turnChatId}
            turnId={tab.turnId}
            discardable={tab.discardable ?? false}
            isNewFile={tab.isNewFile ?? false}
            contentRevision={tab.contentRevision ?? 0}
            viewerMode={tab.viewerMode}
            headerLeading={
              !fileTreeVisible ? (
                // One tight gap-1 cluster (the tree header's own control
                // spacing), so the three chrome glyphs read as a toolbar and
                // the viewer's gap-2 falls between them and the file slug —
                // not between the icons themselves.
                <div
                  data-testid="files-collapsed-toolbar"
                  className="flex shrink-0 items-center gap-1"
                >
                  {treeToggle}
                  {treeSearchTrigger}
                  {workingDirectoriesPicker}
                </div>
              ) : undefined
            }
            onViewerModeChange={(viewerMode) =>
              dispatch({
                type: "UPDATE_WORKBENCH_TAB",
                id: tab.id,
                scope,
                updates: { viewerMode },
              })
            }
            refreshKey={gitRefresh}
            readOnly={false}
          />
        </div>
      )}

      {/* The collapsed state's floating tree + search popup — a launcher over
          the full-width content, gated to the visible collapsed-with-file
          state (the effect above also clears it when the gate flips). Height
          was frozen when the trigger fired; the trigger itself is exempt from
          outside-pointerdown dismissal so its click stays a pure toggle. */}
      {treePanel && active && !fileTreeVisible && layout.hasFile && (
        <FilesTreePanel
          cwd={cwd}
          reloadKey={gitRefresh}
          height={treePanel.height}
          dismissIgnoreRef={treePanelTriggerRef}
          onOpenFile={handlePanelOpenFile}
          onOpenInNewTab={handlePanelOpenInNewTab}
          onDismiss={handlePanelDismiss}
        />
      )}
    </div>
  );
});
