// ──────────────────────────────────────────────────────────
// useWorkspaceChangeLines — the ± line pair a workspace tab shows
// ──────────────────────────────────────────────────────────
//
// Every visible tab reads its OWN workspace, not just the active one, so this
// is keyed server state end to end:
//
//   • one in-flight request per (workspace, refresh generation), shared by any
//     surface that asks for the same pair — the same coalescing the Changes
//     badge uses for its file totals;
//   • the last confirmed pair is remembered per workspace across unmounts, so
//     a repository switch renders the known numbers immediately instead of
//     blanking and re-probing;
//   • a failed refresh keeps the last confirmed pair. A transient bridge or
//     Git fault is not evidence that a workspace went clean.
//
// Revalidation rides the shared Git refresh bus (use-git-refresh-key), which
// already covers a background workspace: it bumps on the engine's scoped
// DB_CHANGED, on any chat's agent finishing a turn in that folder, and on
// renderer-side writes that bypass the bridge.

import { useEffect, useState } from "react";

import {
  gitChangeLineCounts,
  type ChangeLineCounts,
  type Workspace,
} from "../native/git";
import { isLocalMainWorkspace } from "../zeros/store/local-main-workspace";
import { useGitRefreshKey } from "./use-git-refresh-key";

/** The shared "nothing to show" value. Frozen and module-level so a tab that
 *  has no numbers never re-renders on a fresh object identity. */
export const NO_CHANGE_LINES: ChangeLineCounts = Object.freeze({
  additions: 0,
  deletions: 0,
});

// Bounded by the number of workspaces a session realistically visits; the
// oldest entry is dropped once the bound is reached (insertion order is the
// LRU queue, refreshed on every write).
export const MAX_REMEMBERED_CHANGE_LINE_WORKSPACES = 128;
const lastKnownChangeLines = new Map<string, ChangeLineCounts>();

/** Record a target's last CONFIRMED pair and return the CANONICAL object for
 *  it. Only a successful read may call this — a failed refresh must leave the
 *  previous answer standing.
 *
 *  An unchanged pair keeps its previous identity, which is what lets a tab sit
 *  out the re-render: every Git refresh generation re-reads every visible
 *  workspace, and almost none of them have actually moved. */
export function rememberChangeLines(
  target: string,
  counts: ChangeLineCounts,
): ChangeLineCounts {
  const previous = lastKnownChangeLines.get(target);
  const canonical =
    previous &&
    previous.additions === counts.additions &&
    previous.deletions === counts.deletions
      ? previous
      : counts;
  lastKnownChangeLines.delete(target);
  lastKnownChangeLines.set(target, canonical);
  while (lastKnownChangeLines.size > MAX_REMEMBERED_CHANGE_LINE_WORKSPACES) {
    const oldest = lastKnownChangeLines.keys().next().value as
      | string
      | undefined;
    if (oldest === undefined) break;
    lastKnownChangeLines.delete(oldest);
  }
  return canonical;
}

/** The last confirmed pair for a target, or the shared zero pair when that
 *  target has never resolved (or was evicted). Never allocates. */
export function lastConfirmedChangeLines(
  target: string | null,
): ChangeLineCounts {
  if (!target) return NO_CHANGE_LINES;
  return lastKnownChangeLines.get(target) ?? NO_CHANGE_LINES;
}

// In-flight deduplication only — the entry is dropped the moment it settles,
// so this is never a stale cache. Two surfaces asking for the same workspace
// in one refresh generation share a single engine round-trip.
const changeLineRequests = new Map<string, Promise<ChangeLineCounts>>();

/** The strip probes EVERY visible workspace, and one probe costs the engine
 *  several Git subprocesses. A cold start, and any coarse refresh (a bridge
 *  reconnect invalidates every scope at once), would otherwise fire all of
 *  them in a single beat. Reads run a few at a time instead and the rest drain
 *  as slots free; a workspace's badge lands a few hundred milliseconds later
 *  at worst, which is invisible next to the spawn storm it replaces. */
export const MAX_CONCURRENT_CHANGE_LINE_READS = 4;
let activeChangeLineReads = 0;
const waitingChangeLineReads: Array<() => void> = [];

/** Resolves once a read slot is free. Never rejects, so the paired release in
 *  the request's `finally` can only run after a slot was actually taken. */
function acquireChangeLineSlot(): Promise<void> {
  if (activeChangeLineReads < MAX_CONCURRENT_CHANGE_LINE_READS) {
    activeChangeLineReads += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waitingChangeLineReads.push(() => {
      activeChangeLineReads += 1;
      resolve();
    });
  });
}

function releaseChangeLineSlot(): void {
  activeChangeLineReads -= 1;
  waitingChangeLineReads.shift()?.();
}

/** Exported so any other surface can join the SAME generation rather than
 *  issuing a second probe for a pair that is already being read. */
export function changeLineCountsForGeneration(
  target: string,
  refreshKey: number,
): Promise<ChangeLineCounts> {
  const key = JSON.stringify([target, refreshKey]);
  const pending = changeLineRequests.get(key);
  if (pending) return pending;
  // Every bridge op carries its own timeout, so a queued read is always
  // reached — a stuck engine cannot strand the queue behind it.
  const request = acquireChangeLineSlot()
    .then(() => gitChangeLineCounts(target))
    .finally(() => {
      releaseChangeLineSlot();
      if (changeLineRequests.get(key) === request) {
        changeLineRequests.delete(key);
      }
    });
  changeLineRequests.set(key, request);
  return request;
}

/** The Git target for a workspace's own comparison: a real worktree is
 *  addressed by its opaque id, and the synthetic "Local main" trunk by its
 *  repository root, exactly as the Changes surfaces resolve it. A worktree
 *  whose folder is gone from disk has nothing to compare. */
function changeLinesTarget(workspace: Workspace | null): string | null {
  if (!workspace || workspace.present === false) return null;
  if (isLocalMainWorkspace(workspace)) return workspace.repoRoot || null;
  return workspace.id || null;
}

/** Net ± lines for everything this workspace's branch contributed — the All
 *  Changes scope, committed and uncommitted together. Zeroes mean "nothing to
 *  show", which covers both a clean workspace and one not probed yet; callers
 *  render nothing in either case rather than a placeholder. */
export function useWorkspaceChangeLines(
  workspace: Workspace | null,
  enabled = true,
): ChangeLineCounts {
  const target = enabled ? changeLinesTarget(workspace) : null;
  const refreshKey = useGitRefreshKey(workspace?.path, target);
  // The resolved pair carries its target so a workspace switch can never show
  // another workspace's numbers for a frame.
  const [live, setLive] = useState<{
    target: string;
    counts: ChangeLineCounts;
  } | null>(null);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    void changeLineCountsForGeneration(target, refreshKey)
      .then((counts) => {
        const canonical = rememberChangeLines(target, counts);
        if (cancelled) return;
        // Same target, same numbers → keep the exact state object so React
        // bails out instead of re-rendering the whole strip on every refresh.
        setLive((current) =>
          current?.target === target && current.counts === canonical
            ? current
            : { target, counts: canonical },
        );
      })
      .catch(() => {
        // Retain the last confirmed pair — see the header note.
      });
    return () => {
      cancelled = true;
    };
  }, [target, refreshKey]);

  if (!target) return NO_CHANGE_LINES;
  if (live && live.target === target) return live.counts;
  return lastConfirmedChangeLines(target);
}

/** Test-only reset so a suite's remembered pairs cannot leak between cases. */
export function resetWorkspaceChangeLinesForTests(): void {
  lastKnownChangeLines.clear();
  changeLineRequests.clear();
  activeChangeLineReads = 0;
  waitingChangeLineReads.length = 0;
}
