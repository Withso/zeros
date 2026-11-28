// ============================================
// COMPONENT: SidebarRepositoryHeader
// PURPOSE: A repository group header in the app sidebar's Grouped list.
// USED IN: AppSidebar (app-sidebar.tsx)
// ============================================
//
//   [icon] Repository name  count ……… [⚙] [⋯] [+] [⌄]
//
//   • The same 28px header as every sidebar section and group
//     (sidebar-group-header.tsx): the logo stays, the count follows the name,
//     and the arrow sits at the right end. Clicking anywhere else on the row
//     toggles the group.
//   • ⚙ (repository page), ⋯ and + (Create for this repository) appear on
//     hover/focus, before the arrow, and stay while the menu is open. ⋯ offers
//     Create workspace, Create from…, Configuration and Remove repository.
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

// Hover fills the whole row and reveals the actions; the row keeps that fill
// while its repository page is active. Focus stays on the focused control.
const REPOSITORY_HEADER_CLS =
  "group/repo relative flex h-7 w-full min-w-0 shrink-0 select-none items-center gap-1.5 rounded-md pr-0.5 pl-2 text-3xxs leading-4 font-medium text-fg2 transition-none [--repo-fill:var(--nav-bg)] hover:bg-(--surface-hover) hover:text-fg1 hover:[--repo-fill:var(--nav-bg-hover)] data-[active=true]:bg-(--surface-hover) data-[active=true]:[--repo-fill:var(--nav-bg-hover)]";
// Sits left of the arrow: a 16px fade that stays click-through to the name;
// only its buttons take the pointer.
const REPOSITORY_HOVER_ACTIONS_CLS =
  "pointer-events-none absolute inset-y-0 right-full flex items-center gap-0.5 bg-gradient-to-l from-(--repo-fill) from-75% to-transparent pr-0.5 pl-4 opacity-0 transition-none";
// The toggle covers the row under pointer-transparent content, so the whole
// row toggles and the actions can sit inside it without nesting buttons.
const REPOSITORY_TOGGLE_CLS =
  "absolute inset-0 size-full rounded-md outline-none focus-visible:ring-1 focus-visible:ring-accent";
// Row actions: 24px squares inside the 32px row with the shared icon-button
// hover (selected-bg), ending 12px in like every trailing control.
export const SIDEBAR_ROW_ACTION_CLS =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-fg2 outline-none transition-[background-color,color] duration-fast ease-out hover:bg-selected-bg hover:text-fg1 focus-visible:ring-1 focus-visible:ring-accent data-[state=open]:bg-selected-bg data-[state=open]:text-fg1 [&_svg]:size-3.5";
// A pointer-placed context menu can leave a trailing click on the row it
// covered. Swallow a toggle that lands in that brief aftermath (the same guard
// WorkspaceContextMenu applies to workspace rows).
const PHANTOM_CLICK_WINDOW_MS = 250;

// --- TYPES ---

export interface SidebarRepositoryHeaderProps {
  project: Project;
  /** Workspaces listed under the header. */
  count: number;
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
  count,
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
              aria-label={`${project.name}, ${count}`}
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
            />
            <span className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-1.5">
              <span
                className="inline-flex size-4 shrink-0 items-center justify-center"
                aria-hidden="true"
              >
                {opening ? (
                  <ZerosSpinner size={14} label={`Opening ${project.name}`} />
                ) : (
                  <RepositoryIcon project={project} className={REPOSITORY_ICON_CHIP_CLS} />
                )}
              </span>
              <span className="min-w-0 truncate">{project.name}</span>
              <span className="text-fg3 shrink-0 font-normal tabular-nums">{count}</span>
            </span>
            {/* Settings, ⋯ and + appear before the arrow on a fade of the
                row's fill, so hovering never re-truncates the name. */}
            {/* Pointer-transparent over the full-row toggle, so a click on the
                arrow toggles; the hover actions opt their buttons back in. */}
            <div className="pointer-events-none relative flex shrink-0 items-center">
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
              <span className="text-fg3 pointer-events-none inline-flex size-6 items-center justify-center" aria-hidden="true" data-sidebar-header-arrow>
                {collapsed ? <ChevronRight className="size-3.5" strokeWidth={1.5} /> : <ChevronDown className="size-3.5" strokeWidth={1.5} />}
              </span>
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
