import { poll } from "./io";
import { PromotionError, requireCheck } from "./contracts";

export const REQUIRED_CI = [
  { file: "preflight.yml", name: "Preflight" },
  { file: "codeql.yml", name: "CodeQL" },
] as const;
export type RequiredWorkflow = { readonly file: string; readonly name: string };
type Candidate = { repository: string; sourceSha: string };
type WorkflowRun = {
  id: number; run_attempt: number; name: string; path: string; head_sha: string;
  status: string; conclusion: string | null; event: string; head_branch?: string;
  repository: { full_name: string }; head_repository: { full_name: string };
};
/** `failed` names a newest run/attempt that already concluded without
 * success; only a fail-fast wait acts on it (a rerun is a newer attempt). */
export type RequiredCIEvidence = Array<{ workflow: string; runId: number; attempt: number; succeeded: boolean; failed?: string }>;

const MAIN_QUEUE_BRANCH = /^gh-readonly-queue\/main\/pr-[1-9]\d*-[a-f\d]{40}$/;

/** `mergeGroup` (automatic Alpha runtime only): a successful run from main's
 * merge queue for exactly this SHA is the exact-source evidence; the queue
 * fast-forwarded main to that commit, so the push run only repeats it. A
 * failed, pending or foreign merge group falls back to the newest run. */
export function requiredCIEvidence(candidate: Candidate, file: string, name: string, value: unknown,
  options: { mergeGroup?: boolean } = {}): RequiredCIEvidence[number] {
  const response = value as { total_count?: unknown; workflow_runs?: unknown } | null;
  requireCheck(response && Number.isSafeInteger(response.total_count) && Number(response.total_count) >= 0 && Number(response.total_count) <= 100 &&
    Array.isArray(response.workflow_runs) && response.workflow_runs.length === response.total_count, "Required CI history is unavailable or exceeds its bound");
  const runs = (response.workflow_runs as WorkflowRun[]).filter(run => run && run.head_sha === candidate.sourceSha &&
    run.repository?.full_name === candidate.repository && run.head_repository?.full_name === candidate.repository &&
    run.path === `.github/workflows/${file}` && run.name === name && ["push", "pull_request", "merge_group"].includes(run.event) &&
    Number.isSafeInteger(run.id) && run.id > 0 && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0)
    .sort((left, right) => right.id - left.id || right.run_attempt - left.run_attempt);
  const group = options.mergeGroup ? runs.find(run => run.event === "merge_group" && typeof run.head_branch === "string" &&
    MAIN_QUEUE_BRANCH.test(run.head_branch)) : undefined;
  if (group?.status === "completed" && group.conclusion === "success")
    return { workflow: name, runId: group.id, attempt: group.run_attempt, succeeded: true };
  const latest = runs[0];
  const succeeded = latest?.status === "completed" && latest.conclusion === "success";
  return { workflow: name, runId: latest?.id ?? 0, attempt: latest?.run_attempt ?? 0, succeeded,
    ...(latest?.status === "completed" && !succeeded ? { failed: String(latest.conclusion ?? "without a conclusion") } : {}) };
}

export function assertRequiredCI(evidence: RequiredCIEvidence, required: readonly RequiredWorkflow[] = REQUIRED_CI,
  failure = "Exact-source Preflight and CodeQL must both succeed before any provider or feed mutation"): void {
  requireCheck(evidence.length === required.length && required.every(check => evidence.some(item => item.workflow === check.name && item.succeeded)),
    failure);
}

/** `failFast` stops as soon as a required run has concluded without success,
 * instead of polling the full window for a rerun. Automatic Alpha uses it: a
 * waiting runtime job holds the Alpha publication lock, and a new push to
 * main, not a release rerun, is the recovery. */
export async function waitForRequiredCI(read: () => Promise<RequiredCIEvidence>,
  options: Parameters<typeof poll>[1] & { failFast?: boolean } = {}, required: readonly RequiredWorkflow[] = REQUIRED_CI) {
  const { failFast = false, ...pollOptions } = options;
  return poll(async () => {
    const evidence = await read();
    if (required.every(check => evidence.some(item => item.workflow === check.name && item.succeeded))) return evidence;
    const failed = failFast ? evidence.find(item => item.failed && required.some(check => check.name === item.workflow)) : undefined;
    if (failed) throw new PromotionError(`Exact-source ${failed.workflow} run ${failed.runId} attempt ${failed.attempt} concluded ${failed.failed}; ` +
      "stopping now instead of waiting for a rerun. A new push to main ships the next candidate.");
    return false;
  }, { attempts: 660, timeoutMs: 110 * 60_000, ...pollOptions });
}
