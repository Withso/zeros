// ============================================
// COMPONENT: SidebarRepositoryHeader
// PURPOSE: A repository group header in the app sidebar's Grouped list.
// USED IN: AppSidebar (app-sidebar.tsx)
// ============================================
//
//   [icon] Repository name ………………… [⚙] [⋯] [+]
//
//   • The header toggles its group. Hover (or keyboard focus) swaps the
//     repository icon for the disclosure chevron in the same 16px slot.
//   • + is always visible and opens Create for this repository.
//   • ⚙ (repository page) and ⋯ appear on hover/focus and stay while the menu
//     is open. ⋯ offers Create workspace, Create from…, Configuration and
//     Remove repository.
//   • Right-click keeps the repository actions the old navigation offered:
//     Change icon and Repository Settings.
//
// Pointer/focus intent warms the repository's workspace list and settings so
// the destinations behind the header paint from cache.

import { useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Ellipsis,
  ImageIcon,
  Link2,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";

import { RemoveRepositoryDialog } from "../features/repositories/repositories-panel";
import { DEFAULT_REPO_SETTINGS_VIEW } from "../features/repositories/repo-page";
import { REPOSITORY_ICON_CHIP_CLS, RepositoryIcon } from "../features/repositories/repository-icon";
import { prefetchSettingsForRepo } from "../features/settings/use-settings";
import type { Project } from "../state/projects-store";
import { useWorkspaceDispatch } from "../state/store";
import { prefetchWorkspacesFor } from "../state/use-projects";
import { cn } from "../shared/ui/cn";
import { ZerosSpinner } from "../shared/ui/loading";
import { getLastInputModality } from "../shared/ui/overlay-focus";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../shared/ui/primitives/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../shared/ui/primitives/dropdown-menu";
import { useAddProject } from "./add-project-provider";
import { warmCreateSourceProject } from "./dispatcher/create-from-source";
import { requestCreateFromSource } from "./dispatcher/create-source-request";
import { RepositoryIconDialog } from "./repository-icon-dialog";

// --- CONSTANTS ---

// Hover only reveals the disclosure and actions; the row fills bg2-highlight,
// like a selected workspace row, when its repository page is active. Focus
// stays on the focused control itself.
const REPOSITORY_HEADER_CLS =
  "group/repo relative flex h-8 w-full min-w-0 shrink-0 select-none items-center gap-1 rounded-md pr-1 text-fg2 transition-none [--repo-fill:var(--sidebar-bg)] data-[active=true]:bg-bg2-highlight data-[active=true]:[--repo-fill:var(--bg2-highlight)]";
// Sits left of the always-visible Create button: 2px gap, then a 16px fade
// that stays click-through to the name; only its buttons take the pointer.
const REPOSITORY_HOVER_ACTIONS_CLS =
  "pointer-events-none absolute inset-y-0 right-full flex items-center gap-0.5 bg-gradient-to-l from-(--repo-fill) from-75% to-transparent pr-0.5 pl-4 opacity-0 transition-none";
const REPOSITORY_TOGGLE_CLS =
  "group/toggle flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pl-2 text-left text-xs font-medium text-inherit outline-none focus-visible:ring-2 focus-visible:ring-highlighted-bright/50";
// Row actions: 24px squares inside the 32px row with the shared icon-button
// hover (bg2-highlight), ending 12px in like every trailing control.
export const SIDEBAR_ROW_ACTION_CLS =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-fg2 outline-none transition-[background-color,color] duration-120 ease-out hover:bg-bg2-highlight hover:text-fg1 focus-visible:ring-2 focus-visible:ring-highlighted-bright/50 data-[state=open]:bg-bg2-highlight data-[state=open]:text-fg1 [&_svg]:size-3.5";
// A pointer-placed context menu can leave a trailing click on the row it
// covered. Swallow a toggle that lands in that brief aftermath (the same guard
// WorkspaceContextMenu applies to workspace rows).
const PHANTOM_CLICK_WINDOW_MS = 250;

// --- TYPES ---

export interface SidebarRepositoryHeaderProps {
  project: Project;
  /** The group's rows are folded away (its active row stays visible). */
  collapsed: boolean;
  /** The repository page for this project is the current destination. */
  active: boolean;
  /** The engine is mid-respawn for this repository. */
  opening: boolean;
  /** Id of the element holding this repository's rows. */
  groupId: string;
  onToggle: (project: Project) => void;
}

// --- COMPONENT ---

export function SidebarRepositoryHeader({
  project,
  collapsed,
  active,
  opening,
  groupId,
  onToggle,
}: SidebarRepositoryHeaderProps) {
  const dispatch = useWorkspaceDispatch();
  const { openDispatcher } = useAddProject();
  const [menuOpen, setMenuOpen] = useState(false);
  const [iconDialogOpen, setIconDialogOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const contextMenuClosedAtRef = useRef(0);
  // Every menu action moves focus to a new destination or a dialog, so the
  // closing menu must not hand focus back to its (hover-only) trigger.
  const skipMenuFocusReturnRef = useRef(false);

  const warmRepository = () => {
    prefetchWorkspacesFor(project.repoSlug);
    prefetchSettingsForRepo(project.repoRoot);
  };
  const openCreate = () => openDispatcher(project.id);
  const openRepositoryPage = () =>
    dispatch({ type: "OPEN_REPO_PAGE", projectId: project.id });
  const openConfiguration = () =>
    dispatch({
      type: "OPEN_REPO_PAGE",
      projectId: project.id,
      view: DEFAULT_REPO_SETTINGS_VIEW,
    });

  return (
    <>
      <ContextMenu
        onOpenChange={(open) => {
          if (!open && getLastInputModality() === "pointer") {
            contextMenuClosedAtRef.current = Date.now();
          }
        }}
      >
        <ContextMenuTrigger asChild>
          <div
            className={REPOSITORY_HEADER_CLS}
            data-active={active || undefined}
            data-sidebar-repository={project.id}
            onPointerEnter={warmRepository}
            onFocus={warmRepository}
          >
            <button
              type="button"
              className={REPOSITORY_TOGGLE_CLS}
              aria-expanded={!collapsed}
              aria-controls={groupId}
              onClick={() => {
                const closedAt = contextMenuClosedAtRef.current;
                contextMenuClosedAtRef.current = 0;
                if (
                  closedAt !== 0 &&
                  Date.now() - closedAt < PHANTOM_CLICK_WINDOW_MS
                )
                  return;
                onToggle(project);
              }}
            >
              <span
                className="relative inline-flex size-4 shrink-0 items-center justify-center"
                aria-hidden="true"
              >
                {opening ? (
                  <ZerosSpinner size={14} label={`Opening ${project.name}`} />
                ) : (
                  <>
                    <RepositoryIcon
                      project={project}
                      className={cn(
                        REPOSITORY_ICON_CHIP_CLS,
                        "group-hover/repo:invisible group-focus-visible/toggle:invisible",
                      )}
                    />
                    <span className="text-fg2 absolute inset-0 hidden items-center justify-center group-hover/repo:flex group-focus-visible/toggle:flex">
                      {collapsed ? (
                        <ChevronRight className="size-3.5" strokeWidth={1.5} />
                      ) : (
                        <ChevronDown className="size-3.5" strokeWidth={1.5} />
                      )}
                    </span>
                  </>
                )}
              </span>
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
            </button>
            {/* Settings and ⋯ appear over the name's end on a fade of the
                row's fill, so hovering never re-truncates the name. */}
            <div className="relative flex shrink-0 items-center">
              <div
                className={cn(
                  REPOSITORY_HOVER_ACTIONS_CLS,
                  menuOpen
                    ? "opacity-100 [&_button]:pointer-events-auto"
                    : "group-hover/repo:opacity-100 group-hover/repo:[&_button]:pointer-events-auto group-has-focus-visible/repo:opacity-100 group-has-focus-visible/repo:[&_button]:pointer-events-auto",
                )}
              >
                <button
                  type="button"
                  className={SIDEBAR_ROW_ACTION_CLS}
                  aria-label={`${project.name} settings`}
                  onClick={openRepositoryPage}
                >
                  <Settings strokeWidth={1.5} />
                </button>
                <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={SIDEBAR_ROW_ACTION_CLS}
                      aria-label={`More actions for ${project.name}`}
                      onPointerEnter={() => warmCreateSourceProject(project)}
                      onFocus={() => warmCreateSourceProject(project)}
                    >
                      <Ellipsis strokeWidth={1.5} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    className="w-52"
                    onCloseAutoFocus={(event) => {
                      if (!skipMenuFocusReturnRef.current) return;
                      skipMenuFocusReturnRef.current = false;
                      event.preventDefault();
                    }}
                  >
                    <DropdownMenuItem
                      onSelect={() => {
                        skipMenuFocusReturnRef.current = true;
                        openCreate();
                      }}
                    >
                      <Plus />
                      <span>Create workspace</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onPointerLeave={(event) => {
                        // Radix retains the closing item during its animation.
                        // Its hover cleanup must not steal the picker's focus.
                        if (!menuOpen) event.preventDefault();
                      }}
                      onSelect={() => {
                        skipMenuFocusReturnRef.current = true;
                        requestCreateFromSource(project.id);
                        openCreate();
                      }}
                    >
                      <Link2 />
                      <span>Create from…</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => {
                        skipMenuFocusReturnRef.current = true;
                        openConfiguration();
                      }}
                    >
                      <Settings />
                      <span>Configuration</span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => {
                        skipMenuFocusReturnRef.current = true;
                        window.setTimeout(() => setRemoveOpen(true), 0);
                      }}
                    >
                      <Trash2 />
                      <span>Remove repository</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <button
                type="button"
                className={SIDEBAR_ROW_ACTION_CLS}
                aria-label={`Create workspace in ${project.name}`}
                onPointerEnter={() => warmCreateSourceProject(project)}
                onFocus={() => warmCreateSourceProject(project)}
                onClick={openCreate}
              >
                <Plus strokeWidth={1.5} />
              </button>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem
            onSelect={() => window.setTimeout(() => setIconDialogOpen(true), 0)}
          >
            <ImageIcon />
            <span>Change icon</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={openConfiguration}>
            <Settings />
            <span>Repository Settings</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <RepositoryIconDialog
        project={project}
        open={iconDialogOpen}
        onOpenChange={setIconDialogOpen}
      />
      {/* Mounted only while requested: the removal flow subscribes to every
          chat, which a closed dialog per repository has no reason to do. */}
      {removeOpen && (
        <RemoveRepositoryDialog
          project={project}
          open
          onOpenChange={setRemoveOpen}
        />
      )}
    </>
  );
}
