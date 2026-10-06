import { PromotionError, requireCheck, SHA } from "./contracts";
import { type RequiredCIEvidence } from "./ci";
import { AlphaAdmissionReceipt } from "./alpha-frontier";

type Candidate = { repository: string; sourceSha: string; branch: string };
type Read = (route: string) => Promise<any>;
type Run = {
  id: number; run_attempt: number; name: string; path: string; head_sha: string; head_branch: string;
  event: string; status: string; conclusion: string | null;
  repository: { full_name: string }; head_repository: { full_name: string };
};

export class CandidateSupersededError extends PromotionError {
  constructor() { super("Candidate was superseded before mutation; run the current branch SHA"); }
}

/** Reusable workflows retain the caller's run identity and workflow ref. The
 * authenticated parent, never the env flag or workflow ref alone, grants the
 * automatic Alpha policy. Default and direct callers retain full CI. */
export async function automaticAlpha(candidate: Candidate, env: NodeJS.ProcessEnv, read: Read): Promise<boolean> {
  if (env.RELEASE_CHANNEL !== "alpha" || candidate.branch !== "main" || env.RELEASE_SHA !== candidate.sourceSha ||
    env.GITHUB_SHA !== candidate.sourceSha || env.GITHUB_REPOSITORY !== candidate.repository ||
    env.GITHUB_WORKFLOW_REF !== `${candidate.repository}/.github/workflows/release-alpha.yml@refs/heads/main` ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? "") || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? "")) return false;
  const id = Number(env.GITHUB_RUN_ID), attempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(attempt)) return false;
  const run = await read(`/actions/runs/${id}`) as Run | null;
  return !!run && run.id === id && run.run_attempt === attempt && run.path === ".github/workflows/release-alpha.yml" &&
    run.event === "push" && run.head_branch === "main" && run.head_sha === candidate.sourceSha &&
    run.repository?.full_name === candidate.repository && run.head_repository?.full_name === candidate.repository;
}

function trustedRun(candidate: Candidate, file: string, name: string, run: Run | null | undefined): run is Run {
  return !!run && run.head_sha === candidate.sourceSha && (file !== "preflight.yml" || run.head_branch === "main") && run.event === "push" &&
    run.repository?.full_name === candidate.repository && run.head_repository?.full_name === candidate.repository &&
    run.path === `.github/workflows/${file}` && run.name === name &&
    Number.isSafeInteger(run.id) && run.id > 0 && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0;
}

function newestRun(candidate: Candidate, file: string, name: string, value: unknown) {
  const response = value as { total_count?: unknown; workflow_runs?: unknown } | null;
  requireCheck(response && Number.isSafeInteger(response.total_count) && Number(response.total_count) >= 0 && Number(response.total_count) <= 100 &&
    Array.isArray(response.workflow_runs) && response.workflow_runs.length === response.total_count, "Required CI history is unavailable or exceeds its bound");
  return (response.workflow_runs as Run[]).filter(run => trustedRun(candidate, file, name, run))
    .sort((left, right) => right.id - left.id || right.run_attempt - left.run_attempt)[0];
}

export async function jobPages(read: Read, route: string) {
  const jobs: any[] = [];
  let total: number | undefined;
  for (let page = 1; page <= 10; page++) {
    const response = await read(`${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    requireCheck(response && Number.isSafeInteger(response.total_count) && response.total_count >= 0 && response.total_count <= 1000 &&
      Array.isArray(response.jobs) && response.jobs.length <= 100 && (total === undefined || total === response.total_count),
    "Alpha job evidence is unavailable or exceeds its bound");
    total = response.total_count;
    jobs.push(...response.jobs);
    if (response.jobs.length < 100) {
      requireCheck(jobs.length === total, "Alpha job evidence is incomplete");
      return jobs;
    }
  }
  requireCheck(jobs.length === total, "Alpha job evidence exceeds its bound");
  return jobs;
}

// These exact Preflight step identities own artifact, sandbox, credential and
// path-access proof. Pending Darwin work is deferred; observed security failure
// is never an ancillary exception. Unknown/mixed failing steps also deny.
const DEFERRED_MAC_FAILURES = new Set([
  "Packaged engine health + workspace lifecycle", "Workspace lifecycle contracts", "Changes / Review contracts",
]);
const CRITICAL_JOBS = new Set(["quality", "test", "build", "control plane", "secret scan (PR commit range)"]);
function securityVeto(jobs: any[]) {
  return jobs.some(job => {
    if (job?.name !== "source-sync workload (macOS)") return false;
    const failed = Array.isArray(job.steps) ? job.steps.filter((step: any) => step?.conclusion === "failure") : [];
    if (job.status === "completed" && !["success", "failure"].includes(job.conclusion)) return true;
    if (job.conclusion !== "failure" && failed.length === 0) return false;
    return failed.length === 0 || failed.some((step: any) => !DEFERRED_MAC_FAILURES.has(step.name));
  });
}

/** Automatic Alpha's fast path waits only for Preflight's exact-SHA alpha-gate.
 * CodeQL stays required for Beta, Production and every full-policy caller;
 * its findings are advisory, so the disposable Alpha ring does not wait for
 * the scan to finish. */
export const ALPHA_REQUIRED_CI = [{ file: "preflight.yml", name: "Preflight" }] as const;
export const ALPHA_CI_FAILURE = "Exact-source Alpha gate must succeed before any provider or feed mutation";

export async function alphaRequiredChecks(candidate: Candidate, read: Read): Promise<RequiredCIEvidence> {
  return Promise.all(ALPHA_REQUIRED_CI.map(async check => {
    const run = newestRun(candidate, check.file, check.name,
      await read(`/actions/workflows/${check.file}/runs?head_sha=${candidate.sourceSha}&event=push&per_page=100`));
    const evidence = { workflow: check.name, runId: run?.id ?? 0, attempt: run?.run_attempt ?? 0, succeeded: false };
    if (!run) return evidence;
    // Main Preflight coalesces pushes: a newer push replaces a pending run, so
    // its gate never reports. A failed gate or a completed attempt without a
    // green gate also cannot succeed without a rerun. Once main has moved on,
    // supersede such a candidate instead of waiting out the barrier; only the
    // unmutated initial barrier turns that into a green skip.
    const unshippable = async () => {
      const head = await read(`/commits/${encodeURIComponent(candidate.branch)}`);
      requireCheck(typeof head?.sha === "string" && SHA.test(head.sha), "Current main identity is unavailable for automatic Alpha");
      if (head.sha !== candidate.sourceSha) throw new CandidateSupersededError();
      return evidence;
    };
    if (run.conclusion === "cancelled") return unshippable();
    const jobs = await jobPages(read, `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`);
    const gates = jobs.filter(job => job?.name === "alpha-gate");
    const gate = gates[0];
    // Listing in this attempt's endpoint authenticates carried successes. An
    // older run_attempt on a carried row is valid; timestamps prove nothing.
    if (gates.length !== 1 || gate.run_id !== run.id || gate.head_sha !== candidate.sourceSha ||
      gate.head_branch !== "main" || gate.status !== "completed" || gate.conclusion !== "success" ||
      gate.run_attempt !== undefined && (!Number.isSafeInteger(gate.run_attempt) || gate.run_attempt < 1 || gate.run_attempt > run.run_attempt) ||
      jobs.some(job => CRITICAL_JOBS.has(job?.name) && (job.run_id !== run.id || job.head_sha !== candidate.sourceSha ||
        job.status !== "completed" || job.conclusion !== "success")) || securityVeto(jobs)) {
      const failedGate = gates.length === 1 && gate.status === "completed" && gate.conclusion !== "success";
      return failedGate || run.status === "completed" ? unshippable() : evidence;
    }
    // A rerun/cancellation during pagination must invalidate the old snapshot.
    const current = await read(`/actions/runs/${run.id}`) as Run | null;
    return { ...evidence, succeeded: trustedRun(candidate, check.file, check.name, current) && current.id === run.id &&
      current.run_attempt === run.run_attempt && current.conclusion !== "cancelled" };
  }));
}

/** Only the initial barrier may turn supersession into a green no-op. Inspect
 * all retained attempts so retrying CI after a previous services/feed write
 * cannot claim the parent never mutated a destination. */
export async function alphaBarrierUnmutated(candidate: Candidate, env: NodeJS.ProcessEnv, read: Read) {
  if (env.GITHUB_JOB !== "ci" || !await automaticAlpha(candidate, env, read)) return false;
  const jobs = await jobPages(read, `/actions/runs/${env.GITHUB_RUN_ID}/jobs?filter=all`);
  const readOnly = new Set(["Exact-source Preflight and CodeQL barrier", "Prepare Alpha version", "Build Linux runtime bundle",
    "Build + sign Alpha (macOS arm64 · NOT notarized)"]);
  requireCheck(jobs.length > 0 && jobs.every(job => job && job.run_id === Number(env.GITHUB_RUN_ID) && job.head_sha === candidate.sourceSha &&
    job.head_branch === "main" && typeof job.name === "string"), "Alpha parent mutation evidence is unavailable");
  return !jobs.some(job => job.name === "Exact-source Preflight and CodeQL barrier" && job.conclusion === "success") &&
    jobs.some(job => job.name === "Exact-source Preflight and CodeQL barrier" && job.status === "in_progress" && job.run_attempt === Number(env.GITHUB_RUN_ATTEMPT)) &&
    jobs.every(job => readOnly.has(job.name) || !job.started_at && (job.status === "queued" || job.status === "completed" && job.conclusion === "skipped"));
}

/** A successful barrier can also be a green ready=false skip. Only its own
 * uploaded receipt proves admission, including on a desktop-only retry. */
export async function assertAlphaAdmission(candidate: Candidate, env: NodeJS.ProcessEnv, read: Read, receipt: unknown) {
  const parsed = AlphaAdmissionReceipt.safeParse(receipt);
  requireCheck(parsed.success, "Automatic Alpha admission receipt is invalid");
  const value = parsed.data, attempt = Number(value.runAttempt), currentAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  requireCheck(value.repository === candidate.repository && value.sourceSha === candidate.sourceSha && value.branch === candidate.branch &&
    value.runId === env.GITHUB_RUN_ID && Number.isSafeInteger(attempt) && attempt > 0 && attempt <= currentAttempt,
  "Automatic Alpha admission receipt belongs to another source, run or attempt");
  const jobs = await jobPages(read, `/actions/runs/${value.runId}/attempts/${attempt}/jobs`);
  const barriers = jobs.filter(job => job?.name === "Exact-source Preflight and CodeQL barrier");
  requireCheck(barriers.length === 1 && barriers[0].run_id === Number(value.runId) && barriers[0].head_sha === candidate.sourceSha &&
    barriers[0].head_branch === "main" && (barriers[0].run_attempt === undefined || barriers[0].run_attempt === attempt) &&
    barriers[0].status === "completed" && barriers[0].conclusion === "success" &&
    ["Wait for exact-source Alpha CI", "Save Alpha admission receipt"].every(name =>
      barriers[0].steps?.some((step: any) => step.name === name && step.status === "completed" && step.conclusion === "success")),
  "Automatic Alpha admission has no successful producing barrier and receipt upload");
}

export function supersededCandidate(currentSha: unknown): never {
  if (typeof currentSha === "string" && SHA.test(currentSha)) throw new CandidateSupersededError();
  throw new PromotionError("Candidate was superseded before mutation; run the current branch SHA");
}
