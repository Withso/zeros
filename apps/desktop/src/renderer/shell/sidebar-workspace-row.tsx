// ============================================
// COMPONENT: SidebarWorkspaceRow / PendingSidebarWorkspaceRow
// PURPOSE: One workspace in the app sidebar — a full-width row that keeps
//          every behaviour the former top-bar tab had: the workspace's own
//          square (quiet at rest, animating while its agent works, coloured
//          by its PR), change counts, the live Run stream, the unsent-draft
//          pencil, hover Archive, the right-click status menu and
//          pointer/focus warming.
// USED IN: AppSidebar (app-sidebar.tsx) and the draft-indicator harness
// ============================================
//
// Row anatomy (left → right):
//
//   [?] [workspace square] name……………… [± counts] [run stream] [agent state*] [✎]
//
// [?] A plan to review or a question/permission to answer, or else the
//     unread dot of an agent that finished while its chat was off screen. It
//     never replaces the square or the loader: grouped rows show it in their
//     inset gutter, and flat rows (with no gutter) in the pencil's slot, which
//     it outranks, like a chat tab. While the turn waits on the answer the
//     square rests; beside an optional ask the agent keeps working, and so
//     does the square.
// *   Ungrouped rows spend the leading slot on the repository icon, so their
//     agent loader (or the design marker) moves to the trailing cluster.
//
// The open target is a full-size transparent Button under pointer-transparent
// content, so Archive can sit beside the name without nesting buttons. Hover
// replaces the trailing cluster's end with Archive (or a plain folder's
// settings); a drafted row puts that action in the pencil's own 12px slot
// instead, so hovering never moves anything.
//
// The row's font weight is declared ONCE on the container both variants share
// (SIDEBAR_WORKSPACE_ROW_CLS): the optimistic row has no Button, and a weight
// on the real row's Button would make the label change weight at the swap.

import React, { useState } from "react";
import {
  Archive,
  Folder,
  ImageIcon,
  PenTool,
  Settings,
} from "lucide-react";

import { type Workspace } from "../platform/git";
import { isCloudWorkspace } from "../platform/bridge/cloud-workspace-key";
import { AgentActivityIndicator } from "../features/agent/agent-activity-indicator";
import { AgentAwaitingIcon } from "../features/agent/agent-awaiting-indicator";
import { useAnyChatUnread } from "../features/agent/chat-unread";
import { ChatUnreadDot } from "../features/agent/chat-unread-dot";
import { ComposerDraftIndicator } from "../features/agent/composer-draft-indicator";
import {
  useAnyChatWorkingActivity,
  useAnyChatAwaitingKind,
} from "../features/agent/sessions-store";
import { DEFAULT_REPO_SETTINGS_VIEW } from "../features/repositories/repo-page";
import { RepositoryIcon } from "../features/repositories/repository-icon";
import { CloudComputerAdminBadge } from "../features/settings/cloud-computer-admin-badge";
import { useAnyChatHasDraft } from "../state/composer-draft-presence";
import { isLocalMainWorkspace } from "../state/local-main-workspace";
import {
  usePendingWorkspaceMode,
  useWorkspaceArchiving,
} from "../state/pending-workspaces";
import type { Project } from "../state/projects-store";
import { useWorkspaceDispatch } from "../state/store";
import { startCloudNavigationSpan } from "../state/cloud-workspace-latency";
import { cn } from "../shared/ui/cn";
import { RunStream, ZerosSpinner } from "../shared/ui/loading";
import { Button } from "../shared/ui/primitives/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../shared/ui/primitives/context-menu";
import { Tooltip } from "../shared/ui/primitives/tooltip";
import { WorkspaceContextMenu } from "../shared/ui/workspace-context-menu";
import { usePrIslandKind } from "./pr/pr-island-state-store";
import { RepositoryIconDialog } from "./repository-icon-dialog";
import { useAnyRunActionRunning } from "./terminal/run-activity-store";
import { useWorkspaceChangeLines } from "./use-workspace-change-lines";
import { WorkspaceChangeCounts } from "./workspace-change-counts";
import {
  WorkspaceGlyph,
  workspaceGlyphSeed,
  workspacePrTone,
} from "./workspace-glyph";
import { workspaceLabel, workspaceTabDescription } from "./workspace-tabs";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";

// --- CONSTANTS ---

// Full-width 30px row on the sidebar's hover/selection fill. Selection is
// colour-only (fg1 on sidebar-bg-hover); rows never shift. `transition-none`
// keeps a switch from cross-fading the old and new selection.
const SIDEBAR_WORKSPACE_ROW_CLS =
  "group/workspace relative flex h-7.5 w-full min-w-0 shrink-0 select-none items-center overflow-hidden rounded-md pr-2 text-left text-xs font-normal text-fg2 transition-none hover:bg-(--surface-hover) focus-within:bg-(--surface-hover) data-[active=true]:bg-(--surface-hover) data-[active=true]:text-fg1";
// Grouped rows sit under their repository header: the state glyph centres on
// the header's name column. Ungrouped rows (repository icon first) and
// standalone folder rows align with the headers' own icon column instead.
const SIDEBAR_WORKSPACE_GROUPED_INSET_CLS = "pl-6";
// The grouped inset doubles as the gutter for the awaiting mark, left of the
// square it must not replace.
const SIDEBAR_WORKSPACE_GUTTER_CLS =
  "pointer-events-none absolute inset-y-0 left-0 flex w-6 items-center justify-center text-fg2";
const SIDEBAR_WORKSPACE_FLAT_INSET_CLS = "pl-2";
const SIDEBAR_WORKSPACE_OPEN_BUTTON_CLS =
  "absolute inset-0 size-full rounded-md border-0 bg-transparent p-0 text-inherit shadow-none transition-none hover:bg-transparent hover:text-inherit";
const SIDEBAR_WORKSPACE_CONTENT_CLS =
  "pointer-events-none relative flex h-full min-w-0 flex-1 items-center gap-2 whitespace-nowrap text-inherit [&_svg]:shrink-0 [&_svg:not([data-draft-icon])]:size-3.5";
const SIDEBAR_WORKSPACE_TRAILING_CLS = "flex shrink-0 items-center gap-1.5";
// Hover and focus reveal Archive at the row's end over a fade of the same
// hover fill, so the trailing counts/stream slide under it instead of reflowing.
const SIDEBAR_WORKSPACE_ACTION_OVERLAY_CLS =
  "pointer-events-none absolute inset-y-0 right-0 z-10 flex w-12 items-center justify-end rounded-r-md bg-gradient-to-l from-sidebar-bg-hover from-50% to-transparent pr-1.5 opacity-0 transition-none group-hover/workspace:opacity-100 focus-within:opacity-100";
// A drafted (or, in a flat row, awaiting) row's Archive covers that mark in
// its own slot.
const SIDEBAR_WORKSPACE_DRAFT_ACTION_OVERLAY_CLS =
  "pointer-events-none absolute -inset-1 flex items-center justify-center rounded-sm bg-sidebar-bg-hover opacity-0 transition-none group-hover/workspace:opacity-100 focus-within:opacity-100";
// State glyphs stay on fg2 even in the selected row (only the name lifts to
// fg1); the workspace square sets its own rest, working and PR colours.
const GLYPH_BOX_CLS =
  "inline-flex size-4 shrink-0 items-center justify-center text-fg2";

// --- CHILD COMPONENTS ---

/** In Ungrouped rows the repository identity rides the leading slot. Its own
 * right-click target still exposes repository actions without replacing the
 * surrounding workspace context menu. */
export function WorkspaceProjectIcon({ project }: { project: Project }) {
  const [iconDialogOpen, setIconDialogOpen] = useState(false);
  const dispatch = useWorkspaceDispatch();
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger
          asChild
          onContextMenu={(event) => event.stopPropagation()}
        >
          <span className="pointer-events-auto inline-flex size-4 shrink-0 items-center justify-center">
            <RepositoryIcon project={project} className="size-4 rounded-sm" />
          </span>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem
            onSelect={() => window.setTimeout(() => setIconDialogOpen(true), 0)}
          >
            <ImageIcon />
            <span>Change icon</span>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() =>
              dispatch({
                type: "OPEN_REPO_PAGE",
                projectId: project.id,
                view: DEFAULT_REPO_SETTINGS_VIEW,
              })
            }
          >
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
    </>
  );
}

// --- TYPES ---

export interface SidebarWorkspaceRowProps {
  /** The real, engine-managed worktree (or projected folder) this row opens. */
  workspace: Workspace;
  /** Whether the workspace currently owns the app content. */
  active: boolean;
  /** Whether the retained sidebar is visible and may issue Git reads. */
  surfaceActive?: boolean;
  /** Live coding-chat ids in this worktree, used for agent activity state. */
  chatIds: readonly string[];
  /** Includes closed chats whose unsent drafts are still recoverable. */
  draftChatIds?: readonly string[];
  /** Owner repository; its icon leads Ungrouped rows. */
  project: Project | null;
  /** Ungrouped list: repository icon leads, agent state trails. */
  mixedRepositories: boolean;
  /** Indents the row under its repository header (Grouped, Git repositories). */
  grouped: boolean;
  /** Opens the workspace; only code destinations restore or create chat. */
  onSelect: (workspace: Workspace) => void;
  /** Warms the exact chat/tree/file destination on pointer or keyboard intent. */
  onPrefetch: (workspace: Workspace) => void;
  /** Archives the worktree without selecting it first. */
  onArchive: (workspace: Workspace) => void;
  /** Registers the row so a programmatic selection can be revealed. */
  rowRef?: (node: HTMLDivElement | null) => void;
  /** A legacy plain folder has no repository header, so its own row carries
   *  the folder's settings action in the slot Archive uses elsewhere. */
  onOpenSettings?: () => void;
}

// --- ROOT COMPONENTS ---

export function SidebarWorkspaceRow({
  workspace,
  active,
  surfaceActive = true,
  chatIds,
  draftChatIds = chatIds,
  project,
  mixedRepositories,
  grouped,
  onSelect,
  onPrefetch,
  onArchive,
  rowRef,
  onOpenSettings,
}: SidebarWorkspaceRowProps) {
  const requestedMode = usePendingWorkspaceMode(workspace.id);
  const modeSwitching = requestedMode !== null;
  const designWorkspace = workspace.kind === "design";
  // A chat whose turn waits on the user rests (see parkedOnUser); the square
  // keeps moving only while some chat's agent actually works.
  const activity = useAnyChatWorkingActivity(chatIds);
  const working = activity !== null;
  const awaitingKind = useAnyChatAwaitingKind(chatIds);
  const islandKind = usePrIslandKind(workspace.id, workspace.prNumber);
  const runActionRunning = useAnyRunActionRunning(workspace.path);
  const localFolder = isLocalMainWorkspace(workspace);
  const changeLines = useWorkspaceChangeLines(
    localFolder ? null : workspace,
    surfaceActive,
  );
  const label = workspaceLabel(workspace);
  const hasDraft = useAnyChatHasDraft(draftChatIds);
  const showDraft = hasDraft && !active;
  const archiving = useWorkspaceArchiving(workspace.id);
  const trailingAgentState = mixedRepositories && !archiving && working;
  // Legacy workspace kinds remain a visual hint; every workspace has agents.
  const trailingDesignMark =
    mixedRepositories && !!project && !archiving && !working && designWorkspace;
  // An agent finished while its chat wasn't on screen (chat-unread.ts).
  const unread = useAnyChatUnread(chatIds);
  // The row's status mark: a plan or question waiting on the user outranks an
  // unread finish. Grouped rows show it in a gutter left of the square; flat
  // rows put it in the pencil's slot, which it outranks.
  const statusMark = archiving ? null : (awaitingKind ?? (unread ? "unread" : null));
  const trailingMark = !grouped && statusMark ? statusMark : showDraft ? "draft" : null;
  // One hover/focus action per row: Archive for a managed worktree, folder
  // settings for a legacy plain folder, nothing for a primary checkout.
  const action =
    archiving || modeSwitching
      ? null
      : !localFolder
        ? {
            tooltip: "Archive workspace",
            label: `Archive workspace ${label}`,
            icon: <Archive className="size-3.5" strokeWidth={1.25} />,
            run: () => onArchive(workspace),
          }
        : onOpenSettings
          ? {
              tooltip: "Folder settings",
              label: `${project?.name ?? label} settings`,
              icon: <Settings className="size-3.5" strokeWidth={1.25} />,
              run: onOpenSettings,
            }
          : null;
  const rowAction = action && (
    <span
      className={
        trailingMark
          ? SIDEBAR_WORKSPACE_DRAFT_ACTION_OVERLAY_CLS
          : SIDEBAR_WORKSPACE_ACTION_OVERLAY_CLS
      }
    >
      <Tooltip label={action.tooltip} side="right">
        <IconButton
          type="button"
          className="pointer-events-auto shrink-0"
          label={action.label}
          onClick={(event) => {
            event.stopPropagation();
            action.run();
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {action.icon}
        </IconButton>
      </Tooltip>
    </span>
  );

  const row = (
    <div
      ref={rowRef}
      className={cn(
        SIDEBAR_WORKSPACE_ROW_CLS,
        grouped
          ? SIDEBAR_WORKSPACE_GROUPED_INSET_CLS
          : SIDEBAR_WORKSPACE_FLAT_INSET_CLS,
      )}
      data-active={active}
      data-workspace-tab="true"
      data-workspace-id={workspace.id}
      data-streaming={working || undefined}
      aria-busy={archiving || modeSwitching || undefined}
      onPointerEnter={() => {
        if (!surfaceActive) return;
        startCloudNavigationSpan(workspace.path, "intent");
        onPrefetch(workspace);
      }}
      onFocus={() => {
        if (!surfaceActive) return;
        startCloudNavigationSpan(workspace.path, "intent");
        onPrefetch(workspace);
      }}
      onClick={() => {
        if (!surfaceActive || archiving) return;
        startCloudNavigationSpan(workspace.path, "click");
        onSelect(workspace);
      }}
    >
      <Button
        type="button"
        variant="ghost"
        size="default"
        className={SIDEBAR_WORKSPACE_OPEN_BUTTON_CLS}
        aria-current={active ? "page" : undefined}
        aria-label={workspaceTabDescription({
          label,
          runActionRunning,
          changeLines,
          hasDraft,
          unread,
        })}
        disabled={archiving}
      />
      {grouped && statusMark && (
        <span className={SIDEBAR_WORKSPACE_GUTTER_CLS} aria-hidden="true">
          {statusMark === "unread" ? (
            <ChatUnreadDot />
          ) : (
            <AgentAwaitingIcon
              kind={statusMark}
              className="size-3.5"
              strokeWidth={1.25}
            />
          )}
        </span>
      )}
      <span
        className={cn(SIDEBAR_WORKSPACE_CONTENT_CLS, archiving && "opacity-50")}
      >
        {mixedRepositories && project && !archiving ? (
          <WorkspaceProjectIcon project={project} />
        ) : (
          <span className={GLYPH_BOX_CLS} aria-hidden="true">
            {archiving ? (
              <ZerosSpinner size={16} label="Archiving workspace" />
            ) : localFolder || designWorkspace ? (
              // No square of their own: a working plain folder or design
              // workspace shows the agent loader in its icon's place.
              working ? (
                <AgentActivityIndicator activity={activity} />
              ) : designWorkspace ? (
                <PenTool className="size-3.5" strokeWidth={1.25} />
              ) : (
                <Folder className="size-3.5" strokeWidth={1.25} />
              )
            ) : (
              // The same element idle and working, so a stopped square
              // resumes from where it came to rest.
              <WorkspaceGlyph
                seed={workspaceGlyphSeed(workspace.repoSlug, workspace.branch)}
                working={working}
                pr={workspacePrTone(workspace, islandKind)}
              />
            )}
          </span>
        )}
        {/* Only the name truncates; everything after it is shrink-0. */}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {isCloudWorkspace(workspace.path) && (
          <CloudComputerAdminBadge folder={workspace.path} />
        )}
        {/* Counts, then the stream, then state, then the pencil (or a flat
            row's awaiting mark) — each independently optional so a running
            workspace still reports what it changed. Archiving hides the
            counts (that row is already a spinner) but a run genuinely still
            running keeps saying so. */}
        <span className={SIDEBAR_WORKSPACE_TRAILING_CLS}>
          {!archiving && (
            <WorkspaceChangeCounts {...changeLines} active={active} />
          )}
          {runActionRunning && (
            <RunStream size={12} className="text-blue-primary" />
          )}
          {trailingAgentState || trailingDesignMark ? (
            <span className={GLYPH_BOX_CLS} aria-hidden="true">
              {trailingDesignMark ? (
                <PenTool className="size-3.5" strokeWidth={1.25} />
              ) : (
                <AgentActivityIndicator activity={activity} />
              )}
            </span>
          ) : null}
          {trailingMark && (
            <span
              className={cn(
                "relative inline-flex shrink-0 items-center justify-center",
                trailingMark === "draft" ? "size-3" : "text-fg2 size-3.5",
              )}
            >
              {trailingMark === "draft" ? (
                <ComposerDraftIndicator />
              ) : trailingMark === "unread" ? (
                <ChatUnreadDot />
              ) : (
                <AgentAwaitingIcon
                  kind={trailingMark}
                  className="size-3.5"
                  strokeWidth={1.25}
                />
              )}
              {rowAction}
            </span>
          )}
        </span>
      </span>
      {!trailingMark && rowAction}
    </div>
  );

  return (
    <WorkspaceContextMenu
      workspace={workspace}
      onArchive={() => onArchive(workspace)}
      archiveDisabled={archiving || modeSwitching}
    >
      {row}
    </WorkspaceContextMenu>
  );
}

/** Placeholder row for a workspace whose create RPC is still in flight. The
 *  branch name is reserved at prepare time, so the row shows the REAL glyph +
 *  workspace name from the first frame — identical to the SidebarWorkspaceRow
 *  that replaces it (no spinner, no shimmer, no reflow). It inherits its label
 *  weight from SIDEBAR_WORKSPACE_ROW_CLS, the container the real row uses, so
 *  keep this component free of any `font-*` utility. A brand-new workspace has
 *  no diff and no run, so it has no trailing indicators to account for.
 *  Non-interactive — there is nothing to open yet. */
export function PendingSidebarWorkspaceRow({
  label,
  branch,
  kind = "code",
  project,
  mixedRepositories = false,
  grouped = false,
  active = false,
  rowRef,
}: {
  label: string;
  /** The reserved branch: seeds the same square the confirmed row draws. */
  branch?: string;
  kind?: "code" | "design";
  project?: Project | null;
  mixedRepositories?: boolean;
  grouped?: boolean;
  active?: boolean;
  /** Registers the optimistic row with the same reveal machinery. */
  rowRef?: (node: HTMLDivElement | null) => void;
}) {
  // Same relocation the confirmed row makes: an Ungrouped row's leading glyph
  // is the repository icon, so the design marker trails. Both rows render it
  // identically, so the pending → confirmed swap neither drops nor re-adds it.
  const trailingDesignMark =
    mixedRepositories && !!project && kind === "design";
  return (
    <div
      ref={rowRef}
      className={cn(
        SIDEBAR_WORKSPACE_ROW_CLS,
        grouped
          ? SIDEBAR_WORKSPACE_GROUPED_INSET_CLS
          : SIDEBAR_WORKSPACE_FLAT_INSET_CLS,
      )}
      data-workspace-tab="true"
      data-active={active}
      role="status"
      aria-live="polite"
    >
      <span className={SIDEBAR_WORKSPACE_CONTENT_CLS}>
        {mixedRepositories && project ? (
          <WorkspaceProjectIcon project={project} />
        ) : (
          <span className={GLYPH_BOX_CLS} aria-hidden="true">
            {kind === "design" ? (
              <PenTool className="size-3.5" strokeWidth={1.25} />
            ) : (
              <WorkspaceGlyph
                seed={workspaceGlyphSeed(project?.repoSlug, branch ?? label)}
              />
            )}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {trailingDesignMark && (
          <span className={SIDEBAR_WORKSPACE_TRAILING_CLS}>
            <span className={GLYPH_BOX_CLS} aria-hidden="true">
              <PenTool className="size-3.5" strokeWidth={1.25} />
            </span>
          </span>
        )}
      </span>
    </div>
  );
}
