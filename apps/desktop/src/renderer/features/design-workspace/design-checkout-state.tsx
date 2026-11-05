import { readDesignCheckoutStatus } from "../../platform/bridge/design-context-bridge";
import React, { useEffect, useState } from "react";
import type { DesignCheckoutStatus } from "@zeros/protocol/design-context";
import { getActiveBridge } from "../../platform/bridge/active-bridge";
import { workspaceOp } from "../../platform/bridge/workspace-bridge";
import { designCheckoutStatusCache } from "../../state/read-caches";
import { useCachedRead } from "../../state/use-cached-read";
import {
  useGitRefreshKey,
  triggerGitRefresh,
} from "../../shell/use-git-refresh-key";
import { ChevronRight, CirclePause, File } from "lucide-react";
import { Button } from "../../shared/ui/primitives/button";
import { EmptyState } from "../../shared/ui/layout/empty-state";
import { openFilePill, warmFilePill } from "../../shell/workbench/file-pill-navigation";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../shared/ui/primitives/dialog";
import { errorMessage } from "./design-workspace-error";

export function useDesignCheckoutStatus(
  workspaceId: string,
  path: string,
  active: boolean,
) {
  const version = useGitRefreshKey(path, workspaceId, active);
  const key = JSON.stringify([workspaceId, path]);
  useEffect(() => {
    if (active) designCheckoutStatusCache.invalidate(key);
  }, [active, key, version]);
  return useCachedRead(
    designCheckoutStatusCache,
    key,
    async (requestedKey) => {
      const [id] = JSON.parse(requestedKey) as [string, string];
      const bridge = getActiveBridge();
      if (!bridge) throw new Error("Not connected to the Zeros engine yet.");
      return readDesignCheckoutStatus(bridge, id);
    },
    { enabled: active, maxAgeMs: 10_000 },
  );
}

export function DesignCheckoutPause({
  workspaceId,
  path,
  status,
  active,
  retry,
}: {
  workspaceId: string;
  path: string;
  status: DesignCheckoutStatus;
  active: boolean;
  retry: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = async () => {
    if (!active || busy) return;
    const bridge = getActiveBridge();
    if (!bridge) return;
    setBusy(true);
    try {
      await workspaceOp(bridge, "git.abort", { workspaceId });
      setConfirm(false);
      triggerGitRefresh(path);
      retry();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  // The empty-state recipe with the conflicted files in one quiet card; each
  // opens in Changes, where the conflict blocks resolve Code and Design alike.
  return (
    <>
    <EmptyState
      icon={CirclePause}
      title="Design is paused"
      data-design-conflict-pause=""
      className="overflow-auto py-6"
      detail={
        <ul
          className="border-border2 bg-sidebar-bg m-0 mt-1 w-full max-w-105 list-none overflow-y-auto rounded-lg border p-0 text-left max-h-72"
          data-design-conflict-files=""
        >
          {status.conflicts.map((file) => (
            <li key={file} className="border-border1 [&+&]:border-t">
              <ConflictFileRow
                file={file}
                path={path}
                active={active}
              />
            </li>
          ))}
        </ul>
      }
      error={error ? `Couldn’t cancel: ${error}` : null}
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button disabled={!active || busy} onClick={retry}>
            Retry
          </Button>
          {status.operation && (
            <Button
              variant="ghost"
              className="text-fg2"
              disabled={!active || busy}
              onClick={() => setConfirm(true)}
            >
              Cancel {status.operation}…
            </Button>
          )}
        </div>
      }
    >
      {status.operation
        ? `Resolve these files, then finish or cancel the ${status.operation}.`
        : "Resolve these files, then retry."}
    </EmptyState>
      <Dialog open={active && confirm} onOpenChange={setConfirm}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel {status.operation}?</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogDescription>
              Git will return to the state before this operation. Conflict
              resolutions made during it may be discarded.
            </DialogDescription>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              Keep working
            </Button>
            <Button disabled={busy} onClick={() => void abort()}>
              Cancel operation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** One conflicted file: its folder in fg3, then its name, opening in Changes.
 *  Intent warms the diff so the click does not wait. */
function ConflictFileRow({
  file,
  path,
  active,
}: {
  file: string;
  path: string;
  active: boolean;
}) {
  const slash = file.lastIndexOf("/");
  const folder = slash >= 0 ? file.slice(0, slash + 1) : "";
  const name = file.slice(slash + 1);
  const warm = () => {
    if (active) warmFilePill(path, file, "changes");
  };
  return (
    <Button
      type="button"
      variant="ghost"
      title={file}
      aria-label={`Open ${file} in Changes`}
      disabled={!active}
      onPointerEnter={warm}
      onFocus={warm}
      onClick={() => openFilePill(path, file, "changes")}
      className="hover:bg-sidebar-bg-hover text-fg1 h-9 w-full min-w-0 justify-start gap-2 rounded-none pr-2.5 pl-3 font-normal"
    >
      <File className="text-fg3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">
        {folder ? <span className="text-fg3">{folder}</span> : null}
        {name}
      </span>
      <ChevronRight className="text-fg3 shrink-0" aria-hidden="true" />
    </Button>
  );
}
