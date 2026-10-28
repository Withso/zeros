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

import { ghPrSync, type Workspace } from "../../platform/git";
import { notifyWorkspacesChanged } from "../../state/use-projects";
import { isLocalMainWorkspace } from "../../state/local-main-workspace";
import { useGitRefreshKey } from "../use-git-refresh-key";
import { registerPrWorkspaceCacheForget } from "./pr-cache-forget";
import { isCloudWorkspace, parseCloudScopedId } from "../../platform/bridge/cloud-workspace-key";
import { documentIsForeground, pollWhileForeground } from "../../shared/lib/element-activity";
import { publishWorkspacePrDiscovery, workspacePrDiscoverySnapshot } from "./workspace-pr-discovery-state";

/** Last probe per workspace id. Switching INTO a PR-less worktree re-runs the
 *  effect with an unchanged refresh generation — pure navigation, so a recent
 *  identical probe already answered it. Local refresh-key changes probe
 *  immediately; cloud broadcasts still obey the observation/backoff bound. */
type Probe = { refreshKey: number; at: number; failures?: number; retryAt?: number };
const lastProbe = new Map<string, Probe>();
const PROBE_FRESH_MS = 60_000;
const RESUME_PROBE_FRESH_MS = 2_000;
const MAX_PR_PROBE_WORKSPACES = 128;
type ProbeReason = "refresh" | "resume" | "poll" | "manual";
type ProbeConsumer = (reason: ProbeReason) => Promise<unknown> | undefined;
type ProbeFlight = { request: Promise<unknown>; queued: ProbeReason | null };
const inflightProbes = new Map<string, ProbeFlight>();
const probeConsumers = new Map<string, Set<ProbeConsumer>>();

function currentProbeConsumer(workspaceId: string): ProbeConsumer | undefined {
  // One request owns every consumer's shared snapshot. Calling all of them on
  // retry would make each one queue yet another retry behind the first.
  return Array.from(probeConsumers.get(workspaceId) ?? []).at(-1);
}

/** Review's standard failure banner retries the same active discovery owner. */
export async function retryWorkspacePrDiscovery(workspaceId: string): Promise<void> {
  await currentProbeConsumer(workspaceId)?.("manual");
}

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
  if (reason !== "poll" && previous.refreshKey !== refreshKey) return true;
  return (
    now - previous.at >=
    (reason === "resume" ? RESUME_PROBE_FRESH_MS : PROBE_FRESH_MS)
  );
}

function recordProbe(
  workspaceId: string,
  probe: Probe,
): void {
  lastProbe.delete(workspaceId);
  lastProbe.set(workspaceId, probe);
  while (lastProbe.size > MAX_PR_PROBE_WORKSPACES) {
    const oldest = lastProbe.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    lastProbe.delete(oldest);
    // Its late reply is no longer admissible, so also retire the pending UI
    // state. Otherwise that state stays pinned beyond both caches' bounds.
    const snapshot = workspacePrDiscoverySnapshot(oldest);
    if (snapshot.pending) publishWorkspacePrDiscovery(oldest, { ...snapshot, pending: false });
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
  const local = !!workspace && !isCloudWorkspace(workspace.id) && !isCloudWorkspace(workspace.path) && !parseCloudScopedId(workspace.id);

  const probe = useCallback(
    (reason: ProbeReason) => {
      // Only DETECT while unrecorded — once the row has a prNumber, Review's
      // live store owns freshness. Local-main has no PR branch.
      if (!eligible || !id || !repoSlug) return;
      if (!documentIsForeground()) return;
      const pending = inflightProbes.get(id);
      if (pending) {
        // A turn can create the PR while an older lookup is still reading
        // "none". Returning from GitHub or retrying can also be the only nudge.
        // The age gate coalesces mount/focus events that started this read.
        if (reason === "manual" || shouldProbeWorkspacePr(lastProbe.get(id), refreshKey, Date.now(), reason)) {
          pending.queued = pending.queued === "manual" ? "manual" : reason;
        }
        return pending.request;
      }
      const now = Date.now();
      const previous = lastProbe.get(id);
      // Cloud Git/DB broadcasts can arrive for every agent write. Discovery
      // is observation, so those broadcasts cannot bypass its error backoff
      // or issue a fresh database-backed probe on every edit.
      if (reason !== "manual" && !local && previous && (now < (previous.retryAt ?? 0) || now - previous.at < 30_000)) return;
      if (reason !== "manual" && !shouldProbeWorkspacePr(previous, refreshKey, now, reason)) {
        return;
      }
      const probe: Probe = { refreshKey, at: now, failures: previous?.failures ?? 0 };
      recordProbe(id, probe);
      const snapshot = workspacePrDiscoverySnapshot(id);
      publishWorkspacePrDiscovery(id, { ...snapshot, pending: true });
      let found = false;
      const request: Promise<void> = ghPrSync(id)
        .then((pr) => {
          // Deletion/eviction retires the observation, including its late tail.
          if (lastProbe.get(id) !== probe) return;
          probe.failures = 0;
          found = !!pr && pr.number > 0;
          // A queued refresh invalidated this absence. Keep any earlier
          // confirmation, but let the successor establish a new one.
          const checked = !found && (snapshot.checked || !inflightProbes.get(id)?.queued);
          publishWorkspacePrDiscovery(id, { pending: false, checked, error: null });
          if (!found) return;
          // The engine stamped the row — refresh the workspace-list consumers
          // so Create PR atomically gives way to PR status + Review.
          notifyWorkspacesChanged(repoSlug);
        })
        .catch((error: unknown) => {
          if (lastProbe.get(id) !== probe) return;
          publishWorkspacePrDiscovery(id, { pending: false, checked: snapshot.checked, error });
          if (!local) {
            probe.failures = Math.min(4, (probe.failures ?? 0) + 1);
            probe.retryAt = Date.now() + Math.min(300_000, 60_000 * 2 ** (probe.failures - 1));
          }
        })
        .finally(() => {
          const flight = inflightProbes.get(id);
          if (flight?.request !== request) return;
          inflightProbes.delete(id);
          if (flight.queued && !found) {
            // Use the currently mounted owner, never the closure that started
            // an old request. Hidden/unmounted owners cannot start a successor.
            return currentProbeConsumer(id)?.(flight.queued);
          }
        });
      inflightProbes.set(id, { request, queued: null });
      return request;
    },
    [eligible, id, repoSlug, refreshKey, local],
  );

  useEffect(() => {
    if (!id || !eligible) return;
    let consumers = probeConsumers.get(id);
    if (!consumers) { consumers = new Set(); probeConsumers.set(id, consumers); }
    consumers.add(probe);
    void probe("refresh");
    return () => {
      consumers.delete(probe);
      if (consumers.size === 0 && probeConsumers.get(id) === consumers) probeConsumers.delete(id);
    };
  }, [id, eligible, probe]);

  // A PR can be opened entirely on github.com, with no local file/Git event.
  // Re-probe promptly when the user returns to Zeros and periodically while the
  // active workspace remains visible, bounded to one call per minute.
  useEffect(() => {
    if (!eligible || !id || !repoSlug) return;
    // Discovery has no work while the window is away. The existing
    // exact-workspace age and in-flight guards coalesce return events.
    return pollWhileForeground(() => probe("resume"), PROBE_FRESH_MS);
  }, [eligible, id, repoSlug, probe, local]);
}
