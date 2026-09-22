import {
  useDesignWorkspaceUiStore,
  DEFAULT_DESIGN_WORKSPACE_VIEW,
} from "./state/design-workspace-ui";
import {
  DesignCheckoutPause,
  useDesignCheckoutStatus,
} from "./design-checkout-state";
import React, { useCallback, useState } from "react";
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
import { DesignWorkspaceSidebar } from "./design-workspace-sidebar";
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
  const view = useDesignWorkspaceUiStore(
    (state) => state.byWorkspace[workspace.id] ?? DEFAULT_DESIGN_WORKSPACE_VIEW,
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
    return (
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        data-design-tab-surface=""
      >
        <div className="border-border1 flex h-8 shrink-0 items-center justify-end gap-1 border-b px-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={!active}
            aria-pressed={view.layersVisible}
            onClick={() =>
              useDesignWorkspaceUiStore
                .getState()
                .setPanels(workspace.id, { layersVisible: !view.layersVisible })
            }
          >
            Layers
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!active}
            aria-pressed={view.inspectorVisible}
            onClick={() =>
              useDesignWorkspaceUiStore
                .getState()
                .setPanels(workspace.id, {
                  inspectorVisible: !view.inspectorVisible,
                })
            }
          >
            Inspector
          </Button>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {view.layersVisible && (
            <DesignWorkspaceSidebar
              workspace={workspace}
              folder={folder}
              surfaceActive={active}
            />
          )}
          <DesignWorkspaceColumn
            workspace={workspace}
            folder={folder}
            surfaceActive={active}
            inspectorVisible={view.inspectorVisible}
          />
        </div>
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
          : target.data?.exists === false
            ? `Create ${target.data.directory} to start designing in this workspace.`
            : target.loading || checkout.loading
              ? "Checking Design directory…"
              : "Choose a Design directory in repository settings."}
      </p>
      {(failure || target.error || checkout.error) && (
        <p role="alert" className="text-red-fg max-w-lg">
          {failure ?? errorMessage(target.error ?? checkout.error)}
        </p>
      )}
      {!localMain && target.data?.exists === false && (
        <Button
          disabled={!active || creating}
          onClick={() => void initialize()}
        >
          {creating ? "Creating…" : "Create design directory"}
        </Button>
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
