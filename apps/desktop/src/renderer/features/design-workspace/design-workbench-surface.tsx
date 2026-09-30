import {
  DesignCheckoutPause,
  useDesignCheckoutStatus,
} from "./design-checkout-state";
import React, { useCallback, useState } from "react";
import { Frame } from "lucide-react";
import type {
  Workspace,
  DesignWorkspaceSnapshotWire,
} from "../../platform/git";
import { getActiveBridge } from "../../platform/bridge/active-bridge";
import { workspaceOp } from "../../platform/bridge/workspace-bridge";
import { useWorkspaceDispatch } from "../../state/store";
import { useProjectForFolder } from "../../state/use-projects";
import { isLocalMainWorkspace } from "../../state/local-main-workspace";
import {
  designDirectoryTargetKeyForWorkspace,
  markDesignDirectoryTargetExists,
  useDesignDirectoryTarget,
} from "../../state/design-directory-target";
import { Button } from "../../shared/ui/primitives/button";
import { primeDesignWorkspaceSnapshot } from "./state/design-workspace-cache";
import { DesignWorkspaceColumn } from "./design-workspace";
import { errorMessage } from "./design-workspace-error";
import { DesignGitSetup } from "./design-git-setup";

/** Human authoring surface; selecting it has no effect on agent authority. */
export function DesignWorkbenchSurface({
  workspace,
  folder,
  active,
}: {
  workspace: Workspace;
  folder: string;
  active: boolean;
}) {
  const localMain = isLocalMainWorkspace(workspace);
  const key = designDirectoryTargetKeyForWorkspace(workspace.id);
  const target = useDesignDirectoryTarget(localMain ? null : key, {
    enabled: active,
  });
  const checkout = useDesignCheckoutStatus(
    workspace.id,
    workspace.path,
    active && !localMain,
  );
  const refreshTarget = target.refresh;
  const project = useProjectForFolder(folder);
  const dispatch = useWorkspaceDispatch();
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const initialize = useCallback(async () => {
    if (!active || creating) return;
    const bridge = getActiveBridge();
    if (!bridge) return;
    setCreating(true);
    setFailure(null);
    try {
      const { snapshot } = (await workspaceOp(bridge, "design.initialize", {
        workspaceId: workspace.id,
      })) as { snapshot: DesignWorkspaceSnapshotWire };
      primeDesignWorkspaceSnapshot(workspace.id, snapshot);
      markDesignDirectoryTargetExists(key);
      refreshTarget();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setCreating(false);
    }
  }, [active, creating, key, refreshTarget, workspace.id]);

  if (localMain && project?.isGitRepository === false) {
    return (
      <DesignGitSetup key={project.id} project={project} active={active} />
    );
  }

  if (!localMain && checkout.data?.conflicts.length)
    return (
      <DesignCheckoutPause
        workspaceId={workspace.id}
        path={workspace.path}
        status={checkout.data}
        active={active}
        retry={() => {
          checkout.refresh();
          target.refresh();
        }}
      />
    );
  if (!localMain && checkout.data && !checkout.error && target.data?.exists) {
    // The canvas is full bleed; the directory switcher, tools, and the
    // Layers + Inspector panel float over it (see DesignWorkspaceColumn).
    return (
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        data-design-tab-surface=""
      >
        <DesignWorkspaceColumn
          workspace={workspace}
          folder={folder}
          surfaceActive={active}
        />
      </div>
    );
  }
  if (!localMain && target.data?.exists === false) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
        data-design-tab-empty=""
      >
        <Frame className="text-muted-fg size-10" strokeWidth={1} aria-hidden />
        <Button
          variant="secondary"
          size="sm"
          disabled={!active || creating}
          onClick={() => void initialize()}
        >
          {creating ? "Creating…" : "Create design directory"}
        </Button>
        <p className="text-fg2 max-w-sm text-xs">Start designing</p>
        {(failure || target.error || checkout.error) && (
          <p role="alert" className="text-red-fg max-w-lg text-xs">
            {failure ?? errorMessage(target.error ?? checkout.error)}
          </p>
        )}
        {(target.error || checkout.error) && (
          <Button
            variant="ghost"
            size="sm"
            disabled={!active}
            onClick={() => {
              checkout.refresh();
              target.refresh();
            }}
          >
            Retry
          </Button>
        )}
      </div>
    );
  }
  return (
    <div
      className="text-fg2 flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-sm"
      data-design-tab-empty=""
    >
      <p>
        {localMain
          ? "Open a workspace to edit Design."
          : target.loading || checkout.loading
            ? "Checking Design directory…"
            : "Choose a Design directory in repository settings."}
      </p>
      {(failure || target.error || checkout.error) && (
        <p role="alert" className="text-red-fg max-w-lg">
          {failure ?? errorMessage(target.error ?? checkout.error)}
        </p>
      )}
      {project && target.data?.exists !== false && (
        <Button
          variant="ghost"
          disabled={!active || creating}
          onClick={() =>
            dispatch({
              type: "OPEN_REPO_PAGE",
              projectId: project.id,
              view: "design-preferences",
            })
          }
        >
          Design settings
        </Button>
      )}
      {!localMain && (target.error || checkout.error) && (
        <Button
          variant="ghost"
          disabled={!active}
          onClick={() => {
            checkout.refresh();
            target.refresh();
          }}
        >
          Retry
        </Button>
      )}
    </div>
  );
}
