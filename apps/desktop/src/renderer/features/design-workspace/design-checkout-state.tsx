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
import { Button } from "../../shared/ui/primitives/button";
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
  return (
    <div
      className="text-fg2 flex min-w-0 flex-1 flex-col items-start justify-center gap-3 overflow-auto p-4 text-sm"
      data-design-conflict-pause=""
    >
      <p className="text-fg1 font-medium">
        Design is paused while Git conflicts are unresolved.
      </p>
      <p>
        Resolve the listed files and finish the Git operation, or cancel it.
        Then retry Design.
      </p>
      <ul className="max-h-40 max-w-full overflow-auto text-xs">
        {status.conflicts.map((file) => (
          <li key={file} className="break-all">
            {file}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-red-fg">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button disabled={!active || busy} onClick={retry}>
          Retry Design
        </Button>
        {status.operation && (
          <Button
            variant="ghost"
            disabled={!active || busy}
            onClick={() => setConfirm(true)}
          >
            Cancel {status.operation}…
          </Button>
        )}
      </div>
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
    </div>
  );
}
