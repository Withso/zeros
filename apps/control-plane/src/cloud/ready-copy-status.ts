// A project's ready copy as its project page shows it. What a reader gets is
// decided here: whoever edits the project (owners and admins for an
// organization project, its member for a personal one) sees the status with
// its cause, the history and failed setup output; other members see the status
// line only and never a failure; nobody else sees a personal project at all
// (the route answers not found).
import { READY_COPY_REFRESH_MS, type CloudV2ReadyCopy, type ReadyCopyRepositoryResult, type ReadyCopyRetry, type ReadyCopyStep,
  type ReadyCopyTrigger } from "./ready-copies.js";

export type ReadyCopyStatusState = "none" | "getting_ready" | "ready" | "updating" | "update_failed" | "failed";
export type ReadyCopyStatus = {
  state: ReadyCopyStatusState;
  /** When the serving copy was made. */
  updatedAt: string | null;
  /** The next weekly update, while the copy is in use. */
  nextUpdateAt: string | null;
  /** Full view only: the failure, where, how many in a row, and the next automatic retry (null: stopped). */
  failure?: { reason: string; repository: string | null; step: ReadyCopyStep | null; detail: string | null; failures: number; nextRetryAt: string | null };
};
export type ReadyCopyHistoryRow = {
  generation: number; state: CloudV2ReadyCopy["state"]; startedAt: string | null; finishedAt: string | null;
  /** What each repository was cloned at; null until the generation is ready. */
  repositories: ReadyCopyRepositoryResult[] | null; trigger: ReadyCopyTrigger | null;
  /** A finer reason the history line shows instead of `trigger` (the submodules switch). */
  triggerDetail?: "submodules_changed"; startedBy: string | null;
  failure: { reason: string; repository: string | null; step: ReadyCopyStep | null; detail: string | null } | null; output: boolean;
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
    ...(latest?.state === "failed" ? { failure: { reason: latest.failureReason ?? "ready_copy_failed", repository: latest.failureRepository,
      step: latest.failureStep, detail: latest.failureDetail, failures: Math.max(retry.failures, 1), nextRetryAt: retry.nextAt?.toISOString() ?? null } } : {}) };
}

export function readyCopyHistory(history: readonly CloudV2ReadyCopy[], people: ReadonlyMap<string, string>): ReadyCopyHistoryRow[] {
  return history.map(row => ({
    generation: row.generation, state: row.state, startedAt: row.startedAt?.toISOString() ?? null, finishedAt: row.finishedAt?.toISOString() ?? null,
    repositories: row.result, trigger: row.trigger, ...(row.triggerDetail ? { triggerDetail: row.triggerDetail } : {}),
    startedBy: row.trigger === "manual" && row.triggeredBy ? people.get(row.triggeredBy) ?? "A member" : null,
    failure: row.state === "failed" ? { reason: row.failureReason ?? "ready_copy_failed", repository: row.failureRepository, step: row.failureStep,
      detail: row.failureDetail } : null,
    output: !!row.setupOutput,
  }));
}
