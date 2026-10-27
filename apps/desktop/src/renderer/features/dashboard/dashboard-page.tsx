import { useOrganizationProjects } from "../../state/use-organization-projects";
// ──────────────────────────────────────────────────────────
// Dashboard page — shared board and list of owner-scoped workspaces
// ──────────────────────────────────────────────────────────
//
// Full-window page (peer of HistoryPage) reached via activePage === "dashboard".
// Both views share search, repository/archive filters, ordering and metadata.
// The board groups by persisted lifecycle status; archive is an independent
// flag. Rows preserve the workspace's normal open, history and lifecycle actions.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useWarmWorkspaceHistory } from "../../state/use-warm-workspace-history";
import {
  Archive as ArchiveIcon,
  ArrowUp,
  ExternalLink,
  Eye,
  EyeOff,
  Ellipsis,
  FolderX,
  Folder,
  GitMerge,
  GitPullRequestArrow,
  Trash2,
  RotateCcw,
} from "lucide-react";

import { cn } from "../../shared/ui/cn";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import { toast } from "../../shared/ui/primitives/elements";
import { StatusIcon } from "../../shared/ui/primitives/status-icon";
import { WorkspaceContextMenu } from "../../shared/ui/workspace-context-menu";
import {
  LIFECYCLE_STATUSES,
  statusMeta,
} from "../../shared/lib/workspace-status";
import { resolveCardActionKind } from "../../shared/lib/workspace-card-action";
import { useActivePage, useChats } from "../../state/store";
import { Button } from "../../shared/ui/primitives/button";
import { IconButton } from "../../shared/ui/primitives/icon-button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../../shared/ui/primitives/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../shared/ui/primitives/dialog";
import { useExperimentalFeature } from "../settings/experimental-features";
import { useShowHiddenWorkspaces } from "../settings/dashboard-settings";
import {
  AUTO_HIDE_ARCHIVE_MS,
  hideExpiredWorkspaces,
  setWorkspaceHidden,
  useWorkspaceVisibility,
  workspaceIsHidden,
} from "./workspace-visibility";
import {
  notifyWorkspacesChanged,
  commitWorkspaceArchived,
  useArchivedWorkspaces,
  useLiveWorkspaces,
} from "../../state/use-projects";
import {
  dedupePendingCreates,
  useLiveVisible,
} from "../../state/live-workspace-selectors";
import {
  usePendingCreatesAll,
  useWorkspaceArchiving,
  type PendingWorkspaceCreate,
} from "../../state/pending-workspaces";
import { useWorkspaceHasChanges } from "../../shell/pr/use-workspace-has-changes";
import { isGithubDotComRemote } from "../../shell/pr/github-url";
import { useRepositoryRemote } from "../repositories/use-repository-remote";
import { useOpenWorkspace } from "../../state/use-open-workspace";
import {
  saveDashboardRepoFilter,
  useDashboardRepoFilter,
  useDashboardPreferences,
  updateDashboardPreferences,
  type DashboardDisplay,
  type DashboardView,
} from "./preferences";
import {
  dashboardRowBuilder,
  dashboardRowsForArchive,
  dashboardPendingLabel,
  filterDashboardRows,
  filterDashboardPending,
  type DashboardRow as BoardRow,
} from "./dashboard-model";
import { DashboardToolbar, DashboardViewToggle } from "./dashboard-toolbar";
import {
  DashboardList,
  DashboardListRow,
  PendingDashboardListRow,
} from "./dashboard-list";
import {
  DashboardRepositoryIcon,
  DashboardLineChanges,
  DashboardCost,
  DashboardPlacement,
} from "./dashboard-metadata";
import { useSidebarWorkspaceActivity } from "../../shell/sidebar-workspace-activity";
import { useDocumentActive } from "../../state/use-document-active";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { prefetchWorkspaceSurface } from "../../shell/prefetch-workspace-surface";
import {
  restoreWorkspaceWithFeedback,
  useArchiveWorkspace,
} from "../../state/archive-actions";
import { formatCompactAge } from "../agent/format-age";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import {
  ghPrMerge,
  ghPrSync,
  workspaceDeleteSnapshot,
  type Workspace,
} from "../../platform/git";
import { useActiveOrganization } from "../team/team-store";
import { filterRowsForOrganization } from "../team/organization-capabilities";
import { isLocalMainWorkspace } from "../../state/local-main-workspace";
import { useFolderWorkspaces } from "../../state/use-folder-workspaces";
import type { Project } from "../../state/projects-store";
import {
  selectWorkspaceHistory,
  workspaceIsReadOnly,
} from "../../state/workspace-history";

/** Stable empty list so non-Backlog columns don't allocate a new array each
 *  render (the pending placeholders only ever appear under Backlog). */
const EMPTY_PENDING_ROWS: PendingWorkspaceCreate[] = [];

export function DashboardPage() {
  const { projects } = useOrganizationProjects();
  const chats = useChats();
  const { workspaces: liveWorkspaces, loading } = useLiveWorkspaces();
  const listedWorkspaces = useFolderWorkspaces(liveWorkspaces, projects);
  const activeOrganization = useActiveOrganization();
  const accessibleLiveWorkspaces = useMemo(
    () => filterRowsForOrganization(listedWorkspaces, activeOrganization),
    [activeOrganization, listedWorkspaces],
  );
  const workspaces = useLiveVisible(accessibleLiveWorkspaces);
  const rawPending = usePendingCreatesAll();
  const allPending = useMemo(
    () => filterRowsForOrganization(rawPending, activeOrganization),
    [activeOrganization, rawPending],
  );
  const {
    workspaces: rawArchivedWorkspaces,
    loading: archivesLoading,
    error: archivesError,
    refresh: refreshArchives,
  } = useArchivedWorkspaces();
  const visibility = useWorkspaceVisibility();
  const showHidden = useShowHiddenWorkspaces();
  const [autoHide] = useExperimentalFeature(
    "hideArchivedWorkspacesAfter15Days",
  );
  const activePage = useActivePage();
  const active = useDocumentActive(activePage === "dashboard");
  const owner = activeOrganization?.isPersonal
    ? "local"
    : (activeOrganization?.id ?? "local");
  const preferences = useDashboardPreferences();
  const includesArchives = preferences.archive !== "active";
  const archiveError = includesArchives ? archivesError : null;
  const loadingVisibleWorkspaces =
    (preferences.archive !== "archived" && loading) ||
    (includesArchives && archivesLoading);
  const [search, setSearch] = useState({ owner, query: "" });
  const query = search.owner === owner ? search.query : "";
  const setQuery = (value: string) => setSearch({ owner, query: value });
  const ownerName = (workspace: Workspace) =>
    !workspace.organizationId || activeOrganization?.isPersonal
      ? "Local"
      : (activeOrganization?.name ?? "Organization");
  const [now, setNow] = useState(Date.now);
  // One deadline for the aggregate; no per-card polling. Re-evaluate on app
  // resume, and detach timers/listeners while the retained page is inactive.
  useEffect(() => {
    if (!autoHide || activePage !== "dashboard") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") return;
      const time = Date.now();
      setNow(time);
      hideExpiredWorkspaces(rawArchivedWorkspaces, time);
      const next = rawArchivedWorkspaces.reduce((deadline, workspace) => {
        if (
          workspace.archivedAt == null ||
          visibility.entries[workspace.id]?.archivedAt === workspace.archivedAt
        )
          return deadline;
        const due = workspace.archivedAt + AUTO_HIDE_ARCHIVE_MS;
        return due > time ? Math.min(deadline, due) : deadline;
      }, Infinity);
      if (Number.isFinite(next))
        timer = setTimeout(refresh, Math.min(next - time, 2_147_483_647));
    };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [autoHide, activePage, rawArchivedWorkspaces, visibility]);
  const archivedWorkspaces = useMemo(
    () => filterRowsForOrganization(rawArchivedWorkspaces, activeOrganization),
    [activeOrganization, rawArchivedWorkspaces],
  );
  const openWorkspace = useOpenWorkspace();
  // Persist the requested repository identity. A removed/stale slug derives to
  // All projects during render, without a post-paint correction effect.
  const requestedRepoFilter = useDashboardRepoFilter();
  const repoFilter =
    requestedRepoFilter &&
    projects.some((project) => project.repoSlug === requestedRepoFilter)
      ? requestedRepoFilter
      : null;
  const setRepoFilter = saveDashboardRepoFilter;
  const showArchived = preferences.archive !== "active";
  const revealArchived = () => updateDashboardPreferences({ archive: "all" });

  // Reconcile external merges: a workspace whose PR was merged on github.com (not
  // via our Merge button) is still recorded "in-review". ghPrSync now detects a
  // merged PR and flips it to "done". Do it once per id per mount so the board is
  // accurate without hammering the API on every refetch.
  const syncedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!active) return;
    const liveIds = new Set(workspaces.map((workspace) => workspace.id));
    for (const id of syncedRef.current)
      if (!liveIds.has(id)) syncedRef.current.delete(id);
    for (const w of workspaces) {
      if (
        !isCloudWorkspace(w.path) &&
        w.status === "in-review" &&
        w.prNumber != null &&
        !syncedRef.current.has(w.id)
      ) {
        syncedRef.current.add(w.id);
        void ghPrSync(w.id)
          .then((pr) => {
            if (pr?.state === "merged") notifyWorkspacesChanged(w.repoSlug);
          })
          .catch(() => {
            syncedRef.current.delete(w.id);
          });
      }
    }
  }, [workspaces, active]);

  const historyWorkspaces = useMemo(
    () => selectWorkspaceHistory(accessibleLiveWorkspaces, archivedWorkspaces),
    [accessibleLiveWorkspaces, archivedWorkspaces],
  );
  const activityWorkspaces = useMemo(
    () => [...workspaces, ...historyWorkspaces],
    [workspaces, historyWorkspaces],
  );
  const activity = useSidebarWorkspaceActivity(
    owner,
    activityWorkspaces,
    chats,
    active,
  );
  const projectBySlug = useMemo(
    () => new Map(projects.map((project) => [project.repoSlug, project])),
    [projects],
  );
  const toRow = useMemo(
    () => dashboardRowBuilder(projects, chats, activity),
    [projects, chats, activity],
  );
  const rows = useMemo(() => workspaces.map(toRow), [workspaces, toRow]);
  // In-flight optimistic creates as board placeholders, deduped against the real
  // union so a placeholder vanishes the instant its real row lands.
  const dedupedPending = useMemo(
    () => dedupePendingCreates(allPending, accessibleLiveWorkspaces),
    [accessibleLiveWorkspaces, allPending],
  );
  const pendingRows = useMemo(
    () =>
      preferences.archive === "archived"
        ? EMPTY_PENDING_ROWS
        : filterDashboardPending(
            dedupedPending,
            projectBySlug,
            repoFilter,
            query,
          ),
    [dedupedPending, projectBySlug, repoFilter, query, preferences.archive],
  );
  // Confirmed archived and missing rows share this column. Archive intent
  // alone never inserts a row; its confirmed commit removes the live card
  // and publishes history atomically.
  const archivedRows = useMemo(
    () =>
      historyWorkspaces
        .map((workspace) => ({
          ...toRow(workspace),
          hidden: workspaceIsHidden(
            workspace,
            visibility,
            autoHide,
            activePage === "dashboard" ? Math.max(now, Date.now()) : now,
          ),
        }))
        .filter((row) => showHidden || !row.hidden),
    [
      historyWorkspaces,
      toRow,
      visibility,
      autoHide,
      now,
      showHidden,
      activePage,
    ],
  );

  const allRows = useMemo(
    () => [...rows, ...archivedRows],
    [rows, archivedRows],
  );
  const visibleRows = useMemo(
    () =>
      filterDashboardRows(
        dashboardRowsForArchive(allRows, preferences.archive),
        repoFilter,
        query,
        preferences.sort,
      ),
    [allRows, preferences.archive, preferences.sort, repoFilter, query],
  );
  const filteredArchived = useMemo(
    () => visibleRows.filter((row) => row.workspace.archivedAt != null),
    [visibleRows],
  );
  const byStatus = useMemo(() => {
    const map = new Map<string, BoardRow[]>();
    for (const status of LIFECYCLE_STATUSES) map.set(status.value, []);
    for (const row of visibleRows)
      if (row.workspace.archivedAt == null)
        map.get(statusMeta(row.workspace.status).value)?.push(row);
    return map;
  }, [visibleRows]);
  const showRepoChip = preferences.display.repositoryIcon;
  const count = visibleRows.length + pendingRows.length;
  const renderRow = (row: BoardRow, rowIndex?: number) =>
    workspaceIsReadOnly(row.workspace) ? (
      <ArchivedCard
        key={row.workspace.id}
        row={row}
        showRepoChip={showRepoChip}
        active={active}
        view={preferences.view}
        display={preferences.display}
        ownerName={ownerName(row.workspace)}
        rowIndex={rowIndex}
      />
    ) : (
      <DashboardCard
        key={row.workspace.id}
        row={row}
        showRepoChip={showRepoChip}
        active={active}
        view={preferences.view}
        display={preferences.display}
        ownerName={ownerName(row.workspace)}
        rowIndex={rowIndex}
        onOpen={() => openWorkspace(row.workspace)}
        onArchived={revealArchived}
      />
    );
  return (
    <div className="bg-bg1 flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
      <div
        className="flex shrink-0 items-center gap-3 px-6 pt-4 pb-3"
        data-tauri-drag-region
      >
        <h1 className="text-fg1 text-base font-medium">Dashboard</h1>
        {!loadingVisibleWorkspaces && (
          <span
            className="text-muted-fg text-sm tabular-nums"
            data-dashboard-count
            aria-label={`${count} workspaces`}
          >
            {count}
          </span>
        )}
        <DashboardViewToggle view={preferences.view} />
      </div>
      <DashboardToolbar
        key={owner}
        preferences={preferences}
        query={query}
        onQueryChange={setQuery}
        active={active}
      />
      <div
        className="flex shrink-0 items-center gap-1 overflow-x-auto px-6 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="group"
        aria-label="Filter by repository"
      >
        <FilterTab
          active={repoFilter === null}
          onClick={() => setRepoFilter(null)}
        >
          All projects
        </FilterTab>
        {projects.map((p) => (
          <FilterTab
            key={p.repoSlug}
            active={repoFilter === p.repoSlug}
            onClick={() => setRepoFilter(p.repoSlug)}
          >
            <DashboardRepositoryIcon project={p} name={p.name} />
            <span className="max-w-48 truncate">{p.name}</span>
          </FilterTab>
        ))}
      </div>
      {archiveError && count > 0 && (
        <div
          className="text-fg3 flex shrink-0 items-center gap-3 px-6 pb-3 text-xs"
          role="status"
        >
          <span>Couldn't load archived workspaces</span>
          <Button
            variant="ghost"
            size="compact"
            onClick={refreshArchives}
            aria-label="Retry loading archived workspaces"
          >
            Retry
          </Button>
        </div>
      )}
      {count === 0 ? (
        <div
          className="text-fg3 flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 pb-12"
          role="status"
        >
          <Folder
            className="text-muted-fg size-8"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <p className="text-fg2 text-sm">
            {loadingVisibleWorkspaces
              ? "Loading workspaces…"
              : archiveError
                ? "Couldn't load archived workspaces"
                : query.trim() || repoFilter
                  ? "No matching workspaces"
                  : preferences.archive === "archived"
                    ? "No archived workspaces"
                    : "No workspaces yet"}
          </p>
          {archiveError && !loadingVisibleWorkspaces && (
            <Button
              variant="secondary"
              onClick={refreshArchives}
              aria-label="Retry loading archived workspaces"
            >
              Retry
            </Button>
          )}
          {(query || repoFilter) && (
            <Button
              variant="secondary"
              onClick={() => {
                setQuery("");
                setRepoFilter(null);
              }}
            >
              Clear filters
            </Button>
          )}
        </div>
      ) : preferences.view === "list" ? (
        <DashboardList
          rows={visibleRows}
          pending={pendingRows}
          display={preferences.display}
          active={active}
          renderRow={renderRow}
          renderPending={(pending, rowIndex) => (
            <PendingDashboardListRow
              key={pending.token}
              label={dashboardPendingLabel(pending)}
              display={preferences.display}
              rowIndex={rowIndex}
            />
          )}
        />
      ) : (
        <div
          className="zeros-hscroll min-h-0 flex-1 overflow-x-auto overflow-y-hidden pb-3"
          data-dashboard-view="board"
        >
          <div className="flex h-full min-h-0 w-max gap-4 px-6">
            {showArchived && (
              <ArchivedColumn
                rows={filteredArchived}
                showRepoChip={showRepoChip}
                active={active}
                display={preferences.display}
                ownerName={ownerName}
              />
            )}
            {preferences.archive !== "archived" &&
              LIFECYCLE_STATUSES.map((status) => {
                const items = byStatus.get(status.value) ?? [];
                const pendingHere =
                  status.value === "backlog" ? pendingRows : EMPTY_PENDING_ROWS;
                return (
                  <div
                    key={status.value}
                    className="flex h-full min-h-0 w-72 shrink-0 flex-col px-3"
                    role="group"
                    aria-label={`${status.label} workspaces`}
                  >
                    <div className="mb-3 flex shrink-0 items-center gap-2">
                      <StatusIcon status={status.value} className="size-4" />
                      <span className="text-fg1 text-sm font-medium">
                        {status.label}
                      </span>
                      <span className="text-muted-fg text-xs tabular-nums">
                        {items.length + pendingHere.length}
                      </span>
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                      {pendingHere.map((pending) => (
                        <PendingDashboardCard
                          key={pending.token}
                          label={dashboardPendingLabel(pending)}
                          repoName={
                            projectBySlug.get(pending.repoSlug)?.name ??
                            pending.repository?.name ??
                            pending.repoSlug
                          }
                          project={projectBySlug.get(pending.repoSlug) ?? null}
                          showRepoChip={showRepoChip}
                        />
                      ))}
                      {items.map((row) => renderRow(row))}
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}

function FilterTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "shrink-0 gap-1.5 px-2",
        active
          ? "bg-bg2-hover text-fg1"
          : "text-fg2 hover:bg-bg1-hover hover:text-fg1",
      )}
    >
      {children}
    </Button>
  );
}

// The Archived pseudo-column — archived is an orthogonal flag, not a status, so
// it renders first (before Backlog) when the archive filter includes it.
function ArchivedColumn({
  rows,
  showRepoChip,
  active,
  display,
  ownerName,
}: {
  rows: BoardRow[];
  showRepoChip: boolean;
  active: boolean;
  display: DashboardDisplay;
  ownerName: (workspace: Workspace) => string;
}) {
  // A dotted outline (no fill) sets the Archived column apart — archived isn't a
  // status, so it reads as a different kind of column without adding weight.
  // Same layout as the live columns (no column frame) — Archived is set apart by
  // its outlined, unfilled cards + the Archive header, not a border.
  return (
    <div className="flex h-full min-h-0 w-72 shrink-0 flex-col px-3">
      <div className="mb-3 flex shrink-0 items-center gap-2">
        <ArchiveIcon className="text-muted-fg size-4" />
        <span className="text-fg1 text-sm font-medium">Archived</span>
        <span className="text-fg2 text-xs tabular-nums">{rows.length}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {rows.map((row) => (
          <ArchivedCard
            key={row.workspace.id}
            row={row}
            showRepoChip={showRepoChip}
            active={active}
            view="board"
            display={display}
            ownerName={ownerName(row.workspace)}
          />
        ))}
      </div>
    </div>
  );
}

function ArchivedCard({
  row,
  showRepoChip,
  active,
  view,
  display,
  ownerName,
  rowIndex,
}: {
  row: BoardRow;
  showRepoChip: boolean;
  active: boolean;
  view: DashboardView;
  display: DashboardDisplay;
  ownerName: string;
  rowIndex?: number;
}) {
  const warmHistory = useWarmWorkspaceHistory();
  const w = row.workspace;
  const [restoring, setRestoring] = useState(false);
  const [snapshotToDelete, setSnapshotToDelete] = useState<{
    archiveSnapshot: string;
    archivedAt: number;
  } | null>(null);
  const [deletingSnapshot, setDeletingSnapshot] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (active) return;
    setMenuOpen(false);
    setSnapshotToDelete(null);
  }, [active]);
  const openWorkspace = useOpenWorkspace();
  const deleteSnapshot = async () => {
    if (!snapshotToDelete || deletingSnapshot) return;
    setDeletingSnapshot(true);
    try {
      const workspace = await workspaceDeleteSnapshot({
        workspaceId: w.id,
        ...snapshotToDelete,
      });
      commitWorkspaceArchived(workspace);
      setSnapshotToDelete(null);
      toast.success("Saved snapshot deleted", {
        description:
          "Chats, messages, branch, and workspace history were kept.",
      });
    } catch (error) {
      toast.error("Couldn't delete the saved snapshot", {
        description:
          error instanceof Error
            ? error.message
            : "Refresh the workspace and retry.",
      });
    } finally {
      setDeletingSnapshot(false);
      notifyWorkspacesChanged(w.repoSlug);
    }
  };
  const unarchive = () => {
    if (restoring || deletingSnapshot) return;
    setRestoring(true);
    // Serialized per-id across surfaces; surfaces restore's path/branch
    // adaptations + conflicts. onSettled clears the spinner in every path.
    void restoreWorkspaceWithFeedback(w, {
      label: row.title,
      onSettled: () => setRestoring(false),
      // Navigate only after the engine confirms the restored worktree and the
      // cache has atomically moved it back to Live.
      onRestored: (result) => openWorkspace(result.workspace),
    });
  };
  const actions = (
    <>
      {w.archivedAt != null &&
        (view === "list" ? (
          <Tooltip label="Unarchive">
            <IconButton
              size="compact"
              label={`Unarchive ${row.title}`}
              onClick={unarchive}
              disabled={restoring || deletingSnapshot}
            >
              {restoring ? (
                <ZerosSpinner size={14} />
              ) : (
                <RotateCcw className="size-3.5" />
              )}
            </IconButton>
          </Tooltip>
        ) : (
          <Button
            variant="secondary"
            size="compact"
            onClick={unarchive}
            disabled={restoring || deletingSnapshot}
          >
            {restoring && <ZerosSpinner size={14} />}
            <span>{restoring ? "Restoring…" : "Unarchive"}</span>
          </Button>
        ))}
      {row.hidden && (
        <Tooltip label="Hidden workspace">
          <span
            className="text-muted-fg inline-flex"
            role="img"
            aria-label="Hidden workspace"
          >
            <EyeOff size={14} aria-hidden="true" />
          </span>
        </Tooltip>
      )}
      {w.archivedAt != null && (
        <DropdownMenu open={active && menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <IconButton
              size="compact"
              label={`Options for ${row.title}`}
              disabled={restoring || deletingSnapshot}
            >
              <Ellipsis size={14} aria-hidden="true" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => setWorkspaceHidden(w, !row.hidden)}
            >
              {row.hidden ? <Eye /> : <EyeOff />}
              {row.hidden ? "Unhide" : "Hide"}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-red-primary focus:text-red-primary"
              disabled={!w.archiveSnapshot}
              onSelect={() => {
                if (w.archiveSnapshot && w.archivedAt != null)
                  setSnapshotToDelete({
                    archiveSnapshot: w.archiveSnapshot,
                    archivedAt: w.archivedAt,
                  });
              }}
            >
              <Trash2 />
              Delete saved snapshot…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
  return (
    <>
      {view === "list" ? (
        <DashboardListRow
          row={row}
          aria-rowindex={rowIndex}
          display={display}
          ownerName={ownerName}
          active={active}
          onOpen={() => openWorkspace(w)}
          onWarm={() => warmHistory(w)}
          actions={actions}
          busy={restoring || deletingSnapshot}
        />
      ) : (
        <div
          role="button"
          tabIndex={0}
          aria-label={`Open ${row.title} history`}
          data-dashboard-workspace={w.id}
          onPointerEnter={() => {
            if (active) warmHistory(w);
          }}
          onFocus={() => {
            if (active) warmHistory(w);
          }}
          onClick={() => {
            if (active) openWorkspace(w);
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget || !active) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openWorkspace(w);
            }
          }}
          className="border-border1 hover:bg-bg1-hover focus-visible:outline-highlighted-bright flex cursor-pointer flex-col rounded-lg border p-3 text-left select-none focus-visible:outline-2 focus-visible:-outline-offset-2"
        >
          <div className="flex items-center gap-2">
            {showRepoChip && (
              <DashboardRepositoryIcon
                project={row.project}
                name={row.repoName}
              />
            )}
            <span className="text-fg2 min-w-0 flex-1 truncate text-xs">
              {row.branch}
            </span>
            <StatusIcon status={w.status} className="size-3.5" />
          </div>
          <div className="text-fg1 mt-1.5 truncate text-sm font-medium">
            {row.title}
          </div>
          <div className="text-fg3 mt-1 text-xs">
            {w.archivedAt == null ? "Folder missing" : "Archived"}
          </div>
          <DashboardCardMetadata
            row={row}
            display={display}
            ownerName={ownerName}
            active={active}
          />
          <div
            className="mt-2.5 flex items-center gap-2"
            onClick={(event) => event.stopPropagation()}
          >
            {actions}
            {display.lastActive && (
              <span className="text-muted-fg ml-auto text-xs tabular-nums">
                {formatCompactAge(row.lastActiveAt)}
              </span>
            )}
          </div>
        </div>
      )}
      <Dialog
        open={active && snapshotToDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deletingSnapshot) setSnapshotToDelete(null);
        }}
      >
        <DialogContent
          showCloseButton={!deletingSnapshot}
          onClick={(event) => event.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle>
              Delete the saved snapshot for “{row.title}”?
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogDescription>
              Files stored only in this snapshot, including uncommitted files
              and attachments, will no longer be restorable from this archive.
              Chats, messages, the branch, and workspace history will be kept.
              Unarchiving afterward restores committed files only.
            </DialogDescription>
          </DialogBody>
          <DialogFooter>
            <Button
              disabled={deletingSnapshot}
              onClick={() => setSnapshotToDelete(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deletingSnapshot}
              onClick={() => void deleteSnapshot()}
            >
              {deletingSnapshot ? "Deleting…" : "Delete saved snapshot"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DashboardCardMetadata({
  row,
  display,
  ownerName,
  active,
}: {
  row: BoardRow;
  display: DashboardDisplay;
  ownerName: string;
  active: boolean;
}) {
  if (
    !display.repository &&
    !display.lineChanges &&
    !display.cost &&
    !display.owner
  )
    return null;
  return (
    <div className="text-fg3 text-3xxs mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
      {display.repository && (
        <span className="max-w-24 truncate" title={row.repoName}>
          {row.repoName}
        </span>
      )}
      {display.lineChanges && (
        <DashboardLineChanges workspace={row.workspace} active={active} />
      )}
      {display.cost && <DashboardCost />}
      {display.owner && (
        <span className="ml-auto max-w-24 truncate" title={ownerName}>
          {ownerName}
        </span>
      )}
    </div>
  );
}

/** A non-clickable Backlog placeholder for an in-flight optimistic create —
 *  shown until the real workspace row lands (then deduped away). NOT a synthetic
 *  Workspace, so it never enters toRow / byStatus / the lazy change probe. */

function PendingDashboardCard({
  label,
  project,
  repoName,
  showRepoChip,
}: {
  label: string;
  project: Project | null;
  repoName: string;
  showRepoChip: boolean;
}) {
  return (
    <div
      className="border-border1 bg-bg2 flex flex-col rounded-lg border p-3 text-left opacity-80 select-none"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        {showRepoChip && (
          <DashboardRepositoryIcon project={project} name={repoName} />
        )}
        <span className="text-fg2 min-w-0 flex-1 truncate text-xs">
          {label}
        </span>
        <ZerosSpinner size={14} />
      </div>
      <div className="text-fg1 mt-1.5 truncate text-sm font-medium">
        Setting up workspace…
      </div>
    </div>
  );
}

function DashboardCard({
  row,
  showRepoChip,
  onOpen,
  onArchived,
  active,
  view,
  display,
  ownerName,
  rowIndex,
}: {
  row: BoardRow;
  showRepoChip: boolean;
  onOpen: () => void;
  onArchived: () => void;
  active: boolean;
  view: DashboardView;
  display: DashboardDisplay;
  ownerName: string;
  rowIndex?: number;
}) {
  const w = row.workspace;
  const archiveWorkspace = useArchiveWorkspace();
  const mutating = useWorkspaceArchiving(w.id);
  const [busy, setBusy] = useState<null | "merge">(null);
  // Lazy, tri-state dirtiness probe (replaces the removed heavy withChanges list
  // column). `undefined` until the first probe resolves → resolveCardActionKind
  // shows NO button rather than a possibly-wrong destructive Merge.
  const localFolder = isLocalMainWorkspace(w);
  const cloud = isCloudWorkspace(w.path);
  const { remoteUrl } = useRepositoryRemote(w.repoRoot, row.project?.originUrl ?? null, active && view === "board" && !localFolder && !cloud);
  const probedChanges = useWorkspaceHasChanges(
    localFolder || cloud ? null : w,
    active && view === "board" && !localFolder && !cloud,
    { probeWithPr: true },
  );
  // Home is passive. A cloud card must never attach to or wake a VM for its PR action.
  const hasChanges = cloud ? undefined : probedChanges;
  // Missing or broken Git metadata keeps the workspace reachable for recovery.
  const missing = w.present === false;

  const merge = async () => {
    if (w.prNumber == null) return;
    setBusy("merge");
    try {
      await ghPrMerge({
        workspaceId: w.id,
        prNumber: w.prNumber,
        method: "squash",
      });
      notifyWorkspacesChanged(w.repoSlug);
      toast.success(`Merged "${row.title}"`);
    } catch (err) {
      toast.error("Couldn't merge PR", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  const archive = async () => {
    if (mutating) return;
    await archiveWorkspace(w, { label: row.title, onArchived });
  };

  // The card's action mirrors the workspace's OWN state machine — resolved by the
  // pure, unit-tested `resolveCardActionKind` (git + PR reality + disk presence,
  // NOT the kanban column) — then mapped here to a label/icon/handler. Prompt-
  // style actions (create-pr, commit-and-push, ready-for-review) open the
  // workspace, where the agent + PR island run them, so dirty work is never
  // skipped by a direct GitHub API call.
  type CardAction = {
    label: string;
    icon: typeof GitMerge;
    run: () => void;
    busyKey: "archive" | "merge" | null;
  };
  let action: CardAction | null;
  switch (resolveCardActionKind(w, hasChanges, isGithubDotComRemote(remoteUrl))) {
    case "recover":
      action = {
        label: "Recover",
        icon: FolderX,
        run: onOpen,
        busyKey: null,
      };
      break;
    case "archive":
      action = {
        label: "Archive",
        icon: ArchiveIcon,
        run: () => void archive(),
        busyKey: "archive",
      };
      break;
    case "commit-push":
      action = {
        // Mirrors the island's button label (2026-07-19 redesign).
        label: "Commit & Push",
        icon: ArrowUp,
        run: onOpen,
        busyKey: null,
      };
      break;
    case "ready-for-review":
      action = {
        label: "Ready for review",
        icon: GitPullRequestArrow,
        run: onOpen,
        busyKey: null,
      };
      break;
    case "merge":
      action = {
        label: "Merge",
        icon: GitMerge,
        run: () => void merge(),
        busyKey: "merge",
      };
      break;
    case "create-pr":
      action = {
        label: "Create PR",
        icon: GitPullRequestArrow,
        run: onOpen,
        busyKey: null,
      };
      break;
    default:
      action = null; // nothing done → no button (matches the workspace header)
  }
  const spinning =
    action?.busyKey === "archive"
      ? mutating
      : action?.busyKey != null && busy === action.busyKey;
  const ActionIcon = action?.icon;

  const stop = (event: React.MouseEvent) => event.stopPropagation();
  const warm = () => {
    if (active && !cloud) prefetchWorkspaceSurface(w);
  };
  const prLink =
    w.prNumber != null && w.prUrl ? (
      <Tooltip label="Open PR">
        <a
          href={w.prUrl}
          target="_blank"
          rel="noreferrer"
          onClick={stop}
          className="text-fg3 hover:text-fg1 inline-flex items-center gap-0.5 text-xs"
        >
          #{w.prNumber}
          <ExternalLink className="size-3" />
        </a>
      </Tooltip>
    ) : null;
  const content =
    view === "list" ? (
      <DashboardListRow
        row={row}
        aria-rowindex={rowIndex}
        display={display}
        ownerName={ownerName}
        active={active}
        onOpen={onOpen}
        onWarm={warm}
        busy={mutating}
        actions={
          <>
            {prLink}
            {!localFolder && (
              <Tooltip label="Archive">
                <IconButton
                  size="compact"
                  label={`Archive ${row.title}`}
                  disabled={mutating}
                  onClick={() => void archive()}
                >
                  {mutating ? (
                    <ZerosSpinner size={14} />
                  ) : (
                    <ArchiveIcon className="size-3.5" />
                  )}
                </IconButton>
              </Tooltip>
            )}
          </>
        }
      />
    ) : (
      <div
        role="button"
        tabIndex={0}
        data-dashboard-workspace={w.id}
        aria-label={`Open ${row.title}`}
        onPointerEnter={warm}
        onFocus={warm}
        onClick={() => {
          if (!mutating && active) onOpen();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || !active) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (!mutating) onOpen();
          }
        }}
        aria-busy={mutating || undefined}
        className="border-border1 bg-bg2 hover:border-border3 focus-visible:outline-highlighted-bright flex cursor-pointer flex-col rounded-lg border p-3 text-left transition-colors select-none focus-visible:outline-2 focus-visible:-outline-offset-2"
      >
        <div className="flex items-center gap-2">
          {showRepoChip && (
            <DashboardRepositoryIcon
              project={row.project}
              name={row.repoName}
            />
          )}
          <span className="text-fg2 min-w-0 flex-1 truncate text-xs">
            {row.branch}
          </span>
          <DashboardPlacement workspace={w} active={active} />
          {localFolder ? (
            <Folder className="text-fg2 size-3.5" strokeWidth={1.5} />
          ) : missing ? (
            <FolderX
              className="text-red-primary size-3.5"
              aria-label="Worktree missing"
            />
          ) : (
            <StatusIcon status={w.status} className="size-3.5" />
          )}
        </div>
        <div className="text-fg1 mt-1.5 truncate text-sm font-medium">
          {row.title}
        </div>
        {missing && (
          <div className="text-red-primary mt-1 text-xs">Worktree missing</div>
        )}
        <DashboardCardMetadata
          row={row}
          display={display}
          ownerName={ownerName}
          active={active}
        />
        <div className="mt-2.5 flex items-center gap-2">
          {action && ActionIcon && (
            <Button
              variant="secondary"
              size="compact"
              onClick={(event) => {
                stop(event);
                action?.run();
              }}
              disabled={busy !== null || mutating}
            >
              {spinning ? (
                <ZerosSpinner size={14} />
              ) : (
                <ActionIcon className="size-3.5" />
              )}
              <span>
                {mutating && action.busyKey === "archive"
                  ? "Archiving…"
                  : action.label}
              </span>
            </Button>
          )}
          <div className="text-muted-fg ml-auto flex items-center gap-2 text-xs tabular-nums">
            {prLink}
            {display.lastActive && (
              <span>{formatCompactAge(row.lastActiveAt)}</span>
            )}
          </div>
        </div>
      </div>
    );
  // Removing the cheap menu boundary while hidden dismisses its portal and
  // keyboard handlers immediately; no hidden retained context menu survives.
  return active ? (
    <WorkspaceContextMenu
      workspace={w}
      onArchive={archive}
      archiveDisabled={mutating}
    >
      {content}
    </WorkspaceContextMenu>
  ) : (
    content
  );
}
