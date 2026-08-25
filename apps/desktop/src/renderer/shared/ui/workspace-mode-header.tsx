import React, { useCallback, type ReactNode } from "react";
import { Code2, PenTool, type LucideIcon } from "lucide-react";

import { workspaceSetMode, type Workspace } from "../../platform/git";
import { branchDisplayName } from "../lib/branch-name";
import { useActiveWorkspace } from "../../state/use-active-workspace";
import { isLocalMainWorkspace } from "../../state/local-main-workspace";
import {
  beginWorkspaceModeSwitch,
  finishWorkspaceModeSwitch,
  pendingWorkspaceMode,
  usePendingWorkspaceMode,
  useWorkspaceArchiving,
} from "../../state/pending-workspaces";
import {
  commitWorkspaceMode,
  notifyWorkspacesChanged,
} from "../../state/use-projects";
import { cn } from "./cn";
import { Button } from "./primitives/button";
import { toast } from "./primitives/elements";
import { Tooltip } from "./primitives/tooltip";

export type WorkspaceMode = "code" | "design";

const WORKSPACE_MODES: ReadonlyArray<{
  mode: WorkspaceMode;
  label: string;
  Icon: LucideIcon;
}> = [
  { mode: "code", label: "Code", Icon: Code2 },
  { mode: "design", label: "Design", Icon: PenTool },
];

export interface WorkspaceModeHeaderViewProps {
  workspaceName: string;
  mode: WorkspaceMode;
  disabled: boolean;
  switching: boolean;
  separator?: boolean;
  trailing?: ReactNode;
  onModeChange: (mode: WorkspaceMode) => void;
}

/** Shared visual row for Code's conversation column and Design's Layers
 * sidebar. The mode labels remain accessible and available as tooltips, while
 * the compact control itself contains icons only. */
export function WorkspaceModeHeaderView({
  workspaceName,
  mode,
  disabled,
  switching,
  separator = false,
  trailing,
  onModeChange,
}: WorkspaceModeHeaderViewProps) {
  return (
    <div
      data-workspace-mode-header=""
      className={cn(
        "bg-bg1 flex h-10 shrink-0 items-center gap-2 px-3",
        separator && "border-border1 border-b",
      )}
    >
      <span
        data-workspace-mode-name=""
        className="text-fg1 min-w-0 truncate text-xs font-medium"
      >
        {workspaceName}
      </span>
      <div
        data-workspace-mode-toggle=""
        role="group"
        aria-label="Workspace mode"
        aria-busy={switching || undefined}
        className="border-border2/50 bg-bg2/40 inline-flex shrink-0 items-center gap-2 rounded-md border p-1"
      >
        {WORKSPACE_MODES.map((option) => {
          const active = mode === option.mode;
          return (
            <Tooltip key={option.mode} label={`${option.label} mode`}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-workspace-mode={option.mode}
                aria-label={`${option.label} mode`}
                aria-pressed={active}
                disabled={disabled}
                onClick={() => onModeChange(option.mode)}
                className={cn(
                  "size-4 rounded-sm p-0 transition-none",
                  active ? "text-fg1" : "text-fg3",
                )}
              >
                <option.Icon
                  className="size-4"
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
              </Button>
            </Tooltip>
          );
        })}
      </div>
      {trailing ? (
        <div
          data-workspace-mode-header-trailing=""
          className="ml-auto flex shrink-0 items-center"
        >
          {trailing}
        </div>
      ) : null}
    </div>
  );
}

function useWorkspaceModeSwitch(workspace: Workspace) {
  const pendingMode = usePendingWorkspaceMode(workspace.id);
  const archiving = useWorkspaceArchiving(workspace.id);
  const switching = pendingMode !== null;
  const mode = pendingMode ?? workspace.kind ?? "code";
  const canSwitch = !isLocalMainWorkspace(workspace);

  const setMode = useCallback(
    (nextMode: WorkspaceMode) => {
      if (
        !canSwitch ||
        archiving ||
        pendingWorkspaceMode(workspace.id) !== null ||
        nextMode === mode
      ) {
        return;
      }
      const token = beginWorkspaceModeSwitch(workspace.id, nextMode);
      void workspaceSetMode({ workspaceId: workspace.id, mode: nextMode })
        .then((result) => {
          // Seed Design (when supplied) and publish the confirmed kind before
          // removing the immediate presentation intent. No render can observe
          // the requested surface falling back to the old confirmed row.
          commitWorkspaceMode({
            workspaceId: workspace.id,
            repoSlug: workspace.repoSlug,
            mode: result.mode,
            ...(result.snapshot ? { snapshot: result.snapshot } : {}),
          });
          finishWorkspaceModeSwitch(workspace.id, token);
          notifyWorkspacesChanged(workspace.repoSlug);
        })
        .catch((error: unknown) => {
          finishWorkspaceModeSwitch(workspace.id, token);
          toast.error(
            error instanceof Error
              ? error.message
              : `Couldn't switch to ${nextMode} mode`,
          );
        });
    },
    [archiving, canSwitch, mode, workspace],
  );

  return { archiving, canSwitch, mode, setMode, switching };
}

function OwnedWorkspaceModeHeader({
  workspace,
  separator,
  trailing,
}: {
  workspace: Workspace;
  separator?: boolean;
  trailing?: ReactNode;
}) {
  const { archiving, canSwitch, mode, setMode, switching } =
    useWorkspaceModeSwitch(workspace);
  const workspaceName = branchDisplayName(workspace.branch) || workspace.branch;

  return (
    <WorkspaceModeHeaderView
      workspaceName={workspaceName}
      mode={mode}
      // The controller rejects duplicate requests while `switching`; keeping
      // the buttons out of native `disabled` avoids its opacity flash as the
      // Code and Design surfaces exchange ownership of this row.
      disabled={!canSwitch || archiving}
      switching={switching}
      separator={separator}
      trailing={trailing}
      onModeChange={setMode}
    />
  );
}

const ignoreModeChange = () => {};

export function WorkspaceModeHeader({
  workspace,
  separator = false,
  trailing,
}: {
  workspace: Workspace | null;
  separator?: boolean;
  trailing?: ReactNode;
}) {
  if (workspace) {
    return (
      <OwnedWorkspaceModeHeader
        workspace={workspace}
        separator={separator}
        trailing={trailing}
      />
    );
  }
  return (
    <ActiveWorkspaceModeHeader separator={separator} trailing={trailing} />
  );
}

function ActiveWorkspaceModeHeader({
  separator,
  trailing,
}: {
  separator?: boolean;
  trailing?: ReactNode;
}) {
  const { workspace } = useActiveWorkspace();
  if (workspace) {
    return (
      <OwnedWorkspaceModeHeader
        workspace={workspace}
        separator={separator}
        trailing={trailing}
      />
    );
  }
  return (
    <WorkspaceModeHeaderView
      workspaceName="No workspace selected"
      mode="code"
      disabled
      switching={false}
      separator={separator}
      trailing={trailing}
      onModeChange={ignoreModeChange}
    />
  );
}

export { useWorkspaceModeSwitch };
