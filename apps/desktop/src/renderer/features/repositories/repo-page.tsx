// ──────────────────────────────────────────────────────────
// Repo page — one repo's workspaces AND its settings, in place
// ──────────────────────────────────────────────────────────
//
// PAGE: RepoPage
// ROUTE: activePage === "repo" (store.activeRepoId picks the project)
// PURPOSE: The Home surface's per-repository hub. A centered page column shows
//          the repo's logo + name on top, with one segmented toggle below it —
//          Workspaces · Environment · Git · Actions · Paths — and the active
//          view's content underneath. Scripts and run actions live INSIDE the
//          Environment view (below Secrets). No inner section
//          nav, no per-page sidebar; Paths carries the repo's identity/paths/
//          remove-repository content. The only header chrome is the
//          "Open settings.local.toml" button at the top right, which reveals
//          the personal file in Finder (created on first use). Hand edits stay
//          in the user's editor rather than an in-app raw-TOML editor.
//
//          Workspaces is a day-grouped list (Today / Yesterday / …), replacing
//          the per-repo kanban.
//
//          MCP is deliberately ABSENT from this page — per-repo (and user)
//          MCP servers are managed on the Customize page (Home rail →
//          Customize), which writes this repo's personal
//          `.zeros/settings.local.toml`.
//
//          Settings editing is personal-scope only — every write lands
//          in .zeros/settings.local.toml (gitignored, this Mac). Values from
//          the committed repo file / team / managed layers render read-only
//          with their provenance tags. There is no UI that writes the shared
//          (committed) file; teams that want shared settings hand-commit it.
//
// Reached from the Home rail's REPOS rows, the top bar's repo context menu
// ("Repository Settings"), and the legacy `repo:<id>:<section>` settings
// deep links (settings-page redirects them here).

import React, { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { ExternalLink } from "lucide-react";

import { Tooltip } from "@/renderer/shared/ui/primitives";
import { branchDisplayName } from "../../shared/lib/branch-name";
import { Tabs, TabsList, TabsTrigger } from "../../shared/ui/primitives/tabs";
import { StatusIcon } from "../../shared/ui/primitives/status-icon";
import { WorkspaceContextMenu } from "../../shared/ui/workspace-context-menu";
import { RepositoryIcon } from "./repository-icon";
import {
  selectRepoPageView,
  useActivePage,
  useChats,
  useWorkspaceDispatch,
  useWorkspaceStore,
  type RepoPageView as StoreRepoPageView,
} from "../../state/store";
import type { Project } from "../../state/projects-store";
import { useProjects, useWorkspacesFor } from "../../state/use-projects";
import {
  dedupePendingCreates,
  filterPendingCreatesForDesignAccess,
  filterWorkspacesForDesignAccess,
  selectLiveVisible,
} from "../../state/live-workspace-selectors";
import { useInternalFeatureActive } from "../settings/internal-features";
import {
  usePendingCreatesFor,
  useWorkspaceArchiving,
} from "../../state/pending-workspaces";
import { ZerosSpinner } from "../../shared/ui/loading";
import { useOpenWorkspace } from "../../state/use-open-workspace";
import { useArchiveWorkspace } from "../../state/archive-actions";
import { formatCompactAge } from "../agent/format-age";
import type { Workspace } from "../../platform/git";
import { useInstantViewSwitch } from "../../shared/ui/use-instant-view-switch";
import { useScrollMemoryRef } from "../../shell/scroll-memory";
import { OpenSettingsFileButton } from "../../shared/ui/open-settings-file-button";
import { getActiveBridge } from "../../platform/bridge/active-bridge";
import { prefetchFilesToCopyForRepo } from "./files-to-copy-section";
import {
  RepoDetail,
  REPO_SECTIONS,
  type RepoSectionId,
} from "./repositories-panel";

// ── View model ───────────────────────────────────────────
//
// The page has ONE selector: "workspaces" plus each visible settings section.
// MCP is not a view — it lives on the Customize page (repo scope). Paths IS
// one: it holds the repo identity (Name / Slug / Origin / Root path), the
// workspaces-path editor, and Remove repository.

const CONFIG_VIEW_IDS = [
  "environment",
  "git",
  "actions",
  "files",
  "paths",
] as const satisfies readonly RepoSectionId[];

type RepoConfigViewId = (typeof CONFIG_VIEW_IDS)[number];

export type RepoPageView = StoreRepoPageView;

function isConfigViewId(value: string): value is RepoConfigViewId {
  return (CONFIG_VIEW_IDS as readonly string[]).includes(value);
}

/** The toggle entries for the settings views, in REPO_SECTIONS order. */
const CONFIG_VIEWS = REPO_SECTIONS.filter((s) => isConfigViewId(s.id));
/** Retain common repo/view pairs without keeping every repository form alive. */
const MAX_RETAINED_REPO_VIEWS = 8;

/** Where "open this repo's settings" lands when no section is requested. */
export const DEFAULT_REPO_SETTINGS_VIEW: RepoPageView = "environment";

/** Map a (possibly legacy) settings-section id to a page view. Scripts and
 *  run-actions now live under Environment; MCP has no repo page UI (it lives
 *  on the Customize page) and also lands on the default Environment view. */
export function repoPageViewForSection(
  section: string | null | undefined,
): RepoPageView {
  if (section === "scripts" || section === "run-actions") return "environment";
  if (section && isConfigViewId(section)) return section;
  return DEFAULT_REPO_SETTINGS_VIEW;
}

// ── Workspaces view — day-grouped list ───────────────────

interface ListRow {
  workspace: Workspace;
  /** Owning-chat title if present, else the (prefix-stripped) branch. */
  title: string;
  branch: string;
  /** Recency the list sorts and groups by. */
  ts: number;
}

/** Day bucket for the list groups: Today / Yesterday / "N days ago" (the
 *  founder's reference list), then coarser recency like the Commits tab
 *  (review-model recencyLabel). Clock skew clamps to Today. */
function dayGroupLabel(ms: number, now: number): string {
  const startOfDay = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const dayDiff = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (dayDiff <= 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff < 7) return `${dayDiff} days ago`;
  if (dayDiff < 30) return "Last 30 days";
  const d = new Date(ms);
  const month = d.toLocaleDateString("en-US", { month: "long" });
  return d.getFullYear() === new Date(now).getFullYear()
    ? month
    : `${month} ${d.getFullYear()}`;
}

/** One workspace row — status, title, branch, PR link, age. Click opens the
 *  workspace; right-click carries the shared Set-status/Archive menu.
 *  Deliberately lighter than the Dashboard card (no primary-action state
 *  machine) — the Dashboard stays the cross-repo work surface. */
function RepoWorkspaceRow({
  row,
  onOpen,
}: {
  row: ListRow;
  onOpen: () => void;
}) {
  const w = row.workspace;
  const archiveWorkspace = useArchiveWorkspace();
  const archiving = useWorkspaceArchiving(w.id);
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <WorkspaceContextMenu
      workspace={w}
      onArchive={() => void archiveWorkspace(w, { label: row.title })}
      archiveDisabled={archiving}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          if (!archiving) onOpen();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (!archiving) onOpen();
          }
        }}
        aria-busy={archiving || undefined}
        className="hover:bg-bg2 flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 transition-colors select-none"
      >
        <StatusIcon status={w.status} className="size-3.5 shrink-0" />
        <span className="text-fg1 min-w-0 truncate text-sm font-medium">
          {row.title}
        </span>
        {row.branch !== row.title && (
          <span className="text-fg3 hidden min-w-0 truncate font-mono text-xs sm:block">
            {row.branch}
          </span>
        )}
        <span className="text-fg2 ml-auto flex shrink-0 items-center gap-3 text-xs tabular-nums">
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
        </span>
      </div>
    </WorkspaceContextMenu>
  );
}

function RepoWorkspacesList({ project }: { project: Project }) {
  const { workspaces: allWorkspaces, loading } = useWorkspacesFor(
    project.repoSlug,
  );
  const designWorkspacesActive = useInternalFeatureActive("designWorkspaces");
  const accessibleWorkspaces = useMemo(
    () =>
      filterWorkspacesForDesignAccess(allWorkspaces, designWorkspacesActive),
    [allWorkspaces, designWorkspacesActive],
  );
  // Shared selector: a row leaves only after the engine confirms archive/delete;
  // while in flight it remains here, inert and visibly busy.
  const workspaces = useMemo(
    () => selectLiveVisible(accessibleWorkspaces),
    [accessibleWorkspaces],
  );
  const rawPendingCreates = usePendingCreatesFor(project.repoSlug);
  const pendingCreates = useMemo(
    () =>
      filterPendingCreatesForDesignAccess(
        rawPendingCreates,
        designWorkspacesActive,
      ),
    [designWorkspacesActive, rawPendingCreates],
  );
  const pending = useMemo(
    () => dedupePendingCreates(pendingCreates, accessibleWorkspaces),
    [accessibleWorkspaces, pendingCreates],
  );
  const chats = useChats();
  const openWorkspace = useOpenWorkspace();

  // Title join — same derivation as the Dashboard's row builder: the
  // most-recently-updated chat in the worktree folder names the row.
  const groups = useMemo(() => {
    const titleByFolder = new Map<
      string,
      { title: string; updatedAt: number }
    >();
    for (const c of chats) {
      const title = (c.title ?? "").trim();
      if (!c.folder || !title || title === "Untitled") continue;
      const prev = titleByFolder.get(c.folder);
      const updatedAt = c.updatedAt ?? 0;
      if (!prev || updatedAt > prev.updatedAt)
        titleByFolder.set(c.folder, { title, updatedAt });
    }
    const rows = workspaces
      .map((w): ListRow => {
        const branch = branchDisplayName(w.branch);
        return {
          workspace: w,
          title: titleByFolder.get(w.path)?.title || branch,
          branch,
          ts: w.lastActiveAt ?? w.createdAt,
        };
      })
      .sort((a, b) => b.ts - a.ts);

    // Rows arrive sorted newest-first, so buckets emerge already ordered.
    const now = Date.now();
    const out: { label: string; rows: ListRow[] }[] = [];
    for (const row of rows) {
      const label = dayGroupLabel(row.ts, now);
      const last = out[out.length - 1];
      if (last && last.label === label) last.rows.push(row);
      else out.push({ label, rows: [row] });
    }
    return out;
  }, [workspaces, chats]);

  if (loading && groups.length === 0 && pending.length === 0) {
    return <div className="min-h-24" aria-busy="true" />;
  }

  if (groups.length === 0 && pending.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1 py-16 text-center">
        <span className="text-fg1 text-sm font-medium">No workspaces yet</span>
        <span className="text-fg2 text-sm">
          Create one with + in the top bar to start an agent on {project.name}.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {pending.length > 0 && (
        <section className="flex flex-col pt-6 first:pt-0">
          <div className="flex items-baseline gap-2 px-3 pb-2">
            <span className="text-fg1 text-sm font-medium">Setting up</span>
            <span className="text-fg2 text-xs tabular-nums">
              {pending.length}
            </span>
          </div>
          {pending.map((p) => (
            <div
              key={p.token}
              className="flex items-center gap-3 rounded-md px-3 py-2 opacity-80 select-none"
              role="status"
              aria-live="polite"
            >
              <ZerosSpinner size={14} />
              <span className="text-fg1 min-w-0 truncate text-sm font-medium">
                {p.branch ? branchDisplayName(p.branch) : "New workspace"}
              </span>
              <span className="text-fg2 ml-auto shrink-0 text-xs">
                Setting up workspace…
              </span>
            </div>
          ))}
        </section>
      )}
      {groups.map((group) => (
        <section key={group.label} className="flex flex-col pt-6 first:pt-0">
          <div className="flex items-baseline gap-2 px-3 pb-2">
            <span className="text-fg1 text-sm font-medium">{group.label}</span>
            <span className="text-fg2 text-xs tabular-nums">
              {group.rows.length}
            </span>
          </div>
          {group.rows.map((row) => (
            <RepoWorkspaceRow
              key={row.workspace.id}
              row={row}
              onOpen={() => openWorkspace(row.workspace)}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

// ── The page ─────────────────────────────────────────────

/** First-write contents of a repo's `.zeros/settings.toml` — comments only
 *  (parses as an empty document), stating the scripts-only contract so a
 *  hand-editor knows what the file is for. */
const REPO_LOCAL_SETTINGS_SEED = `# Zeros repo settings — personal to this Mac (gitignored).
# Values you set on this repo's Settings tabs are saved here.
`;

/** The header button: reveal this repo's personal `.zeros/settings.local.toml`
 *  in Finder — the file the repository's Settings tabs actually write to:
 *  personal-lens only). Seeds it on first use so Finder has something to
 *  select. Same shape as the user Settings page's "Open settings.toml"; hand-
 *  edits happen in your own editor, not an in-app code box. */
function OpenRepoSettingsButton({ repoRoot }: { repoRoot: string }) {
  return (
    <OpenSettingsFileButton
      layer="repo-local"
      repoRoot={repoRoot}
      label="Open settings.local.toml"
      tooltip=".zeros/settings.local.toml (personal, gitignored) — reveal in Finder"
      seed={REPO_LOCAL_SETTINGS_SEED}
    />
  );
}

export function RepoPage({ project }: { project: Project }) {
  const pageSurfaceRef = useRef<HTMLDivElement | null>(null);
  const pageActive = useActivePage() === "repo";
  const dispatch = useWorkspaceDispatch();
  const { projects } = useProjects();
  // The active hub tab is owned by this exact repository and restored from the
  // synchronous Zustand snapshot on its first render.
  const view = useWorkspaceStore((state) =>
    selectRepoPageView(state, project.id),
  );

  // Recently visited repo/view trees survive repository and section switches.
  // This retains local form state and Keychain-backed rows; the shared settings
  // and workspace caches keep their background reads deduplicated.
  const retainedTargetsRef = useRef<
    Array<{ key: string; project: Project; view: RepoPageView }>
  >([]);
  const activeTargetKey = `${project.id}:${view}`;
  useInstantViewSwitch(`repo:${activeTargetKey}`, pageSurfaceRef);
  const targetsToRender = useMemo(() => {
    const retainedTargets = retainedTargetsRef.current;
    const availableProjectById = new Map(
      projects.map((available) => [available.id, available] as const),
    );
    let next = retainedTargets
      .filter((target) => availableProjectById.has(target.project.id))
      .map((target) => ({
        ...target,
        project: availableProjectById.get(target.project.id) ?? target.project,
      }));
    const activeProject = availableProjectById.get(project.id) ?? null;
    const current = next[next.length - 1];
    if (
      activeProject &&
      (current?.key !== activeTargetKey ||
        current.project !== activeProject ||
        current.view !== view)
    ) {
      next = [
        ...next.filter((target) => target.key !== activeTargetKey),
        { key: activeTargetKey, project: activeProject, view },
      ].slice(-MAX_RETAINED_REPO_VIEWS);
    }
    if (
      next.length === retainedTargets.length &&
      next.every(
        (target, index) =>
          target.key === retainedTargets[index]?.key &&
          target.project === retainedTargets[index]?.project &&
          target.view === retainedTargets[index]?.view,
      )
    ) {
      return retainedTargets;
    }
    return next;
  }, [activeTargetKey, project.id, projects, view]);
  useLayoutEffect(() => {
    retainedTargetsRef.current = targetsToRender;
  }, [targetsToRender]);

  // One scroller hosts every repo/view target (inactive deck entries hide
  // with display:none, which clamps the shared scrollTop). Keyed memory per
  // repo+view: returning to a target restores its exact offset; a fresh
  // target starts at the top instead of inheriting the previous one's.
  const pageScrollRef = useScrollMemoryRef(`repo:${activeTargetKey}`);

  const setView = (next: RepoPageView) => {
    dispatch({
      type: "SET_REPO_PAGE_VIEW",
      projectId: project.id,
      view: next,
    });
  };

  const warmFilesToCopy = useCallback(() => {
    prefetchFilesToCopyForRepo(getActiveBridge(), project.repoRoot);
  }, [project.repoRoot]);

  return (
    <div
      ref={pageSurfaceRef}
      className="bg-bg1 flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
    >
      {/* Header strip — only the Finder-open button, top right. */}
      <div
        className="flex shrink-0 items-center justify-end px-6 pt-4"
        data-tauri-drag-region
      >
        <OpenRepoSettingsButton repoRoot={project.repoRoot} />
      </div>

      {/* Left-aligned page column: logo + name, the one view toggle, then the
          active view. The left gutter is responsive, growing with the window
          width but capped at 100px so the content hugs the left on wide screens. */}
      <div ref={pageScrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex w-full max-w-5xl flex-col pt-10 pr-6 pb-16 pl-[clamp(1.5rem,5vw,6.25rem)]">
          <div className="flex flex-col items-start gap-5">
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                className="bg-bg2-hover text-fg2 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-xs font-medium"
                aria-hidden="true"
              >
                <RepositoryIcon
                  project={project}
                  className="size-full rounded-md"
                />
              </span>
              <h1 className="text-fg1 min-w-0 truncate text-lg font-medium">
                {project.name}
              </h1>
            </div>

            <Tabs
              value={view}
              onValueChange={(v) => setView(v as RepoPageView)}
            >
              <TabsList className="h-8">
                <TabsTrigger value="workspaces" className="text-xs">
                  Workspaces
                </TabsTrigger>
                {CONFIG_VIEWS.map((s) => (
                  <TabsTrigger
                    key={s.id}
                    value={s.id}
                    className="text-xs"
                    // Warm on intent: the Files tab's scan is the only repo-page
                    // read the boot/hover settings prefetch doesn't already
                    // cover, so opening it would otherwise land on a spinner.
                    // The click handler itself never awaits.
                    onPointerEnter={
                      s.id === "files" ? warmFilesToCopy : undefined
                    }
                    onFocus={s.id === "files" ? warmFilesToCopy : undefined}
                  >
                    {s.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          <div className="w-full pt-8">
            {targetsToRender.map((target) => {
              const isActive = target.key === activeTargetKey;
              return (
                <div
                  key={target.key}
                  {...(!isActive ? { inert: "" } : {})}
                  className={isActive ? "block" : "hidden"}
                  aria-hidden={!isActive}
                >
                  {target.view === "workspaces" ? (
                    <RepoWorkspacesList project={target.project} />
                  ) : (
                    <RepoDetail
                      project={target.project}
                      section={target.view}
                      layer="repo-local"
                      root={target.project.repoRoot}
                      surfaceActive={pageActive && isActive}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
