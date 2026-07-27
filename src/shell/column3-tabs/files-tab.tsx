// ──────────────────────────────────────────────────────────
// FilesTab — row-1 file surface: All-Files sidebar + viewer
// ──────────────────────────────────────────────────────────
//
// A row-1 File tab is a two-pane surface:
//   Left:  the gitignore-aware workspace file tree (WorkspaceFileTree),
//          with the built-in
//          filter bar. Its selection MIRRORS the tab's open file, and
//          clicking another file navigates THIS tab in place (via
//          useOpenFileInRow1, so dirty-draft protection and the active-tab
//          policy hold). Right-click → "Open in new tab" spawns a separate
//          File tab.
//   Seam:  a 1px divider that doubles as a pointer-captured drag handle;
//          the width is one shared, persisted preference
//          (files-sidebar-width).
//   Right: FileViewer — the file's content (Edit / Preview / Diff). The
//          file path + view controls live in its own header.
//
// Clean tabs can be reused in place; a tab with an unsaved editor is
// retained separately so switching to another File/Terminal/Browser cannot
// destroy its draft.
// ──────────────────────────────────────────────────────────

import React, { useCallback, useRef } from "react";
import { FileQuestion } from "lucide-react";

import { useActiveWorkspace } from "@/zeros/store/use-active-workspace";
import { isLocalMainWorkspace } from "@/zeros/store/local-main-workspace";
import { useWorkspaceDispatch } from "@/zeros/store/store";
import { useChatCwd } from "../use-chat-cwd";
import { useGitRefreshKey } from "../use-git-refresh-key";
import { useOpenFileInRow1 } from "../use-open-file-in-row1";
import { createFilesTab, type Column3Tab } from "../column3-tab-manager";
import { useFilesSidebarFraction } from "./files-sidebar-width";
import { useSidebarResizeDrag } from "./use-sidebar-drag";
import { useResizeHint } from "../use-resize-hint";
import { FileViewer } from "./file-viewer";
import { WorkspaceFileTree } from "./workspace-file-tree";
import { treeSelectionMirrorTarget } from "./tree-paths";

interface TabBodyProps {
  tab: Column3Tab;
  active: boolean;
  scope?: string;
}

// Memoised: the row-1 body switch re-renders on unrelated tab/store changes;
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
  // Single source of truth for "open a file in row 1": follows the ACTIVE tab
  // (this one, when its sidebar is clicked) — reuse it in place unless that
  // would destroy another path's unsaved draft (then focus/open separately).
  const openInRow1 = useOpenFileInRow1();
  // The shared live refresh bus: agent turn-end / git writes / editor
  // saves invalidate the cached listing, then bump — so the sidebar picks up
  // created/deleted files without a manual refresh.
  const gitRefresh = useGitRefreshKey(cwd, workspaceId);

  // ── Sidebar geometry ──
  // Committed share of the two-pane container — shared across every File
  // tab + persisted (one preference, not per-tab state). Rendered as a
  // percentage width so the tree and the viewer scale together when
  // column 3 itself resizes.
  const sidebarFraction = useFilesSidebarFraction();
  // Root two-pane container: the drag measures its rect once per gesture.
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Sidebar element: the live drag writes its width directly (no React
  // re-render per pointer tick); the commit on release re-syncs the store.
  const sidebarRef = useRef<HTMLDivElement | null>(null);

  const filePath = tab.filePath ?? "";

  // A sidebar click navigates THIS tab. The same-path guard makes the
  // selection mirror's programmatic echo (and a re-click on the already-open
  // row) inert — without it, re-opening would clear the tab's entry-point
  // intent (e.g. flip a Changes-opened Diff view back to Edit). Opens carry
  // the All Files intent: source view, no Discard affordance (D2).
  const handleOpenFile = useCallback(
    (p: string) => {
      if (p === filePath) return;
      openInRow1(p, { diff: false, diffScope: "all", discardable: false });
    },
    [filePath, openInRow1],
  );

  // Right-click → "Open in new tab": the explicit escape hatch that spawns a
  // separate, always-new File tab (bypasses the active-tab reuse; may
  // duplicate a file already open elsewhere in row 1).
  const handleOpenInNewTab = useCallback(
    (p: string) => {
      dispatch({ type: "ADD_COLUMN3_TAB", tab: createFilesTab(p) });
    },
    [dispatch],
  );

  // ── Seam drag (mirrors the column-1 resizer) ──
  // Shared with the Changes tab's sidebar (use-sidebar-drag): both resize the
  // same committed width preference, so the gesture and clamps are identical.
  const onResizePointerDown = useSidebarResizeDrag(containerRef, sidebarRef);
  const { hintHandlers, hint } = useResizeHint("Drag to resize");

  // Blank File tabs are intentional, closable file-browsing entry points. They
  // render the same tree and empty viewer as the fresh workspace's first tab.
  return (
    <div ref={containerRef} className="bg-bg1 flex h-full min-h-0">
      {/* Sidebar — the workspace tree. Percentage width keeps the split
          proportional as column 3 resizes; `min-w-[140px]`/`max-w-[70%]`
          mirror the drag clamp's pixel floor and share cap. */}
      <div
        ref={sidebarRef}
        className="h-full min-h-0 max-w-[70%] min-w-[140px] shrink-0 overflow-hidden"
        style={{ width: `${sidebarFraction * 100}%` }}
      >
        <WorkspaceFileTree
          cwd={cwd}
          reloadKey={gitRefresh}
          search
          // Pre-focus the tab's file on mount; then MIRROR it while this tab
          // is visible. Hidden tabs (a dirty draft kept mounted) suspend the
          // mirror — it re-asserts on re-activation, healing any divergence
          // left when a click was diverted away to protect the draft.
          initialSelectedPath={tab.filePath}
          // `undefined` suspends the mirror for a hidden tab; `null` explicitly
          // clears it when an active blank File tab has no open file.
          selectedPath={treeSelectionMirrorTarget(active, tab.filePath)}
          scrollMemoryKey={JSON.stringify(["files-tree", cwd ?? "", tab.id])}
          onOpenFile={handleOpenFile}
          onOpenInNewTab={handleOpenInNewTab}
        />
      </div>

      {/* Seam — 1px divider + invisible 7px grab strip. The resize cursor +
          the idle "Drag to resize" hint above the pointer are the only
          affordances (like the column-1 seam). */}
      <div className="bg-border1 relative w-px shrink-0">
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

      {/* Viewer pane — the open file, or a blank tab's selection prompt. */}
      <div className="h-full min-h-0 min-w-0 flex-1 overflow-hidden">
        {tab.filePath ? (
          <FileViewer
            tabId={tab.id}
            active={active}
            cwd={cwd}
            path={tab.filePath}
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
            onViewerModeChange={(viewerMode) =>
              dispatch({
                type: "UPDATE_COLUMN3_TAB",
                id: tab.id,
                scope,
                updates: { viewerMode },
              })
            }
            refreshKey={gitRefresh}
            readOnly={false}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            <FileQuestion className="text-muted-fg size-10" strokeWidth={1} />
            <p className="text-fg2 m-0 text-xs">Select a file to view</p>
          </div>
        )}
      </div>
    </div>
  );
});
