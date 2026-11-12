import React, { useRef, type MouseEvent, type ReactNode } from "react";
import { isLocalMainWorkspace } from "../../state/local-main-workspace";
import { Archive, BellOff, BellRing, Check, Link, Pin, PinOff, RotateCw, UserRoundCog } from "lucide-react";
import { openReassignDialog } from "../../features/team/reassign-dialog";
import { useCloudFolderSharedDocument } from "../../state/cloud-workspace-creators";
import { setCloudWorkspaceSharingFlag } from "../../state/team-sharing-actions";
import { parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { copyLocalLink, useCanCopyLocalLink } from "../../state/local-link-actions";
import {
  copyCloudWorkspaceLink,
  useCanCopyCloudWorkspaceLink,
} from "../../state/cloud-workspace-link-actions";

import {
  workspaceSetStatus,
  type Workspace,
  type WorkspaceStatus,
} from "@/renderer/platform/git";
import { notifyWorkspacesChanged } from "@/renderer/state/use-projects";
import { LIFECYCLE_STATUSES } from "@/renderer/shared/lib/workspace-status";
import { getLastInputModality } from "@/renderer/shared/ui/overlay-focus";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import { StatusIcon } from "@/renderer/shared/ui/primitives/status-icon";
import { Tooltip } from "./primitives/tooltip";
import { useWorkspaceArchiving } from "@/renderer/state/pending-workspaces";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/renderer/shared/ui/primitives/context-menu";

export interface WorkspaceContextMenuProps {
  workspace: Workspace;
  /** Archive handler. Omit to hide the Archive item (e.g. the local-main row). */
  onArchive?: () => void;
  /** Show the Archive item greyed-out and inert for a caller-owned reason. */
  archiveDisabled?: boolean;
  /** Optional placement-owned lifecycle action; Local callers omit it. */
  onRestart?: () => void;
  restartDisabledReason?: string;
  /** The right-click target — wrapped as the menu trigger via `asChild`. */
  children: ReactNode;
  /** Top-bar tabs anchor their context menu to the trigger's bottom-left rather
   *  than the exact pointer, so the menu never covers the compact tab row. */
  placement?: "pointer" | "below-trigger";
}

// A pointer-placed context menu (the Dashboard cards + Repo rows) renders its
// items directly OVER the trigger. Radix selects an item on pointer-up and then
// closes the menu; the browser dispatches the trailing `click` to whatever now
// sits under the pointer — the trigger beneath the just-removed item — which
// fires the trigger's OWN onClick (e.g. "open this workspace"). That phantom
// click is why archiving from the Dashboard also navigated into the workspace.
// Swallow a click that lands in the brief aftermath of a menu close. Comfortably
// longer than the sub-frame gap between the select and the phantom click, short
// enough that a genuine card click (no menu in play) is never in the window.
const PHANTOM_CLICK_WINDOW_MS = 250;

/** The right-click menu shared by sidebar rows and Dashboard cards: a
 *  "Set status →" submenu (five lifecycle states, current one checked) plus an
 *  optional Archive. A manual set writes `status` directly, deliberately
 *  bypassing the auto-transition guards (the user is choosing explicitly). */
export function WorkspaceContextMenu({
  workspace,
  onArchive,
  archiveDisabled = false,
  onRestart,
  restartDisabledReason,
  children,
  placement = "pointer",
}: WorkspaceContextMenuProps) {
  const archiving = useWorkspaceArchiving(workspace.id);
  const canCopyLink = useCanCopyLocalLink(workspace);
  const canCopyCloudLink = useCanCopyCloudWorkspaceLink(workspace);
  const folderWorkspace = isLocalMainWorkspace(workspace);
  const archiveInert = archiveDisabled || archiving;
  // Team sharing: a reader cannot set status or restart; only managers archive; anyone follows (but its Creator) and pins.
  const shared = useCloudFolderSharedDocument(workspace.path);
  const sharedTarget = shared ? parseCloudWorkspaceKey(workspace.path) : null;
  const reader = shared?.sharing?.readOnly === true;
  const canArchive = !shared || shared.capabilities.canManage;
  const toggleShared = (field: "following" | "pinned", value: boolean, failure: string) => {
    if (sharedTarget) void setCloudWorkspaceSharingFlag(sharedTarget, field, value).catch(() => toast.error(failure, { description: "Try again." }));
  };
  const setStatus = (status: WorkspaceStatus) => {
    if (status === workspace.status) return;
    void workspaceSetStatus({ workspaceId: workspace.id, status })
      .then(() => notifyWorkspacesChanged(workspace.repoSlug))
      .catch((err: unknown) => {
        toast.error(
          err instanceof Error ? err.message : "Couldn't update status",
        );
      });
  };

  // Timestamp of the most recent menu close, used to eat the phantom click above.
  const menuClosedAtRef = useRef(0);
  // Clone the trigger to intercept its click in the CAPTURE phase — this runs
  // before the trigger's own onClick (Dashboard/Repo) and before any inner
  // "open" button's onClick (top-bar tab), so a single stopPropagation cancels
  // the whole open regardless of where the handler lives. Consume-once (reset to
  // 0) so at most one click is ever suppressed per menu close.
  const guardedTrigger = React.isValidElement(children)
    ? React.cloneElement(
        children as React.ReactElement<{
          onClickCapture?: (event: MouseEvent<HTMLElement>) => void;
        }>,
        {
          onClickCapture: (event: MouseEvent<HTMLElement>) => {
            if (
              menuClosedAtRef.current !== 0 &&
              Date.now() - menuClosedAtRef.current < PHANTOM_CLICK_WINDOW_MS
            ) {
              menuClosedAtRef.current = 0;
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            (
              children as React.ReactElement<{
                onClickCapture?: (event: MouseEvent<HTMLElement>) => void;
              }>
            ).props.onClickCapture?.(event);
          },
        },
      )
    : children;

  // Root folders have no engine workspace row to archive or change status.
  if (folderWorkspace && !canCopyLink) return <>{children}</>;

  return (
    <ContextMenu
      onOpenChange={(open) => {
        // Only a POINTER-driven close arms the guard — the phantom click follows
        // a pointer select. A keyboard close (Escape / Enter) produces no stray
        // mouse click, so leaving it unarmed avoids eating a genuine click that a
        // keyboard user makes moments later.
        if (!open && getLastInputModality() === "pointer") {
          menuClosedAtRef.current = Date.now();
        }
      }}
    >
      <ContextMenuTrigger asChild placement={placement}>
        {guardedTrigger}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {!folderWorkspace && !reader && <ContextMenuSub>
          <ContextMenuSubTrigger>
            <StatusIcon status={workspace.status} className="size-3.5" />
            <span>Set status</span>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {LIFECYCLE_STATUSES.map((s) => (
              <ContextMenuItem
                key={s.value}
                onSelect={() => setStatus(s.value)}
              >
                <StatusIcon status={s.value} className="size-3.5" />
                <span>{s.label}</span>
                {workspace.status === s.value && (
                  <Check className="text-fg1 ml-auto size-3.5" />
                )}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>}

        {(canCopyLink || canCopyCloudLink) && (
          <ContextMenuItem
            onSelect={() =>
              void (canCopyCloudLink
                ? copyCloudWorkspaceLink(workspace)
                : copyLocalLink(workspace))
            }
          >
            <Link />
            <span>Copy link</span>
          </ContextMenuItem>
        )}

        {shared?.sharing && (
          <>
            {shared.sharing.viewerRole !== "creator" && (
              <ContextMenuItem onSelect={() => toggleShared("following", !shared.sharing!.following,
                shared.sharing!.following ? "Couldn't unfollow workspace" : "Couldn't follow workspace")}>
                {shared.sharing.following ? <BellOff /> : <BellRing />}
                <span>{shared.sharing.following ? "Unfollow" : "Follow"}</span>
              </ContextMenuItem>
            )}
            <ContextMenuItem onSelect={() => toggleShared("pinned", !shared.sharing!.pinned,
              shared.sharing!.pinned ? "Couldn't unpin workspace" : "Couldn't pin workspace")}>
              {shared.sharing.pinned ? <PinOff /> : <Pin />}
              <span>{shared.sharing.pinned ? "Unpin" : "Pin"}</span>
            </ContextMenuItem>
            {/* 3B: the Creator or an admin, on an activated workspace with team ownership. */}
            {shared.sharing.ownership?.canReassign && sharedTarget && (
              <ContextMenuItem onSelect={() => openReassignDialog(sharedTarget)}>
                <UserRoundCog />
                <span>Reassign…</span>
              </ContextMenuItem>
            )}
          </>
        )}

        {!folderWorkspace && !reader && onRestart && (
          <>
            <ContextMenuSeparator />
            <Tooltip label={restartDisabledReason}>
              <div>
                <ContextMenuItem onSelect={onRestart} disabled={!!restartDisabledReason}>
                  <RotateCw />
                  <span>Restart workspace</span>
                </ContextMenuItem>
              </div>
            </Tooltip>
          </>
        )}

        {!folderWorkspace && canArchive && onArchive && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onArchive} disabled={archiveInert}>
              <Archive />
              <span>Archive</span>
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
