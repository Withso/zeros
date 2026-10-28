// ──────────────────────────────────────────────────────────
// review-data — the Review tab's live snapshot store
// ──────────────────────────────────────────────────────────
//
// One module-level cache per (workspace, PR) holding the PR row + checks +
// commits + timeline as a single snapshot, so:
//
//   • Switching workspaces/tabs re-shows the last snapshot INSTANTLY and
//     revalidates underneath (no "Loading…" flash — stale-while-revalidate).
//   • Every consumer sees the same data; refreshes are deduped in-flight.
//   • Freshness is layered, cheapest-first:
//       1. Event bus — useGitRefreshKey bumps (agent turn-end, engine git/gh
//          writes, editor saves) trigger an immediate silent full refresh.
//       2. Fast lane — while CI is running, ONLY the checks resource re-polls
//          (CHECKS_POLL_ACTIVE_MS) so runs complete "live".
//       3. Slow lane — the full snapshot re-pulls every FULL_POLL_MS to catch
//          activity that happened on github.com directly (new comments,
//          reviews, force-pushes, an external merge).
//     Lanes 2–3 run only while the Review tab is ACTIVE and the document is
//     visible; a bump that arrives while hidden marks the snapshot stale and
//     the next activation refreshes once. Zero background API burn.
//     TERMINAL (merged/closed) PRs mute only refresh-bus churn from local Git
//     activity. The bounded slow/resume lanes stay live because their Review
//     resources remain mutable (comments/reviews and post-merge CI), and the
//     fast checks lane runs only until any pending checks settle.
//
// All GitHub access goes through the ReviewProvider seam (review-provider.ts)
// so GitLab/Bitbucket plug in underneath without touching this store or the UI.

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import {
  isGitErrorShape,
  type PR,
  type PrChecksResult,
  type PrCommitSummary,
  type PrTimelineItem,
} from "../../../platform/git";
import type {
  ReviewMergeMethod,
  ReviewProvider,
  ReviewTarget,
} from "../../pr/review-provider";
import {
  effectivePrPollState,
  shouldPollPrStatus,
} from "../../pr/pr-status-refresh";
import { registerPrWorkspaceCacheForget } from "../../pr/pr-cache-forget";
import { isCloudWorkspace, parseCloudScopedId } from "../../../platform/bridge/cloud-workspace-key";
import { cloudGithubPrScope, useCloudGithubPrScope } from "../../../platform/cloud-github-pr-scope";
import { documentIsForeground, observeForeground, pollWhileForeground } from "../../../shared/lib/element-activity";
import {
  CHECKS_POLL_ACTIVE_MS,
  FULL_POLL_MS,
  hasPendingChecks,
} from "./review-model";

export function humanGitError(e: unknown): string {
  if (isGitErrorShape(e))
    return e.remediation ? `${e.message} — ${e.remediation}` : e.message;
  return e instanceof Error ? e.message : String(e);
}

/** A revoked/expired token surfaces as NOT_AUTHENTICATED from any read — flip
 *  the snapshot back to the sign-in gate instead of a generic error. */
function isAuthFailure(e: unknown): boolean {
  return isGitErrorShape(e) && e.code === "NOT_AUTHENTICATED";
}

/** Timeline entry + the client-only optimistic flag (a just-posted comment
 *  rendered before GitHub confirms it). */
export type ReviewTimelineEntry = PrTimelineItem & { optimistic?: boolean };

export interface ReviewSnapshot {
  /** null until the first auth probe resolves. */
  authed: boolean | null;
  /** The signed-in login (labels optimistic comments). */
  login: string | null;
  pr: PR | null;
  checks: PrChecksResult | null;
  commits: PrCommitSummary[] | null;
  timeline: ReviewTimelineEntry[] | null;
  /** Fatal load error — set when the PR itself can't be fetched AND there is
   *  no prior data to keep showing. Per-resource hiccups don't set this. */
  error: string | null;
  /** Per-resource fetch failures (the PR row loaded but a sibling read
   *  didn't) — sections surface these instead of a misleading empty state. */
  resourceErrors: {
    checks: string | null;
    commits: string | null;
    timeline: string | null;
  };
  /** True while ANY fetch for this snapshot is in flight. */
  refreshing: boolean;
  /** Epoch ms of the last successful full refresh (0 = never). */
  loadedAt: number;
  /** A refresh signal arrived while the tab was inactive/hidden. */
  stale: boolean;
}

const EMPTY_SNAPSHOT: ReviewSnapshot = {
  authed: null,
  login: null,
  pr: null,
  checks: null,
  commits: null,
  timeline: null,
  error: null,
  resourceErrors: { checks: null, commits: null, timeline: null },
  refreshing: false,
  loadedAt: 0,
  stale: false,
};

interface Entry {
  snap: ReviewSnapshot;
  listeners: Set<() => void>;
  inflightFull: Promise<void> | null;
  inflightChecks: Promise<void> | null;
  /** Invalidates reads that began before a newer refresh signal or mutation. */
  generation: number;
}

const cache = new Map<string, Entry>();
const REVIEW_RESUME_MIN_AGE_MS = 2_000;
/** Local refresh generations arrive in bursts while an agent edits, builds and
 * tests (one per watcher poll). Only a push or a gh write among them can change
 * the PR, so a burst refreshes the snapshot's GitHub resources at most once per
 * window, with a trailing read so the last change still lands. */
export const REVIEW_REFRESH_KEY_MIN_INTERVAL_MS = 15_000;

// Deletion purge (pr-cache-forget): snapshot keys are
// `provider.cacheKey#workspaceId#reviewRef`, so the delimited infix match is exact.
// Disconnect also retires mounted content. Async tails check entry identity
// before publication, so they cannot recreate a retired snapshot.
registerPrWorkspaceCacheForget((workspaceId) => {
  for (const [key, entry] of cache) {
    if (!key.includes(`#${workspaceId}#`)) continue;
    cache.delete(key);
    entry.generation++;
    entry.snap = EMPTY_SNAPSHOT;
    for (const listener of entry.listeners) listener();
  }
});

/** Refocusing the app is an explicit external-change boundary: the user may
 * have edited the PR on github.com while Zeros was behind another window. Keep
 * a tiny age floor for focus thrash, but do not wait for the one-minute poll. */
export function shouldRefreshReviewOnResume(
  snap: Pick<ReviewSnapshot, "loadedAt" | "stale">,
  now: number = Date.now(),
): boolean {
  return (
    snap.stale ||
    snap.loadedAt === 0 ||
    now - snap.loadedAt >= REVIEW_RESUME_MIN_AGE_MS
  );
}

/** Milliseconds to wait before a refresh-key bump may refresh the snapshot:
 * 0 when the last full load is older than the window (or never happened). */
export function refreshKeyRefreshDelay(
  loadedAt: number,
  now: number = Date.now(),
): number {
  if (loadedAt === 0) return 0;
  return Math.max(0, loadedAt + REVIEW_REFRESH_KEY_MIN_INTERVAL_MS - now);
}

export type ReviewSnapshotRefreshTrigger =
  | "refresh-key"
  | "interval"
  | "resume";

/** Review owns mutable resources beyond the PR row. This policy is separate
 * from the compact island's status-only polling contract. */
export function shouldRefreshReviewSnapshot(
  effectiveState: string | null,
  trigger: ReviewSnapshotRefreshTrigger,
): boolean {
  // Local Git/agent refresh churn cannot mutate a terminal PR and was the
  // source of the observed several-second loop. External boundaries stay
  // bounded and must refresh the Review snapshot's still-mutable resources.
  return trigger === "refresh-key"
    ? shouldPollPrStatus(effectiveState, trigger)
    : true;
}

/** Whether the fast checks lane should be armed for this snapshot. */
export function shouldPollReviewChecks(args: {
  active: boolean;
  pending: boolean;
  effectiveState: string | null;
}): boolean {
  const { active, pending } = args;
  return active && pending;
}

function reviewCacheKey(
  provider: ReviewProvider,
  workspaceId: string,
  prNumber: number,
  scope = cloudGithubPrScope(workspaceId),
): string {
  return `${provider.cacheKey}#${workspaceId}#${prNumber}${isLocalReviewWorkspace(workspaceId) ? "" : `@${scope}`}`;
}

function currentReviewEntry(provider: ReviewProvider, target: ReviewTarget, key: string, entry: Entry): boolean {
  return cache.get(key) === entry && key === reviewCacheKey(provider, target.workspaceId, Number(target.reviewRef));
}

function targetForReview(
  provider: ReviewProvider,
  workspaceId: string,
  prNumber: number,
): ReviewTarget {
  return {
    workspaceId,
    hostOrigin: provider.hostOrigin,
    reviewRef: String(prNumber),
  };
}

function isLocalReviewWorkspace(workspaceId: string): boolean {
  return !isCloudWorkspace(workspaceId) && !parseCloudScopedId(workspaceId);
}

function entryFor(key: string): Entry {
  let e = cache.get(key);
  if (!e) {
    e = {
      snap: EMPTY_SNAPSHOT,
      listeners: new Set(),
      inflightFull: null,
      inflightChecks: null,
      generation: 0,
    };
    cache.set(key, e);
    // Bound the cache: PR review snapshots are small, but a long session
    // hopping across many workspaces shouldn't accumulate forever.
    if (cache.size > 32) {
      for (const [k, v] of cache) {
        if (v.listeners.size === 0) cache.delete(k);
        if (cache.size <= 32) break;
      }
    }
  }
  return e;
}

function patch(key: string, p: Partial<ReviewSnapshot>): void {
  const e = entryFor(key);
  e.snap = { ...e.snap, ...p };
  for (const l of e.listeners) l();
}

function invalidate(key: string): void {
  const e = entryFor(key);
  e.generation += 1;
  patch(key, { stale: true });
}

/** Publish a mutation result and prevent an older provider read from undoing
 * it. The invalidated full read automatically schedules one fresh successor. */
function patchAuthoritative(key: string, p: Partial<ReviewSnapshot>): void {
  const e = entryFor(key);
  e.generation += 1;
  patch(key, p);
}

/** Defensive compatibility for an older engine that returned an empty PR
 * sentinel. Current read façades reject when transport is unavailable. */
function livePr(pr: PR | null): PR | null {
  return pr && pr.number > 0 ? pr : null;
}

async function refreshFull(
  provider: ReviewProvider,
  target: ReviewTarget,
  key: string,
): Promise<void> {
  if (key !== reviewCacheKey(provider, target.workspaceId, Number(target.reviewRef))) return;
  const e = entryFor(key);
  if (e.inflightFull) return e.inflightFull;
  const generation = e.generation;
  e.inflightFull = (async () => {
    let superseded = false;
    let stopAfterAuth = false;
    patch(key, { refreshing: true, stale: false });
    try {
      // Probe auth until it confirms a signed-in user, then trust the cached
      // verdict (authed === true). While still unauthenticated we re-probe on
      // every refresh, so signing in flips the gate open on the next poll; a
      // NOT_AUTHENTICATED read below re-arms this by flipping authed to false.
      if (e.snap.authed !== true) {
        const status = await provider.authStatus(target.workspaceId);
        if (!currentReviewEntry(provider, target, key, e)) return;
        if (e.generation !== generation) {
          superseded = true;
        } else {
          patch(key, {
            authed: status.authenticated,
            login: status.login ?? null,
          });
          stopAfterAuth = !status.authenticated;
        }
      }
      if (!superseded && !stopAfterAuth) {
        const [pr, checks, commits, timeline] = await Promise.allSettled([
          provider.getPr(target),
          provider.getChecks(target),
          provider.getCommits(target),
          provider.getTimeline(target),
        ]);
        if (!currentReviewEntry(provider, target, key, e)) return;
        if (e.generation !== generation) {
          superseded = true;
        } else {
          // A revoked token mid-session: any read rejecting NOT_AUTHENTICATED
          // flips the surface back to the sign-in gate.
          if (
            [pr, checks, commits, timeline].some(
              (r) => r.status === "rejected" && isAuthFailure(r.reason),
            )
          ) {
            patch(key, { authed: false });
          } else {
            const next: Partial<ReviewSnapshot> = {};
            if (pr.status === "fulfilled" && livePr(pr.value))
              next.pr = pr.value;
            if (checks.status === "fulfilled") next.checks = checks.value;
            if (commits.status === "fulfilled") next.commits = commits.value;
            if (timeline.status === "fulfilled") next.timeline = timeline.value;
            next.resourceErrors = {
              checks:
                checks.status === "rejected"
                  ? humanGitError(checks.reason)
                  : null,
              commits:
                commits.status === "rejected"
                  ? humanGitError(commits.reason)
                  : null,
              timeline:
                timeline.status === "rejected"
                  ? humanGitError(timeline.reason)
                  : null,
            };
            if (pr.status === "rejected") {
              // Retain the confirmed PR and expose revalidation failure to the
              // tab's banner, even when there is still useful content.
              next.error = humanGitError(pr.reason);
            } else if (pr.status === "fulfilled") {
              next.error = null;
            }
            if (pr.status === "fulfilled") next.loadedAt = Date.now();
            patch(key, next);
          }
        }
      }
    } catch (err) {
      // authStatus threw (network / engine down): retain prior exact-key data
      // and expose the persistent failure to the tab's banner.
      if (!currentReviewEntry(provider, target, key, e)) return;
      if (e.generation !== generation) superseded = true;
      else patch(key, { error: humanGitError(err) });
    } finally {
      e.inflightFull = null;
      if (currentReviewEntry(provider, target, key, e)) patch(key, { refreshing: false });
    }
    // An event or mutation that landed during this request invalidated its
    // response. Run exactly one successor after releasing the in-flight slot.
    if (superseded && currentReviewEntry(provider, target, key, e)) {
      // A hidden refresh signal must not turn the completed request
      // into another native read. Keep the confirmed snapshot and let the
      // next foreground observer (or explicit request) settle its staleness.
      if (!documentIsForeground()) patch(key, { stale: true });
      else await refreshFull(provider, target, key);
    }
  })();
  return e.inflightFull;
}

async function refreshChecksOnly(
  provider: ReviewProvider,
  target: ReviewTarget,
  key: string,
): Promise<void> {
  if (key !== reviewCacheKey(provider, target.workspaceId, Number(target.reviewRef))) return;
  const e = entryFor(key);
  if (e.inflightChecks || e.inflightFull) return;
  const generation = e.generation;
  e.inflightChecks = (async () => {
    try {
      const checks = await provider.getChecks(target);
      if (currentReviewEntry(provider, target, key, e) && e.generation === generation) patch(key, { checks });
    } catch {
      // Fast-lane miss — the slow lane / event bus will repair.
    } finally {
      e.inflightChecks = null;
    }
  })();
  return e.inflightChecks;
}

/** Re-pull ONLY the timeline (post-comment reconcile). When GitHub's list
 *  read lags behind the write (eventual consistency), the confirmed comment
 *  is re-appended with its real id so it never blinks out of the stream. */
async function refreshTimelineOnly(
  provider: ReviewProvider,
  target: ReviewTarget,
  key: string,
  confirmed?: { id: number; entry: ReviewTimelineEntry },
): Promise<void> {
  const entry = entryFor(key), generation = entry.generation;
  if (!currentReviewEntry(provider, target, key, entry)) return;
  try {
    const fetched: ReviewTimelineEntry[] = await provider.getTimeline(target);
    const timeline =
      confirmed && !fetched.some((t) => t.id === confirmed.id)
        ? [
            ...fetched,
            { ...confirmed.entry, id: confirmed.id, optimistic: false },
          ]
        : fetched;
    if (currentReviewEntry(provider, target, key, entry) && entry.generation === generation) {
      patchAuthoritative(key, { timeline });
    }
  } catch {
    // Keep the optimistic entry; the next full refresh reconciles.
  }
}

export interface ReviewLiveData {
  snap: ReviewSnapshot;
  /** Silent full refresh (deduped). */
  refresh: () => Promise<void>;
  /** Post a conversation comment with an optimistic timeline entry. Throws on
   *  failure (after rolling the optimistic entry back). */
  postComment: (body: string) => Promise<void>;
  merge: (method: ReviewMergeMethod) => Promise<void>;
  markReady: () => Promise<void>;
}

/** Warm or revalidate one exact PR snapshot from pointer/focus intent. Calls
 * made during an older request invalidate it and share its single successor. */
export function prefetchReviewLiveData(
  provider: ReviewProvider,
  workspaceId: string,
  prNumber: number,
  options: { force?: boolean } = {},
): Promise<void> {
  const key = reviewCacheKey(provider, workspaceId, prNumber);
  const entry = entryFor(key);
  if (!options.force) {
    if (entry.inflightFull) return entry.inflightFull;
    if (
      entry.snap.loadedAt > 0 &&
      !entry.snap.stale &&
      Date.now() - entry.snap.loadedAt <= FULL_POLL_MS
    ) {
      return Promise.resolve();
    }
  }
  invalidate(key);
  return refreshFull(
    provider,
    targetForReview(provider, workspaceId, prNumber),
    key,
  );
}

/** Non-fetching snapshot read used by navigation/tests and future status
 * islands. The returned object is immutable-by-convention until publication. */
export function peekReviewLiveData(
  provider: ReviewProvider,
  workspaceId: string,
  prNumber: number,
): ReviewSnapshot {
  return entryFor(reviewCacheKey(provider, workspaceId, prNumber)).snap;
}

export function useReviewLiveData(args: {
  provider: ReviewProvider;
  workspaceId: string;
  prNumber: number;
  /** Shared git refresh bus (useGitRefreshKey). */
  refreshKey: number;
  /** Is the Review tab the visible workbench tab? Gates all polling. */
  active: boolean;
}): ReviewLiveData {
  const { provider, workspaceId, prNumber, refreshKey, active } = args;
  const initialActive = active;
  const scope = useCloudGithubPrScope(workspaceId);
  const key = reviewCacheKey(provider, workspaceId, prNumber, scope);
  const target = targetForReview(provider, workspaceId, prNumber);

  const snap = useSyncExternalStore(
    useCallback(
      (cb: () => void) => {
        const e = entryFor(key);
        e.listeners.add(cb);
        return () => {
          e.listeners.delete(cb);
        };
      },
      [key],
    ),
    () => entryFor(key).snap,
  );

  const refresh = useCallback(
    () =>
      prefetchReviewLiveData(provider, workspaceId, prNumber, { force: true }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- target is derived from key
    [provider, key],
  );

  // Initial load — once per (workspace, PR) unless nothing arrived yet.
  useEffect(() => {
    if (!initialActive || !documentIsForeground()) return;
    const e = entryFor(key);
    if (e.snap.loadedAt === 0 && !e.inflightFull) void refresh();
  }, [key, refresh, initialActive]);

  // Event bus: engine git/gh writes + agent turn-end. Active → refresh, at
  // most once per REVIEW_REFRESH_KEY_MIN_INTERVAL_MS with a trailing read;
  // hidden → mark stale, the activation effect below settles it. Terminal
  // (merged/closed) PRs skip the lane entirely — local git activity cannot
  // change them, and every agent turn-end was re-pulling a merged PR's four
  // GitHub resources forever. The seen refreshKey is still recorded so a
  // later reopen doesn't replay stale generations.
  const lastRefreshKey = useRef(refreshKey);
  const trailingRefresh = useRef<number | null>(null);
  useEffect(() => {
    if (refreshKey === lastRefreshKey.current) return;
    lastRefreshKey.current = refreshKey;
    if (
      !shouldRefreshReviewSnapshot(
        effectivePrPollState(entryFor(key).snap.pr),
        "refresh-key",
      )
    ) {
      return;
    }
    if (!active || !documentIsForeground()) {
      invalidate(key);
      return;
    }
    const delay = refreshKeyRefreshDelay(entryFor(key).snap.loadedAt);
    if (delay === 0) {
      void refresh();
      return;
    }
    if (trailingRefresh.current != null) return;
    trailingRefresh.current = window.setTimeout(() => {
      trailingRefresh.current = null;
      if (!documentIsForeground()) invalidate(key);
      else void refresh();
    }, delay);
  }, [refreshKey, active, key, refresh]);
  // A pending trailing read belongs to this key's visible surface. Leaving
  // keeps its signal as staleness for the activation effect instead.
  useEffect(() => {
    const cancel = () => {
      if (trailingRefresh.current == null) return;
      window.clearTimeout(trailingRefresh.current);
      trailingRefresh.current = null;
      invalidate(key);
    };
    const unwatch = active ? observeForeground(() => {
      if (!documentIsForeground()) cancel();
    }) : undefined;
    return () => { unwatch?.(); cancel(); };
  }, [active, key]);

  // Activation: settle staleness (bus bump while hidden, or simply old data).
  // Deliberately NOT terminal-gated: this bounded once-per-activation read is
  // the cheap re-check that lets a PR reopened on github.com recover after
  // the recurring lanes below muted themselves.
  useEffect(() => {
    if (!active || !documentIsForeground()) return;
    const e = entryFor(key);
    const old = Date.now() - e.snap.loadedAt > FULL_POLL_MS;
    if (e.snap.loadedAt > 0 && (e.snap.stale || old)) void refresh();
  }, [active, key, refresh]);

  // Slow lane: the full snapshot, catching github.com-side activity. Terminal
  // PR rows are stable, but their timeline and post-merge checks are not, so
  // this bounded active-only lane remains live for every state.
  useEffect(() => {
    if (!active) return;
    return pollWhileForeground(() => {
      const entry = entryFor(key);
      // A visibility/focus pair observes the same boundary. It must not
      // invalidate the first read and force an unnecessary successor.
      if (entry.inflightFull) return;
      const snapshot = entry.snap;
      if (shouldRefreshReviewSnapshot(effectivePrPollState(snapshot.pr), "resume") &&
          shouldRefreshReviewOnResume(snapshot)) void refresh();
    }, FULL_POLL_MS);
  }, [active, key, refresh]);

  // Fast lane: checks only, while CI is in flight. A merge can land before the
  // head's checks/deployments settle; `pending` naturally disarms the lane as
  // soon as the completion is observed, regardless of the PR row's state.
  const pending = hasPendingChecks(snap.checks);
  const effectiveState = effectivePrPollState(snap.pr);
  const pollChecks = shouldPollReviewChecks({
    active,
    pending,
    effectiveState,
  });
  useEffect(() => {
    if (!pollChecks) return;
    return pollWhileForeground(() => {
      // A fresh full read already contains checks. Return events share the
      // full lane above, so they cannot start a redundant checks request.
      if (Date.now() - entryFor(key).snap.loadedAt >= CHECKS_POLL_ACTIVE_MS)
        void refreshChecksOnly(provider, target, key);
    }, CHECKS_POLL_ACTIVE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- target is derived from key
  }, [pollChecks, provider, key]);

  const postComment = useCallback(
    async (body: string) => {
      const e = entryFor(key);
      if (!currentReviewEntry(provider, target, key, e)) throw new Error("Your GitHub connection changed. Refresh before posting.");
      const optimistic: ReviewTimelineEntry = {
        kind: "comment",
        id: -Date.now(),
        author: e.snap.login ?? "you",
        authorAvatarUrl: null,
        state: "",
        body,
        url: null,
        createdAt: Date.now(),
        optimistic: true,
      };
      patchAuthoritative(key, {
        timeline: [...(e.snap.timeline ?? []), optimistic],
      });
      try {
        const posted = await provider.addComment(target, body);
        if (!currentReviewEntry(provider, target, key, e)) return;
        await refreshTimelineOnly(provider, target, key, {
          id: posted.id,
          entry: optimistic,
        });
      } catch (err) {
        // Roll back the optimistic entry so a failed post never lingers.
        if (currentReviewEntry(provider, target, key, e)) patchAuthoritative(key, {
          timeline: (entryFor(key).snap.timeline ?? []).filter(
            (t) => t.id !== optimistic.id,
          ),
        });
        throw err;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- target is derived from key
    [provider, key],
  );

  const merge = useCallback(
    async (method: ReviewMergeMethod) => {
      const entry = entryFor(key);
      if (!currentReviewEntry(provider, target, key, entry)) throw new Error("Your GitHub connection changed. Refresh before merging.");
      await provider.merge(target, method);
      if (currentReviewEntry(provider, target, key, entry)) await refresh();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- target is derived from key
    [provider, key, refresh],
  );

  const markReady = useCallback(
    async () => {
      const entry = entryFor(key);
      if (!currentReviewEntry(provider, target, key, entry)) throw new Error("Your GitHub connection changed. Refresh before continuing.");
      const pr = await provider.markReady(target);
      if (!currentReviewEntry(provider, target, key, entry)) return;
      if (livePr(pr)) patchAuthoritative(key, { pr });
      void refresh();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- target is derived from key
    [provider, key, refresh],
  );

  return { snap, refresh, postComment, merge, markReady };
}
