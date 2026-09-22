// ──────────────────────────────────────────────────────────
// Dashboard page — cross-repo kanban board of live workspaces
// ──────────────────────────────────────────────────────────
//
// Full-window page (peer of HistoryPage) reached via activePage === "dashboard".
// Lists NON-archived workspaces across every repo, grouped into the five
// lifecycle columns (Backlog / In progress / In review / Done / Cancelled), with
// an "All projects" + per-repo filter. Each card opens the workspace on click,
// exposes a state-appropriate primary action (Create PR / Merge / Archive), and
// carries the same right-click "Set status / Archive" menu as workspace tabs.
//
// Status is the persisted `workspace.status`; archiving a card moves it out of
// the board into History (archived is the orthogonal `archivedAt` flag).

import React, { useEffect, useMemo, useRef, useState } from "react";
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
} from "lucide-react";

import { cn } from "../../shared/ui/cn";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import { toast } from "../../shared/ui/primitives/elements";
import { StatusIcon } from "../../shared/ui/primitives/status-icon";
import { WorkspaceContextMenu } from "../../shared/ui/workspace-context-menu";
import { Switch } from "../../shared/ui/primitives/switch";
import { LIFECYCLE_STATUSES } from "../../shared/lib/workspace-status";
import { resolveCardActionKind } from "../../shared/lib/workspace-card-action";
import { useActivePage, useChats } from "../../state/store";
import { Button } from "../../shared/ui/primitives/button";
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
  useProjects,
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
import { useOpenWorkspace } from "../../state/use-open-workspace";
import { saveDashboardRepoFilter, useDashboardRepoFilter } from "./preferences";
import {
  restoreWorkspaceWithFeedback,
  useArchiveWorkspace,
} from "../../state/archive-actions";
import { branchDisplayName } from "../../shared/lib/branch-name";
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
import {
  projectInitial,
  RepositoryIcon,
} from "../repositories/repository-icon";
import { isLocalMainWorkspace } from "../../state/local-main-workspace";
import { useFolderWorkspaces } from "../../state/use-folder-workspaces";
import type { Project } from "../../state/projects-store";

const REPO_CHIP_CLS =
  "inline-flex size-5 shrink-0 items-center justify-center rounded-sm bg-bg2-hover text-xxs font-medium leading-none text-fg2";

// Compact secondary action button on a card — transparent fill so it blends
// with the card's surface (matches the secondary button family).
const CARD_ACTION_CLS =
  "inline-flex items-center gap-1.5 rounded-sm border border-border3 bg-transparent px-2 py-1 text-xs font-medium text-fg1 transition-colors hover:bg-bg2-hover disabled:pointer-events-none disabled:opacity-60";

// The "Archived" toggle persists across reloads (the Archived column is heavy,
// so remember the user's choice) — localStorage, best-effort.
const SHOW_ARCHIVED_KEY = "zeros:dashboard-show-archived";
function readShowArchived(): boolean {
  try {
    return localStorage.getItem(SHOW_ARCHIVED_KEY) === "1";
  } catch {
    return false;
  }
}

// Branch → workspace name goes through the shared branchDisplayName (see
// renderer/shared/lib/branch-name.ts). The private `zeros/`-literal strip that used to
// live here stopped being correct when Settings → Git made the prefix a
// choice: a workspace on `jordan/Cream` showed its whole ref where every other
// surface showed `Cream`.

/** Stable empty list so non-Backlog columns don't allocate a new array each
 *  render (the pending placeholders only ever appear under Backlog). */
const EMPTY_PENDING_ROWS: PendingWorkspaceCreate[] = [];

interface BoardRow {
  workspace: Workspace;
  project: Project | null;
  repoName: string;
  /** Owning-chat title if present, else the (prefix-stripped) branch. */
  title: string;
  branch: string;
  hidden?: boolean;
}

export function DashboardPage() {
  const { projects } = useProjects();
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
  const { workspaces: rawArchivedWorkspaces } = useArchivedWorkspaces();
  const visibility = useWorkspaceVisibility();
  const showHidden = useShowHiddenWorkspaces();
  const [autoHide] = useExperimentalFeature(
    "hideArchivedWorkspacesAfter15Days",
  );
  const activePage = useActivePage();
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
  const [showArchived, setShowArchived] = useState<boolean>(readShowArchived);
  useEffect(() => {
    try {
      localStorage.setItem(SHOW_ARCHIVED_KEY, showArchived ? "1" : "0");
    } catch {
      /* storage disabled (private mode) — non-fatal */
    }
  }, [showArchived]);

  // Reconcile external merges: a workspace whose PR was merged on github.com (not
  // via our Merge button) is still recorded "in-review". ghPrSync now detects a
  // merged PR and flips it to "done". Do it once per id per mount so the board is
  // accurate without hammering the API on every refetch.
  const syncedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const w of workspaces) {
      if (
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
  }, [workspaces]);

  // A row-builder: join repo name by slug + derive a title from the owning chat
  // (most-recently-updated chat in the worktree folder), else the branch. Reused
  // for BOTH live and archived rows — archive doesn't move the chat's folder, so
  // titleByFolder still resolves for an archived workspace's (now-gone) path.
  const projectBySlug = useMemo(
    () => new Map(projects.map((project) => [project.repoSlug, project])),
    [projects],
  );
  const toRow = useMemo(() => {
    const titleByFolder = new Map<
      string,
      { title: string; updatedAt: number }
    >();
    for (const c of chats) {
      const folder = c.folder;
      const title = (c.title ?? "").trim();
      if (!folder || !title || title === "Untitled") continue;
      const prev = titleByFolder.get(folder);
      const updatedAt = c.updatedAt ?? 0;
      if (!prev || updatedAt > prev.updatedAt)
        titleByFolder.set(folder, { title, updatedAt });
    }
    return (w: Workspace): BoardRow => {
      const branch = branchDisplayName(w.branch);
      const project = projectBySlug.get(w.repoSlug) ?? null;
      return {
        workspace: w,
        project,
        repoName: project?.name ?? w.repoSlug,
        title: isLocalMainWorkspace(w)
            ? branch
            : titleByFolder.get(w.path)?.title || branch,
        branch,
      };
    };
  }, [chats, projectBySlug]);

  const rows = useMemo(() => workspaces.map(toRow), [workspaces, toRow]);
  // In-flight optimistic creates as board placeholders, deduped against the real
  // union so a placeholder vanishes the instant its real row lands.
  const dedupedPending = useMemo(
    () => dedupePendingCreates(allPending, accessibleLiveWorkspaces),
    [accessibleLiveWorkspaces, allPending],
  );
  const pendingRows = useMemo(
    () =>
      repoFilter
        ? dedupedPending.filter((p) => p.repoSlug === repoFilter)
        : dedupedPending,
    [dedupedPending, repoFilter],
  );
  // Only authoritatively archived rows enter this column. The archive commit
  // atomically removes the live card and inserts this row, so there is no
  // disappear/rollback bounce on a concrete failure.
  const archivedRows = useMemo(
    () =>
      archivedWorkspaces
        .map((workspace) => ({
          ...toRow(workspace),
          hidden: workspaceIsHidden(
            workspace,
            visibility,
            autoHide,
            activePage === "dashboard" ? Math.max(now, Date.now()) : now,
          ),
        }))
        .filter((row) => showHidden || !row.hidden)
        .sort(
          (a, b) =>
            (b.workspace.archivedAt ?? 0) - (a.workspace.archivedAt ?? 0),
        ),
    [
      archivedWorkspaces,
      toRow,
      visibility,
      autoHide,
      now,
      showHidden,
      activePage,
    ],
  );

  const filtered = useMemo(
    () =>
      repoFilter
        ? rows.filter((r) => r.workspace.repoSlug === repoFilter)
        : rows,
    [rows, repoFilter],
  );
  const filteredArchived = useMemo(
    () =>
      repoFilter
        ? archivedRows.filter((r) => r.workspace.repoSlug === repoFilter)
        : archivedRows,
    [archivedRows, repoFilter],
  );

  const byStatus = useMemo(() => {
    const map = new Map<string, BoardRow[]>();
    for (const s of LIFECYCLE_STATUSES) map.set(s.value, []);
    for (const r of filtered) map.get(r.workspace.status)?.push(r);
    return map;
  }, [filtered]);

  const showRepoChip = repoFilter === null;

  return (
    <div className="bg-bg1 flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
      {/* The global top bar now owns native title-bar spacing. */}
      <div
        className="flex shrink-0 items-center gap-3 px-6 pt-4 pb-4"
        data-tauri-drag-region
      >
        <h1 className="text-fg1 text-base font-medium">Dashboard</h1>
        {!loading && filtered.length + pendingRows.length > 0 && (
          <span className="text-fg2 text-sm tabular-nums">
            {filtered.length + pendingRows.length}
          </span>
        )}
        {/* Archived toggle — reveals the Archived column (first, before Backlog).
            Archived isn't a status; it's an orthogonal flag, so it's opt-in. */}
        <div className="text-fg2 ml-auto flex items-center gap-2 text-sm select-none">
          <span>Archived</span>
          <Switch
            checked={showArchived}
            onCheckedChange={setShowArchived}
            aria-label="Show archived workspaces"
          />
        </div>
      </div>

      {/* Project filter tabs. */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto px-6 pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
            <span className="truncate">{p.name}</span>
          </FilterTab>
        ))}
      </div>

      {/* Board — five columns, horizontally scrollable with an always-visible
          bottom scrollbar. The inner row is `w-max` (sizes to its content) so its
          `px-6` becomes part of the scroll width — that's what makes BOTH the left
          and right gutters scroll into view (a plain width:100% flex lets the
          columns overflow past its padding, collapsing the right gutter). */}
      <div className="zeros-hscroll min-h-0 flex-1 overflow-x-auto overflow-y-hidden pb-3">
        <div className="flex h-full min-h-0 w-max gap-4 px-6">
          {showArchived && (
            <ArchivedColumn
              rows={filteredArchived}
              showRepoChip={showRepoChip}
              active={activePage === "dashboard"}
            />
          )}
          {LIFECYCLE_STATUSES.map((s) => {
            const items = byStatus.get(s.value) ?? [];
            // Optimistic creates live in Backlog until their real row lands.
            const pendingHere =
              s.value === "backlog" ? pendingRows : EMPTY_PENDING_ROWS;
            return (
              <div
                key={s.value}
                className="flex h-full min-h-0 w-72 shrink-0 flex-col px-3"
              >
                <div className="mb-3 flex shrink-0 items-center gap-2">
                  <StatusIcon status={s.value} className="size-4" />
                  <span className="text-fg1 text-sm font-medium">
                    {s.label}
                  </span>
                  <span className="text-fg2 text-xs tabular-nums">
                    {items.length + pendingHere.length}
                  </span>
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {pendingHere.map((pending) => (
                    <PendingDashboardCard
                      key={pending.token}
                      label={
                        pending.branch
                          ? branchDisplayName(pending.branch)
                          : "New workspace"
                      }
                      repoName={
                        projectBySlug.get(pending.repoSlug)?.name ??
                        pending.repoSlug
                      }
                      project={projectBySlug.get(pending.repoSlug) ?? null}
                      showRepoChip={showRepoChip}
                    />
                  ))}
                  {items.map((row) => (
                    <DashboardCard
                      key={row.workspace.id}
                      row={row}
                      showRepoChip={showRepoChip}
                      onOpen={() => openWorkspace(row.workspace)}
                      onArchived={() => setShowArchived(true)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
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
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-sm px-2.5 py-1 text-sm transition-colors",
        active
          ? "bg-bg2-hover text-fg1"
          : "text-fg2 hover:bg-bg1-hover hover:text-fg1",
      )}
    >
      {children}
    </button>
  );
}

function DashboardRepositoryIcon({
  project,
  name,
}: {
  project: Project | null;
  name: string;
}) {
  return (
    <span className={REPO_CHIP_CLS} aria-hidden="true">
      {project ? (
        <RepositoryIcon project={project} className="size-full rounded-sm" />
      ) : (
        projectInitial(name)
      )}
    </span>
  );
}

// The Archived pseudo-column — archived is an orthogonal flag, not a status, so
// it renders first (before Backlog) only when the header toggle is on.
function ArchivedColumn({
  rows,
  showRepoChip,
  active,
}: {
  rows: BoardRow[];
  showRepoChip: boolean;
  active: boolean;
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
}: {
  row: BoardRow;
  showRepoChip: boolean;
  active: boolean;
}) {
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
  // Not clickable-to-open — the worktree is gone until restored. Outlined, no
  // fill (just a border1) so archived reads as distinct from the filled live cards.
  return (
    <div className="border-border1 flex flex-col rounded-lg border p-3 text-left select-none">
      <div className="flex items-center gap-2">
        {showRepoChip && (
          <DashboardRepositoryIcon project={row.project} name={row.repoName} />
        )}
        <span className="text-fg2 min-w-0 flex-1 truncate text-xs">
          {row.branch}
        </span>
        {/* Its preserved lifecycle status, dimmed — restore returns it here. */}
        <StatusIcon status={w.status} className="size-3.5 opacity-60" />
      </div>
      <div className="text-fg1 mt-1.5 truncate text-sm font-medium">
        {row.title}
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <Tooltip label="Unarchive">
          <Button
            variant="secondary"
            size="sm"
            onClick={unarchive}
            disabled={restoring || deletingSnapshot}
          >
            {restoring && <ZerosSpinner size={14} />}
            <span>{restoring ? "Restoring…" : "Unarchive"}</span>
          </Button>
        </Tooltip>
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
        <DropdownMenu open={active && menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Options for ${row.title}`}
              disabled={restoring || deletingSnapshot}
            >
              <Ellipsis size={14} aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
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
        <span className="text-fg2 ml-auto text-xs tabular-nums">
          {formatCompactAge(w.archivedAt ?? w.createdAt)}
        </span>
      </div>
      <Dialog
        open={active && snapshotToDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deletingSnapshot) setSnapshotToDelete(null);
        }}
      >
        <DialogContent showCloseButton={!deletingSnapshot}>
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
}: {
  row: BoardRow;
  showRepoChip: boolean;
  onOpen: () => void;
  onArchived: () => void;
}) {
  const w = row.workspace;
  const archiveWorkspace = useArchiveWorkspace();
  const mutating = useWorkspaceArchiving(w.id);
  const [busy, setBusy] = useState<null | "merge">(null);
  // Lazy, tri-state dirtiness probe (replaces the removed heavy withChanges list
  // column). `undefined` until the first probe resolves → resolveCardActionKind
  // shows NO button rather than a possibly-wrong destructive Merge.
  const localFolder = isLocalMainWorkspace(w);
  const hasChanges = useWorkspaceHasChanges(localFolder ? null : w, !localFolder, {
    probeWithPr: true,
  });
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
  switch (resolveCardActionKind(w, hasChanges)) {
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

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <WorkspaceContextMenu
      workspace={w}
      onArchive={archive}
      archiveDisabled={mutating}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          if (!mutating) onOpen();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (!mutating) onOpen();
          }
        }}
        aria-busy={mutating || undefined}
        className="border-border1 bg-bg2 hover:border-border3 flex cursor-pointer flex-col rounded-lg border p-3 text-left transition-colors select-none"
      >
        {/* Top: repo chip (all-projects view) + branch + status glyph. */}
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
          {localFolder ? (
            <Folder className="text-fg2 size-3.5" strokeWidth={1.5} />
          ) : missing ? (
            <Tooltip label="Worktree folder deleted on disk">
              <FolderX
                className="text-red-fg size-3.5 shrink-0"
                aria-label="Worktree missing"
              />
            </Tooltip>
          ) : (
            <StatusIcon status={w.status} className="size-3.5" />
          )}
        </div>

        {/* Title. */}
        <div className="text-fg1 mt-1.5 truncate text-sm font-medium">
          {row.title}
        </div>
        {missing && (
          <div className="text-red-fg mt-1 text-xs">Worktree missing</div>
        )}

        {/* Bottom: primary action + PR link + last-active. */}
        <div className="mt-2.5 flex items-center gap-2">
          {action && ActionIcon && (
            <Tooltip label={action.label}>
              <button
                type="button"
                className={CARD_ACTION_CLS}
                onClick={(e) => {
                  stop(e);
                  action?.run();
                }}
                disabled={busy !== null || mutating}
              >
                {spinning ? (
                  <ZerosSpinner size={14} />
                ) : ActionIcon ? (
                  <ActionIcon className="size-3.5" />
                ) : null}
                <span>
                  {mutating && action.busyKey === "archive"
                    ? "Archiving…"
                    : action.label}
                </span>
              </button>
            </Tooltip>
          )}
          <div className="text-fg2 ml-auto flex items-center gap-2 text-xs tabular-nums">
            {w.prNumber != null && w.prUrl && (
              <Tooltip label="Open PR on GitHub">
                <a
                  href={w.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={stop}
                  className="hover:text-fg1 inline-flex items-center gap-0.5"
                >
                  #{w.prNumber}
                  <ExternalLink className="size-3" />
                </a>
              </Tooltip>
            )}
            <span>{formatCompactAge(w.lastActiveAt ?? w.createdAt)}</span>
          </div>
        </div>
      </div>
    </WorkspaceContextMenu>
  );
}
