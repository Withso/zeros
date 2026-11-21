// A repository's ready copy as its project page shows it. What a reader gets
// is decided here: owners and admins see a shared repository's status with its
// cause, its history and failed setup output; members see the status line only
// and never a failure; a private repository's member sees everything of it and
// nobody else sees anything (the route answers not found).
import { READY_COPY_REFRESH_MS, type CloudV2ReadyCopy, type ReadyCopyRetry, type ReadyCopyTrigger } from "./ready-copies.js";

export type ReadyCopyStatusState = "none" | "getting_ready" | "ready" | "updating" | "update_failed" | "failed";
export type ReadyCopyStatus = {
  state: ReadyCopyStatusState;
  /** When the serving copy was made. */
  updatedAt: string | null;
  /** The next weekly update, while the copy is in use. */
  nextUpdateAt: string | null;
  /** Full view only: the failure, where, how many in a row, and the next automatic retry (null: stopped). */
  failure?: { reason: string; detail: string | null; failures: number; nextRetryAt: string | null };
};
export type ReadyCopyHistoryRow = {
  generation: number; state: CloudV2ReadyCopy["state"]; startedAt: string | null; finishedAt: string | null;
  commit: string | null; branch: string | null; trigger: ReadyCopyTrigger | null; startedBy: string | null;
  failure: { reason: string; detail: string | null } | null; output: boolean;
};

export function readyCopyStatus(history: readonly CloudV2ReadyCopy[], retry: ReadyCopyRetry, now: Date, full: boolean): ReadyCopyStatus {
  const latest = history[0], serving = history.find(row => row.state === "ready" && !row.stale && row.stoppedAt
    && now.getTime() - row.stoppedAt.getTime() < 13 * 24 * 60 * 60_000);
  const at = (date: Date | null | undefined) => date?.toISOString() ?? null;
  const updatedAt = at(serving?.stoppedAt), nextUpdateAt = serving?.stoppedAt ? new Date(serving.stoppedAt.getTime() + READY_COPY_REFRESH_MS).toISOString() : null;
  let state: ReadyCopyStatusState = !latest ? "none" : latest.state === "building" ? (serving ? "updating" : "getting_ready")
    : latest.state === "failed" ? (serving ? "update_failed" : "failed") : serving ? "ready" : "none";
  if (!full) {
    // A member never meets a failure: an older copy still serving reads as ready, none as no line at all.
    if (state === "update_failed") state = "ready";
    if (state === "failed") state = "none";
    return { state, updatedAt: state === "none" ? null : updatedAt, nextUpdateAt: state === "ready" ? nextUpdateAt : null };
  }
  return { state, updatedAt, nextUpdateAt,
    ...(latest?.state === "failed" ? { failure: { reason: latest.failureReason ?? "ready_copy_failed", detail: latest.failureDetail,
      failures: Math.max(retry.failures, 1), nextRetryAt: retry.nextAt?.toISOString() ?? null } } : {}) };
}

export function readyCopyHistory(history: readonly CloudV2ReadyCopy[], people: ReadonlyMap<string, string>): ReadyCopyHistoryRow[] {
  return history.map(row => ({
    generation: row.generation, state: row.state, startedAt: row.startedAt?.toISOString() ?? null, finishedAt: row.finishedAt?.toISOString() ?? null,
    commit: row.commit, branch: row.branch, trigger: row.trigger,
    startedBy: row.trigger === "manual" && row.triggeredBy ? people.get(row.triggeredBy) ?? "A member" : null,
    failure: row.state === "failed" ? { reason: row.failureReason ?? "ready_copy_failed", detail: row.failureDetail } : null,
    output: !!row.setupOutput,
  }));
}
