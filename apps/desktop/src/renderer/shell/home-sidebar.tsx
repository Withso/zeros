// ============================================
// COMPONENT: HomeSidebar
// PURPOSE: Left nav rail for the Home surface — Dashboard, Customize (agent
//          capabilities: MCP now, Skills/Plugins later), the REPOS list
//          (every opened repo, navigating to its repo page), Add repo, and
//          the profile card (identity + the Settings entry point).
// USED IN: MainShellBody (rendered for activePage === "dashboard" |
//          "customize" | "settings" | "repo")
// ============================================
//
// The rail holds destinations: Dashboard, Customize, and repositories.
// Settings is configuration, so it lives behind the profile card's gear (and
// ⌘,). Repository rows navigate to the repository page; they do not filter the
// Dashboard, which owns its own filter chips.
//
// Selection is the store's `activePage` (+ `activeRepoId` for repo rows), so
// it survives reloads and stays in sync with the top bar.

import { useMemo, useRef } from "react";
import {
  Blocks,
  FolderOpen,
  LayoutDashboard,
  Plus,
  Settings,
  Sparkles,
} from "lucide-react";

import {
  useActivePage,
  useActiveRepoId,
  useWorkspaceDispatch,
} from "../state/store";
import {
  prefetchWorkspacesFor,
  useLiveWorkspaces,
  useProjects,
} from "../state/use-projects";
import {
  countLiveVisibleBySlug,
  filterPendingCreatesForDesignAccess,
  filterWorkspacesForDesignAccess,
} from "../state/live-workspace-selectors";
import { usePendingCreatesAll } from "../state/pending-workspaces";
import type { Project } from "../state/projects-store";
import { useAuth } from "../features/auth";
import { Button } from "../shared/ui/primitives/button";
import { GithubIcon } from "../shared/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../shared/ui/primitives/dropdown-menu";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import { RepositoryIcon } from "../features/repositories/repository-icon";
import { prefetchSettingsForRepo } from "../features/settings/use-settings";
import { useAddProject } from "./add-project-provider";
import {
  HOME_SIDEBAR_DEFAULT_PX,
  setHomeSidebarWidth,
  useHomeSidebarWidth,
} from "./home-sidebar-width";
import { useHomeSidebarResizeDrag } from "./use-home-sidebar-drag";
import { useResizeHint } from "./use-resize-hint";
import { useInternalFeatureActive } from "../features/settings/internal-features";

// One shared row shape, mirroring the settings sidebar entry (settings-page.tsx
// SIDEBAR_ENTRY_CLS) so both nav rails read as the same control: fg2 at rest,
// fg1 + a lifted --sidebar-bg-hover background when selected, hover lifts only
// the background. Selection is COLOR-only — rows never shift width.
const HOME_ENTRY_CLS =
  "flex h-auto w-full min-w-0 items-center justify-start gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-sm font-normal text-fg2 transition-colors duration-150 ease-out hover:bg-sidebar-bg-hover hover:text-fg2 data-[state=active]:bg-sidebar-bg-hover data-[state=active]:text-fg1 data-[state=active]:hover:text-fg1 [&>svg]:shrink-0 [&>svg]:text-fg2 data-[state=active]:[&>svg]:text-fg1";

// Group label above the repo list — mirrors the settings sidebar's group
// header (SETTINGS_GROUP_HEADER_CLS) so the two rails share one vocabulary.
const GROUP_HEADER_CLS =
  "select-none px-2.5 pb-1.5 pt-5 text-xs font-normal text-fg3";

// Repo-icon chip inside a rail row — same recipe as the top bar's project
// chip (PROJECT_CHIP_CLS), sized to sit where the 16px lucide icons do.
const REPO_CHIP_CLS =
  "inline-flex size-4 shrink-0 items-center justify-center rounded-sm bg-bg2-hover text-[10px] font-medium text-fg2";

/** One repo row — icon chip, name, and its live (non-archived) workspace
 *  count. Click opens the repo page; selection tracks activeRepoId. */
function RepoRow({
  project,
  count,
  isActive,
  onOpen,
}: {
  /** The opened repo this row represents. */
  project: Project;
  /** Non-archived workspace count for the badge (0 renders nothing). */
  count: number;
  /** Whether the repo page for this project is the active page. */
  isActive: boolean;
  /** Navigate to this repo's page. */
  onOpen: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      role="tab"
      aria-selected={isActive}
      aria-current={isActive ? "page" : undefined}
      data-state={isActive ? "active" : "inactive"}
      className={HOME_ENTRY_CLS}
      onPointerEnter={() => {
        prefetchWorkspacesFor(project.repoSlug);
        prefetchSettingsForRepo(project.repoRoot);
      }}
      onFocus={() => {
        prefetchWorkspacesFor(project.repoSlug);
        prefetchSettingsForRepo(project.repoRoot);
      }}
      onClick={onOpen}
    >
      <span className={REPO_CHIP_CLS} aria-hidden="true">
        <RepositoryIcon project={project} className="size-full rounded-sm" />
      </span>
      <span className="min-w-0 flex-1 truncate">{project.name}</span>
      {count > 0 && (
        <span className="text-fg3 shrink-0 text-xs tabular-nums">{count}</span>
      )}
    </Button>
  );
}

/** Initials for the profile avatar — first letters of the first two words
 *  of the display name (falls back to the email's first letter). */
function profileInitials(name: string | null, email: string | null): string {
  const source = (name ?? "").trim() || (email ?? "").trim();
  if (!source) return "·";
  const words = source.split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? "";
  const second = words.length > 1 ? (words[1][0] ?? "") : "";
  return (first + second).toUpperCase() || "·";
}

export function HomeSidebar() {
  const activePage = useActivePage();
  const activeRepoId = useActiveRepoId();
  const dispatch = useWorkspaceDispatch();
  const { projects } = useProjects();
  const effectiveActivePage =
    activePage === "repo" &&
    !projects.some((project) => project.id === activeRepoId)
      ? "dashboard"
      : activePage;
  // Same single live source the top bar + Dashboard read (the per-repo cache
  // union), so a repo badge can never disagree with that repo's tab count.
  const { workspaces } = useLiveWorkspaces();
  const rawPending = usePendingCreatesAll();
  const designWorkspacesActive = useInternalFeatureActive("designWorkspaces");
  const accessibleWorkspaces = useMemo(
    () => filterWorkspacesForDesignAccess(workspaces, designWorkspacesActive),
    [designWorkspacesActive, workspaces],
  );
  const allPending = useMemo(
    () =>
      filterPendingCreatesForDesignAccess(rawPending, designWorkspacesActive),
    [designWorkspacesActive, rawPending],
  );
  const { openProject, openGithubProject, quickStart } = useAddProject();
  const { session, email } = useAuth();

  // Persisted, drag-resizable rail width (module store → survives reloads).
  const railWidth = useHomeSidebarWidth();
  const railRef = useRef<HTMLDivElement | null>(null);
  const onResizePointerDown = useHomeSidebarResizeDrag(railRef);
  const { hintHandlers, hint } = useResizeHint(
    "Drag to resize · Double-click to reset",
  );

  const displayName = session?.user.name ?? null;
  // Live-visible rows + deduped pending creates, computed by the SAME helper the
  // Dashboard uses — badge == that repo's top-bar tab count, including during
  // the optimistic-create and confirmed-archive transition window. A workspace
  // remains counted while its destructive operation is visibly in progress.
  const countBySlug = countLiveVisibleBySlug(accessibleWorkspaces, allPending);

  return (
    <div
      ref={railRef}
      className="relative flex shrink-0"
      style={{ width: `${railWidth}px` }}
    >
      <nav
        className="bg-sidebar-bg flex min-w-0 flex-1 flex-col overflow-y-auto px-3 py-3"
        role="tablist"
        aria-label="Home navigation"
      >
        <Button
          type="button"
          variant="ghost"
          role="tab"
          aria-selected={effectiveActivePage === "dashboard"}
          aria-current={
            effectiveActivePage === "dashboard" ? "page" : undefined
          }
          data-state={
            effectiveActivePage === "dashboard" ? "active" : "inactive"
          }
          className={HOME_ENTRY_CLS}
          onClick={() =>
            dispatch({ type: "SET_ACTIVE_PAGE", page: "dashboard" })
          }
        >
          <LayoutDashboard size={16} strokeWidth={1.5} />
          <span className="truncate">Dashboard</span>
        </Button>

        {/* CUSTOMIZE — agent capabilities (MCP now; Skills / Plugins later),
          scoped User or per-repo inside the page itself. A destination row
          like Dashboard, not a Dashboard filter. */}
        <Button
          type="button"
          variant="ghost"
          role="tab"
          aria-selected={effectiveActivePage === "customize"}
          aria-current={
            effectiveActivePage === "customize" ? "page" : undefined
          }
          data-state={
            effectiveActivePage === "customize" ? "active" : "inactive"
          }
          className={HOME_ENTRY_CLS}
          onClick={() =>
            dispatch({ type: "SET_ACTIVE_PAGE", page: "customize" })
          }
        >
          <Blocks size={16} strokeWidth={1.5} />
          <span className="truncate">Customize</span>
        </Button>

        {/* REPOS — every opened repo, one row each, navigating to its repo
          page. The list is the destination index; the Dashboard keeps its own
          per-repo filter chips (they filter, these navigate). */}
        <div className={GROUP_HEADER_CLS}>Repos</div>
        <div className="flex flex-col gap-1">
          {projects.map((p) => (
            <RepoRow
              key={p.id}
              project={p}
              count={countBySlug.get(p.repoSlug) ?? 0}
              isActive={effectiveActivePage === "repo" && activeRepoId === p.id}
              onOpen={() =>
                dispatch({ type: "OPEN_REPO_PAGE", projectId: p.id })
              }
            />
          ))}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className={HOME_ENTRY_CLS}
                aria-label="Add repository"
              >
                <Plus size={16} strokeWidth={1.5} />
                <span className="truncate">Add repo</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuItem onSelect={openProject}>
                <FolderOpen />
                <span>Open folder…</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={openGithubProject}>
                <GithubIcon />
                <span>Open GitHub project…</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={quickStart}>
                <Sparkles />
                <span>Quick start…</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="min-h-4 flex-1" />

        {/* Profile card — identity anchor + the Settings entry point (the gear;
          ⌘, still works). Settings left the nav rows per the H1 redesign:
          configuration lives behind your identity, not in the file tree. */}
        <div className="border-border1 -mx-1 flex items-center gap-2.5 border-t px-1 pt-3">
          <span
            className="bg-bg2-hover text-fg1 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-medium"
            aria-hidden="true"
          >
            {profileInitials(displayName, email)}
          </span>
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="text-fg1 truncate text-sm">
              {displayName ?? email ?? "Not signed in"}
            </span>
            {displayName && email && (
              <span className="text-fg3 truncate text-xs">{email}</span>
            )}
          </span>
          <Tooltip label="Settings">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Open settings"
              data-state={activePage === "settings" ? "active" : "inactive"}
              className="text-fg2 hover:text-fg1 data-[state=active]:text-fg1 shrink-0"
              onClick={() =>
                dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" })
              }
            >
              <Settings size={16} strokeWidth={1.5} />
            </Button>
          </Tooltip>
        </div>
      </nav>
      {/* Right-edge resize seam — a 1px border line with a wider invisible
          hit strip. The resize cursor + the idle "Drag to resize" hint that
          rides above the pointer are the only affordances. Drag to resize
          (persists per user); double-click to reset to the default width. */}
      <div className="bg-border1 relative w-px shrink-0">
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          className="absolute -inset-x-[3px] inset-y-0 z-20 cursor-ew-resize select-none"
          onPointerDown={onResizePointerDown}
          onMouseDown={(e) => e.preventDefault()}
          onDoubleClick={(e) => {
            e.preventDefault();
            setHomeSidebarWidth(HOME_SIDEBAR_DEFAULT_PX);
          }}
          {...hintHandlers}
        />
        {hint}
      </div>
    </div>
  );
}
