import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CHANNELS, HostedReceipt, HostedServicesReceipt, SHA, requireCheck, type Channel, type PromotionConfig } from "./contracts";
import { command, jsonClient, type Command } from "./io";
import { assertRequiredCI, requiredCIEvidence, REQUIRED_CI } from "./ci";
import { ALPHA_CI_FAILURE, ALPHA_REQUIRED_CI, alphaBarrierUnmutated, alphaRequiredChecks, automaticAlpha, supersededCandidate } from "./alpha-ci";
import { CutoverReceipt } from "./cutover";

function validateHostedReceipt(receipt: unknown, run: any, config: Pick<PromotionConfig, "sourceSha" | "branch" | "repository">, channel: Channel, jobs: any[], requireOverallSuccess: boolean) {
  const parsed = HostedReceipt.safeParse(receipt);
  requireCheck(parsed.success, "Hosted receipt is invalid");
  const value = parsed.data;
  const attempt = Number(value.runAttempt), surfaces = CHANNELS[channel].ops ? ["app", "ops"] : ["app"];
  const workflow = channel === "production" ? "release.yml" : `release-${channel}.yml`;
  requireCheck((!requireOverallSuccess || run.conclusion === "success") && run.event === (channel === "production" ? "workflow_dispatch" : "push") &&
    run.head_sha === config.sourceSha && run.head_branch === config.branch && run.path === `.github/workflows/${workflow}` && run.repository?.full_name === config.repository &&
    value.channel === channel && value.sourceSha === config.sourceSha && value.branch === config.branch && value.repository === config.repository &&
    value.runId === String(run.id) && Number.isSafeInteger(attempt) && attempt > 0 && Number.isSafeInteger(run.run_attempt) && attempt <= run.run_attempt && value.migration.ledger === "verified" &&
    value.migration.mode === "execute" && value.migration.backup?.state === "success" && value.migration.database === `zeros-control-plane-${channel}` &&
    value.migration.branch.name === "main" && value.backend.channel === channel && value.backend.sourceSha === config.sourceSha &&
    value.backend.migrations.head === value.backend.migrations.expectedHead && value.pages.length === surfaces.length && surfaces.every(surface => value.pages.some(page => page.surface === surface)),
  "Hosted receipt does not belong to the trusted run, channel, SHA and branch");
  // Jobs come from /runs/:id/attempts/:recordedAttempt/jobs, never the latest
  // attempt's merged job list. A desktop-only rerun can reuse older proof.
  requireCheck(jobs.some(job => job.run_id === run.id && job.head_sha === config.sourceSha &&
    (job.run_attempt === undefined || job.run_attempt === attempt) && job.status === "completed" && job.conclusion === "success" &&
    (job.name === "Hosted mutation" || job.name?.endsWith(" / Hosted mutation")) &&
    ["Provider preflight and ordered promotion", "Save success receipt"].every(name => job.steps?.some((step: any) => step.name === name && step.conclusion === "success"))),
  "The receipt's recorded attempt has no successful hosted publication job");
  return value;
}
export function validateBetaReceipt(receipt: unknown, run: any, config: Pick<PromotionConfig, "sourceSha" | "branch" | "repository">, jobs: any[] = []) {
  return validateHostedReceipt(receipt, run, config, "beta", jobs, true);
}
function assertArtifactRun(run: any, config: Pick<PromotionConfig, "sourceSha" | "branch" | "repository">, channel: Channel) {
  const workflow = channel === "production" ? "release.yml" : `release-${channel}.yml`;
  requireCheck(Number.isSafeInteger(run.id) && run.id > 0 && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0 &&
    run.head_sha === config.sourceSha && run.head_branch === config.branch && run.repository?.full_name === config.repository &&
    run.head_repository?.full_name === config.repository && run.path === `.github/workflows/${workflow}` &&
    run.event === (channel === "production" ? "workflow_dispatch" : "push"), "Release artifact does not belong to the trusted parent workflow");
}
function assertArtifactJob(run: any, attempt: number, config: Pick<PromotionConfig, "sourceSha" | "branch">, jobs: any[], name: string, steps: string[]) {
  requireCheck(jobs.some(job => job.run_id === run.id && job.head_sha === config.sourceSha && job.head_branch === config.branch &&
    (job.run_attempt === undefined || job.run_attempt === attempt) && job.status === "completed" && job.conclusion === "success" &&
    (job.name === name || job.name?.endsWith(` / ${name}`)) && steps.every(step => job.steps?.some((value: any) => value.name === step && value.conclusion === "success"))),
  "The artifact's recorded attempt has no successful producing job");
}
export function validateServicesReceipt(receipt: unknown, run: any, config: Pick<PromotionConfig, "sourceSha" | "branch" | "repository">, channel: Channel, jobs: any[]) {
  assertArtifactRun(run, config, channel);
  const value = HostedServicesReceipt.parse(receipt), attempt = Number(value.runAttempt), surfaces = CHANNELS[channel].ops ? ["app", "ops"] : ["app"];
  requireCheck(value.channel === channel && value.sourceSha === config.sourceSha && value.branch === config.branch && value.repository === config.repository &&
    value.runId === String(run.id) && Number.isSafeInteger(attempt) && attempt > 0 && attempt <= run.run_attempt &&
    value.migration.mode === "execute" && value.migration.ledger === "verified" && value.migration.backup?.state === "success" && value.migration.role.deleted &&
    value.migration.database === `zeros-control-plane-${channel}` && value.migration.branch.name === "main" && value.backend.sourceSha === config.sourceSha &&
    value.backend.channel === channel && value.backend.migrations.head === value.backend.migrations.expectedHead &&
    value.pages.length === surfaces.length && value.workos.surfaces.length === surfaces.length &&
    surfaces.every(surface => value.pages.some(page => page.surface === surface) && value.workos.surfaces.some(item => item === surface)),
  "Services receipt does not bind the verified database, API, Pages and WorkOS to this release");
  assertArtifactJob(run, attempt, config, jobs, "Hosted services", ["Promote services and verify WorkOS", "Save services receipt"]);
  return value;
}
export async function validateWorkerArtifact(receipt: unknown, run: any, config: Pick<PromotionConfig, "sourceSha" | "branch" | "repository">, channel: Channel, jobs: any[]) {
  assertArtifactRun(run, config, channel);
  const { WorkerReceipt, validateWorkerReceipt } = await import("./worker");
  const parsed = WorkerReceipt.parse(receipt), attempt = Number(parsed.runAttempt);
  requireCheck(Number.isSafeInteger(attempt) && attempt > 0 && attempt <= run.run_attempt, "Worker artifact attempt is invalid");
  const value = validateWorkerReceipt(parsed, { ...config, channel, runId: String(run.id), runAttempt: parsed.runAttempt });
  assertArtifactJob(run, attempt, config, jobs, "worker", ["Worker plan or guarded execution", "Save success receipt"]);
  return value;
}
export function githubClient(config: Pick<PromotionConfig, "repository" | "sourceSha" | "branch">, env: NodeJS.ProcessEnv, options: { fetch?: typeof fetch; command?: Command } = {}) {
  const json = jsonClient(options.fetch), runCommand = options.command ?? command;
  const read = (route: string) => json(`https://api.github.com/repos/${config.repository}${route}`, { headers: {
    authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
  } });
  const alphaFastPath = async () => env.ZEROS_ALPHA_CI_FAST_PATH === "enabled" && await automaticAlpha(config, env, read);
  const fullChecks = () => Promise.all(REQUIRED_CI.map(async check => requiredCIEvidence(config, check.file, check.name,
    await read(`/actions/workflows/${check.file}/runs?head_sha=${config.sourceSha}&per_page=100`))));
  const requiredChecks = async () => await alphaFastPath() ? alphaRequiredChecks(config, read) : fullChecks();
  async function receiptForRun(run: any, channel: Channel, requireOverallSuccess: boolean, kind: "hosted" | "services" | "worker" = "hosted") {
    requireCheck(Number.isSafeInteger(run.id), "Invalid hosted workflow run");
    const name = `${kind === "services" ? "hosted-services" : kind === "worker" ? "worker-promotion" : "hosted-promotion"}-${channel}-${config.sourceSha}`;
    const list = await read(`/actions/runs/${run.id}/artifacts?per_page=100`);
    const artifact = list.artifacts?.find((item: any) => item.name === name && item.expired === false && item.workflow_run?.head_sha === config.sourceSha);
    if (!artifact) return null;
    const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-hosted-receipt-"));
    try {
      await runCommand("gh", ["run", "download", String(run.id), "--repo", config.repository, "--name", name, "--dir", directory],
        { env: { PATH: env.PATH, HOME: env.HOME, GH_TOKEN: env.GH_TOKEN }, timeout: 60_000 });
      const bytes = await readFile(path.join(directory, kind === "services" ? "hosted-services.json" : kind === "worker" ? "worker-receipt.json" : "hosted-receipt.json"));
      requireCheck(bytes.length <= 64 * 1024, "Hosted receipt exceeds its size bound");
      const parser = kind === "services" ? HostedServicesReceipt : kind === "worker" ? (await import("./worker")).WorkerReceipt : HostedReceipt;
      const receipt = parser.parse(JSON.parse(bytes.toString("utf8"))), attempt = Number(receipt.runAttempt);
      requireCheck(Number.isSafeInteger(attempt) && attempt > 0 && attempt <= run.run_attempt, "Invalid receipt attempt");
      const jobs: any[] = [];
      for (let page = 1; page <= 10; page++) {
        const result = await read(`/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100&page=${page}`);
        requireCheck(Array.isArray(result.jobs), "Hosted job evidence is unavailable");
        jobs.push(...result.jobs);
        if (result.jobs.length < 100) return kind === "services" ? validateServicesReceipt(receipt, run, config, channel, jobs)
          : kind === "worker" ? await validateWorkerArtifact(receipt, run, config, channel, jobs)
          : validateHostedReceipt(receipt, run, config, channel, jobs, requireOverallSuccess);
      }
      throw new Error("Hosted job evidence exceeds its bound");
    } finally { await rm(directory, { force: true, recursive: true }); }
  }
  return {
    requiredChecks,
    /** The workflows the active policy waits for: the Alpha gate alone on the
     * automatic Alpha fast path, otherwise Preflight and CodeQL. */
    requiredWorkflows: async () => await alphaFastPath() ? ALPHA_REQUIRED_CI : REQUIRED_CI,
    automaticAlpha: () => automaticAlpha(config, env, read),
    alphaBarrierUnmutated: () => alphaBarrierUnmutated(config, env, read),
    async assertRequiredChecks() {
      if (await alphaFastPath()) assertRequiredCI(await alphaRequiredChecks(config, read), ALPHA_REQUIRED_CI, ALPHA_CI_FAILURE);
      else assertRequiredCI(await fullChecks());
    },
    /** True only for a successful controlled-cutover run's own complete receipt
     * (API, every Pages surface and WorkOS) for this channel and exact SHA. */
    async cutoverReceipt(channel: Channel, sourceSha: string, manifestSha256?: string) {
      requireCheck(SHA.test(sourceSha), "Invalid cutover source");
      const name = `controlled-cutover-${channel}-${sourceSha}`;
      const runs = await read(`/actions/workflows/controlled-cutover.yml/runs?head_sha=${sourceSha}&status=success&event=workflow_dispatch&per_page=100`);
      for (const run of runs.workflow_runs ?? []) {
        if (!Number.isSafeInteger(run.id) || run.head_sha !== sourceSha || run.status !== "completed" || run.conclusion !== "success" ||
          run.event !== "workflow_dispatch" || run.path !== ".github/workflows/controlled-cutover.yml" ||
          run.repository?.full_name !== config.repository || run.head_repository?.full_name !== config.repository) continue;
        const list = await read(`/actions/runs/${run.id}/artifacts?per_page=100`);
        if (!list.artifacts?.some((item: any) => item.name === name && item.expired === false && item.workflow_run?.head_sha === sourceSha)) continue;
        const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-cutover-receipt-"));
        try {
          await runCommand("gh", ["run", "download", String(run.id), "--repo", config.repository, "--name", name, "--dir", directory],
            { env: { PATH: env.PATH, HOME: env.HOME, GH_TOKEN: env.GH_TOKEN }, timeout: 60_000 });
          const bytes = await readFile(path.join(directory, "cutover-receipt.json"));
          if (bytes.length > 64 * 1024) continue;
          const parsed = CutoverReceipt.safeParse(JSON.parse(bytes.toString("utf8")));
          if (!parsed.success) continue;
          const receipt = parsed.data, attempt = Number(receipt.runAttempt), surfaces = CHANNELS[channel].ops ? ["app", "ops"] : ["app"];
          // The receipt must prove a finished cutover of this channel's own
          // database and API, bound to the run, branch and attempt producing it.
          if (!(receipt.channel === channel && receipt.sourceSha === sourceSha && receipt.repository === config.repository &&
            receipt.runId === String(run.id) && receipt.branch === run.head_branch &&
            Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= (run.run_attempt ?? 1) &&
            receipt.migration.mode === "execute" && receipt.migration.ledger === "verified" && receipt.migration.backup?.state === "success" &&
            receipt.migration.database === `zeros-control-plane-${channel}` && receipt.migration.branch.name === "main" && receipt.migration.role.deleted &&
            receipt.backend.channel === channel && receipt.backend.sourceSha === sourceSha &&
            receipt.backend.migrations.head === receipt.backend.migrations.expectedHead &&
            (!manifestSha256 || receipt.backend.migrations.manifestSha256 === manifestSha256) &&
            surfaces.every(surface => receipt.pages.some(page => page.surface === surface) && receipt.workos.surfaces.includes(surface as "app" | "ops")))) continue;
          const jobs = await read(`/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`);
          if ((jobs.jobs ?? []).some((job: any) => job.run_id === run.id && job.status === "completed" && job.conclusion === "success" &&
            typeof job.name === "string" && job.name.startsWith("Controlled cutover") &&
            ["Controlled cutover", "Save cutover receipt"].every(name => job.steps?.some((step: any) => step.name === name && step.conclusion === "success")))) return true;
        } catch { /* An unreadable artifact is not proof. */ } finally { await rm(directory, { force: true, recursive: true }); }
      }
      return false;
    },
    async lastPublication(channel: Channel) {
      requireCheck(/^[\w.-]+\/[\w.-]+$/.test(config.repository), "Publication repository is invalid");
      const workflow = channel === "production" ? "release.yml" : `release-${channel}.yml`;
      const event = channel === "production" ? "workflow_dispatch" : "push";
      const label = channel === "production" ? "Production" : channel === "alpha" ? "Alpha" : "Beta";
      const jobNames = [channel === "production" ? "Notarize + verify + publish (macOS arm64)"
        : `Build + publish ${label} (macOS arm64 · signed · NOT notarized)`, `Publish ${label} feed`];
      const stepName = channel === "production" ? "Publish GitHub release" : `Publish rolling "${channel}" prerelease`;
      const runs: any[] = [];
      // Read bounded complete retained history: creation order alone misses a
      // later publication from a rerun of an older workflow run.
      for (let page = 1; page <= 10; page++) {
        const result = await read(`/actions/workflows/${workflow}/runs?status=success&event=${event}&per_page=100&page=${page}`);
        requireCheck(Array.isArray(result.workflow_runs) && result.total_count <= 1000, "Publication history is unavailable or exceeds its bound");
        runs.push(...result.workflow_runs);
        if (result.workflow_runs.length < 100) break;
        requireCheck(page < 10, "Publication history exceeds its bound");
      }
      const trusted = runs.filter(run => Number.isSafeInteger(run.id) && run.id > 0 && SHA.test(run.head_sha ?? "") &&
        run.repository?.full_name === config.repository && run.head_repository?.full_name === config.repository &&
        run.path === `.github/workflows/${workflow}` && run.event === event && run.status === "completed" && run.conclusion === "success" &&
        (channel === "alpha" ? run.head_branch === "main" : /^release\/\d+\.\d+\.\d+$/.test(run.head_branch ?? "")) &&
        Number.isFinite(Date.parse(run.updated_at))).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
      let latest: { sourceSha: string; runId: string; publishedAt: number } | null = null;
      for (const run of trusted) {
        if (latest && Date.parse(run.updated_at) < latest.publishedAt) break;
        for (let page = 1; page <= 10; page++) {
          // All attempts preserve a successful publish before a cleanup-only
          // retry. Every job/step remains bound to this successful run and SHA.
          const result = await read(`/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${page}`);
          requireCheck(Array.isArray(result.jobs), "Publication job evidence is unavailable");
          for (const job of result.jobs) {
            if (job.run_id !== run.id || job.head_sha !== run.head_sha || job.head_branch !== run.head_branch || !jobNames.includes(job.name) ||
              job.status !== "completed" || job.conclusion !== "success" || !Array.isArray(job.steps)) continue;
            for (const step of job.steps) {
              const publishedAt = Date.parse(step.completed_at);
              if (step.name === stepName && step.status === "completed" && step.conclusion === "success" &&
                Number.isFinite(publishedAt) && publishedAt <= Date.parse(run.updated_at) && (!latest || publishedAt > latest.publishedAt)) {
                latest = { sourceSha: run.head_sha, runId: String(run.id), publishedAt };
              }
            }
          }
          if (result.jobs.length < 100) break;
          requireCheck(page < 10, "Publication job evidence exceeds its bound");
        }
      }
      return latest && { sourceSha: latest.sourceSha, runId: latest.runId };
    },
    async assertCurrent() {
      const commit = await read(`/commits/${encodeURIComponent(config.branch)}`);
      if (commit.sha !== config.sourceSha) supersededCandidate(commit.sha);
    },
    async ownReceipt(channel: Channel, runId: string) {
      requireCheck(/^[1-9]\d*$/.test(runId), "Invalid publication run identity");
      const run = await read(`/actions/runs/${runId}`);
      requireCheck(String(run.id) === runId, "Publication run identity mismatch");
      const receipt = await receiptForRun(run, channel, false);
      requireCheck(receipt, "Current run has no trusted hosted receipt");
      return receipt;
    },
    async ownServicesReceipt(channel: Channel, runId: string) {
      requireCheck(/^[1-9]\d*$/.test(runId), "Invalid services run identity");
      const run = await read(`/actions/runs/${runId}`);
      requireCheck(String(run.id) === runId, "Services run identity mismatch");
      const receipt = await receiptForRun(run, channel, false, "services");
      requireCheck(receipt, "Current run has no trusted services receipt");
      return receipt;
    },
    async ownWorkerReceipt(channel: Channel, runId: string) {
      requireCheck(/^[1-9]\d*$/.test(runId), "Invalid worker run identity");
      const run = await read(`/actions/runs/${runId}`);
      requireCheck(String(run.id) === runId, "Worker run identity mismatch");
      const receipt = await receiptForRun(run, channel, false, "worker");
      requireCheck(receipt, "Current run has no trusted worker success receipt");
      return receipt;
    },
    async betaReceipt() {
      const runs = await read(`/actions/workflows/release-beta.yml/runs?head_sha=${config.sourceSha}&status=success&event=push&per_page=100`);
      for (const run of runs.workflow_runs ?? []) {
        if (run.head_branch !== config.branch || run.head_sha !== config.sourceSha || run.conclusion !== "success" || run.event !== "push") continue;
        const receipt = await receiptForRun(run, "beta", true);
        if (receipt) return receipt;
      }
      throw new Error("No trusted Beta promotion receipt");
    },
  };
}
