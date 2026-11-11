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
  status: string; conclusion: string | null; event: string;
  repository: { full_name: string }; head_repository: { full_name: string };
};
/** `failed`: the newest attempt completed without success. It cannot turn
 * green; only a newer attempt can. */
export type RequiredCIEvidence = Array<{ workflow: string; runId: number; attempt: number; succeeded: boolean; failed?: boolean }>;
/** CI Recovery reconciles failed main Preflight every 15 minutes and may start
 * one rerun; a person can start one too. Past this, nothing is coming. */
export const FAILED_CI_GRACE_MS = 20 * 60_000;

export function requiredCIEvidence(candidate: Candidate, file: string, name: string, value: unknown): RequiredCIEvidence[number] {
  const response = value as { total_count?: unknown; workflow_runs?: unknown } | null;
  requireCheck(response && Number.isSafeInteger(response.total_count) && Number(response.total_count) >= 0 && Number(response.total_count) <= 100 &&
    Array.isArray(response.workflow_runs) && response.workflow_runs.length === response.total_count, "Required CI history is unavailable or exceeds its bound");
  const runs = (response.workflow_runs as WorkflowRun[]).filter(run => run && run.head_sha === candidate.sourceSha &&
    run.repository?.full_name === candidate.repository && run.head_repository?.full_name === candidate.repository &&
    run.path === `.github/workflows/${file}` && run.name === name && ["push", "pull_request", "merge_group"].includes(run.event) &&
    Number.isSafeInteger(run.id) && run.id > 0 && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0)
    .sort((left, right) => right.id - left.id || right.run_attempt - left.run_attempt);
  const latest = runs[0];
  return { workflow: name, runId: latest?.id ?? 0, attempt: latest?.run_attempt ?? 0,
    succeeded: latest?.status === "completed" && latest.conclusion === "success",
    failed: latest?.status === "completed" && latest.conclusion !== "success" };
}

export function assertRequiredCI(evidence: RequiredCIEvidence, required: readonly RequiredWorkflow[] = REQUIRED_CI,
  failure = "Exact-source Preflight and CodeQL must both succeed before any provider or feed mutation"): void {
  requireCheck(evidence.length === required.length && required.every(check => evidence.some(item => item.workflow === check.name && item.succeeded)),
    failure);
}

export async function waitForRequiredCI(read: () => Promise<RequiredCIEvidence>,
  options: NonNullable<Parameters<typeof poll>[1]> & { graceMs?: number; now?: () => number } = {},
  required: readonly RequiredWorkflow[] = REQUIRED_CI) {
  const { graceMs = FAILED_CI_GRACE_MS, now = Date.now, ...polling } = options;
  // When each workflow's current failed attempt was first seen. A newer
  // attempt, pending or failed, starts its own clock.
  const failedSince = new Map<string, { attempt: string; since: number }>();
  return poll(async () => {
    const evidence = await read();
    for (const check of required) {
      const item = evidence.find(candidate => candidate.workflow === check.name);
      if (!item?.failed) { failedSince.delete(check.name); continue; }
      const attempt = `${item.runId}:${item.attempt}`, seen = failedSince.get(check.name);
      const since = seen?.attempt === attempt ? seen.since : now();
      failedSince.set(check.name, { attempt, since });
      if (now() - since >= graceMs) throw new PromotionError(
        `${check.name} failed for this exact source and was not re-run within ${Math.round(graceMs / 60_000)} minutes. Re-run its failed jobs, then re-run this job; no downstream publication is authorized`);
    }
    return required.every(check => evidence.some(item => item.workflow === check.name && item.succeeded)) ? evidence : false;
  }, { attempts: 660, timeoutMs: 110 * 60_000, ...polling });
}
