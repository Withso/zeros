import { getPrInlineReview } from "@/renderer/platform/github-review";
import { onActiveBridgeConnected } from "@/renderer/platform/bridge/active-bridge";
import { codeReviewAvailable } from "@/renderer/platform/bridge/code-review-availability";
import {
  documentIsForeground,
  observeForeground,
} from "@/renderer/shared/lib/element-activity";
import { registerPrWorkspaceCacheForget } from "@/renderer/shell/pr/pr-cache-forget";
import { githubReviewCache, githubReviewTargetFromKey } from "./github-review-cache";
import { beginReviewCacheRequest, registerReviewCacheForget } from "./review-cache-forget";

const MIN_DELAY_MS = 30_000;
const MAX_DELAY_MS = 120_000;
interface Observation {
  key: string;
  cwd?: string;
  consumers: number;
  foreground: boolean;
  delay: number;
  timer?: ReturnType<typeof setTimeout>;
  flight?: Promise<void>;
  queued: boolean;
  confirmedRevision?: string;
  stopForeground: () => void;
  stopConnected: () => void;
}

// Only actively owned keys live here. Confirmed data has its separate bounded
// cache; leaving the last surface releases every observer and timer immediately.
const observations = new Map<string, Observation>();
const current = (entry: Observation) => observations.get(entry.key) === entry;
const foreground = (entry: Observation) =>
  current(entry) && entry.foreground && documentIsForeground();

function clearTimer(entry: Observation): void {
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  entry.timer = undefined;
}

function fenceRead(entry: Observation): void {
  if (!entry.flight) return;
  const confirmed = githubReviewCache.peekSnapshot(entry.key).data;
  // Release pending cache ownership as well as its generation. Reopening A
  // must start its own read even if the previous visit's transport is held.
  if (confirmed) githubReviewCache.setData(entry.key, confirmed);
  else githubReviewCache.forget(entry.key);
}

function retire(entry: Observation): void {
  if (!current(entry)) return;
  observations.delete(entry.key);
  clearTimer(entry);
  entry.stopForeground();
  entry.stopConnected();
  entry.queued = false;
  fenceRead(entry);
}

function schedule(entry: Observation): void {
  clearTimer(entry);
  if (!foreground(entry) || entry.flight) return;
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    void read(entry, false);
  }, entry.delay);
}

function read(entry: Observation, reset: boolean): Promise<void> {
  if (!foreground(entry)) return Promise.resolve();
  clearTimer(entry);
  if (reset) entry.delay = MIN_DELAY_MS;
  if (entry.flight) {
    if (!entry.queued) {
      entry.queued = true;
      githubReviewCache.invalidate(entry.key);
    }
    return entry.flight;
  }
  const before = githubReviewCache.peekSnapshot(entry.key).data;
  const request = entry.cwd ? beginReviewCacheRequest(entry.cwd) : undefined;
  const result = githubReviewCache.load(entry.key, () => {
    // load dispatches in a microtask. A tab/visibility change can retire the
    // intent before that microtask, even though the effect started foreground.
    if (!foreground(entry)) {
      if (current(entry)) fenceRead(entry);
      throw new Error("The review surface is no longer active.");
    }
    request?.assertCurrent();
    return getPrInlineReview(githubReviewTargetFromKey(entry.key));
  }, { force: true });
  const flight: Promise<void> = result.then(
    () => {
      const changed = githubReviewCache.peekSnapshot(entry.key).data !== before;
      entry.delay = reset || changed ? MIN_DELAY_MS : Math.min(entry.delay * 2, MAX_DELAY_MS);
    },
    () => { entry.delay = reset ? MIN_DELAY_MS : Math.min(entry.delay * 2, MAX_DELAY_MS); },
  ).then(() => {
    request?.finish();
    if (!current(entry) || entry.flight !== flight) return;
    entry.flight = undefined;
    const queued = entry.queued;
    entry.queued = false;
    if (!foreground(entry)) return;
    if (queued) return read(entry, true);
    schedule(entry);
  });
  entry.flight = flight;
  return flight;
}

/** One next-due read, reconnect subscription and foreground observer per PR. */
export function observeGithubReview(key: string, cwd?: string): () => void {
  if (!codeReviewAvailable({ cwd, ...githubReviewTargetFromKey(key) })) return () => {};
  let entry = observations.get(key);
  if (!entry) {
    entry = {
      key, cwd, consumers: 0, foreground: documentIsForeground(),
      delay: MIN_DELAY_MS, queued: false,
      stopForeground: () => {}, stopConnected: () => {},
    };
    observations.set(key, entry);
    const owned = entry;
    entry.stopForeground = observeForeground(() => {
      const visible = documentIsForeground();
      if (visible === owned.foreground) return;
      owned.foreground = visible;
      clearTimer(owned);
      if (visible) void read(owned, true);
    });
    entry.stopConnected = onActiveBridgeConnected((_bridge, { initial }) => {
      if (!initial) return read(owned, true);
    }, cwd);
    void read(entry, true);
  }
  entry.consumers++;
  const owned = entry;
  return () => {
    owned.consumers--;
    if (owned.consumers === 0) retire(owned);
  };
}

export function refreshGithubReview(
  key: string,
  cwd: string | undefined,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent() || !documentIsForeground() ||
      !codeReviewAvailable({ cwd, ...githubReviewTargetFromKey(key) })) return Promise.resolve();
  const entry = observations.get(key);
  if (entry) return read(entry, true);
  // A committed mutation may refresh before its surface's observation effect.
  // This one-off has no timer and rechecks the captured owner at dispatch.
  githubReviewCache.invalidate(key);
  return githubReviewCache.load(key, () => {
    if (!isCurrent() || !documentIsForeground())
      throw new Error("The review surface is no longer active.");
    return getPrInlineReview(githubReviewTargetFromKey(key));
  }, { force: true }).then(() => {}, () => {});
}

export function confirmGithubReviewRevision(key: string, head: string, base: string): void {
  const entry = observations.get(key);
  if (!entry) return;
  const revision = JSON.stringify([head, base]);
  if (entry.confirmedRevision === revision) return;
  entry.confirmedRevision = revision;
  const data = githubReviewCache.peekSnapshot(key).data;
  if (data && (data.headSha !== head || data.baseSha !== base)) void read(entry, true);
}

registerPrWorkspaceCacheForget((workspaceId) => {
  for (const entry of observations.values()) {
    if (githubReviewTargetFromKey(entry.key).workspaceId === workspaceId) retire(entry);
  }
});
registerReviewCacheForget((ownsFolder) => {
  for (const entry of observations.values()) {
    if (!entry.cwd || !ownsFolder(entry.cwd)) continue;
    retire(entry);
    githubReviewCache.forget(entry.key);
  }
});
