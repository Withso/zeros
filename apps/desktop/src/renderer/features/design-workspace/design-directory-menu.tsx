import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Check, Folder, Settings } from "lucide-react";
import type { Workspace } from "../../platform/git";
import { getActiveBridge } from "../../platform/bridge/active-bridge";
import { bridgeCloudDesignSelectDirectory, bridgeDesignListDirectories } from "../../platform/bridge/design-bridge";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle, DialogDescription } from "../../shared/ui/primitives/dialog";
import { CloudDesignDirectories } from "./cloud-design-directories";
import { useCloudDesignManagement } from "./use-cloud-design-management";
import { workspaceOp } from "../../platform/bridge/workspace-bridge";
import { useCachedRead } from "../../state/use-cached-read";
import {
  designDirectoryListingCache,
  invalidateDesignDirectoryTargetReadCache,
} from "../../state/read-caches";
import { useWorkspaceDispatch } from "../../state/store";
import { useProjectForFolder } from "../../state/use-projects";
import { Tooltip } from "../../shared/ui/primitives";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import {
  invalidateDesignWorkspaceSnapshot,
  waitForPendingDesignEdits,
} from "./state/design-workspace-cache";
import { triggerGitRefresh } from "../../shell/use-git-refresh-key";
import { reportDesignDirectoryFailure } from "./design-directory-failure";

/** Selecting a directory changes only this workspace's personal pointer.
 * Rename/adoption remain explicit repository lifecycle actions in Settings.
 * The trigger lives in the canvas's floating directory pill. */
export function DesignDirectoryMenu({
  workspace,
  active,
  name,
}: {
  workspace: Workspace;
  active: boolean;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [managing, setManaging] = useState(false);
  const cloud = isCloudWorkspace(workspace.id);
  const cloudCanManage = useCloudDesignManagement(workspace.id, active);
  const canManage = !cloud || cloudCanManage;
  const latest = useRef({ id: workspace.id, active, canManage });
  latest.current = { id: workspace.id, active, canManage };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const project = useProjectForFolder(workspace.path);
  const dispatch = useWorkspaceDispatch();
  const listing = useCachedRead(
    designDirectoryListingCache,
    workspace.id,
    async (id) => {
      const bridge = getActiveBridge();
      if (!bridge) throw new Error("Not connected to the Zeros engine yet.");
      return bridgeDesignListDirectories(bridge, id);
    },
    { enabled: active && open, maxAgeMs: 10_000 },
  );
  const choose = async (directory: string, directoryId?: string) => {
    if (!active || !canManage || busy || directory === name || !listing.data || listing.error) return;
    const bridge = getActiveBridge();
    if (!bridge) return;
    setBusy(true);
    try {
      await waitForPendingDesignEdits(workspace.id);
      if (cloud && (!mounted.current || latest.current.id !== workspace.id || !latest.current.active || !latest.current.canManage)) return;
      if (cloud) {
        if (!directoryId) throw new Error("Refresh the directory list before switching.");
        await bridgeCloudDesignSelectDirectory(bridge, workspace.id, directoryId, listing.data.directoryIds?.[listing.data.active] ?? null);
      } else await workspaceOp(bridge, "settings.write", {
        layer: "workspace-local",
        repoRoot: workspace.path,
        patch: {
          design: directoryId
            ? { directory_id: directoryId, directory: null }
            : { directory, directory_id: null },
        },
        confirmDesignDirectoryChange: true,
      });
      invalidateDesignWorkspaceSnapshot(workspace.id);
      invalidateDesignDirectoryTargetReadCache();
      triggerGitRefresh(workspace.path);
    } catch (error) {
      reportDesignDirectoryFailure(workspace.id, "open", error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <><DropdownMenu open={active && open} onOpenChange={setOpen}>
      <Tooltip label="Switch Design directory" side="bottom">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={!active || busy}
            className="zd-design-directory-trigger"
            aria-label="Choose Design directory"
          >
            <Folder aria-hidden="true" />
            <span data-design-directory-name="" className="min-w-0 truncate">
              {name}
            </span>
            <ChevronDown aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start" className="max-w-sm">
        {listing.error && (
          <DropdownMenuItem onSelect={listing.refresh}>
            Couldn't load directories — Retry
          </DropdownMenuItem>
        )}
        {listing.loading && (
          <DropdownMenuItem disabled>Loading directories…</DropdownMenuItem>
        )}
        {listing.data?.directories.map((directory) => (
          <DropdownMenuItem
            key={directory}
            disabled={!canManage || busy || !!listing.error}
            onSelect={() =>
              void choose(directory, listing.data?.directoryIds?.[directory])
            }
          >
            <span className="truncate">{directory}</span>
            {directory === name && <Check className="size-3" />}
          </DropdownMenuItem>
        ))}
        {canManage && (cloud || project) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                cloud ? setManaging(true) : project && dispatch({
                  type: "OPEN_REPO_PAGE",
                  projectId: project.id,
                  view: "design-preferences",
                })
              }
            >
              <Settings className="size-3" />
              Manage directories…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
    {cloud && <Dialog open={active && managing && canManage} onOpenChange={setManaging}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Design directories</DialogTitle><DialogDescription>Manage folders in this cloud workspace.</DialogDescription></DialogHeader>
        <DialogBody><CloudDesignDirectories key={workspace.id} workspaceId={workspace.id} active={active && managing && canManage} /></DialogBody>
      </DialogContent>
    </Dialog>}</>
  );
}
