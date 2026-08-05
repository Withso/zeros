import { useEffect, useState } from "react";

import { gitHasChanges, type Workspace } from "../../platform/git";
import { useGitRefreshKey } from "../use-git-refresh-key";

/** Last probe result per workspace id — survives the hook's unmount/remount
 *  cycle (inactive workbench tabs unmount), so a tab switch renders the last-known
 *  answer instantly instead of flashing the Create-PR button disabled
 *  ("Nothing to PR yet") until the async probe lands. Bounded by the number of
 *  live workspaces. */
const lastKnownHasChanges = new Map<string, boolean>();
const MAX_HAS_CHANGES_WORKSPACES = 128;

function rememberHasChanges(workspaceId: string, value: boolean): void {
  lastKnownHasChanges.delete(workspaceId);
  lastKnownHasChanges.set(workspaceId, value);
  while (lastKnownHasChanges.size > MAX_HAS_CHANGES_WORKSPACES) {
    const oldest = lastKnownHasChanges.keys().next().value as
      | string
      | undefined;
    if (oldest === undefined) break;
    lastKnownHasChanges.delete(oldest);
  }
}

/** Whether the workspace's exact All Changes net comparison is non-empty, as a
 *  TRI-STATE: `true`/`false` once probed, `undefined` while the very first probe
 *  of a workspace is still in flight (so callers can tell "no changes" apart
 *  from "not yet known" — the Dashboard uses this to avoid flashing a
 *  destructive Merge button). Gates the PR row's "Create PR" button and the
 *  Dashboard card's Create-PR / Commit-&-Push action.
 *
 *  Re-probes on the shared git-refresh signal (agent turn-end + git/DB change).
 *  By default it skips probing once a PR exists (the PR row's button is hidden
 *  then); pass `{ probeWithPr: true }` (the Dashboard) to also probe with a PR
 *  so the open-PR "Commit & Push" branch can resolve. The module cache
 *  (`lastKnownHasChanges`) bridges unmount/remount so a re-open renders the
 *  last-known answer instantly instead of a fresh `undefined`. */
export function useWorkspaceHasChanges(
  workspace: Workspace | null,
  active: boolean,
  opts?: { probeWithPr?: boolean },
): boolean | undefined {
  const refreshKey = useGitRefreshKey(workspace?.path, workspace?.id);
  const id = workspace?.id ?? null;
  const prNumber = workspace?.prNumber ?? null;
  const probeWithPr = opts?.probeWithPr ?? false;
  // Skip probing when a PR exists and the caller doesn't need dirtiness-with-PR.
  const skipForPr = prNumber != null && !probeWithPr;
  // Live state carries its workspace id so a workspace switch can never serve
  // another workspace's probe; the module cache covers the remount gap.
  const [live, setLive] = useState<{ id: string; value: boolean } | null>(null);

  useEffect(() => {
    if (!active || !id || skipForPr) return;
    let cancelled = false;
    void gitHasChanges(id)
      .then((v) => {
        rememberHasChanges(id, v);
        if (!cancelled) setLive({ id, value: v });
      })
      .catch(() => {
        // Keep the last-known answer on a failed probe (offline / transient).
        if (!cancelled)
          setLive({ id, value: lastKnownHasChanges.get(id) ?? false });
      });
    return () => {
      cancelled = true;
    };
  }, [active, id, skipForPr, refreshKey]);

  if (!id || skipForPr) return false;
  if (live && live.id === id) return live.value;
  // `undefined` for a never-before-probed workspace (Map.get → undefined);
  // a remembered boolean (incl. false) renders instantly on remount.
  return lastKnownHasChanges.get(id);
}
