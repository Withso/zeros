import { poll } from "./io";
import { requireCheck } from "./contracts";

export const REQUIRED_CI = [
  { file: "preflight.yml", name: "Preflight" },
  { file: "codeql.yml", name: "CodeQL" },
] as const;
type Candidate = { repository: string; sourceSha: string };
type WorkflowRun = {
  id: number; run_attempt: number; name: string; path: string; head_sha: string;
  status: string; conclusion: string | null; event: string;
  repository: { full_name: string }; head_repository: { full_name: string };
};
export type RequiredCIEvidence = Array<{ workflow: string; runId: number; attempt: number; succeeded: boolean }>;

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
    succeeded: latest?.status === "completed" && latest.conclusion === "success" };
}

export function assertRequiredCI(evidence: RequiredCIEvidence): void {
  requireCheck(evidence.length === REQUIRED_CI.length && REQUIRED_CI.every(check => evidence.some(item => item.workflow === check.name && item.succeeded)),
    "Exact-source Preflight and CodeQL must both succeed before any provider or feed mutation");
}

export async function waitForRequiredCI(read: () => Promise<RequiredCIEvidence>, options: Parameters<typeof poll>[1] = {}) {
  return poll(async () => {
    const evidence = await read();
    return REQUIRED_CI.every(check => evidence.some(item => item.workflow === check.name && item.succeeded)) ? evidence : false;
  }, { attempts: 660, timeoutMs: 110 * 60_000, ...options });
}
