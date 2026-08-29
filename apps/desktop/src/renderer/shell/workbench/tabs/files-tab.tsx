// ──────────────────────────────────────────────────────────
// FilesTab — workbench file surface: All-Files sidebar + viewer
// ──────────────────────────────────────────────────────────
//
// A workbench File tab is a fixed header over an optional two-pane body:
//   Header: file breadcrumb + nearby Copy + viewer controls + Directories,
//           Search, and Tree actions in one continuous full-width chrome row.
//   Left:  FileViewer — the file's content (Edit / Preview / Diff).
//   Right: one mutually-exclusive sidebar below that header. Tree, Search,
//          and Directories share the same base background, resize seam, and
//          persisted width. The tree's selection MIRRORS the tab's open file;
//          clicking another file navigates THIS tab in place (via
//          useOpenFileInWorkbench, so dirty-draft protection and the active-tab
//          policy hold). Right-click → "Open in new tab" spawns a separate
//          File tab.
//   Seam:  a body-height 1px divider that doubles as a drag handle; the width
//          is one shared, persisted preference (files-sidebar-width).
// Blank tabs omit the viewer and seam, leaving the chosen sidebar full width;
// their fixed row retains the same three actions and falls back to Tree instead
// of allowing an unusable all-closed state. Search starts with only its input
// and reveals matches after typing. Directories keeps sparse-checkout edits as
// a draft until Save because it rewrites the whole worktree.
//
// Clean tabs can be reused in place; a tab with an unsaved editor is
// retained separately so switching to another File/Terminal/Browser cannot
// destroy its draft.
// ──────────────────────────────────────────────────────────

import React, { useCallback, useRef, useState } from "react";
import { FolderOpen, FolderTree, Search } from "lucide-react";

import { useActiveWorkspace } from "@/renderer/state/use-active-workspace";
import { isLocalMainWorkspace } from "@/renderer/state/local-main-workspace";
import { useWorkspaceDispatch } from "@/renderer/state/store";
import { Button, Tooltip } from "@/renderer/shared/ui/primitives";
import { cn } from "@/renderer/shared/ui/cn";
import { useChatCwd } from "../../use-chat-cwd";
import { useGitRefreshKey } from "../../use-git-refresh-key";
import { useOpenFileInWorkbench } from "../use-open-file";
import { createFilesTab, type WorkbenchTab } from "../tab-model";
import { useFilesSidebarFraction } from "./files-sidebar-width";
import { useSidebarResizeDrag } from "./use-sidebar-drag";
import { useResizeHint } from "../../use-resize-hint";
import { FileViewer } from "./file-viewer";
import { resolveFilesTabLayout } from "./files-tab-layout";
import { WorkspaceFileTree } from "./workspace-file-tree";
import {
  canPickWorkingDirectories,
  WorkingDirectoriesPanel,
} from "./working-directories-panel";
import { prefetchWorkingDirectories } from "./working-directories-cache";
import { FilesSearchSidebar } from "./files-search-sidebar";
import {
  nextFilesSidebarMode,
  reconcileFilesSidebarSelection,
  type FilesSidebarKind,
  type FilesSidebarSelection,
} from "./files-sidebar-mode";
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
  const gitRefresh = useGitRefreshKey(cwd, workspaceId, active);

  const filePath = tab.filePath ?? "";
  // Blank tabs start with a full-width tree. A filled tab restores its own
  // persisted tree visibility synchronously from the tab object.
  const layout = resolveFilesTabLayout(tab.filePath, tab.fileTreeVisible);
  const directoriesAvailable = canPickWorkingDirectories(cwd);

  // ── Unified right sidebar ──
  // Tree visibility keeps its persisted compatibility field; Search and
  // Directories are lightweight per-mount modes. Only one can own the shared
  // sidebar shell, seam, and persisted width at a time.
  const [sidebarSelection, setSidebarSelection] =
    useState<FilesSidebarSelection>(() => ({
      hasFile: layout.hasFile,
      mode: layout.fileTreeVisible ? "tree" : null,
    }));
  const reconciledSidebarSelection = reconcileFilesSidebarSelection(
    sidebarSelection,
    layout.hasFile,
  );
  if (reconciledSidebarSelection !== sidebarSelection) {
    // React applies this guarded render-time adjustment before committing, so
    // a same-id fixed tab never paints its stale Search/Directories sidebar.
    setSidebarSelection(reconciledSidebarSelection);
  }
  const requestedSidebarMode = reconciledSidebarSelection.mode;
  const sidebarMode =
    requestedSidebarMode === "directories" && !directoriesAvailable
      ? layout.hasFile
        ? null
        : "tree"
      : requestedSidebarMode;

  // Committed share of the two-pane container — shared across every File tab
  // and all three modes, and persisted as one preference.
  const sidebarFraction = useFilesSidebarFraction();
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The live drag writes the currently mounted sidebar width directly; mode
  // changes reuse this exact node/ref and the same committed fraction.
  const sidebarRef = useRef<HTMLDivElement | null>(null);

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

  const toggleSidebarMode = useCallback(
    (requested: FilesSidebarKind) => {
      const next = nextFilesSidebarMode(sidebarMode, requested, layout.hasFile);
      setSidebarSelection((current) =>
        current.hasFile === layout.hasFile && current.mode === next
          ? current
          : { hasFile: layout.hasFile, mode: next },
      );
      // Preserve the existing serialized field as the tree-mode compatibility
      // contract. Search/Directories are mutually exclusive with it.
      dispatch({
        type: "UPDATE_WORKBENCH_TAB",
        id: tab.id,
        scope,
        updates: { fileTreeVisible: next === "tree" },
      });
    },
    [dispatch, layout.hasFile, scope, sidebarMode, tab.id],
  );
  const closeSearchSidebar = useCallback(
    () => toggleSidebarMode("search"),
    [toggleSidebarMode],
  );

  // ── Seam drag (mirrors the repository panel resizer) ──
  // Shared with the Changes tab's sidebar (use-sidebar-drag): both resize the
  // same committed width preference and clamps, from their respective edge.
  const onResizePointerDown = useSidebarResizeDrag(
    containerRef,
    sidebarRef,
    "right",
  );
  const { hintHandlers, hint } = useResizeHint("Drag to resize");

  const treeToggle = (
    <Tooltip
      label={
        sidebarMode === "tree" && layout.hasFile
          ? "Hide file tree"
          : "Show file tree"
      }
    >
      <Button
        variant="ghost"
        size="icon-sm"
        className={cn(
          "text-fg2 shrink-0",
          sidebarMode === "tree" && "bg-bg2-hover text-fg1",
        )}
        aria-label={
          sidebarMode === "tree" && layout.hasFile
            ? "Hide file tree"
            : "Show file tree"
        }
        aria-pressed={sidebarMode === "tree"}
        onClick={() => toggleSidebarMode("tree")}
      >
        <FolderTree className="size-3.5" />
      </Button>
    </Tooltip>
  );

  const searchTrigger = (
    <Tooltip label="Search files">
      <Button
        variant="ghost"
        size="icon-sm"
        className={cn(
          "text-fg2 shrink-0",
          sidebarMode === "search" && "bg-bg2-hover text-fg1",
        )}
        aria-label="Search files"
        aria-pressed={sidebarMode === "search"}
        onClick={() => toggleSidebarMode("search")}
      >
        <Search className="size-3.5" />
      </Button>
    </Tooltip>
  );

  const warmWorkingDirectories = useCallback(() => {
    if (!cwd) return;
    prefetchWorkingDirectories(cwd, workspaceId);
  }, [cwd, workspaceId]);

  const directoriesTrigger = directoriesAvailable ? (
    <Tooltip label="Working folders">
      <Button
        variant="ghost"
        size="icon-sm"
        className={cn(
          "text-fg2 shrink-0",
          sidebarMode === "directories" && "bg-bg2-hover text-fg1",
        )}
        aria-label="Choose working folders"
        aria-pressed={sidebarMode === "directories"}
        onPointerEnter={warmWorkingDirectories}
        onFocus={warmWorkingDirectories}
        onClick={() => toggleSidebarMode("directories")}
      >
        <FolderOpen className="size-3.5" />
      </Button>
    </Tooltip>
  ) : null;

  const sidebarActions = (
    <div
      data-testid="files-sidebar-actions"
      className="flex shrink-0 items-center gap-1"
    >
      {directoriesTrigger}
      {searchTrigger}
      {treeToggle}
    </div>
  );

  const sidebarPane = sidebarMode ? (
    <div
      ref={sidebarRef}
      data-testid="files-sidebar"
      data-sidebar-mode={sidebarMode}
      className={cn(
        "bg-bg1 flex h-full min-h-0 flex-col overflow-hidden",
        layout.hasFile
          ? "max-w-[70%] min-w-[140px] shrink-0"
          : "min-w-0 flex-1",
      )}
      style={
        layout.hasFile ? { width: `${sidebarFraction * 100}%` } : undefined
      }
    >
      {sidebarMode === "tree" ? (
        <div className="min-h-0 flex-1">
          <WorkspaceFileTree
            active={active}
            cwd={cwd}
            reloadKey={gitRefresh}
            initialSelectedPath={tab.filePath}
            selectedPath={treeSelectionMirrorTarget(active, tab.filePath)}
            scrollMemoryKey={JSON.stringify(["files-tree", cwd ?? "", tab.id])}
            onOpenFile={handleOpenFile}
            onOpenInNewTab={handleOpenInNewTab}
          />
        </div>
      ) : sidebarMode === "search" ? (
        <FilesSearchSidebar
          active={active}
          cwd={cwd}
          reloadKey={gitRefresh}
          onOpenFile={handleOpenFile}
          onOpenInNewTab={handleOpenInNewTab}
          onClose={closeSearchSidebar}
        />
      ) : (
        <WorkingDirectoriesPanel
          cwd={cwd}
          workspaceId={workspaceId}
          active={active}
        />
      )}
    </div>
  ) : null;

  // Blank File tabs are intentional sidebar-only entry points: there is no
  // empty content column, divider, viewer header, or selection placeholder.
  return (
    <div
      ref={containerRef}
      data-testid="files-tab"
      className="bg-bg1 relative flex h-full min-h-0 overflow-hidden"
    >
      {layout.viewerVisible ? (
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
            headerBorder
            headerTrailing={sidebarActions}
            bodyTrailing={
              sidebarMode ? (
                <>
                  {/* All sidebar modes share this body-only seam and width. */}
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
                  {sidebarPane}
                </>
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
      ) : (
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div
            data-testid="files-tree-header"
            className="border-border1 flex h-9 shrink-0 items-center justify-between gap-2 border-b px-2"
          >
            <span className="text-fg2 truncate text-xs font-medium">
              No file open
            </span>
            {sidebarActions}
          </div>
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {sidebarPane}
          </div>
        </div>
      )}
    </div>
  );
});
