// ──────────────────────────────────────────────────────────
// useRunStatuses — live per-action run states for the Run sub-tabs
// ──────────────────────────────────────────────────────────
//
// The Run counterpart of the Setup tab's status poller (useSetupStatus in
// terminal-tab.tsx): fetched from `workspace.runInfo` on mount / workspace
// switch, then re-pulled on every DB_CHANGED{workspaces} broadcast — the
// engine's RunManager fires one for each run transition (running / finished /
// failed / stopped). Statuses key by actionId and merge the engine's live
// in-memory runs over the workspace's durable last-run rows, so a verdict
// survives an app restart (the trunk / `local:` workspace is in-memory only).

import { useEffect, useMemo, useState } from "react";
import { runSessionId, type RunAction } from "@zeros/core/run-actions";

import {
  workspaceRunInfo,
  type Workspace,
  type WorkspaceRunActionStatus,
} from "../../native/git";
import { isLocalMainWorkspace } from "../../zeros/store/local-main-workspace";
import { useBridge } from "../../zeros/bridge/use-bridge";

export type RunStatusMap = Record<string, WorkspaceRunActionStatus>;

export interface RunStatusesSnapshot {
  statuses: RunStatusMap;
  /** Whether `statuses` is an ANSWER rather than a not-read-yet placeholder.
   *  The map reads `{}` in both cases — an action that has never run has no
   *  durable row, so an empty map is a perfectly ordinary "nothing running" —
   *  which makes the two indistinguishable to a caller. Anything that acts on
   *  the NEGATIVE ("no run is live here") must wait for this; a caller that
   *  only reacts to a positive can ignore it. */
  ready: boolean;
}

const EMPTY_RUN_STATUSES: RunStatusMap = {};
const runStatusCache = new Map<string, RunStatusMap>();
const MAX_RUN_STATUS_SNAPSHOTS = 64;

function cacheRunStatuses(key: string, statuses: RunStatusMap): void {
  runStatusCache.delete(key);
  runStatusCache.set(key, statuses);
  while (runStatusCache.size > MAX_RUN_STATUS_SNAPSHOTS) {
    const oldest = runStatusCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    runStatusCache.delete(oldest);
  }
}

export function useRunStatuses(
  workspace: Workspace | null,
  folderKey: string,
  actions: RunAction[],
): RunStatusesSnapshot {
  const workspaceId = workspace?.id ?? null;
  const repoRoot =
    workspace && isLocalMainWorkspace(workspace)
      ? workspace.repoRoot
      : undefined;
  // Stable key so the effect doesn't refire on every render (actions is a
  // fresh array each resolve).
  const actionIdsKey = useMemo(
    () => actions.map((a) => a.id).join("\n"),
    [actions],
  );
  const cacheKey = JSON.stringify([workspaceId, folderKey, actionIdsKey]);
  const bridge = useBridge();
  // Associates each completion with its workspace/actions generation so a
  // context switch can paint the last confirmed badges immediately.
  const [snapshot, setSnapshot] = useState<{
    key: string;
    statuses: RunStatusMap;
  }>(() => ({
    key: cacheKey,
    statuses: runStatusCache.get(cacheKey) ?? EMPTY_RUN_STATUSES,
  }));
  useEffect(() => {
    const actionIds = actionIdsKey ? actionIdsKey.split("\n") : [];
    if (!workspaceId || !folderKey || actionIds.length === 0) return;
    let cancelled = false;
    // Monotonic pull token: DB_CHANGED can fire back-to-back (running → then
    // finished) and responses may resolve out of order — only the LATEST
    // issued pull may commit, or a tab could stick on a stale "running".
    let pullGen = 0;
    const sessionIds = actionIds.map((id) => runSessionId(folderKey, id));
    const pull = async () => {
      const gen = ++pullGen;
      try {
        const res = await workspaceRunInfo({
          workspaceId,
          repoRoot,
          sessionIds,
        });
        if (!cancelled && gen === pullGen) {
          cacheRunStatuses(cacheKey, res.actions);
          setSnapshot({ key: cacheKey, statuses: res.actions });
        }
      } catch {
        /* bridge not ready / transient — keep what we have */
      }
    };
    void pull();
    const off = bridge?.on("DB_CHANGED", (msg) => {
      const change = msg as { kinds?: unknown; workspaceIds?: unknown };
      const kinds = change.kinds;
      if (!Array.isArray(kinds) || !kinds.includes("workspaces")) return;
      const workspaceIds = Array.isArray(change.workspaceIds)
        ? change.workspaceIds.filter(
            (id): id is string => typeof id === "string",
          )
        : [];
      if (workspaceIds.length > 0 && !workspaceIds.includes(workspaceId))
        return;
      void pull();
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [workspaceId, repoRoot, folderKey, actionIdsKey, cacheKey, bridge]);
  if (!workspaceId || !folderKey) {
    return { statuses: EMPTY_RUN_STATUSES, ready: false };
  }
  // A repo that defines NO run actions is an answer, not a pending read — the
  // effect above never pulls, and nothing can be running.
  if (!actionIdsKey) return { statuses: EMPTY_RUN_STATUSES, ready: true };
  // The cache is written only by a resolved pull (cacheRunStatuses, called
  // immediately before setSnapshot), so its membership IS the readiness bit —
  // including for a remount that inherits a previous mount's answer. Eviction
  // at the retention bound can flip it back to false, which only ever
  // suppresses a negative until the next pull.
  return {
    statuses:
      snapshot.key === cacheKey
        ? snapshot.statuses
        : (runStatusCache.get(cacheKey) ?? EMPTY_RUN_STATUSES),
    ready: runStatusCache.has(cacheKey),
  };
}
