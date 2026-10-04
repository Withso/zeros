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
import { RepositoryIcon } from "../features/repositories/repository-icon";
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
import { Tooltip } from "../shared/ui/primitives/tooltip";
import { useAddProject } from "./add-project-provider";
import { warmCreateSourceProject } from "./dispatcher/create-from-source";
import { requestCreateFromSource } from "./dispatcher/create-source-request";
import { RepositoryIconDialog } from "./repository-icon-dialog";

// --- CONSTANTS ---

// Only hover lifts the row; focus shows on the focused control itself, so
// creating from + or collapsing leaves no header looking selected. The name
// stays on the default fg2 tier.
const REPOSITORY_HEADER_CLS =
  "group/repo relative flex h-7.5 w-full min-w-0 shrink-0 select-none items-center gap-1 rounded-md pr-1 text-fg2 transition-none hover:bg-sidebar-bg-hover data-[active=true]:bg-sidebar-bg-hover";
const REPOSITORY_TOGGLE_CLS =
  "group/toggle flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pl-2 text-left text-xs font-medium text-inherit outline-none focus-visible:ring-2 focus-visible:ring-highlighted-bright/50";
const REPOSITORY_CHIP_CLS =
  "inline-flex size-4 shrink-0 items-center justify-center rounded-sm bg-bg2-hover text-xxs font-medium text-fg2";
// Row actions: 24px squares inside the 30px row, on the sidebar's own hover.
export const SIDEBAR_ROW_ACTION_CLS =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-fg2 outline-none transition-[background-color,color] duration-120 ease-out hover:bg-bg2-hover hover:text-fg1 focus-visible:ring-2 focus-visible:ring-highlighted-bright/50 data-[state=open]:bg-bg2-hover data-[state=open]:text-fg1 [&_svg]:size-3.5";
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
                    <span
                      className={cn(
                        REPOSITORY_CHIP_CLS,
                        "group-hover/repo:invisible group-focus-visible/toggle:invisible",
                      )}
                    >
                      <RepositoryIcon
                        project={project}
                        className="size-full rounded-sm"
                      />
                    </span>
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
            <div className="flex shrink-0 items-center gap-0.5">
              <div
                className={cn(
                  "items-center gap-0.5",
                  menuOpen
                    ? "flex"
                    : "hidden group-hover/repo:flex group-has-[:focus-visible]/repo:flex",
                )}
              >
                <Tooltip label="Repository settings" side="bottom">
                  <button
                    type="button"
                    className={SIDEBAR_ROW_ACTION_CLS}
                    aria-label={`${project.name} settings`}
                    onClick={openRepositoryPage}
                  >
                    <Settings strokeWidth={1.5} />
                  </button>
                </Tooltip>
                <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                  <Tooltip label="More actions" side="bottom">
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
                  </Tooltip>
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
                      className="text-red-primary focus:text-red-primary"
                      onSelect={() => {
                        skipMenuFocusReturnRef.current = true;
                        window.setTimeout(() => setRemoveOpen(true), 0);
                      }}
                    >
                      <Trash2 className="text-red-primary" />
                      <span>Remove repository</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <Tooltip label="Create workspace" side="bottom">
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
              </Tooltip>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
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
