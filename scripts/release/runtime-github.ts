import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { SHA, requireCheck } from "./contracts";
import { assertRequiredCI, requiredCIEvidence, REQUIRED_CI } from "./ci";
import { command, jsonClient, type Command } from "./io";
import type { RuntimeReleaseConfig } from "./runtime-contracts";
import { requireCurrentAlphaRuntime } from "./runtime-alpha";
import { runtimeCaller, runtimeJobNames } from "./runtime-caller";

export function runtimeGithub(config: RuntimeReleaseConfig, env: NodeJS.ProcessEnv, options: { fetch?: typeof fetch; command?: Command } = {}) {
  const json = jsonClient(options.fetch), execute = options.command ?? command;
  const read = (path: string) => json(`https://api.github.com/repos/${config.repository}${path}`, { headers: {
    authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
  } });
  async function mainSource(sourceSha: string) {
    requireCheck(SHA.test(sourceSha), "Runtime source must be a full commit SHA");
    const comparison = await read(`/compare/${sourceSha}...main`);
    requireCheck(["ahead", "identical"].includes(comparison?.status) && comparison.merge_base_commit?.sha === sourceSha,
      "Runtime source must be an immutable commit on main");
    const candidate = { repository: config.repository, sourceSha };
    const evidence = await Promise.all(REQUIRED_CI.map(async workflow => requiredCIEvidence(candidate, workflow.file, workflow.name,
      await read(`/actions/workflows/${workflow.file}/runs?head_sha=${sourceSha}&per_page=100`))));
    assertRequiredCI(evidence);
  }
  async function artifact(kind: "qualification" | "build", runId: string, attempt: number): Promise<unknown> {
    requireCheck(/^[1-9][0-9]{0,19}$/.test(runId) && Number.isSafeInteger(attempt) && attempt > 0 && attempt <= 10_000, "Qualification artifact run is invalid");
    const name = `${kind === "build" ? "runtime-archive" : "runtime-release"}-${runId}-${attempt}`;
    const run = await read(`/actions/runs/${runId}/attempts/${attempt}`);
    const list = z.object({ total_count: z.number().int().min(0).max(100), artifacts: z.array(z.object({
      name: z.string(), expired: z.boolean(), workflow_run: z.object({ head_sha: z.string() }),
    })) }).safeParse(await read(`/actions/runs/${runId}/artifacts?per_page=100`));
    requireCheck(list.success && list.data.artifacts.length === list.data.total_count && list.data.artifacts.filter(a =>
      a.name === name && !a.expired && a.workflow_run.head_sha === run.head_sha).length === 1, "The exact qualification artifact is unavailable or ambiguous");
    const directory = await mkdtemp(join(tmpdir(), "zeros-runtime-proof-"));
    try {
      await execute("gh", ["run", "download", runId, "--repo", config.repository, "--name", name, "--dir", directory],
        { env: { PATH: env.PATH, HOME: env.HOME, GH_TOKEN: env.GH_TOKEN }, timeout: 60_000 });
      const file = await open(join(directory, kind === "build" ? "runtime-build.json" : "runtime-qualification.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat(); requireCheck(stat.isFile() && stat.size <= 32 * 1024, "Runtime qualification artifact is not a bounded regular file");
        const bytes = await file.readFile(); requireCheck(bytes.length <= 32 * 1024, "Runtime qualification artifact exceeds its bound");
        return JSON.parse(bytes.toString("utf8"));
      } finally { await file.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  return {
    read, mainSource,
    alphaCurrent: (sha256: string) => requireCurrentAlphaRuntime(sha256, options.fetch),
    async source() {
      requireCheck((await execute("git", ["rev-parse", "HEAD"])).trim() === config.workflowSha &&
        !(await execute("git", ["status", "--porcelain", "--untracked-files=normal"])).trim(), "Runtime controller checkout must be the clean dispatched commit");
      const run = await read(`/actions/runs/${config.runId}/attempts/${config.runAttempt}`);
      const file = config.workflowFile ?? "runtime-release.yml", caller = runtimeCaller(file, config.channel, config.action);
      requireCheck(String(run?.id) === config.runId && run.run_attempt === config.runAttempt && run.head_sha === config.workflowSha && run.head_branch === config.branch &&
        run.path === caller.path && run.event === caller.event &&
        run.repository?.full_name === config.repository && run.head_repository?.full_name === config.repository &&
        ["queued", "in_progress"].includes(run.status), "Runtime release is not owned by the exact trusted workflow attempt");
      if (config.channel === "alpha") await mainSource(config.workflowSha);
      else {
        requireCheck((await read(`/commits/${encodeURIComponent(config.branch)}`)).sha === config.workflowSha, "Release branch moved after dispatch");
        const candidate = { repository: config.repository, sourceSha: config.workflowSha };
        assertRequiredCI(await Promise.all(REQUIRED_CI.map(async workflow => requiredCIEvidence(candidate, workflow.file, workflow.name,
          await read(`/actions/workflows/${workflow.file}/runs?head_sha=${config.workflowSha}&per_page=100`)))));
      }
      if (config.channel === "production") {
        const jobs = z.object({ total_count: z.number().int().min(1).max(100), jobs: z.array(z.object({ run_id: z.number(), run_attempt: z.number(),
          head_sha: z.string(), name: z.string(), status: z.string(), conclusion: z.string().nullable(),
          steps: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })) })) }).safeParse(
          await read(`/actions/runs/${config.runId}/attempts/${config.runAttempt}/jobs?per_page=100`));
        requireCheck(jobs.success && jobs.data.jobs.length === jobs.data.total_count && jobs.data.jobs.filter(job =>
          runtimeJobNames(file, "approval").includes(job.name) && String(job.run_id) === config.runId && job.run_attempt === config.runAttempt &&
          job.head_sha === config.workflowSha && job.status === "completed" && job.conclusion === "success" &&
          job.steps.some(step => step.name === "Record runtime approval" && step.status === "completed" && step.conclusion === "success")).length === 1,
          "Production runtime promotion requires this exact attempt's protected approval job");
      }
      if (config.sourceSha && config.sourceSha !== config.workflowSha) await mainSource(config.sourceSha);
    },
    async sameControlPlane(left: string, right: string) {
      requireCheck(SHA.test(left) && SHA.test(right), "Control-plane compatibility source is invalid");
      for (const path of ["apps/control-plane", "packages/protocol"]) {
        const a = (await execute("git", ["rev-parse", `${left}:${path}`])).trim(), b = (await execute("git", ["rev-parse", `${right}:${path}`])).trim();
        if (!SHA.test(a) || !SHA.test(b) || a !== b) return false;
      }
      return true;
    },
    artifact: (runId: string, attempt: number) => artifact("qualification", runId, attempt),
    buildArtifact: (runId: string, attempt: number) => artifact("build", runId, attempt),
  };
}
