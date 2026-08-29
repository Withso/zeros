import React, { useRef, type MouseEvent, type ReactNode } from "react";
import { Archive, Check, Code2, PenTool } from "lucide-react";

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
import { useWorkspaceModeSwitch } from "@/renderer/shared/ui/workspace-mode-header";
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
  children,
  placement = "pointer",
}: WorkspaceContextMenuProps) {
  const {
    archiving,
    canSwitch: showModeSwitch,
    mode,
    setMode,
    switching: switchingMode,
  } = useWorkspaceModeSwitch(workspace);
  const archiveInert = archiveDisabled || archiving || switchingMode;
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

  // Mode switch — one workspace, two modes. Hidden for the synthetic
  // local-main trunk (no managed row to flip) and while a lifecycle operation
  // owns the row (archive shares that signal).
  const inDesignMode = mode === "design";

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

  const positionBelowTrigger = (event: MouseEvent<HTMLElement>) => {
    if (placement !== "below-trigger") return;
    const rect = event.currentTarget.getBoundingClientRect();
    // Radix ContextMenu intentionally anchors to the event coordinates and
    // doesn't expose Popper's side/align props. Its composed handler receives
    // this same synthetic event after ours, so replace the anchor point with
    // the trigger's bottom-left for this opt-in placement.
    const anchorEvent = event as MouseEvent<HTMLElement> & {
      clientX: number;
      clientY: number;
    };
    anchorEvent.clientX = rect.left;
    anchorEvent.clientY = rect.bottom;
  };

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
      <ContextMenuTrigger asChild onContextMenu={positionBelowTrigger}>
        {guardedTrigger}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuSub>
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
                  <Check className="text-fg2 ml-auto size-4" />
                )}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        {showModeSwitch && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => setMode(inDesignMode ? "code" : "design")}
              disabled={switchingMode || archiving}
            >
              {inDesignMode ? <Code2 /> : <PenTool />}
              <span>
                {inDesignMode ? "Switch to Code Mode" : "Switch to Design Mode"}
              </span>
            </ContextMenuItem>
          </>
        )}
        {onArchive && (
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
