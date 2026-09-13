import { ChangesScopeMenu } from "./changes-scope-menu";
import { scopeIdentity } from "./changes-scope";
import {
  changesHistoryKey,
  changesHistorySchema,
  type ChangesHistory,
} from "@zeros/protocol/changes-history";
// ──────────────────────────────────────────────────────────
// ChangesWorkbenchSurface — the pinned Changes workbench surface
// ──────────────────────────────────────────────────────────
//
// The branch's permanent change-review surface:
//
//   Shared chrome — the workbench owns one PR STATUS row above both retained Changes
//           and Review bodies (omitted on main, which is the merge target).
//           Keeping it outside this body prevents the two tabs from holding
//           independent live snapshots.
//   Toolbar — the comparison dropdown on the left, then the CodeView layout,
//           fold-all, and all-files/focused controls. The sidebar toggle sits
//           at the far right in one full-width row.
//   Below — left: one virtualized CodeView for the comparison; right: the
//           changed-file list (status glyphs, ± counts, discard-on-hover
//           included), resizable via the shared files-sidebar width.
//
// Selection lives ON the tab (tab.filePath + the diff* intent fields), so it
// persists like an open File tab, but the tab itself never closes — clearing
// a selection just returns to the "select a change" state. Clicking a change
// navigates THIS tab in place. A draft created before Changes became diff-only
// remains mounted until it is saved; another-path opens divert to a File tab so
// that compatibility path cannot destroy unsaved work.
// ──────────────────────────────────────────────────────────

import React, {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FileDiff, Folders, Search } from "lucide-react";

import { useWorkspaceDispatch } from "@/renderer/state/store";
import { Button, Input, Tooltip } from "@/renderer/shared/ui/primitives";
import { cn } from "@/renderer/shared/ui/cn";
import { useChatCwd } from "../../use-chat-cwd";
import { triggerGitRefresh, useGitRefreshKey } from "../../use-git-refresh-key";
import { useOpenFileInWorkbench, type OpenFileOpts } from "../use-open-file";
import { type WorkbenchTab } from "../tab-model";
import { useWorkbenchDirtyEditorIds } from "./code-editor/editor-state";
import { changeOpenIntent } from "./changes-open-intent";
import { reconcileChangesSelection } from "./changes-selection";
import { filterChangeSections } from "./changes-search";
import {
  ChangesList,
  EmptyState,
  NotAGitRepo,
  useChangesModel,
  useSourceTarget,
  useTrunkGitState,
  type RowActions,
} from "./changes-tab";
import { type ChangedFile } from "./changes-parse";
import { DiscardDialog } from "./discard-file";
import { FileViewer } from "./file-viewer";
import { ChangesDiffViewer } from "./changes-diff-viewer";
import { useFilesSidebarFraction } from "./files-sidebar-width";
import { useSidebarResizeDrag } from "./use-sidebar-drag";
import { useResizeHint } from "../../use-resize-hint";
import {
  setChangesSidebarVisible,
  useChangesSidebarVisible,
} from "./changes-sidebar-visible";
import { useViewedVersion } from "./use-viewed-files";
import { useRetainedViewKeySet } from "../../use-retained-view-keys";
import {
  isRetainedViewVisible,
  retainLatestViewKeyPerIdentity,
} from "../../retained-view-keys";
import { useInstantViewSwitch } from "@/renderer/shared/ui/use-instant-view-switch";
import {
  prefetchWorkspaceFileDiff,
  prefetchWorkspaceFileRead,
  type WorkspaceFileDiffQuery,
} from "../../workspace-file-data-cache";

interface TabBodyProps {
  tab: WorkbenchTab;
  active: boolean;
  scope?: string;
}

// Memoised like FilesTab: the workbench body switch re-renders on unrelated store
// changes; context hooks below still see live updates.
export const ChangesWorkbenchSurface = React.memo(
  function ChangesWorkbenchSurface({ tab, active, scope }: TabBodyProps) {
    const cwd = useChatCwd();
    const { workspace, isLocalMain, changesTarget } = useSourceTarget();
    // The same live refresh bus as the File tabs: agent turn-end / git
    // writes / editor saves re-pull the list, the PR row, and the open diff.
    const gitRefresh = useGitRefreshKey(cwd, changesTarget, active);
    // The Local main folder might not be a git repo yet — offer Initialize /
    // Publish instead of a raw git error.
    const trunkRoot = isLocalMain ? workspace?.repoRoot || null : null;
    const { nonGit, checked } = useTrunkGitState(trunkRoot, gitRefresh, active);

    // Writes that bypass the engine bridge (discard, git init) nudge the exact
    // cwd's refresh consumers — including this tab's own gitRefresh key.
    const handleChanged = useCallback((changedCwd?: string) => {
      triggerGitRefresh(changedCwd);
    }, []);

    return (
      <div className="bg-bg1 flex h-full min-h-0 flex-col">
        {trunkRoot && !checked ? (
          <div className="min-h-0 flex-1" aria-busy="true" />
        ) : nonGit ? (
          <NotAGitRepo
            repoRoot={trunkRoot ?? ""}
            defaultName={workspace?.repoSlug}
            onInitialized={handleChanged}
          />
        ) : changesTarget ? (
          <ChangesSurface
            // Per-target remount — a workspace switch must never leak the prior
            // worktree's list/filter state.
            key={changesTarget}
            tab={tab}
            active={active}
            scope={scope}
            cwd={cwd}
            workspaceId={changesTarget}
            baseBranch={workspace?.baseBranch ?? "main"}
            folder={workspace?.path ?? ""}
            refreshKey={gitRefresh}
            onChanged={handleChanged}
          />
        ) : (
          <EmptyState
            title="No git workspace"
            subtitle="Open this folder as a Zeros workspace (create a worktree) to review its changes here."
          />
        )}
      </div>
    );
  },
);

// ── Rows B+C: toolbar, sidebar, viewer ───────────────────────

interface ChangesSurfaceProps {
  tab: WorkbenchTab;
  active: boolean;
  scope?: string;
  cwd: string | undefined;
  workspaceId: string;
  baseBranch: string;
  folder: string;
  refreshKey: number;
  onChanged: (changedCwd?: string) => void;
}

const MAX_RETAINED_CHANGE_FILE_VIEWS = 6;

type ChangeFileView = {
  path: string;
  diff: boolean;
  diffScope?:
    | "all"
    | "uncommitted"
    | "staged"
    | "unstaged"
    | "commit"
    | "turn"
    | "history";
  diffSha?: string;
  diffHistory?: ChangesHistory;
  turnChatId?: string;
  turnId?: string;
  discardable: boolean;
  isNewFile: boolean;
  contentRevision: number;
};

function changeFileViewKey(view: ChangeFileView): string {
  return JSON.stringify([
    view.path,
    view.diff,
    view.diffScope ?? "",
    view.diffSha ?? "",
    view.turnChatId ?? "",
    view.turnId ?? "",
    view.discardable,
    view.isNewFile,
    view.contentRevision,
    view.diffHistory ?? null,
  ]);
}

/** React identity excludes live review metadata so a dirty editor survives it. */
function changeFileViewIdentityKey(view: ChangeFileView): string {
  // Diff scope and review affordances can refresh while the user edits. Only
  // a path/revision change is allowed to replace the mounted source editor.
  return JSON.stringify([view.path, view.contentRevision]);
}

function changeFileViewFromKey(key: string): ChangeFileView | null {
  try {
    const value = JSON.parse(key) as unknown[];
    if (!Array.isArray(value) || typeof value[0] !== "string") return null;
    const scope = value[2];
    const history = changesHistorySchema.safeParse(value[9]);
    return {
      path: value[0],
      diff: value[1] === true,
      ...(scope === "all" ||
      scope === "uncommitted" ||
      scope === "staged" ||
      scope === "unstaged" ||
      scope === "commit" ||
      scope === "turn" ||
      scope === "history"
        ? { diffScope: scope }
        : {}),
      ...(typeof value[3] === "string" && value[3]
        ? { diffSha: value[3] }
        : {}),
      ...(typeof value[4] === "string" && value[4]
        ? { turnChatId: value[4] }
        : {}),
      ...(typeof value[5] === "string" && value[5] ? { turnId: value[5] } : {}),
      ...(history.success ? { diffHistory: history.data } : {}),
      discardable: value[6] === true,
      isNewFile: value[7] === true,
      contentRevision:
        typeof value[8] === "number" && Number.isFinite(value[8])
          ? value[8]
          : 0,
    };
  } catch {
    return null;
  }
}

function viewFromIntent(
  path: string,
  intent: OpenFileOpts,
  contentRevision = 0,
): ChangeFileView {
  return {
    path,
    diff: intent.diff === true,
    diffScope: intent.diffScope,
    diffSha: intent.diffSha,
    diffHistory: intent.diffHistory,
    turnChatId: intent.turnChatId,
    turnId: intent.turnId,
    discardable: intent.discardable === true,
    isNewFile: intent.isNewFile === true,
    contentRevision,
  };
}

function ChangesSurface({
  tab,
  active,
  scope,
  cwd,
  workspaceId,
  baseBranch,
  folder,
  refreshKey,
  onChanged,
}: ChangesSurfaceProps) {
  const dispatch = useWorkspaceDispatch();
  const openInWorkbench = useOpenFileInWorkbench();
  const dirtyEditorIds = useWorkbenchDirtyEditorIds();
  // Re-render the sidebar rows when any file's viewed-state changes so the
  // dimming stays in sync with the viewer's checkbox.
  const viewedVersion = useViewedVersion();
  const model = useChangesModel({
    active,
    workspaceId,
    baseBranch,
    folder,
    refreshKey,
    onChanged,
  });
  const [search, setSearch] = useState("");
  const searchQuery = search.trim().toLowerCase();
  const visibleSections = useMemo(
    () => filterChangeSections(model.effectiveSections, searchQuery),
    [model.effectiveSections, searchQuery],
  );
  const fileCount = model.effectiveSections.reduce(
    (total, section) => total + section.files.length,
    0,
  );
  const matchingCount = visibleSections.reduce(
    (total, section) => total + section.files.length,
    0,
  );
  const sidebarVisible = useChangesSidebarVisible();
  // The same committed share-of-container preference as the File tab's
  // tree sidebar — rendered as a percentage width so the list and the
  // viewer scale together when workbench resizes.
  const sidebarFraction = useFilesSidebarFraction();
  const [headerContainer, setHeaderContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const onResizePointerDown = useSidebarResizeDrag(
    containerRef,
    sidebarRef,
    "right",
  );
  const { hintHandlers, hint } = useResizeHint("Drag to resize");

  const selected = tab.filePath ?? null;
  const [selectionRequest, setSelectionRequest] = useState(0);
  const diffFiles = useMemo(
    () => model.effectiveSections.flatMap((section) => section.files),
    [model.effectiveSections],
  );
  const diffOwnerKey = JSON.stringify([
    workspaceId,
    tab.id,
    scopeIdentity(model.scope),
    model.turnFilter?.chatId,
    model.turnFilter?.turnId,
    baseBranch,
  ]);
  const queryForFile = useCallback(
    (file: ChangedFile): WorkspaceFileDiffQuery => {
      const intent = changeOpenIntent(model.scope, model.turnFilter, file);
      return {
        workspaceId,
        path: file.path,
        ...(file.oldPath ? { oldPath: file.oldPath } : {}),
        diffScope: intent.diffScope,
        diffSha: intent.diffSha,
        diffHistory: intent.diffHistory,
        turnChatId: intent.turnChatId,
        turnId: intent.turnId,
        ...(intent.diffScope === "all" || intent.diffHistory?.kind === "commits"
          ? { baseBranch }
          : {}),
      };
    },
    [workspaceId, model.scope, model.turnFilter, baseBranch],
  );
  const orderedPaths = useMemo(
    () =>
      model.effectiveSections.flatMap((section) =>
        section.files.map((file) => file.path),
      ),
    [model.effectiveSections],
  );
  const previousOrderedPaths = useRef<readonly string[]>(orderedPaths);
  const activeView = useMemo<ChangeFileView | null>(
    () =>
      selected
        ? {
            path: selected,
            diff: tab.diff === true,
            diffScope: tab.diffScope,
            diffSha: tab.diffSha,
            diffHistory: tab.diffHistory,
            turnChatId: tab.turnChatId,
            turnId: tab.turnId,
            discardable: tab.discardable === true,
            isNewFile: tab.isNewFile === true,
            contentRevision: tab.contentRevision ?? 0,
          }
        : null,
    [
      selected,
      tab.diff,
      tab.diffScope,
      tab.diffSha,
      tab.diffHistory,
      tab.turnChatId,
      tab.turnId,
      tab.discardable,
      tab.isNewFile,
      tab.contentRevision,
    ],
  );
  const activeViewKey = activeView ? changeFileViewKey(activeView) : null;
  useInstantViewSwitch(
    active
      ? `changes-file:${workspaceId}:${activeViewKey ?? "empty"}`
      : "changes-file:hidden",
    containerRef,
  );
  // Pointer intent mounts the expensive virtualized/highlighted destination in
  // a transition before the urgent click. The finished DOM then becomes the
  // visible layer; returning to any of the recent six files is only a visibility
  // flip, not a worker/highlighter reconstruction.
  const [warmViewSnapshot, setWarmViewSnapshot] = useState<{
    workspaceId: string;
    view: ChangeFileView;
  } | null>(null);
  const warmView =
    warmViewSnapshot?.workspaceId === workspaceId
      ? warmViewSnapshot.view
      : null;
  const warmViewKey = warmView ? changeFileViewKey(warmView) : null;
  const retainedViewInputs = useMemo(
    () =>
      [warmViewKey, activeViewKey].filter((key): key is string => key !== null),
    [warmViewKey, activeViewKey],
  );
  const retainedViewKeys = useRetainedViewKeySet(
    retainedViewInputs,
    MAX_RETAINED_CHANGE_FILE_VIEWS,
    undefined,
    workspaceId,
  );
  const renderedViewKeys = useMemo(
    () =>
      retainLatestViewKeyPerIdentity(retainedViewKeys, (key) => {
        const viewTarget = changeFileViewFromKey(key);
        return viewTarget ? changeFileViewIdentityKey(viewTarget) : key;
      }),
    [retainedViewKeys],
  );

  // Prime the first review sweep after the list itself settles. This runs off
  // the click path and is deliberately bounded; pointer intent handles rows
  // outside the initial window. Aggregate patches are already primed by the
  // model, so these are cheap local file reads only.
  useEffect(() => {
    if (!active || model.loading || !dirtyEditorIds.has(tab.id)) return;
    const paths = model.effectiveSections
      .flatMap((section) => section.files)
      .slice(0, 10)
      .map((file) => file.path);
    if (paths.length === 0) return;
    const run = () => {
      for (const path of paths) prefetchWorkspaceFileRead(folder, path);
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(run, { timeout: 500 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(run, 0);
    return () => window.clearTimeout(id);
  }, [
    active,
    folder,
    model.loading,
    model.effectiveSections,
    dirtyEditorIds,
    tab.id,
  ]);

  // Write a selection + viewer intent onto THIS tab (the Changes tab is its
  // own viewer target — a click never spawns a File tab).
  const applySelection = useCallback(
    (path: string, intent: OpenFileOpts) => {
      const updates: Partial<Omit<WorkbenchTab, "id" | "type">> = {
        filePath: path,
        diff: intent.diff ?? false,
        diffScope: intent.diffScope,
        diffSha: intent.diffSha,
        diffHistory: intent.diffHistory,
        turnChatId: intent.turnChatId,
        turnId: intent.turnId,
        discardable: intent.discardable ?? false,
        isNewFile: intent.isNewFile ?? false,
        viewerMode: undefined,
      };
      // A fresh open is a new intent — clear the one-shot post-discard reset
      // marker, EXCEPT while this tab's editor holds an unsaved draft: the
      // SourceEditor is keyed on the revision, so resetting it would remount
      // the editor and silently destroy the draft (same rule as
      // use-open-file; a dirty tab is only ever re-applied same-path).
      if (!dirtyEditorIds.has(tab.id)) updates.contentRevision = 0;
      dispatch({
        type: "UPDATE_WORKBENCH_TAB",
        id: tab.id,
        scope,
        updates,
      });
    },
    [dispatch, scope, tab.id, dirtyEditorIds],
  );

  // Reconcile external list changes before paint. A cold/opened Changes tab
  // therefore starts on its first row, and removing the selected file from a
  // terminal/IDE advances in list order without briefly painting a stale
  // missing-file pane. Never replace an unsaved draft automatically.
  useLayoutEffect(() => {
    if (!active || model.loading) return;
    const nextSelected = reconcileChangesSelection(
      previousOrderedPaths.current,
      orderedPaths,
      selected,
    );
    const selectedDisappeared = !!selected && !orderedPaths.includes(selected);
    if (selectedDisappeared && dirtyEditorIds.has(tab.id)) return;
    previousOrderedPaths.current = orderedPaths;
    if (nextSelected === selected) return;
    if (nextSelected) {
      const file = model.effectiveSections
        .flatMap((section) => section.files)
        .find((entry) => entry.path === nextSelected);
      if (file) {
        applySelection(
          file.path,
          changeOpenIntent(model.scope, model.turnFilter, file),
        );
      }
      return;
    }
    dispatch({
      type: "UPDATE_WORKBENCH_TAB",
      id: tab.id,
      scope,
      updates: {
        filePath: undefined,
        diff: false,
        diffScope: undefined,
        diffSha: undefined,
        diffHistory: undefined,
        turnChatId: undefined,
        turnId: undefined,
        discardable: false,
        isNewFile: false,
        viewerMode: undefined,
      },
    });
  }, [
    active,
    model.loading,
    model.effectiveSections,
    model.scope,
    model.turnFilter,
    orderedPaths,
    selected,
    dirtyEditorIds,
    tab.id,
    applySelection,
    dispatch,
    scope,
  ]);

  // A sidebar click navigates THIS tab in place — unless that would destroy
  // another path's unsaved draft here, in which case the open diverts to the
  // shared workbench flow (focus an existing File tab / spawn a new one) and the
  // draft stays alive in this tab.
  const handleOpenFile = useCallback(
    (file: ChangedFile) => {
      const intent = changeOpenIntent(model.scope, model.turnFilter, file);
      if (dirtyEditorIds.has(tab.id) && file.path !== selected) {
        openInWorkbench(file.path, intent);
        return;
      }
      applySelection(file.path, intent);
      setSelectionRequest((value) => value + 1);
    },
    [
      model.scope,
      model.turnFilter,
      dirtyEditorIds,
      tab.id,
      selected,
      openInWorkbench,
      applySelection,
    ],
  );

  const handlePrefetchFile = useCallback(
    (file: ChangedFile) => {
      const intent = changeOpenIntent(model.scope, model.turnFilter, file);
      const view = viewFromIntent(file.path, intent);
      prefetchWorkspaceFileRead(folder, file.path);
      const diffQuery: WorkspaceFileDiffQuery = {
        workspaceId,
        path: file.path,
        diffScope: intent.diffScope,
        diffSha: intent.diffSha,
        diffHistory: intent.diffHistory,
        turnChatId: intent.turnChatId,
        turnId: intent.turnId,
      };
      if (intent.diffScope === "all" || intent.diffHistory?.kind === "commits")
        diffQuery.baseBranch = baseBranch;
      prefetchWorkspaceFileDiff(diffQuery);
      if (!dirtyEditorIds.has(tab.id)) return;
      startTransition(() =>
        setWarmViewSnapshot((current) =>
          current?.workspaceId === workspaceId &&
          changeFileViewKey(current.view) === changeFileViewKey(view)
            ? current
            : { workspaceId, view },
        ),
      );
    },
    [
      model.scope,
      model.turnFilter,
      folder,
      workspaceId,
      baseBranch,
      dirtyEditorIds,
      tab.id,
    ],
  );

  // The Viewed auto-advance sweep, redirected into this tab: enrich the target
  // with the live row's intent when it's in the current list (Discard
  // affordance, new-file classification), else apply the sweep's own opts.
  const handleAdvance = useCallback(
    (path: string, opts: OpenFileOpts) => {
      const file = model.effectiveSections
        .flatMap((s) => s.files)
        .find((f) => f.path === path);
      if (file) {
        handleOpenFile(file);
        return;
      }
      if (dirtyEditorIds.has(tab.id) && path !== selected) {
        openInWorkbench(path, opts);
        return;
      }
      applySelection(path, opts);
    },
    [
      model.effectiveSections,
      handleOpenFile,
      dirtyEditorIds,
      tab.id,
      selected,
      openInWorkbench,
      applySelection,
    ],
  );

  // Keep the open diff in sync with the FILTER: a
  // scope change re-scopes the selected file's diff + Discard affordance
  // without forcing its view mode; a selection that left the list sheds any
  // stale Discard/new-file classification. Apply the complete history identity
  // before paint, including when a range changes but its path stays selected.
  useLayoutEffect(() => {
    if (!active || !selected) return;
    const file = model.effectiveSections
      .flatMap((s) => s.files)
      .find((f) => f.path === selected);
    if (!file) {
      // Clean missing selections are advanced atomically by the layout
      // reconciliation above. Only an unsaved draft intentionally remains on a
      // missing row; shed its stale review affordances without changing path.
      if (
        !model.loading &&
        dirtyEditorIds.has(tab.id) &&
        (tab.discardable || tab.isNewFile)
      ) {
        dispatch({
          type: "UPDATE_WORKBENCH_TAB",
          id: tab.id,
          scope,
          updates: { discardable: false, isNewFile: false },
        });
      }
      return;
    }
    const intent = changeOpenIntent(model.scope, model.turnFilter, file);
    const discardable = intent.discardable === true;
    const isNewFile = intent.isNewFile === true;
    if (
      tab.diffScope === intent.diffScope &&
      (tab.diffSha ?? undefined) === intent.diffSha &&
      (tab.diffHistory ? changesHistoryKey(tab.diffHistory) : "") ===
        (intent.diffHistory ? changesHistoryKey(intent.diffHistory) : "") &&
      tab.turnChatId === intent.turnChatId &&
      tab.turnId === intent.turnId &&
      (tab.discardable ?? false) === discardable &&
      (tab.isNewFile ?? false) === isNewFile
    )
      return;
    dispatch({
      type: "UPDATE_WORKBENCH_TAB",
      id: tab.id,
      scope,
      updates: {
        diffScope: intent.diffScope,
        diffSha: intent.diffSha,
        diffHistory: intent.diffHistory,
        turnChatId: intent.turnChatId,
        turnId: intent.turnId,
        discardable,
        isNewFile,
      },
    });
  }, [
    active,
    model.scope,
    model.turnFilter,
    model.effectiveSections,
    model.loading,
    selected,
    dirtyEditorIds,
    tab,
    scope,
    dispatch,
  ]);

  const worktreeScope =
    model.scope.kind === "uncommitted" ||
    model.scope.kind === "staged" ||
    model.scope.kind === "unstaged";
  const rowActions: RowActions = useMemo(
    () => ({
      selected,
      busy: model.busy,
      // Discard only under the "All changes" filter (the full per-file revert
      // needs the whole-tree context) — never a turn view. Workbench's targets are
      // always writable (the trunk is first-class editable), so no readOnly gate.
      interactive: !model.turnFilter && model.scope.kind === "all",
      committed: model.turnFilter ? true : !worktreeScope,
      viewedKey: workspaceId,
      viewedVersion,
      onSelect: handleOpenFile,
      onPrefetch: handlePrefetchFile,
      onDiscard: model.setDiscardTarget,
    }),
    [
      selected,
      model.busy,
      model.turnFilter,
      model.scope.kind,
      model.setDiscardTarget,
      worktreeScope,
      workspaceId,
      viewedVersion,
      handleOpenFile,
      handlePrefetchFile,
    ],
  );

  // Filters stay before the file path, independently of sidebar visibility.
  const toolbar = (
    <div className="flex shrink-0 items-center gap-1">
      <ChangesScopeMenu
        scope={model.scope}
        commits={model.commits}
        turns={model.turns}
        legacyTurn={model.turnFilter}
        changeCounts={model.changeCounts}
        onChange={model.setScope}
        commitsLoading={model.commitsLoading}
        turnsLoading={model.turnsLoading}
        commitsError={model.commitsError}
        turnsError={model.turnsError}
        onRetry={() => onChanged(folder)}
      />
    </div>
  );

  const sidebarToggle = (
    <Tooltip label={sidebarVisible ? "Hide changes list" : "Show changes list"}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={sidebarVisible ? "Hide changes list" : "Show changes list"}
        aria-pressed={sidebarVisible}
        onClick={() => setChangesSidebarVisible(!sidebarVisible)}
        className={cn(
          "text-fg2 shrink-0",
          sidebarVisible && "bg-bg2-hover text-fg1",
        )}
      >
        <Folders className="size-3.5" />
      </Button>
    </Tooltip>
  );

  const discardTarget = model.discardTarget;
  const listScrollKey = JSON.stringify([
    "changes-list",
    workspaceId,
    "tree",
    model.turnFilter ? "turn" : model.scope.kind,
    model.turnFilter?.chatId ?? "",
    model.turnFilter?.turnId ?? "",
    scopeIdentity(model.scope),
    searchQuery,
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        data-testid="changes-toolbar"
        className="border-border1 flex h-9 shrink-0 items-center border-b px-2"
      >
        {/* The history menu must survive file selection and empty results so
          a first endpoint cannot dismiss the menu before the second click. */}
        {toolbar}
        <div ref={setHeaderContainer} className="h-full min-w-0 flex-1" />
        {sidebarToggle}
      </div>
      {model.error && (
        <div
          role="alert"
          className="bg-red-bg text-red-fg flex shrink-0 items-center gap-2 px-3 py-2 text-xs"
        >
          <span className="min-w-0 flex-1">{model.error}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChanged(folder)}
            aria-label="Retry changes"
          >
            Retry
          </Button>
        </div>
      )}
      <div ref={containerRef} className="flex min-h-0 flex-1">
        {/* Diff pane — one virtualized stream for every file by default, or
          the selected file when the user chooses focused presentation. */}
        <div className="h-full min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="relative h-full min-h-0 overflow-hidden">
            {!dirtyEditorIds.has(tab.id) && (
              <ChangesDiffViewer
                key={diffOwnerKey}
                active={active}
                files={diffFiles}
                selected={selected}
                selectionRequest={selectionRequest}
                workspaceId={workspaceId}
                cwd={folder}
                ownerKey={diffOwnerKey}
                refreshKey={refreshKey}
                presentation={tab.changesPresentation ?? "all"}
                onPresentationChange={(changesPresentation) =>
                  dispatch({
                    type: "UPDATE_WORKBENCH_TAB",
                    id: tab.id,
                    scope,
                    updates: { changesPresentation },
                  })
                }
                queryForFile={queryForFile}
                toolbarContainer={headerContainer}
              />
            )}
            {/* A pre-existing unsaved editor remains mounted until saved. New
                Changes surfaces never open editors or offer viewer-mode tabs. */}
            {dirtyEditorIds.has(tab.id) &&
              renderedViewKeys.map((viewKey) => {
                const viewTarget = changeFileViewFromKey(viewKey);
                if (!viewTarget) return null;
                const isSelected = viewKey === activeViewKey;
                const isVisible = isRetainedViewVisible(
                  active,
                  viewKey,
                  activeViewKey,
                );
                return (
                  <div
                    key={changeFileViewIdentityKey(viewTarget)}
                    // Retained hidden diff views each carry @pierre/diffs' own
                    // ResizeObservers; pinning them during seam drags (resize-
                    // gesture-freeze.ts) keeps those quiet so only the visible
                    // diff re-virtualizes per frame.
                    {...(!isVisible
                      ? { inert: "", "data-zeros-resize-freeze": "" }
                      : {})}
                    className={cn(
                      "absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden",
                      isVisible
                        ? "pointer-events-auto visible opacity-100"
                        : "pointer-events-none invisible opacity-0",
                    )}
                    aria-hidden={!isVisible}
                  >
                    <FileViewer
                      tabId={tab.id}
                      active={active && isSelected}
                      cwd={cwd}
                      path={viewTarget.path}
                      workspaceId={workspaceId}
                      diff={viewTarget.diff}
                      diffScope={viewTarget.diffScope}
                      diffSha={viewTarget.diffSha}
                      diffHistory={viewTarget.diffHistory}
                      diffBaseBranch={
                        viewTarget.diffScope === "all" ||
                        viewTarget.diffHistory?.kind === "commits"
                          ? baseBranch
                          : undefined
                      }
                      turnChatId={viewTarget.turnChatId}
                      turnId={viewTarget.turnId}
                      discardable={isSelected && viewTarget.discardable}
                      isNewFile={viewTarget.isNewFile}
                      contentRevision={viewTarget.contentRevision}
                      viewerMode="diff"
                      showModeToggle={false}
                      refreshKey={refreshKey}
                      readOnly={!isSelected}
                      headerContainer={isSelected ? headerContainer : null}
                      onOpenPath={handleAdvance}
                    />
                  </div>
                );
              })}
            {!selected && (
              <div className="pointer-events-none absolute inset-0 flex h-full min-h-0 flex-col">
                <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
                  <FileDiff className="text-muted-fg size-10" strokeWidth={1} />
                  <p className="text-fg2 m-0 text-xs">
                    {model.loading
                      ? "Loading changes…"
                      : model.error
                        ? "Choose another comparison or retry."
                        : fileCount > 0
                          ? "Select a change to review its diff"
                          : model.scope.kind === "last-turn" ||
                              model.scope.kind === "turns"
                            ? "No agent changes recorded yet"
                            : model.scope.kind === "staged"
                              ? "No staged changes"
                              : model.scope.kind === "unstaged"
                                ? "No unstaged changes"
                                : model.scope.kind === "uncommitted"
                                  ? "No uncommitted changes"
                                  : model.scope.kind === "all"
                                    ? "No branch changes"
                                    : "No changes in this selection"}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {sidebarVisible && (
          <>
            {/* Body-only seam, aligned with the File tab's right sidebar. */}
            <div className="bg-border1 relative w-px shrink-0">
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize changes sidebar"
                className="absolute -inset-x-[3px] inset-y-0 z-20 cursor-ew-resize select-none"
                onPointerDown={onResizePointerDown}
                onMouseDown={(e) => e.preventDefault()}
                {...hintHandlers}
              />
              {hint}
            </div>

            {/* Keep one list outside the retained viewers so selecting a file
              preserves its scroll container. Percentage width shares the File
              tab's preference and drag bounds. */}
            <div
              ref={sidebarRef}
              className="flex h-full min-h-0 max-w-[70%] min-w-[140px] shrink-0 flex-col overflow-hidden"
              style={{ width: `${sidebarFraction * 100}%` }}
            >
              <div className="flex shrink-0 flex-col gap-3 p-2">
                <div className="relative">
                  <Search className="text-fg3 pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
                  <Input
                    aria-label="Search changed files"
                    placeholder="Search files"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape" && search) {
                        event.stopPropagation();
                        setSearch("");
                      }
                    }}
                    className="h-6 pl-7 text-xs"
                  />
                </div>
                <div className="text-fg2 text-xs" aria-live="polite">
                  {model.loading && fileCount === 0 ? (
                    "Files Changed"
                  ) : (
                    <>
                      {searchQuery ? `${matchingCount} of ` : ""}
                      {fileCount} {fileCount === 1 ? "File" : "Files"} Changed
                    </>
                  )}
                </div>
              </div>
              <ChangesList
                sections={visibleSections}
                view="tree"
                searchQuery={searchQuery}
                loading={model.loading}
                error={model.error}
                showError={false}
                turnFilterActive={!!model.turnFilter}
                rowActions={rowActions}
                scrollKey={listScrollKey}
              />
            </div>
          </>
        )}
      </div>

      {discardTarget && (
        <DiscardDialog
          path={discardTarget.path}
          isNew={discardTarget.isNewFile === true}
          onCancel={() => model.setDiscardTarget(null)}
          onConfirm={() => model.runDiscard(discardTarget)}
        />
      )}
    </div>
  );
}
