import React, { useEffect, useState } from "react";
import { Archive, FolderX } from "lucide-react";
import { Button } from "../shared/ui/primitives";
import {
  type Workspace,
  dialogPickFolder,
  workspaceGet,
  workspaceLocate,
  workspaceRecover,
  workspaceRestore,
} from "../platform/git";
import { useCachedRead } from "../state/use-cached-read";
import {
  workspaceRecoveryCache,
  workspaceRecoveryKey,
  readWorkspaceRecovery,
  RECOVERY_MAX_AGE_MS,
} from "../state/workspace-recovery-cache";
import { workspaceHistoryBanner } from "../state/workspace-history";
import {
  commitConfirmedRestore,
  commitConfirmedRestoreWithFeedback,
} from "../state/archive-actions";
import { notifyWorkspacesChanged } from "../state/use-projects";

export function WorkspaceHistoryBar({
  workspace,
  surfaceActive = true,
}: {
  workspace: Workspace;
  surfaceActive?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recoveryKey = workspaceRecoveryKey(workspace);
  const recovery = useCachedRead(
    workspaceRecoveryCache,
    recoveryKey,
    readWorkspaceRecovery,
    { maxAgeMs: RECOVERY_MAX_AGE_MS, enabled: surfaceActive },
  );
  const banner = workspaceHistoryBanner(workspace, recovery.data);
  useEffect(() => {
    if (!surfaceActive) return;
    let inFlight = false;
    let cancelled = false;
    let lastSourceCheck = Date.now();
    const check = async () => {
      if (document.visibilityState === "hidden" || busy || inFlight) return;
      inFlight = true;
      try {
        const current = await workspaceGet(workspace.id);
        if (
          !cancelled &&
          current.present !== false &&
          current.archivedAt == null
        ) {
          commitConfirmedRestore(workspace, {
            workspace: current,
            path: current.path,
            branch: current.branch,
            restoredAt: current.lastActiveAt ?? Date.now(),
            conflicts: [],
            adaptations: [],
          });
        }
        if (!cancelled && Date.now() - lastSourceCheck >= 30_000) {
          lastSourceCheck = Date.now();
          if (recoveryKey) workspaceRecoveryCache.invalidate(recoveryKey);
        }
      } catch {
        /* Keep the confirmed state while the engine is unavailable. */
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void check(), 2500);
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [workspace, busy, recoveryKey, surfaceActive]);
  const act = async () => {
    if (!surfaceActive || busy || !banner.action) return;
    setBusy(true);
    setError(null);
    try {
      let result;
      if (banner.action === "Locate") {
        const folder = await dialogPickFolder({
          title: "Locate the original workspace folder",
          defaultPath: workspace.path,
        });
        if (!folder) return;
        result = await workspaceLocate({
          workspaceId: workspace.id,
          path: folder,
        });
      } else {
        result = await (
          banner.action === "Unarchive" ? workspaceRestore : workspaceRecover
        )({ workspaceId: workspace.id });
      }
      const restored = result.workspace ?? (await workspaceGet(workspace.id));
      if (restored.present === false || restored.archivedAt != null)
        throw new Error("The workspace is still unavailable.");
      commitConfirmedRestoreWithFeedback(workspace, {
        ...result,
        workspace: restored,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      if (recoveryKey) workspaceRecoveryCache.invalidate(recoveryKey);
      notifyWorkspacesChanged(workspace.repoSlug);
    } finally {
      setBusy(false);
    }
  };
  const Icon = workspace.archivedAt == null ? FolderX : Archive;
  return (
    <div className="mx-auto w-full max-w-[1152px] shrink-0 px-7 pt-2 pb-4">
      <div
        className="border-border1 bg-bg2 flex items-center gap-3 rounded-lg border px-4 py-3"
        role="status"
      >
        <Icon className="text-fg2 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-fg2 text-sm">{banner.message}</p>
          {recovery.data?.action === "restore" &&
            recovery.data.snapshotAt != null && (
              <p className="text-fg3 mt-1 text-xs">
                Saved {new Date(recovery.data.snapshotAt).toLocaleString()}.
                Later changes may be unavailable.
              </p>
            )}
          {(error || recovery.error) && (
            <p role="alert" className="text-red-fg mt-1 text-xs">
              {error ?? "Couldn't check workspace recovery."}
            </p>
          )}
        </div>
        {banner.action && (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void act()}
          >
            {busy ? "Working…" : banner.action}
          </Button>
        )}
      </div>
    </div>
  );
}
