import React, { useCallback, useMemo, type ReactNode } from "react";
import { Code2, FolderPlus, PenTool, type LucideIcon } from "lucide-react";

import { workspaceSetMode, type Workspace } from "../../platform/git";
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
import {
  designDirectoryTargetKeyForWorkspace,
  markDesignDirectoryTargetExists,
  useDesignDirectoryTarget,
} from "../../state/design-directory-target";
import { cn } from "./cn";
import { Button } from "./primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./primitives/dropdown-menu";
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

/** Offered in place of the direct Design switch when the checkout has no
 *  design directory yet: choosing Design opens a one-item menu naming the
 *  folder the switch will create, and the switch runs only on that pick. */
export type CreateDesignDirectoryOption =
  | {
      /** The first exact-key preview has not settled yet. Keep Design behind a
       *  non-mutating menu instead of racing ahead with an unconfirmed switch. */
      state: "loading";
    }
  | {
      state: "ready";
      /** Repo-relative folder the engine will create ("<repo> - Design"). */
      directory: string;
      onConfirm: () => void;
    };

export const CREATE_DESIGN_DIRECTORY_LABEL = "Create design directory";

export interface WorkspaceModeToggleViewProps {
  mode: WorkspaceMode;
  disabled: boolean;
  switching: boolean;
  onModeChange: (mode: WorkspaceMode) => void;
  /** When set (and the current mode is Code), the Design choice confirms the
   *  folder creation through a menu instead of switching immediately. */
  createDesignDirectory?: CreateDesignDirectoryOption | null;
}

/** The Code/Design control on its own, with no row of its own. Code's chat-tab
 * strip seats it directly as the strip's fixed leading control; Design's Layers
 * sidebar still gets it inside {@link WorkspaceModeHeaderView}'s row. The mode
 * labels remain accessible and available as tooltips, while the compact control
 * itself contains icons only. */
export function WorkspaceModeToggleView({
  mode,
  disabled,
  switching,
  onModeChange,
  createDesignDirectory = null,
}: WorkspaceModeToggleViewProps) {
  return (
    <div
      data-workspace-mode-toggle=""
      role="group"
      aria-label="Workspace mode"
      aria-busy={switching || undefined}
      className="border-border2/50 bg-bg2/40 inline-flex shrink-0 items-center gap-2 rounded-md border p-1"
    >
      {WORKSPACE_MODES.map((option) => {
        const active = mode === option.mode;
        const button = (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-workspace-mode={option.mode}
            aria-label={`${option.label} mode`}
            aria-pressed={active}
            disabled={disabled}
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
        );
        // The checkout has no design directory: Design becomes a confirmed
        // creation rather than a silent one. The button keeps its identity
        // (label, pressed state, geometry); only its activation changes.
        if (option.mode === "design" && !active && createDesignDirectory) {
          const creationReady = createDesignDirectory.state === "ready";
          return (
            <DropdownMenu key={option.mode}>
              <Tooltip label={`${option.label} mode`}>
                <DropdownMenuTrigger asChild>
                  {React.cloneElement(button, {
                    "data-workspace-mode-create": "",
                  })}
                </DropdownMenuTrigger>
              </Tooltip>
              <DropdownMenuContent
                align="start"
                sideOffset={6}
                className="min-w-[240px]"
              >
                <DropdownMenuItem
                  data-workspace-mode-create-item=""
                  disabled={!creationReady}
                  onSelect={() => {
                    if (creationReady) createDesignDirectory.onConfirm();
                  }}
                >
                  <FolderPlus className="text-fg2" strokeWidth={1.5} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span>
                      {creationReady
                        ? CREATE_DESIGN_DIRECTORY_LABEL
                        : "Checking design directory…"}
                    </span>
                    {creationReady ? (
                      <span className="text-fg3 truncate font-mono text-[11px]">
                        {createDesignDirectory.directory}
                      </span>
                    ) : null}
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        }
        return (
          <Tooltip key={option.mode} label={`${option.label} mode`}>
            {React.cloneElement(button, {
              onClick: () => onModeChange(option.mode),
            })}
          </Tooltip>
        );
      })}
    </div>
  );
}

export interface WorkspaceModeHeaderViewProps {
  designDirectoryName: string;
  mode: WorkspaceMode;
  disabled: boolean;
  switching: boolean;
  separator?: boolean;
  trailing?: ReactNode;
  onModeChange: (mode: WorkspaceMode) => void;
  createDesignDirectory?: CreateDesignDirectoryOption | null;
}

/** Design's Layers header: the shared toggle stays at the same leading edge as
 * Code's copy, followed by the active Design directory. */
export function WorkspaceModeHeaderView({
  designDirectoryName,
  mode,
  disabled,
  switching,
  separator = false,
  trailing,
  onModeChange,
  createDesignDirectory = null,
}: WorkspaceModeHeaderViewProps) {
  return (
    <div
      data-workspace-mode-header=""
      className={cn(
        "bg-bg1 flex h-10 shrink-0 items-center gap-2 pr-3 pl-2",
        separator && "border-border1 border-b",
      )}
    >
      <WorkspaceModeToggleView
        mode={mode}
        disabled={disabled}
        switching={switching}
        onModeChange={onModeChange}
        createDesignDirectory={createDesignDirectory}
      />
      <span
        data-design-directory-name=""
        title={designDirectoryName}
        className="text-fg1 min-w-0 truncate text-xs font-medium"
      >
        {designDirectoryName}
      </span>
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
          if (result.mode === "design") {
            // Mode entry initialized the design directory if it was missing;
            // the toggle must not keep offering to create it.
            markDesignDirectoryTargetExists(
              designDirectoryTargetKeyForWorkspace(workspace.id),
            );
          }
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

/** The "Create design directory" option for a Code-mode workspace whose
 *  checkout has no design directory yet. Reads the engine's entry preview as
 *  keyed server state (warm on mount, patched by the switch itself). While the
 *  preview is unknown or refused, the toggle offers the plain switch — mode
 *  entry then behaves exactly as before this option existed. */
function useCreateDesignDirectoryOption(
  workspace: Workspace,
  args: {
    canSwitch: boolean;
    mode: WorkspaceMode;
    setMode: (mode: WorkspaceMode) => void;
  },
): CreateDesignDirectoryOption | null {
  const { canSwitch, mode, setMode } = args;
  const relevant = canSwitch && mode === "code";
  const target = useDesignDirectoryTarget(
    relevant ? designDirectoryTargetKeyForWorkspace(workspace.id) : null,
  );
  const directory =
    relevant && target.data && !target.data.exists
      ? target.data.directory
      : null;
  const previewPending =
    relevant && target.data === undefined && target.error === null;
  return useMemo(() => {
    if (directory !== null) {
      return {
        state: "ready" as const,
        directory,
        onConfirm: () => setMode("design"),
      };
    }
    return previewPending ? { state: "loading" as const } : null;
  }, [directory, previewPending, setMode]);
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
  const createDesignDirectory = useCreateDesignDirectoryOption(workspace, {
    canSwitch,
    mode,
    setMode,
  });
  const designDirectoryTarget = useDesignDirectoryTarget(
    mode === "design"
      ? designDirectoryTargetKeyForWorkspace(workspace.id)
      : null,
  );
  const designDirectoryName =
    designDirectoryTarget.data?.directory ?? "Design directory";

  return (
    <WorkspaceModeHeaderView
      designDirectoryName={designDirectoryName}
      mode={mode}
      // The controller rejects duplicate requests while `switching`; keeping
      // the buttons out of native `disabled` avoids its opacity flash as the
      // Code and Design surfaces exchange ownership of this row.
      disabled={!canSwitch || archiving}
      switching={switching}
      separator={separator}
      trailing={trailing}
      onModeChange={setMode}
      createDesignDirectory={createDesignDirectory}
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
      designDirectoryName="Design directory"
      mode="code"
      disabled
      switching={false}
      separator={separator}
      trailing={trailing}
      onModeChange={ignoreModeChange}
    />
  );
}

function OwnedWorkspaceModeToggle({ workspace }: { workspace: Workspace }) {
  const { archiving, canSwitch, mode, setMode, switching } =
    useWorkspaceModeSwitch(workspace);
  const createDesignDirectory = useCreateDesignDirectoryOption(workspace, {
    canSwitch,
    mode,
    setMode,
  });

  return (
    <WorkspaceModeToggleView
      mode={mode}
      // Same reasoning as the header's: the controller rejects duplicate
      // requests while `switching`, so native `disabled` (and its opacity
      // flash) stays off the buttons as the two surfaces trade ownership.
      disabled={!canSwitch || archiving}
      switching={switching}
      onModeChange={setMode}
      createDesignDirectory={createDesignDirectory}
    />
  );
}

function ActiveWorkspaceModeToggle() {
  const { workspace } = useActiveWorkspace();
  if (workspace) return <OwnedWorkspaceModeToggle workspace={workspace} />;
  return (
    <WorkspaceModeToggleView
      mode="code"
      disabled
      switching={false}
      onModeChange={ignoreModeChange}
    />
  );
}

/** Row-less mode toggle for hosts that already own their chrome band — Code's
 *  chat-tab strip carries it as that strip's fixed first control. */
export function WorkspaceModeToggle({
  workspace,
}: {
  workspace: Workspace | null;
}) {
  if (workspace) return <OwnedWorkspaceModeToggle workspace={workspace} />;
  return <ActiveWorkspaceModeToggle />;
}

export { useWorkspaceModeSwitch };
