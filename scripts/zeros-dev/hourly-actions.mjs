import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createGitHubApi } from "../ci/recovery-api.mjs";
import { reviewedPrestartRecovery } from "./prestart-recovery.mjs";
import { reviewedChainRestart } from "./chain-restart.mjs";

export const HOURLY_PATH = ".github/workflows/zeros-dev-e2e.yml";
export const HOURLY_NAME = "Zeros dev E2E";
export const REPO = "/repos/Withso/zeros";
const WORKFLOW = `${REPO}/actions/workflows/zeros-dev-e2e.yml`;
const SKIPPED_PROFILE_JOB_NAME = "inputs.profile == 'gate0' && 'gate0' || 'lifecycle'";
const SKIPPED_INFRASTRUCTURE_JOB_NAME = "(inputs.profile == 'infrastructure' || (github.event_name == 'schedule' && vars.ZEROS_DEV_INFRASTRUCTURE_ENABLED == 'true')) && 'infrastructure' || (inputs.profile == 'gate0' && 'gate0' || 'lifecycle')";
const integer = value => Number.isSafeInteger(value) && value > 0;
const identifier = value => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value);
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const failure = code => new Error(`zeros_dev_${code}`);
export function hourlyContext(env) {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== "Withso/zeros" || env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_WORKFLOW_REF !== `Withso/zeros/${HOURLY_PATH}@refs/heads/main` || !["schedule", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME) ||
    !identifier(env.GITHUB_RUN_ID) || !/^[1-9][0-9]{0,1}$/.test(env.GITHUB_RUN_ATTEMPT ?? "") || !sha(env.GITHUB_SHA)) throw failure("actions_required");
  return { workflowRunId: env.GITHUB_RUN_ID, attempt: Number(env.GITHUB_RUN_ATTEMPT), sourceSha: env.GITHUB_SHA };
}
export function actionsProfile(env) {
  hourlyContext(env);
  const profile = env.ZEROS_DEV_PROFILE ?? "hourly";
  if (!["hourly", "gate0", "infrastructure"].includes(profile) || profile === "gate0" && env.GITHUB_EVENT_NAME !== "workflow_dispatch")
    throw failure("actions_required");
  return profile;
}
export function trustedHourlyRun(run) {
  return run?.path === HOURLY_PATH && run.name === HOURLY_NAME && run.head_branch === "main" &&
    run.repository?.full_name === "Withso/zeros" && run.head_repository?.full_name === "Withso/zeros" &&
    ["schedule", "workflow_dispatch"].includes(run.event) && integer(run.id) && integer(run.run_number) &&
    integer(run.run_attempt) && run.run_attempt <= 100 && sha(run.head_sha);
}
function collection(value, key) {
  if (!value || !Number.isSafeInteger(value.total_count) || value.total_count < 0 || !Array.isArray(value[key]) ||
    value[key].length > 100 || value.total_count < value[key].length)
    throw failure("artifact_invalid");
  return value[key];
}

export async function lifecycleJob(api, run) {
  const response = await api.get(`${REPO}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  const jobs = collection(response, "jobs");
  if (response.total_count !== jobs.length || jobs.length !== 1 ||
    jobs[0].run_attempt !== run.run_attempt || jobs[0].status !== "completed" || !Array.isArray(jobs[0].steps)) throw failure("artifact_invalid");
  const job = jobs[0];
  // GitHub leaves this name unevaluated when the job-level condition skips it.
  // Only schedule proves the profile; preserve the skip so it can never be green.
  if (job.name === SKIPPED_PROFILE_JOB_NAME && run.event === "schedule" && run.status === "completed" &&
    job.conclusion === "skipped" && job.steps.length === 0) return { ...job, name: "lifecycle" };
  // The current expression also depends on a variable. A skipped job cannot
  // identify its chosen profile; it is only proof that no product step ran.
  if (job.name === SKIPPED_INFRASTRUCTURE_JOB_NAME && run.event === "schedule" && run.status === "completed" &&
    job.conclusion === "skipped" && job.steps.length === 0) return { ...job, name: "unselected" };
  if (!["lifecycle", "gate0", "infrastructure"].includes(job.name) || job.name === "gate0" && run.event !== "workflow_dispatch") throw failure("artifact_invalid");
  return job;
}
function productNeverStarted(job) {
  if (job.conclusion === "skipped" && job.steps.length === 0) return true;
  const steps = job.steps.filter(step => step.name === "Execute Alpha product lifecycle");
  return steps.length === 1 && steps[0].status === "completed" && steps[0].conclusion === "skipped";
}
export function productCompleted(job, profile = "lifecycle") {
  return ["lifecycle", "gate0", "infrastructure"].includes(profile) && job.name === profile && job.conclusion === "success" && ["Execute Alpha product lifecycle", "Save signed cleanup receipt"].every(name => {
    const steps = job.steps.filter(step => step.name === name);
    return steps.length === 1 && steps[0].status === "completed" && steps[0].conclusion === "success";
  });
}

export async function planHourly(api, execution) {
  const current = await api.get(`${REPO}/actions/runs/${execution.workflowRunId}`);
  if (!trustedHourlyRun(current) || current.status !== "in_progress" || current.run_attempt !== execution.attempt || current.head_sha !== execution.sourceSha)
    throw failure("actions_required");
  const response = await api.get(`${WORKFLOW}/runs?branch=main&per_page=100`), rows = collection(response, "workflow_runs");
  if (!rows.some(run => run.id === current.id && run.run_attempt === current.run_attempt) ||
    rows.some(run => !trustedHourlyRun(run) || run.run_number > current.run_number && !["queued", "waiting", "requested"].includes(run.status)))
    throw failure("artifact_invalid");
  const older = rows.filter(run => run.run_number < current.run_number).sort((a, b) => b.run_number - a.run_number);
  const predecessor = async run => run.run_attempt > 1
    ? api.get(`${REPO}/actions/runs/${run.id}/attempts/${run.run_attempt - 1}`) : older.shift();
  let previous = await predecessor(current);
  let prestartRecovery;
  for (let inspected = 0; previous && inspected < 100; inspected++) {
    if (!trustedHourlyRun(previous) || previous.status !== "completed") throw failure("artifact_invalid");
    const listed = await api.get(`${REPO}/actions/runs/${previous.id}/artifacts?per_page=100`), artifacts = collection(listed, "artifacts");
    if (listed.total_count !== artifacts.length) throw failure("artifact_invalid");
    const matches = artifacts.filter(row => row.name === `zeros-dev-receipt-${previous.id}-${previous.run_attempt}`), artifact = matches[0];
    if (matches.length === 0) {
      const job = await lifecycleJob(api, previous);
      if (productNeverStarted(job)) { previous = await predecessor(previous); continue; }
      const reviewed = reviewedPrestartRecovery(previous, job);
      if (reviewed && !prestartRecovery) { prestartRecovery = reviewed; previous = await predecessor(previous); continue; }
    }
    if (matches.length !== 1 || !integer(artifact.id) || artifact.expired || !Number.isSafeInteger(artifact.size_in_bytes) ||
      artifact.size_in_bytes <= 0 || artifact.size_in_bytes > 2 * 1024 * 1024 || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "") ||
      artifact.workflow_run?.id !== previous.id || artifact.workflow_run?.head_sha !== previous.head_sha) throw failure("artifact_invalid");
    // Its signer is retired, so the exact receipt starts a new chain instead.
    const chainRestart = reviewedChainRestart(previous, artifact);
    if (chainRestart) return { execution, bootstrap: true, previous: null, artifactId: null, chainRestart, ...(prestartRecovery ? { prestartRecovery } : {}) };
    return { execution, bootstrap: false, previous: { workflowRunId: String(previous.id), attempt: previous.run_attempt, sourceSha: previous.head_sha }, artifactId: String(artifact.id),
      ...(prestartRecovery ? { prestartRecovery } : {}) };
  }
  if (previous || response.total_count !== rows.length) throw failure("artifact_invalid");
  return { execution, bootstrap: true, previous: null, artifactId: null, ...(prestartRecovery ? { prestartRecovery } : {}) };
}

export async function hourlySnapshot(api) {
  // Query successes separately: a long red sequence must never reset the
  // activation latch merely because the first green fell off the recent page.
  const greens = await api.get(`${WORKFLOW}/runs?branch=main&status=success&per_page=100`);
  const successes = collection(greens, "workflow_runs");
  if (successes.some(run => !trustedHourlyRun(run) || run.status !== "completed" || run.conclusion !== "success")) throw failure("artifact_invalid");
  const rows = await api.get(`${WORKFLOW}/runs?branch=main&per_page=100`);
  const runs = collection(rows, "workflow_runs");
  if (runs.some(run => !trustedHourlyRun(run))) throw failure("artifact_invalid");
  runs.sort((a, b) => b.run_number - a.run_number);
  if (!runs.length && rows.total_count) throw failure("artifact_invalid");
  const previousAttempts = new Map();
  const jobs = new Map();
  const jobFor = async run => {
    const key = `${run.id}/${run.run_attempt}`;
    if (!jobs.has(key)) jobs.set(key, await lifecycleJob(api, run));
    return jobs.get(key);
  };
  const previousAttempt = async (run, attempt) => {
    const key = `${run.id}/${attempt}`;
    if (!previousAttempts.has(key)) {
      const previous = await api.get(`${REPO}/actions/runs/${run.id}/attempts/${attempt}`);
      if (!trustedHourlyRun(previous) || previous.id !== run.id || previous.run_number !== run.run_number ||
        previous.run_attempt !== attempt || previous.head_sha !== run.head_sha || previous.status !== "completed") throw failure("artifact_invalid");
      previousAttempts.set(key, previous);
    }
    return previousAttempts.get(key);
  };
  // Admission uses completed evidence. A newer run in flight cannot replace
  // it, including when GitHub hides the prior attempt behind an active rerun.
  let latest = null;
  for (const run of runs) {
    let completed = run;
    if (run.status !== "completed") {
      if (!["queued", "waiting", "requested", "pending", "in_progress"].includes(run.status)) throw failure("artifact_invalid");
      if (run.run_attempt <= 1) continue;
      completed = await previousAttempt(run, run.run_attempt - 1);
    }
    // The manual rehearsal shares cleanup ownership, never the hourly merge
    // requirement. Its longer/red run must neither activate nor replace it.
    if ((await jobFor(completed)).name === "lifecycle") { latest = completed; break; }
  }
  let activated = false;
  for (const run of successes) if (productCompleted(await jobFor(run))) { activated = true; break; }
  if (!activated) {
    // GitHub's success filter shows the latest attempt only. A rerun of the
    // first green must not erase activation when that new attempt goes red.
    let inspected = 0;
    history: for (const run of runs) {
      for (let attempt = run.run_attempt - 1; attempt >= 1; attempt--) {
        if (++inspected > 100) throw failure("artifact_invalid");
        const previous = await previousAttempt(run, attempt);
        if (previous.conclusion === "success" && productCompleted(await jobFor(previous))) { activated = true; break history; }
      }
    }
  }
  if (!activated) {
    if (greens.total_count !== successes.length || rows.total_count !== runs.length) throw failure("artifact_invalid");
    return { activated: false, latest, completedAt: null };
  }
  if (!latest) throw failure("artifact_invalid");
  const job = await jobFor(latest);
  if (!Number.isFinite(Date.parse(job.completed_at))) throw failure("artifact_invalid");
  return { activated: true, latest, completedAt: job.completed_at, executed: productCompleted(job) };
}

export function decideHourlyGate(snapshot, cloudRequired, now = Date.now()) {
  let code;
  if (snapshot?.activated === false) code = "hourly_not_live";
  else if (!snapshot || snapshot.activated !== true || !trustedHourlyRun(snapshot.latest)) code = "hourly_unavailable";
  else if (["queued", "waiting", "requested", "pending", "in_progress"].includes(snapshot.latest.status)) code = "hourly_running";
  else if (snapshot.latest.status !== "completed") code = "hourly_unavailable";
  else if (snapshot.latest.conclusion !== "success" || snapshot.executed !== true) code = "hourly_failed";
  else {
    const age = now - Date.parse(snapshot.completedAt);
    code = !Number.isFinite(age) || age < -60_000 ? "hourly_unavailable" : age >= 2 * 60 * 60_000 ? "hourly_stale" : "hourly_green";
  }
  const good = ["hourly_not_live", "hourly_green"].includes(code);
  return { allowed: good || !cloudRequired, code, alert: !good, activated: snapshot?.activated === true };
}

// A restart still restores the retired receipt, only so its exact bytes are
// checked against the reviewed digest. It is never imported or authenticated.
export function planOutputs(plan) {
  const source = plan.previous?.workflowRunId ?? plan.chainRestart?.workflowRunId ?? "";
  return `plan=${JSON.stringify(plan)}\nprevious_run=${source}\nartifact_id=${plan.artifactId ?? plan.chainRestart?.artifactId ?? ""}\n`;
}

export async function planMain(env = process.env) {
  try {
    const execution = hourlyContext(env), api = createGitHubApi({ token: env.GITHUB_TOKEN });
    const plan = { ...await planHourly(api, execution), profile: actionsProfile(env) };
    if (!env.GITHUB_OUTPUT) throw failure("actions_required");
    appendFileSync(env.GITHUB_OUTPUT, planOutputs(plan));
    return 0;
  } catch (error) {
    const code = error instanceof Error && error.message === "zeros_dev_chain_restart_mismatch" ? "chain_restart_mismatch" : "artifact_invalid";
    process.stderr.write(`{"schema":"zeros.dev-error/v1","code":"${code}"}\n`); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void planMain().then(code => { process.exitCode = code; });
}
