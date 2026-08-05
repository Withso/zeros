// Setup-script status for the chat's provenance row.
//
// Answers exactly two questions — "is a setup script configured for this
// workspace?" and "how did its last run end?" — which together pick one of the
// three lines the empty chat shows:
//
//   hasCommand === false   → "Configure setup script"
//   state === "running"    → "Setup script is running"   (spinner)
//   otherwise              → "Completed setup script"
//
// Sibling of useSetupStatus in shell/workbench/tabs/terminal-tab.tsx, which
// drives the Setup tab's off-tab dot. They are deliberately NOT merged: that
// one pulls with `statusOnly` (it needs only the state enum and refires on
// every workspaces broadcast) and carries the unseen-result bookkeeping the dot
// needs. This one additionally needs `hasCommand` — the "not configured" case
// is not a SetupState, it's the absence of a command — and has no dot to track.
//
// Treated as keyed server state per the repo's bridge rules: the last confirmed
// snapshot for THIS workspace is retained while a refresh is in flight, and a
// workspace switch never shows the previous workspace's answer.

import { useEffect, useState } from "react";

import { workspaceSetupInfo } from "../../platform/git";
import { useBridge } from "../../platform/bridge/use-bridge";
import type { Workspace } from "../../platform/git";

export interface WorkspaceSetupSummary {
  /** Null until the first read lands — callers must render nothing rather than
   *  flash "Configure setup script" at a workspace that has one. */
  hasCommand: boolean | null;
  state: Workspace["setupState"];
}

const EMPTY: WorkspaceSetupSummary = { hasCommand: null, state: null };

export function useWorkspaceSetupSummary(
  workspaceId: string | null,
  /** The trunk / "main" synthetic workspace has no engine row, so the engine
   *  needs the repo root to resolve its setup command. Undefined for a real
   *  worktree. */
  repoRoot?: string,
): WorkspaceSetupSummary {
  // Key the snapshot by the workspace it describes. Without this, switching
  // workspaces would render the previous one's answer for a frame — and
  // "Completed setup script" for the wrong workspace is a lie, not a stale
  // pixel.
  const [snapshot, setSnapshot] = useState<{
    workspaceId: string;
    value: WorkspaceSetupSummary;
  } | null>(null);

  const bridge = useBridge();

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    // Monotonic pull token: DB_CHANGED fires back-to-back across a setup
    // transition (running → passed) and the responses can resolve out of
    // order. Only the LATEST issued pull may commit, or the row sticks on
    // "Setup script is running" after the run finished.
    let pullGen = 0;
    const pull = async () => {
      const gen = ++pullGen;
      try {
        // omitLog: this row needs hasCommand (statusOnly reports it as a
        // placeholder `false`, which would read as "no setup configured") but
        // never renders output — and it re-pulls on every workspaces
        // broadcast, so shipping the log would drag up to 512 KB per pull.
        const next = await workspaceSetupInfo({
          workspaceId,
          repoRoot,
          omitLog: true,
        });
        if (cancelled || gen !== pullGen) return;
        setSnapshot({
          workspaceId,
          value: { hasCommand: next.hasCommand, state: next.state },
        });
      } catch {
        /* bridge not ready / transient — keep the last confirmed snapshot */
      }
    };
    void pull();
    const off = bridge?.on("DB_CHANGED", (msg) => {
      const change = msg as { kinds?: unknown; workspaceIds?: unknown };
      if (!Array.isArray(change.kinds) || !change.kinds.includes("workspaces"))
        return;
      const ids = Array.isArray(change.workspaceIds)
        ? change.workspaceIds.filter((id): id is string => typeof id === "string")
        : [];
      // A broadcast scoped to OTHER workspaces can't change this one's answer.
      // An unscoped broadcast (ids empty) always re-pulls.
      if (ids.length > 0 && !ids.includes(workspaceId)) return;
      void pull();
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [workspaceId, repoRoot, bridge]);

  if (!workspaceId) return EMPTY;
  return snapshot?.workspaceId === workspaceId ? snapshot.value : EMPTY;
}
