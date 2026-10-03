import { useEffect, useState } from "react";

import { gitHasChanges, type Workspace } from "../../platform/git";
import { LatestGenerationFlight } from "../../shared/lib/latest-generation-flight";
import { useGitRefreshKey } from "../use-git-refresh-key";

/** Last probe result per workspace id — survives the hook's unmount/remount
 *  cycle (inactive workbench tabs unmount), so a tab switch renders the last-known
 *  answer instantly instead of flashing the Create-PR button disabled
 *  ("Nothing to PR yet") until the async probe lands. Bounded by the number of
 *  live workspaces. */
const lastKnownHasChanges = new Map<string, boolean>();
const MAX_HAS_CHANGES_WORKSPACES = 128;
// Agent edits can invalidate faster than Git answers. Share each read across
// PR surfaces and retain only the latest follow-up for that exact workspace.
const hasChangesRequests = new LatestGenerationFlight<boolean>();

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
  const id = workspace?.id ?? null;
  const prNumber = workspace?.prNumber ?? null;
  const probeWithPr = opts?.probeWithPr ?? false;
  // Skip probing when a PR exists and the caller doesn't need dirtiness-with-PR.
  const skipForPr = prNumber != null && !probeWithPr;
  const refreshKey = useGitRefreshKey(
    workspace?.path,
    id,
    active && !skipForPr,
  );
  // Live state carries its workspace id so a workspace switch can never serve
  // another workspace's probe; the module cache covers the remount gap.
  const [live, setLive] = useState<{ id: string; value: boolean } | null>(null);

  useEffect(() => {
    if (!active || !id || skipForPr) return;
    let cancelled = false;
    void hasChangesRequests
      .run(id, refreshKey, () => gitHasChanges(id))
      .then((v) => {
        if (cancelled) return;
        rememberHasChanges(id, v);
        setLive((current) =>
          current?.id === id && current.value === v
            ? current
            : { id, value: v },
        );
      })
      .catch(() => {
        // Failure is not a confirmed clean tree. Preserve the last exact-key
        // result, including undefined when the first read has not succeeded.
        // Another surface may have confirmed a newer answer while this one
        // was retained but inactive; prefer that over its older local state.
        const confirmed = lastKnownHasChanges.get(id);
        if (cancelled || confirmed === undefined) return;
        setLive((current) =>
          current?.id === id && current.value === confirmed
            ? current
            : { id, value: confirmed },
        );
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
