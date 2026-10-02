import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DIGEST, SHA, requireCheck } from "./contracts";
import { command, type Command } from "./io";
import { githubClient, validateServicesReceipt } from "./github";
import { assertRequiredCI } from "./ci";
import { RetentionIntentSchema, RetentionProducerSchema, RetentionSubjectSchema, retentionIntentKey, retentionRunTitle,
  type RetentionIntent, type RetentionProducer, type RetentionSubject } from "./worker-retention-resume";

export const RETENTION_WORKFLOW = "worker-retention-resume.yml";
const conflicts = new Set(["release-alpha.yml", "release-beta.yml", "release.yml", "cloud-worker-promotion.yml", "cloud-provision.yml",
  "controlled-cutover.yml", "cloud-runtime-publication.yml", "zsr-cloud-qualification.yml"].map(file => `.github/workflows/${file}`));
const readOnlyWorkflows = new Set(["preflight.yml", "codeql.yml", "lint-ci.yml", "scheduled.yml", "uptime.yml", RETENTION_WORKFLOW]
  .map(file => `.github/workflows/${file}`));
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const workflowFor = (channel: RetentionSubject["channel"]) => channel === "production" ? "release.yml" : `release-${channel}.yml`;
const positive = (value: unknown) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const completed = (step: any) => step?.status === "completed" && step.conclusion === "success";
const executionStep = (job: any) => job.steps?.find((step: any) => step.name === "Worker plan or guarded execution");

export function retentionGithubClient(repository: string, env: NodeJS.ProcessEnv, options: { fetch?: typeof fetch; command?: Command; now?: () => number } = {}) {
  requireCheck(/^[\w.-]+\/[\w.-]+$/.test(repository) && env.GH_TOKEN?.trim(), "Observer repository Actions authority is missing");
  const fetcher = options.fetch ?? fetch, runCommand = options.command ?? command, now = options.now ?? Date.now;
  const base = `https://api.github.com/repos/${repository}`;
  const headers = { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  async function read(route: string) {
    const response = await fetcher(`${base}${route}`, { headers, redirect: "error", signal: AbortSignal.timeout(20_000) });
    requireCheck(response.status === 200, "Required GitHub observation is unavailable");
    const bytes = await response.text(); requireCheck(bytes.length <= 2 * 1024 * 1024, "GitHub observation exceeds its bound");
    return JSON.parse(bytes);
  }
  async function list(route: string, field: "workflow_runs" | "jobs" | "artifacts") {
    const values: any[] = [], seen = new Set<number>(); let total: number | undefined;
    for (let page = 1; page <= 10; page++) {
      const result = await read(`${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      requireCheck(Number.isSafeInteger(result.total_count) && result.total_count >= 0 && result.total_count <= 1000 &&
        Array.isArray(result[field]) && result[field].length <= 100 && (total === undefined || total === result.total_count),
        "GitHub inventory is incomplete or exceeds its bound");
      total = result.total_count;
      for (const item of result[field]) {
        requireCheck(positive(item?.id) && !seen.has(item.id), "GitHub inventory has a missing or repeated identity");
        seen.add(item.id); values.push(item);
      }
      if (values.length === total) return values;
      requireCheck(result[field].length === 100 && values.length < Number(total), "GitHub inventory is incomplete");
    }
    throw new Error("GitHub inventory exceeds its bound");
  }
  function ownRun(run: any, source: RetentionSubject, workflow: string, event: string) {
    requireCheck(positive(run.id) && positive(run.run_attempt) && run.run_attempt <= 50 && run.repository?.full_name === repository &&
      run.repository.fork === false && run.head_repository?.full_name === repository && run.head_repository.fork === false &&
      run.path === `.github/workflows/${workflow}` && run.event === event && run.head_sha === source.sourceSha && run.head_branch === source.branch,
      "Workflow is not the exact trusted repository/source/ref/event");
  }
  function ownJob(job: any, run: any, attempt: number) {
    requireCheck(positive(job.id) && job.run_id === run.id && job.head_sha === run.head_sha && job.head_branch === run.head_branch &&
      (job.run_attempt === undefined || job.run_attempt === attempt) && Array.isArray(job.steps), "Recorded job producer is unconfirmed");
    return job;
  }
  const jobsFor = (run: any, attempt: number) => list(`/actions/runs/${run.id}/attempts/${attempt}/jobs`, "jobs");
  function workerJob(jobs: any[], run: any, attempt: number) {
    const matching = jobs.filter(job => (job.name === "worker" || job.name?.endsWith(" / worker")) && executionStep(job));
    requireCheck(matching.length === 1, "Native leaf worker job is missing or ambiguous");
    return ownJob(matching[0], run, attempt);
  }
  async function parent(subject: RetentionSubject) {
    RetentionSubjectSchema.parse(subject);
    requireCheck(subject.repository === repository, "Observer repository changed");
    const run = await read(`/actions/runs/${subject.runId}`);
    ownRun(run, subject, workflowFor(subject.channel), subject.channel === "production" ? "workflow_dispatch" : "push");
    requireCheck(String(run.id) === subject.runId && String(run.run_attempt) === subject.failedAttempt && run.status === "completed" && run.conclusion === "failure" &&
      Number.isFinite(Date.parse(run.created_at)) && now() - Date.parse(run.created_at) < 30 * 24 * 3600_000,
      "Original parent is not the latest failed eligible attempt");
    const candidates = await list(`/actions/workflows/${workflowFor(subject.channel)}/runs?event=${run.event}&created=${encodeURIComponent(`>=${new Date(now() - 30 * 24 * 3600_000).toISOString()}`)}`, "workflow_runs");
    requireCheck(candidates.length > 0 && candidates.every(value => value.repository?.full_name === repository && value.head_repository?.full_name === repository &&
      value.path === run.path && value.event === run.event) && Math.max(...candidates.map(value => value.id)) === run.id,
      "A newer channel parent superseded this failed run");
    requireCheck((await read(`/commits/${encodeURIComponent(subject.branch)}`)).sha === subject.sourceSha, "Original channel source was superseded");
    const source = await read(`/contents/.github/workflows/${RETENTION_WORKFLOW}?ref=${subject.sourceSha}`);
    requireCheck(source.type === "file" && source.path === `.github/workflows/${RETENTION_WORKFLOW}` && SHA.test(source.sha ?? "") && source.size > 0 && source.size <= 64 * 1024,
      "The original exact source does not contain this observer workflow");
    return run;
  }
  async function assertNoConflicts() {
    for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
      const runs = await list(`/actions/runs?status=${status}`, "workflow_runs");
      requireCheck(runs.every(run => run.repository?.full_name === repository && run.repository.fork === false &&
        (conflicts.has(run.path) || readOnlyWorkflows.has(run.path))), "Active workflow visibility is unconfirmed");
      requireCheck(!runs.some(run => conflicts.has(run.path)), "An active release/provision/cutover/worker conflicts with observation");
    }
  }
  async function producer(run: any, allJobs: any[], name: string, steps: string[], artifact?: any) {
    const candidates = allJobs.filter(job => job.name === name || job.name?.endsWith(` / ${name}`));
    const matches = candidates.filter(job => job.status === "completed" && job.conclusion === "success" &&
      steps.every(name => job.steps?.some((step: any) => step.name === name && completed(step))) &&
      (!artifact || job.steps.some((step: any) => step.name === steps.at(-1) && Date.parse(step.started_at) <= Date.parse(artifact.created_at) &&
        Date.parse(artifact.created_at) <= Date.parse(step.completed_at) + 5000)));
    requireCheck(matches.length === 1 && positive(matches[0].run_attempt) && matches[0].run_attempt <= run.run_attempt,
      "Original successful artifact/approval producing attempt is unconfirmed");
    const match = matches[0], recorded = await jobsFor(run, match.run_attempt);
    requireCheck(recorded.some(job => job.id === match.id && job.status === "completed" && job.conclusion === "success" &&
      steps.every(name => job.steps?.some((step: any) => step.name === name && completed(step))) && ownJob(job, run, match.run_attempt)),
      "Original producer is absent from its recorded attempt");
    return { id: match.id, attempt: match.run_attempt };
  }
  function exactArtifact(artifacts: any[], name: string, run: any) {
    const matches = artifacts.filter(artifact => artifact.name === name);
    requireCheck(matches.length === 1 && matches[0].expired === false && matches[0].workflow_run?.id === run.id &&
      matches[0].workflow_run.head_sha === run.head_sha && /^sha256:[a-f0-9]{64}$/.test(matches[0].digest ?? "") &&
      Number.isSafeInteger(matches[0].size_in_bytes) && matches[0].size_in_bytes > 0 &&
      Number.isFinite(Date.parse(matches[0].created_at)) && Date.parse(matches[0].expires_at) > now(), "Original artifact identity/integrity/lifetime is unconfirmed");
    return matches[0];
  }
  async function smallArtifact(artifact: any, filename: string) {
    requireCheck(artifact.size_in_bytes <= 128 * 1024, "Observer receipt/intent artifact exceeds its bound");
    let response = await fetcher(`${base}/actions/artifacts/${artifact.id}/zip`, { headers, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    if (response.status === 302) {
      const location = new URL(response.headers.get("location") ?? "https://invalid.invalid");
      requireCheck(location.protocol === "https:" && !location.username && !location.password && !location.port &&
        (location.hostname.endsWith(".blob.core.windows.net") || location.hostname.endsWith(".githubusercontent.com")), "Artifact download destination is unconfirmed");
      response = await fetcher(location.href, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    }
    requireCheck(response.status === 200, "Artifact download is unavailable");
    requireCheck(response.body, "Artifact bytes are unavailable");
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.length; requireCheck(length <= 128 * 1024, "Artifact bytes exceed their bound"); chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    const bytes = Buffer.concat(chunks);
    requireCheck(bytes.length <= 128 * 1024 && bytes.length === artifact.size_in_bytes &&
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` === artifact.digest, "Artifact download digest changed");
    const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-retention-artifact-"));
    try {
      const archive = path.join(directory, "artifact.zip"); await writeFile(archive, bytes, { mode: 0o600, flag: "wx" });
      requireCheck((await runCommand("unzip", ["-Z1", archive], { timeout: 10_000 })).trim() === filename, "Artifact entries do not match the fixed receipt/intent");
      const value = await runCommand("unzip", ["-p", archive, filename], { timeout: 10_000 });
      requireCheck(value.length <= 64 * 1024, "Artifact receipt/intent exceeds its decoded bound");
      return JSON.parse(value);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  async function approval(run: any, jobs: any[], subject: RetentionSubject) {
    return subject.channel === "production" ? producer(run, jobs, "Approve Production release", ["Record the approved candidate"]) : null;
  }
  async function inspect(subject: RetentionSubject) {
    const run = await parent(subject), attempt = Number(subject.failedAttempt), jobs = await jobsFor(run, attempt), worker = workerJob(jobs, run, attempt);
    requireCheck(String(worker.id) === subject.jobId && worker.status === "completed" && worker.conclusion === "failure" &&
      executionStep(worker)?.conclusion === "failure" && completed(worker.steps.find((step: any) => step.name === "Exact-source Preflight and CodeQL gate")) &&
      Number.isFinite(Date.parse(worker.completed_at)) && Date.parse(worker.completed_at) <= now() &&
      jobs.every(job => job.id === worker.id || ["success", "skipped"].includes(job.conclusion)),
      "Failure is not confined to the original executed native worker leaf");
    const allJobs = await list(`/actions/runs/${run.id}/jobs?filter=all`, "jobs"), artifacts = await list(`/actions/runs/${run.id}/artifacts`, "artifacts");
    const ci = await producer(run, allJobs, "Exact-source Preflight and CodeQL barrier", []);
    const approved = await approval(run, allJobs, subject), label = subject.channel[0].toUpperCase() + subject.channel.slice(1);
    const signed = exactArtifact(artifacts, subject.channel === "production" ? "zeros-macos-arm64-build" : `zeros-${subject.channel}-arm64-build-${subject.sourceSha}`, run);
    const built = await producer(run, allJobs, subject.channel === "production" ? "Build + sign (macOS arm64)" : `Build + sign ${label} (macOS arm64 · NOT notarized)`,
      ["Record the baked cloud capability", "Verify installer + updater signatures", subject.channel === "production" ? "Upload signed build artifact" : `Save signed ${label} artifacts`], signed);
    const services = exactArtifact(artifacts, `hosted-services-${subject.channel}-${subject.sourceSha}`, run);
    const serviceProducer = await producer(run, allJobs, "Hosted services", ["Promote services and verify WorkOS", "Save services receipt"], services);
    const receipt = validateServicesReceipt(await smallArtifact(services, "hosted-services.json"), run, subject, subject.channel,
      await jobsFor(run, serviceProducer.attempt));
    requireCheck(receipt.cloudRequired === true && Number(receipt.runAttempt) === serviceProducer.attempt, "Original services receipt is not cloud-on eligibility");
    const github = githubClient(subject, env, { fetch: fetcher, command: runCommand });
    const required = await github.requiredChecks(); assertRequiredCI(required); await assertNoConflicts();
    return { failedAt: Date.parse(worker.completed_at), sha256: hash({ subject, createdAt: run.created_at, worker: worker.id, completedAt: worker.completed_at,
      ci, approved, built, signed: { id: signed.id, digest: signed.digest, expiresAt: signed.expires_at },
      serviceProducer, services: { id: services.id, digest: services.digest, expiresAt: services.expires_at }, receipt, required }) };
  }
  async function originalWorker(subject: RetentionSubject, attempt: string) {
    requireCheck(positive(attempt) && Number(attempt) <= Number(subject.failedAttempt), "Native producing attempt is invalid");
    const run = await parent(subject), job = workerJob(await jobsFor(run, Number(attempt)), run, Number(attempt)), step = executionStep(job);
    requireCheck(job.status === "completed" && job.conclusion === "failure" && step?.status === "completed" && step.conclusion === "failure" &&
      completed(job.steps.find((value: any) => value.name === "Exact-source Preflight and CodeQL gate")) &&
      Number.isFinite(Date.parse(step.started_at)) && Number.isFinite(Date.parse(step.completed_at)), "Native original executed producer is unconfirmed");
    return { startedAt: Date.parse(step.started_at), finishedAt: Date.parse(step.completed_at) };
  }
  function observerRun(run: any, subject: RetentionSubject) {
    ownRun(run, subject, RETENTION_WORKFLOW, "workflow_dispatch");
    requireCheck(run.display_title === retentionRunTitle(subject), "Observer intent title/subject attribution is unconfirmed");
  }
  async function observerUpload(run: any, attempt: number, subject: RetentionSubject, ownPreparation = false) {
    observerRun(run, subject);
    const jobs = await jobsFor(run, attempt), observers = jobs.filter(job => job.name === "Observe retained cleanup");
    if (!observers.length) {
      requireCheck(jobs.some(job => job.name === "Validate protected source and original parent" && job.status === "completed" &&
        ["failure", "cancelled", "skipped"].includes(job.conclusion)), "Observer upload history is unavailable");
      return null;
    }
    requireCheck(observers.length === 1, "Observer upload history is ambiguous");
    const job = ownJob(observers[0], run, attempt), step = job.steps.find((value: any) => value.name === "Persist rerun intent");
    if (!step && ownPreparation && job.status === "in_progress" && job.steps.some((value: any) =>
      value.name === "Observe exact native physical completion" && value.status === "in_progress" && value.conclusion === null)) return null;
    requireCheck(step && ["pending", "queued", "in_progress", "completed"].includes(step.status), "Observer upload step is unavailable");
    return { job, step };
  }
  async function validateIntentArtifact(run: any, attempt: number, subject: RetentionSubject, artifacts: any[]) {
    const upload = await observerUpload(run, attempt, subject);
    requireCheck(upload && completed(upload.step), "Observer intent upload did not complete authoritatively");
    const artifact = exactArtifact(artifacts, retentionIntentKey(subject), run), value = RetentionIntentSchema.parse(await smallArtifact(artifact, "retention-intent.json"));
    requireCheck(hash(value.subject) === hash(subject) && value.producer.runId === String(run.id) && value.producer.runAttempt === String(attempt) &&
      Date.parse(upload.step.started_at) <= Date.parse(artifact.created_at) && Date.parse(artifact.created_at) <= Date.parse(upload.step.completed_at) + 5000,
      "Observer intent producing attempt/artifact attribution changed");
    return { artifact, value };
  }
  async function assertIntentAvailable(subject: RetentionSubject, current?: RetentionProducer) {
    const original = await parent(subject);
    const history = await list(`/actions/workflows/${RETENTION_WORKFLOW}/runs?head_sha=${subject.sourceSha}&event=workflow_dispatch&created=${encodeURIComponent(`>=${original.created_at}`)}`, "workflow_runs");
    for (const run of history) {
      const artifacts = await list(`/actions/runs/${run.id}/artifacts`, "artifacts"), matching = artifacts.filter(artifact => artifact.name === retentionIntentKey(subject));
      if (run.display_title !== retentionRunTitle(subject) && !matching.length) continue;
      observerRun(run, subject);
      const ownCurrent = String(run.id) === (current?.runId ?? env.GITHUB_RUN_ID) && String(run.run_attempt) === (current?.runAttempt ?? env.GITHUB_RUN_ATTEMPT);
      requireCheck(run.status === "completed" || ownCurrent, "A prior matching observer is still active");
      for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
        const upload = await observerUpload(run, attempt, subject, ownCurrent && !current && attempt === run.run_attempt && !matching.length);
        const reached = upload && upload.step.conclusion !== "skipped" && !["pending", "queued"].includes(upload.step.status);
        if (!reached) { requireCheck(!matching.length, "Intent exists without a matching upload producer"); continue; }
        if (current && ownCurrent && attempt === Number(current.runAttempt)) {
          await validateIntentArtifact(run, attempt, subject, artifacts); continue;
        }
        if (completed(upload.step) && matching.length) await validateIntentArtifact(run, attempt, subject, artifacts);
        requireCheck(false, matching.length ? "Original failed-leaf intent is consumed; observation only" : "Prior intent upload is missing or uncertain; observation only");
      }
    }
  }
  async function verifyOwnIntent(intent: RetentionIntent, expected: { id: string; digest: string }) {
    requireCheck(positive(expected.id) && DIGEST.test(expected.digest), "Current intent upload output is unavailable");
    const run = await read(`/actions/runs/${intent.producer.runId}`);
    observerRun(run, intent.subject);
    requireCheck(String(run.run_attempt) === intent.producer.runAttempt && run.status === "in_progress", "Only the current observer attempt may request once");
    const { artifact, value } = await validateIntentArtifact(run, Number(intent.producer.runAttempt), intent.subject,
      await list(`/actions/runs/${run.id}/artifacts`, "artifacts"));
    requireCheck(String(artifact.id) === expected.id && artifact.digest === `sha256:${expected.digest}` && hash(value) === hash(RetentionIntentSchema.parse(intent)),
      "Current immutable intent readback does not match upload and local decision");
  }
  async function rerun(jobId: string): Promise<"accepted" | "refused" | "unconfirmed"> {
    requireCheck(positive(jobId) && /^[1-9]\d*$/.test(jobId), "Original leaf job identity is invalid");
    try {
      const response = await fetcher(`${base}/actions/jobs/${jobId}/rerun`, { method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ enable_debug_logging: false, enable_debugger: false }), redirect: "error", signal: AbortSignal.timeout(20_000) });
      return response.status === 201 ? "accepted" : [403, 404, 409, 422].includes(response.status) ? "refused" : "unconfirmed";
    } catch { return "unconfirmed"; }
  }
  async function discover(channel: RetentionSubject["channel"]) {
    const runs = await list(`/actions/workflows/${workflowFor(channel)}/runs?event=${channel === "production" ? "workflow_dispatch" : "push"}&created=${encodeURIComponent(`>=${new Date(now() - 5 * 24 * 3600_000).toISOString()}`)}`, "workflow_runs");
    const run = runs.sort((left, right) => right.id - left.id)[0];
    if (!run || run.status !== "completed" || run.conclusion !== "failure") return null;
    const job = workerJob(await jobsFor(run, run.run_attempt), run, run.run_attempt);
    const subject = RetentionSubjectSchema.parse({ repository, channel, sourceSha: run.head_sha, branch: run.head_branch, runId: String(run.id), failedAttempt: String(run.run_attempt), jobId: String(job.id) });
    await inspect(subject);
    const history = await list(`/actions/workflows/${RETENTION_WORKFLOW}/runs?head_sha=${subject.sourceSha}&event=workflow_dispatch&created=${encodeURIComponent(`>=${run.created_at}`)}`, "workflow_runs");
    if (history.some(value => value.display_title === retentionRunTitle(subject) && value.status !== "completed")) return null;
    return subject;
  }
  async function dispatch(subject: RetentionSubject) {
    await inspect(subject);
    const response = await fetcher(`${base}/actions/workflows/${RETENTION_WORKFLOW}/dispatches`, { method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ ref: subject.branch, inputs: { channel: subject.channel, source_sha: subject.sourceSha, parent_run_id: subject.runId,
        failed_attempt: subject.failedAttempt, worker_job_id: subject.jobId } }), redirect: "error", signal: AbortSignal.timeout(20_000) });
    requireCheck(response.status === 204, "Protected observer dispatch is unconfirmed; no worker rerun was requested");
  }
  return { inspect, originalWorker, assertIntentAvailable, verifyOwnIntent, rerun, discover, dispatch };
}
