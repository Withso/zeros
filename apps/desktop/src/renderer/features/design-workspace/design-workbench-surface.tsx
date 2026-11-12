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
import { useProjectForFolder } from "../../state/use-projects";
import { isLocalMainWorkspace } from "../../state/local-main-workspace";
import {
  designDirectoryTargetKeyForWorkspace,
  markDesignDirectoryTargetExists,
  useDesignDirectoryTarget,
  fetchDesignDirectoryTarget,
} from "../../state/design-directory-target";
import {
  designDirectoryTargetCache,
  designCheckoutStatusCache,
} from "../../state/read-caches";
import { readDesignCheckoutStatus } from "../../platform/bridge/design-context-bridge";
import {
  WorkbenchEmptyState,
  useWorkbenchStatusSource,
} from "../../shell/workbench/tab-status";
import { Button } from "../../shared/ui/primitives/button";
import { EmptyState } from "../../shared/ui/layout/empty-state";
import { ZerosSpinner } from "../../shared/ui/loading/zeros-spinner";
import { primeDesignWorkspaceSnapshot } from "./state/design-workspace-cache";
import { DesignWorkspaceColumn } from "./design-workspace";
import { useOpenFileInWorkbench } from "../../shell/workbench/use-open-file";
import { reportDesignDirectoryFailure } from "./design-directory-failure";
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
  const [creating, setCreating] = useState(false);
  // A components/ file has no frame to select; its source opens in Files.
  const openFile = useOpenFileInWorkbench();
  const loadError = target.error ?? checkout.error;
  useWorkbenchStatusSource(
    {
      error: loadError,
      pending:
        !localMain &&
        (target.loading ||
          target.refreshing ||
          checkout.loading ||
          checkout.refreshing),
      primary: true,
      // A confirmed empty directory is content too: retain its start surface
      // through transient lookup/connection failures, just like the canvas.
      hasContent: target.data !== undefined && !!checkout.data,
      retry: async () => {
        const bridge = getActiveBridge();
        if (!bridge || localMain) return;
        await Promise.allSettled([
          designDirectoryTargetCache.load(
            key,
            () => fetchDesignDirectoryTarget(key),
            { force: true },
          ),
          designCheckoutStatusCache.load(
            JSON.stringify([workspace.id, workspace.path]),
            () => readDesignCheckoutStatus(bridge, workspace.id),
            { force: true },
          ),
        ]);
      },
    },
    key,
  );
  const initialize = useCallback(async () => {
    if (!active || creating) return;
    const bridge = getActiveBridge();
    if (!bridge) return;
    setCreating(true);
    try {
      const { snapshot } = (await workspaceOp(bridge, "design.initialize", {
        workspaceId: workspace.id,
      })) as { snapshot: DesignWorkspaceSnapshotWire };
      primeDesignWorkspaceSnapshot(workspace.id, snapshot);
      markDesignDirectoryTargetExists(key);
      refreshTarget();
    } catch (error) {
      reportDesignDirectoryFailure(workspace.id, "create", error);
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
  if (!localMain && checkout.data && target.data?.exists) {
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
          onOpenFile={openFile}
        />
      </div>
    );
  }
  if (!localMain && target.data?.exists === false) {
    // Create is the one primary action; while it runs it keeps its place
    // and shows the spinner.
    return (
      <EmptyState
        icon={Frame}
        title="Design"
        data-design-tab-empty=""
        action={
          <Button
            variant="primary"
            loading={creating}
            disabled={!active}
            aria-label="Create design directory"
            onClick={() => void initialize()}
          >
            {creating ? "Creating…" : "Create design directory"}
          </Button>
        }
      >
        Start designing
      </EmptyState>
    );
  }
  if (loadError && (target.data === undefined || checkout.data === undefined))
    return <WorkbenchEmptyState type="design" />;
  // Checking is one quiet line with the spinner; the rest are the shared
  // empty state.
  if (!localMain && (target.data !== null || target.loading || checkout.loading))
    return (
      <div
        className="text-fg2 flex min-h-0 flex-1 items-center justify-center gap-2 p-4 text-xs leading-4.5"
        data-design-tab-empty=""
      >
        <ZerosSpinner size={16} />
        <p className="m-0">Checking Design directory…</p>
      </div>
    );
  return (
    <EmptyState icon={Frame} data-design-tab-empty="">
      {localMain ? "Open a workspace to edit Design." : "No Design directory available."}
    </EmptyState>
  );
}
