// ============================================
// COMPONENT: SidebarWorkspaceRow / PendingSidebarWorkspaceRow
// PURPOSE: One workspace in the app sidebar (step 2): two lines, or one
//          32px line in Compact view, keeping every behaviour of the former
//          tab: the unsent-draft pencil, hover Archive, the right-click status
//          menu and pointer/focus warming.
// USED IN: AppSidebar (app-sidebar.tsx) and the draft-indicator harness
// ============================================
//
// Row anatomy:
//
//   [lead] name ✎………………………………… [loader | •]   line 1
//          [⌂] status word or time · PR marks     line 2 (sidebar-workspace-row-meta)
//          project name                           optional line 3
//
// [lead] The project logo, which stays while an agent works; the logo loader
//        while archiving. Under a repository header, or for a child in its
//        parent's project, the logo would only repeat what is above the row,
//        so the lead carries the loader, the status dot or a faint idle dot.
//        On a parent, the arrow takes its place on hover and toggles the
//        child workspaces. Folders and legacy Design workspaces keep a folder
//        or a pen. (sidebarRowLead)
// ✎      The unsent-draft pencil, right after the name.
// [loader | •] The agent loader, else the status dot (sidebarRowEndMark);
//        Compact puts its PR marks before it and shows the time only when
//        neither speaks for the row.
// The ± line counts are not on the row; the hover card shows them.
//
// The open target is a full-size transparent Button under pointer-transparent
// content, so Archive can sit beside the name without nesting buttons. Hover
// shows Archive over line 1's end only (or a plain folder's settings), so
// hovering never moves anything.
//
// The row's font weight is declared ONCE on the container both variants share
// (SIDEBAR_WORKSPACE_ROW_CLS): the optimistic row has no Button, and a weight
// on the real row's Button would make the label change weight at the swap.

import React, { useState } from "react";
import {
  ChevronRight,
  Folder,
  ImageIcon,
  PenTool,
  Settings,
} from "lucide-react";
import { ArchiveIcon } from "../shared/ui/archive-icon";

import { type Workspace } from "../platform/git";
import { isCloudWorkspace } from "../platform/bridge/cloud-workspace-key";
import { localWorkShowsEverywhere } from "../features/team/organization-capabilities";
import { useCloudWorkspaceStatus } from "./sidebar-cloud-mark";
import { formatCompactAge } from "../features/agent/format-age";
import {
  prMarkGroups,
  prMarkLayout,
  workspacePullRequests,
  workspaceUpdatedAt,
} from "./sidebar-view-model";
import {
  SidebarPlacementIcon,
  SidebarPrMarks,
  SidebarWorkspaceRowMeta,
  sidebarCompactShowsTime,
  sidebarRowEndMark,
  sidebarRowLead,
  sidebarRowStatus,
  sidebarStatusDot,
} from "./sidebar-workspace-row-meta";
import { AgentActivityIndicator } from "../features/agent/agent-activity-indicator";
import { useAnyChatUnread } from "../features/agent/chat-unread";
import { ComposerDraftIndicator } from "../features/agent/composer-draft-indicator";
import {
  useAnyChatWorkingActivity,
  useAnyChatAwaitingKind,
} from "../features/agent/sessions-store";
import { DEFAULT_REPO_SETTINGS_VIEW } from "../features/repositories/repo-page";
import { REPOSITORY_ICON_CHIP_CLS, RepositoryIcon } from "../features/repositories/repository-icon";
import { useAnyChatHasDraft } from "../state/composer-draft-presence";
import { setupFailureShown, useSetupFailureAcknowledged } from "../state/setup-failure-acknowledgements";
import { isLocalMainWorkspace } from "../state/local-main-workspace";
import {
  usePendingWorkspaceMode,
  useWorkspaceArchiving,
} from "../state/pending-workspaces";
import type { Project } from "../state/projects-store";
import { useWorkspaceDispatch } from "../state/store";
import { cn } from "../shared/ui/cn";
import { ZerosSpinner } from "../shared/ui/loading";
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
import { ActivityScope } from "../shared/ui/loading/activity-scope";
import { workspaceLabel, workspaceTabDescription } from "./workspace-tabs";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";
import { Popover, PopoverAnchor, PopoverContent } from "../shared/ui/primitives/popover";
import { SidebarWorkspaceHoverCard } from "./sidebar-workspace-hover-card";
import { useSidebarWorkspacePreview } from "./use-sidebar-workspace-preview";
import { pullRequestTarget } from "../state/workspace-repositories";

// --- CONSTANTS ---

// Full-width row. Hover and the selected row share the sidebar's own hover
// fill (#222 in dark). Rows never shift. --row-fill carries the current fill so
// the Archive fade matches it. Keyboard focus is the 1px accent edge drawn as
// an inset ring, so the row keeps no layout border and its lead lands on the
// 16px icon column. `transition-none` keeps a switch from cross-fading the old
// and new selection.
const SIDEBAR_WORKSPACE_ROW_CLS =
  "group/workspace relative flex w-full min-w-0 shrink-0 select-none items-center overflow-hidden rounded-md pr-2 text-left text-xs font-normal text-fg2 transition-none [--row-fill:var(--surface-hover)] hover:bg-(--surface-hover) focus-within:bg-(--surface-hover) data-[active=true]:bg-(--surface-hover) data-[active=true]:text-fg1 has-[>button:focus-visible]:inset-ring has-[>button:focus-visible]:inset-ring-accent";
// Compact rows keep the one 32px line; the default row is two lines (name,
// then placement · status · PRs · time) and an optional third for the project.
const SIDEBAR_WORKSPACE_COMPACT_ROW_CLS = "h-8";
const SIDEBAR_WORKSPACE_TWO_LINE_ROW_CLS = "items-start py-1.5";
// Archive covers line 1 only, so line 2 never changes on hover.
const SIDEBAR_WORKSPACE_TWO_LINE_ACTION_CLS = "inset-y-auto top-0 h-[30px]";
// Grouped rows sit under their repository header: the lead starts on the
// header's 40px name column. Ungrouped rows and standalone folder rows align
// with the headers' own 16px icon column.
const SIDEBAR_WORKSPACE_GROUPED_INSET_CLS = "pl-8";
const SIDEBAR_WORKSPACE_FLAT_INSET_CLS = "pl-2";
const SIDEBAR_WORKSPACE_OPEN_BUTTON_CLS =
  "absolute inset-0 size-full rounded-md border-0 bg-transparent p-0 text-inherit shadow-none transition-none hover:bg-transparent hover:text-inherit focus-visible:ring-0";
const SIDEBAR_WORKSPACE_CONTENT_CLS =
  "pointer-events-none relative flex h-full min-w-0 flex-1 items-center gap-2 whitespace-nowrap text-inherit [&_svg]:shrink-0 [&_svg:not([data-draft-icon])]:size-3.5";
const SIDEBAR_WORKSPACE_TRAILING_CLS = "flex shrink-0 items-center gap-1.5";
// The loader and the status dot share one 16px slot, so the name's truncation
// point never moves with the state.
const TRAILING_SLOT_CLS =
  "relative inline-flex size-4 shrink-0 items-center justify-center";
// Hover and focus reveal Archive at the row's end over a fade of the same
// hover fill, so the right end's marks slide under it instead of reflowing. The 24px button ends 12px in, like the headers' row actions.
const SIDEBAR_WORKSPACE_ACTION_OVERLAY_CLS =
  "pointer-events-none absolute inset-y-0 right-0 z-10 flex w-12 items-center justify-end rounded-r-md bg-gradient-to-l from-(--row-fill) from-50% to-transparent pr-1 opacity-0 transition-none group-hover/workspace:opacity-100 focus-within:opacity-100";
// The lead stays on fg2 in every state; the name is fg1 on every row.
const GLYPH_BOX_CLS =
  "inline-flex size-4 shrink-0 items-center justify-center text-fg2";
const STATUS_DOT_BASE_CLS = "size-1.5 rounded-full";
// Idle under a repository header or a same-project parent: deliberately faint,
// so "nothing to report" never reads as a status.
const IDLE_DOT_CLS = "size-1.5 rounded-full bg-(--sidebar-idle-dot)";
// A parent's lead is a 16px toggle: its mark at rest, the arrow on hover or
// keyboard focus.
const PARENT_TOGGLE_CLS =
  "group/lead pointer-events-auto size-4 rounded-sm hover:bg-selected-bg";

/** React bubbles a portalled menu's or dialog's events through the component
 * tree; only an event whose DOM target sits inside the element is its own. */
export function eventInsideOwnDom(event: { currentTarget: Element; target: EventTarget | null }): boolean {
  return event.target instanceof Node && event.currentTarget.contains(event.target);
}

// --- CHILD COMPONENTS ---

/** The project logo in a row's leading slot. Its own right-click target still
 * exposes repository actions without replacing the surrounding workspace
 * context menu. */
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
          <span data-sidebar-row-logo="" className="pointer-events-auto inline-flex size-4 shrink-0 items-center justify-center">
            <RepositoryIcon project={project} className={REPOSITORY_ICON_CHIP_CLS} />
          </span>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
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
  /** Retire hover intent when the signed-in owner changes, even for a reused row. */
  previewOwner?: string;
  activeAt?: number;
  /** Live coding-chat ids in this worktree, used for agent activity state. */
  chatIds: readonly string[];
  /** Includes closed chats whose unsent drafts are still recoverable. */
  draftChatIds?: readonly string[];
  /** Owner repository; its logo leads the row. */
  project: Project | null;
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
  /** One-line rows: the loader, the status dot or the time at the end. */
  compact?: boolean;
  /** Adds the project name as a third line (never in Compact). */
  showProjectName?: boolean;
  /** Child-workspace nesting depth (0 for a top-level row). */
  depth?: number;
  /** A child of a workspace in the same project: its lead carries the loader or a dot. */
  sameProjectAsParent?: boolean;
  /** Listed under its repository's header: its lead carries the loader or a
   *  dot instead of repeating the header's logo. */
  repositoryLead?: boolean;
  /** Child workspaces under this row; with `onToggleChildren` the lead toggles them. */
  childCount?: number;
  childrenExpanded?: boolean;
  onToggleChildren?: () => void;
}

// --- ROOT COMPONENTS ---

export function SidebarWorkspaceRow({
  workspace,
  active,
  surfaceActive = true,
  previewOwner,
  activeAt,
  chatIds,
  draftChatIds = chatIds,
  project,
  grouped,
  onSelect,
  onPrefetch,
  onArchive,
  rowRef,
  onOpenSettings,
  compact = false,
  showProjectName = false,
  depth = 0,
  sameProjectAsParent = false,
  repositoryLead = false,
  childCount = 0,
  childrenExpanded = false,
  onToggleChildren,
}: SidebarWorkspaceRowProps) {
  const twoLine = !compact;
  const requestedMode = usePendingWorkspaceMode(workspace.id);
  const modeSwitching = requestedMode !== null;
  const designWorkspace = workspace.kind === "design";
  // A chat whose turn waits on the user rests (see parkedOnUser); the square
  // keeps moving only while some chat's agent actually works.
  const activity = useAnyChatWorkingActivity(chatIds);
  const working = activity !== null;
  const awaitingKind = useAnyChatAwaitingKind(chatIds);
  const islandKind = usePrIslandKind(pullRequestTarget(workspace), workspace.prNumber);
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
  const preview = useSidebarWorkspacePreview(
    JSON.stringify([previewOwner, workspace.organizationId, workspace.id, workspace.path]),
    surfaceActive && !archiving && !modeSwitching,
  );
  // An agent finished while its chat wasn't on screen (chat-unread.ts).
  const unread = useAnyChatUnread(chatIds);
  const setupAcknowledged = useSetupFailureAcknowledged(workspace.id);
  const cloudRow = isCloudWorkspace(workspace.path);
  const cloudStatus = useCloudWorkspaceStatus(cloudRow ? workspace.path : null);
  const rowStatus = sidebarRowStatus({
    archiving,
    setupFailed: setupFailureShown(workspace, setupAcknowledged),
    cloudStatus,
    awaiting: archiving ? null : awaitingKind,
    working,
    unread,
  });
  const pulls = workspacePullRequests(workspace, islandKind);
  const updatedAt = workspaceUpdatedAt(workspace, activeAt);
  const statusDot = archiving ? null : sidebarStatusDot(rowStatus);
  // The lead carries the loader and dot when the logo would only repeat what
  // is above the row: its repository header, or its parent in the same project.
  const dotLead = repositoryLead || (depth > 0 && sameProjectAsParent);
  const lead = sidebarRowLead({ archiving, working, dotLead, statusDot: !!statusDot, folder: localFolder, design: designWorkspace });
  const endMark = sidebarRowEndMark({ archiving, working, dotLead, statusDot: !!statusDot });
  const statusDotLabel = rowStatus && statusDot ? rowStatus.label : undefined;
  const leadMark =
    lead === "archiving" ? <ZerosSpinner size={16} label="Archiving workspace" />
    : lead === "working" ? <AgentActivityIndicator activity={activity} />
    : lead === "status-dot" ? <span className={cn(STATUS_DOT_BASE_CLS, statusDot)} data-sidebar-lead-dot="status" />
    : lead === "idle-dot" ? <span className={IDLE_DOT_CLS} data-sidebar-lead-dot="idle" />
    : lead === "design" ? <PenTool className="size-3.5" strokeWidth={1.25} />
    : lead === "folder" || !project ? <Folder className="size-3.5" strokeWidth={1.25} />
    : <WorkspaceProjectIcon project={project} />;
  const parentToggle = childCount > 0 && onToggleChildren && !archiving;
  const projectName = showProjectName && twoLine ? (workspace.project?.name ?? project?.name ?? null) : null;
  // unified-workspaces lists Local and cloud rows together. Compact rows carry
  // the placement beside the name; two-line rows on line 2.
  const placementMark = compact && localWorkShowsEverywhere();
  // One hover/focus action per row: Archive for a managed worktree, folder
  // settings for a legacy plain folder, nothing for a primary checkout.
  const action =
    archiving || modeSwitching
      ? null
      : !localFolder
        ? {
            tooltip: "Archive workspace",
            label: `Archive workspace ${label}`,
            icon: <ArchiveIcon className="size-3.5" strokeWidth={1.25} />,
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
    <span className={cn(SIDEBAR_WORKSPACE_ACTION_OVERLAY_CLS, twoLine && SIDEBAR_WORKSPACE_TWO_LINE_ACTION_CLS)}>
      <Tooltip label={action.tooltip} side="right">
        <IconButton
          type="button"
          size="compact"
          className="pointer-events-auto shrink-0"
          label={action.label}
          onClick={(event) => {
            event.stopPropagation();
            preview.close();
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
        compact ? SIDEBAR_WORKSPACE_COMPACT_ROW_CLS : SIDEBAR_WORKSPACE_TWO_LINE_ROW_CLS,
        grouped
          ? SIDEBAR_WORKSPACE_GROUPED_INSET_CLS
          : SIDEBAR_WORKSPACE_FLAT_INSET_CLS,
      )}
      data-active={active}
      data-compact={compact}
      data-workspace-tab="true"
      data-workspace-id={workspace.id}
      data-streaming={working || undefined}
      aria-busy={archiving || modeSwitching || undefined}
      onPointerEnter={(event) => {
        if (!surfaceActive || !eventInsideOwnDom(event)) return;
        onPrefetch(workspace);
        preview.scheduleOpen();
      }}
      onPointerLeave={preview.scheduleClose}
      onFocus={(event) => {
        if (!surfaceActive || !eventInsideOwnDom(event)) return;
        onPrefetch(workspace);
        preview.scheduleOpen();
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget) || preview.contentRef.current?.contains(event.relatedTarget)) return;
        preview.scheduleClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowRight" || !preview.open) return;
        event.preventDefault();
        preview.contentRef.current?.querySelector<HTMLElement>("button:not(:disabled), a[href]")?.focus();
      }}
      onContextMenu={preview.close}
      onClick={(event) => {
        if (!eventInsideOwnDom(event)) return;
        if (!surfaceActive || archiving) return;
        preview.close();
        onSelect(workspace);
      }}
    >
      <Button
        ref={preview.triggerRef}
        type="button"
        variant="ghost"
        className={SIDEBAR_WORKSPACE_OPEN_BUTTON_CLS}
        aria-current={active ? "page" : undefined}
        aria-haspopup="dialog"
        aria-expanded={preview.open}
        aria-label={workspaceTabDescription({
          label,
          runActionRunning,
          changeLines,
          hasDraft,
          unread,
        })}
        disabled={archiving}
      />
      <span
        className={cn(SIDEBAR_WORKSPACE_CONTENT_CLS, twoLine && "h-auto items-start", archiving && "opacity-50")}
      >
        {/* Cloud agents run remotely: their loader is not local activity. */}
        <ActivityScope.Provider value={isCloudWorkspace(workspace.path) ? undefined : true}>
          {parentToggle ? (
            <IconButton
              type="button"
              size="inline"
              className={PARENT_TOGGLE_CLS}
              label={`${childrenExpanded ? "Hide" : "Show"} ${childCount === 1 ? "1 child workspace" : `${childCount} child workspaces`}`}
              aria-expanded={childrenExpanded}
              data-child-workspaces-toggle={workspace.id}
              onClick={(event) => { event.stopPropagation(); onToggleChildren(); }}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <span className={cn(GLYPH_BOX_CLS, "group-hover/lead:hidden group-focus-visible/lead:hidden")} aria-hidden="true">{leadMark}</span>
              <ChevronRight className={cn("hidden size-3.5 text-fg2 group-hover/lead:block group-focus-visible/lead:block", childrenExpanded && "rotate-90")} strokeWidth={1.5} aria-hidden="true" />
            </IconButton>
          ) : (
            <span className={GLYPH_BOX_CLS} aria-hidden={lead !== "logo" || undefined} data-sidebar-lead={lead}>
              {leadMark}
            </span>
          )}
        </ActivityScope.Provider>
        <span className={twoLine ? "flex min-w-0 flex-1 flex-col gap-0.5" : "contents"}>
        <span className={twoLine ? "flex h-4.5 min-w-0 items-center gap-2" : "contents"}>
        {/* Only the name truncates; everything after it is shrink-0. */}
        <span className="text-fg1 min-w-0 truncate">{label}</span>
        {showDraft && (
          <span className="text-fg2 inline-flex shrink-0" data-sidebar-draft-mark>
            <ComposerDraftIndicator />
          </span>
        )}
        {placementMark && (
          <span className="text-fg3 inline-flex shrink-0">
            <SidebarPlacementIcon cloud={cloudRow} cloudStatus={cloudStatus} />
          </span>
        )}
        {/* The right end: Compact's PR marks, then the agent loader, else the
            status dot, else (Compact) the time. Hover covers it with Archive. */}
        <span className={cn(SIDEBAR_WORKSPACE_TRAILING_CLS, "ml-auto")}>
          {compact && pulls.length > 0 && (
            <span className="text-3xxs inline-flex shrink-0 items-center">
              <SidebarPrMarks groups={prMarkGroups(pulls)} layout={prMarkLayout(prMarkGroups(pulls), 0, true)} />
            </span>
          )}
          {endMark === "loader" ? (
            <ActivityScope.Provider value={isCloudWorkspace(workspace.path) ? undefined : true}>
              <span className={TRAILING_SLOT_CLS} data-sidebar-end-mark="loader">
                <AgentActivityIndicator activity={activity} />
              </span>
            </ActivityScope.Provider>
          ) : endMark === "dot" ? (
            <span className={TRAILING_SLOT_CLS} role="img" aria-label={statusDotLabel} data-sidebar-end-mark="dot">
              <span className={cn(STATUS_DOT_BASE_CLS, statusDot)} />
            </span>
          ) : compact && sidebarCompactShowsTime({ working, statusDot: !!statusDot }) ? (
            <span className="text-fg3 text-3xxs shrink-0 tabular-nums">{formatCompactAge(updatedAt)}</span>
          ) : null}
        </span>
        </span>
        {twoLine && (
          <SidebarWorkspaceRowMeta
            workspace={workspace}
            pulls={pulls}
            status={rowStatus}
            cloud={cloudRow}
            cloudStatus={cloudStatus}
            updatedAt={updatedAt}
          />
        )}
        {projectName && (
          <span className="text-fg3 truncate text-3xxs leading-4" data-sidebar-project-name>{projectName}</span>
        )}
        </span>
      </span>
      {rowAction}
    </div>
  );

  return (
    <Popover open={preview.open} onOpenChange={(open) => { if (!open) preview.close(); }}>
      <WorkspaceContextMenu
        workspace={workspace}
        onArchive={() => onArchive(workspace)}
        archiveDisabled={archiving || modeSwitching}
      >
        <PopoverAnchor asChild>{row}</PopoverAnchor>
      </WorkspaceContextMenu>
      {preview.open && (
        <PopoverContent
          ref={preview.contentRef}
          side="right"
          align="start"
          // The row ends 8px before the 1px seam: 13 floats the card the
          // recipe's 4px beyond it instead of looking attached.
          sideOffset={13}
          collisionPadding={8}
          aria-label={`Workspace details for ${label}`}
          size="md"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={() => {
            if (preview.contentRef.current?.contains(document.activeElement)) preview.triggerRef.current?.focus();
            preview.close();
          }}
          onPointerEnter={preview.cancel}
          onPointerLeave={preview.scheduleClose}
          onFocusCapture={preview.cancel}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) preview.scheduleClose();
          }}
        >
          <SidebarWorkspaceHoverCard
            workspace={workspace}
            project={project}
            chatIds={chatIds}
            changeLines={changeLines}
            activeAt={activeAt}
            onSelect={() => { preview.close(); onSelect(workspace); }}
            onArchive={() => { preview.close(); onArchive(workspace); }}
            onMenuOpenChange={preview.setMenuOpen}
          />
        </PopoverContent>
      )}
    </Popover>
  );
}

/** Placeholder row for a workspace whose create RPC is still in flight. The
 *  branch name is reserved at prepare time, so the row shows the project logo
 *  and the real workspace name from the first frame, with Creating… on line 2,
 *  and the SidebarWorkspaceRow that replaces it keeps both (no shimmer, no
 *  reflow). It inherits its label weight from SIDEBAR_WORKSPACE_ROW_CLS, the
 *  container the real row uses, so keep this component free of any `font-*`
 *  utility. A brand-new workspace has no diff and no run, so it has no
 *  trailing indicators to account for. Non-interactive: there is nothing to
 *  open yet. */
export function PendingSidebarWorkspaceRow({
  label,
  kind = "code",
  project,
  projectInteractive = true,
  cloud = false,
  grouped = false,
  active = false,
  compact = false,
  rowRef,
}: {
  label: string;
  /** Matches the confirmed row's height so the swap never reflows. */
  compact?: boolean;
  kind?: "code" | "design";
  project?: Project | null;
  projectInteractive?: boolean;
  /** Placement of the workspace being created (line 2's icon). */
  cloud?: boolean;
  grouped?: boolean;
  active?: boolean;
  /** Registers the optimistic row with the same reveal machinery. */
  rowRef?: (node: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={rowRef}
      className={cn(
        SIDEBAR_WORKSPACE_ROW_CLS,
        compact ? SIDEBAR_WORKSPACE_COMPACT_ROW_CLS : SIDEBAR_WORKSPACE_TWO_LINE_ROW_CLS,
        grouped
          ? SIDEBAR_WORKSPACE_GROUPED_INSET_CLS
          : SIDEBAR_WORKSPACE_FLAT_INSET_CLS,
      )}
      data-workspace-tab="true"
      data-compact={compact}
      data-active={active}
      role="status"
      aria-live="polite"
    >
      <span className={cn(SIDEBAR_WORKSPACE_CONTENT_CLS, !compact && "h-auto items-start")}>
        <span className={GLYPH_BOX_CLS} aria-hidden={kind === "design" || !project || undefined} data-sidebar-lead={kind === "design" ? "design" : "logo"}>
          {kind === "design" ? (
            <PenTool className="size-3.5" strokeWidth={1.25} />
          ) : project ? (
            projectInteractive ? <WorkspaceProjectIcon project={project} /> : <RepositoryIcon project={project} className={REPOSITORY_ICON_CHIP_CLS} />
          ) : (
            <Folder className="size-3.5" strokeWidth={1.25} />
          )}
        </span>
        <span className={compact ? "contents" : "flex min-w-0 flex-1 flex-col gap-0.5"}>
          <span className={cn("text-fg1", compact ? "min-w-0 flex-1 truncate" : "h-4.5 min-w-0 truncate")}>{label}</span>
          {compact ? (
            <span className="text-fg3 text-3xxs ml-auto shrink-0">Creating…</span>
          ) : (
            <span className="text-fg3 flex h-4 items-center gap-1.5 text-3xxs leading-4">
              <span className="inline-flex size-3 shrink-0 items-center justify-center">
                <SidebarPlacementIcon cloud={cloud} cloudStatus={null} />
              </span>
              Creating…
            </span>
          )}
        </span>
      </span>
    </div>
  );
}
