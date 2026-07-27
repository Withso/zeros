// ──────────────────────────────────────────────────────────
// useWorkspacePrSync — reveal a PR opened outside the engine
// ──────────────────────────────────────────────────────────
//
// The "Create PR" flow hands the agent a brief and lets IT run `git push` +
// `gh pr create` in its own shell — which never touches the engine, so the
// workspace row's prNumber stays null and the PR-status island (gated on
// prNumber) would never appear. (Same for a PR opened from the terminal or
// github.com.)
//
// This hook closes that gap: for the active workspace that has NO prNumber yet,
// it asks the engine to detect the branch's open PR on GitHub and backfill the
// row (prNumber/prState/prUrl). On success it nudges the workspace-list
// consumers (topbar, sidebar, island) to re-read — so the island appears and the
// "Create PR" button hides, all from the one persisted field.
//
// It runs on the shared refresh signal (agent turn-end + git/DB change), on app
// resume, and at a bounded visible-only interval. Once prNumber is set the hook
// short-circuits — the island/Review surfaces keep recorded PR state fresh.
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect } from "react";

import { ghPrSync, type Workspace } from "../../native/git";
import { notifyWorkspacesChanged } from "../../zeros/store/use-projects";
import { isLocalMainWorkspace } from "../../zeros/store/local-main-workspace";
import { useGitRefreshKey } from "../use-git-refresh-key";
import { registerPrWorkspaceCacheForget } from "./pr-cache-forget";

/** Last probe per workspace id. Switching INTO a PR-less worktree re-runs the
 *  effect with an unchanged refresh generation — pure navigation, so a recent
 *  identical probe already answered it. A refresh-key bump (turn end / git
 *  write, i.e. the moments a PR could actually appear) always probes. */
const lastProbe = new Map<string, { refreshKey: number; at: number }>();
const PROBE_FRESH_MS = 60_000;
const RESUME_PROBE_FRESH_MS = 2_000;
const MAX_PR_PROBE_WORKSPACES = 128;
const inflightProbes = new Map<string, Promise<unknown>>();

/** Synthetic Local-main rows deliberately have no engine workspace record. */
export function isWorkspacePrSyncEligible(
  workspace: Pick<Workspace, "id" | "repoSlug" | "prNumber"> | null | undefined,
): boolean {
  return !!(
    workspace?.id &&
    workspace.repoSlug &&
    workspace.prNumber == null &&
    !isLocalMainWorkspace(workspace.id)
  );
}

export function shouldProbeWorkspacePr(
  previous: { refreshKey: number; at: number } | undefined,
  refreshKey: number,
  now: number,
  reason: "refresh" | "resume" | "poll",
): boolean {
  if (!previous) return true;
  if (reason === "refresh" && previous.refreshKey !== refreshKey) return true;
  return (
    now - previous.at >=
    (reason === "resume" ? RESUME_PROBE_FRESH_MS : PROBE_FRESH_MS)
  );
}

function recordProbe(
  workspaceId: string,
  probe: { refreshKey: number; at: number },
): void {
  lastProbe.delete(workspaceId);
  lastProbe.set(workspaceId, probe);
  while (lastProbe.size > MAX_PR_PROBE_WORKSPACES) {
    const oldest = lastProbe.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    lastProbe.delete(oldest);
  }
}

// Deletion purge (pr-cache-forget): probe bookkeeping is keyed by the exact
// workspace id, which never returns after a permanent delete. Dropping an
// in-flight probe's slot is safe — its finally block only deletes the slot if
// it still owns it.
registerPrWorkspaceCacheForget((workspaceId) => {
  lastProbe.delete(workspaceId);
  inflightProbes.delete(workspaceId);
});

/** Test-only seams for the deletion-purge path (the probe cache is
 *  module-private and only written through the mounted hook). */
export function recordWorkspacePrProbeForTests(
  workspaceId: string,
  probe: { refreshKey: number; at: number },
): void {
  recordProbe(workspaceId, probe);
}

export function peekWorkspacePrProbeForTests(
  workspaceId: string,
): { refreshKey: number; at: number } | null {
  return lastProbe.get(workspaceId) ?? null;
}

export function useWorkspacePrSync(workspace: Workspace | null): void {
  const refreshKey = useGitRefreshKey(workspace?.path, workspace?.id);
  const id = workspace?.id ?? null;
  const repoSlug = workspace?.repoSlug ?? null;
  const eligible = isWorkspacePrSyncEligible(workspace);

  const probe = useCallback(
    (reason: "refresh" | "resume" | "poll") => {
      // Only DETECT while unrecorded — once the row has a prNumber, Review's
      // live store owns freshness. Local-main has no PR branch.
      if (!eligible || !id || !repoSlug) return;
      if (inflightProbes.has(id)) return;
      const now = Date.now();
      if (!shouldProbeWorkspacePr(lastProbe.get(id), refreshKey, now, reason)) {
        return;
      }
      recordProbe(id, { refreshKey, at: now });
      const request = ghPrSync(id)
        .then((pr) => {
          if (!pr || pr.number <= 0) return;
          // The engine stamped the row — refresh the workspace-list consumers
          // so Create PR atomically gives way to PR status + Review.
          notifyWorkspacesChanged(repoSlug);
        })
        .catch(() => {
          /* best-effort — no PR yet, not authed, or temporarily offline */
        })
        .finally(() => {
          if (inflightProbes.get(id) === request) inflightProbes.delete(id);
        });
      inflightProbes.set(id, request);
    },
    [eligible, id, repoSlug, refreshKey],
  );

  useEffect(() => {
    probe("refresh");
  }, [probe]);

  // A PR can be opened entirely on github.com, with no local file/Git event.
  // Re-probe promptly when the user returns to Zeros and periodically while the
  // active workspace remains visible, bounded to one call per minute.
  useEffect(() => {
    if (!eligible || !id || !repoSlug) return;
    const onResume = () => {
      if (document.visibilityState === "visible") probe("resume");
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") probe("poll");
    }, PROBE_FRESH_MS);
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("focus", onResume);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("focus", onResume);
    };
  }, [eligible, id, repoSlug, probe]);
}
