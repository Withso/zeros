import React, { useState } from "react";
import { ChevronDown, Check, Settings } from "lucide-react";
import type { Workspace } from "../../platform/git";
import { getActiveBridge } from "../../platform/bridge/active-bridge";
import { bridgeDesignListDirectories } from "../../platform/bridge/design-bridge";
import { workspaceOp } from "../../platform/bridge/workspace-bridge";
import { useCachedRead } from "../../state/use-cached-read";
import {
  designDirectoryListingCache,
  invalidateDesignDirectoryTargetReadCache,
} from "../../state/read-caches";
import { useWorkspaceDispatch } from "../../state/store";
import { useProjectForFolder } from "../../state/use-projects";
import { Button, toast } from "../../shared/ui/primitives";
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
import { errorMessage } from "./design-workspace-error";

/** Selecting a directory changes only this workspace's personal pointer.
 * Rename/adoption remain explicit repository lifecycle actions in Settings. */
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
    if (!active || busy || directory === name) return;
    const bridge = getActiveBridge();
    if (!bridge) return;
    setBusy(true);
    try {
      await waitForPendingDesignEdits(workspace.id);
      await workspaceOp(bridge, "settings.write", {
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
      toast.error("Couldn't open Design directory", {
        description: errorMessage(error),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <DropdownMenu open={active && open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          disabled={!active || busy}
          className="min-w-0 flex-1 justify-between px-0"
          aria-label="Choose Design directory"
        >
          <span data-design-directory-name="" className="truncate" title={name}>
            {name}
          </span>
          <ChevronDown className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
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
            onSelect={() =>
              void choose(directory, listing.data?.directoryIds?.[directory])
            }
          >
            <span className="truncate">{directory}</span>
            {directory === name && <Check className="size-3" />}
          </DropdownMenuItem>
        ))}
        {project && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                dispatch({
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
  );
}
