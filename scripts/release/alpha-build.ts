import { z } from "zod";
import { automaticAlpha, jobPages } from "./alpha-ci";
import { PromotionError, SHA, releaseSource, requireCheck } from "./contracts";
import { poll } from "./io";

type Read = (route: string) => Promise<any>;
const counter = z.string().regex(/^[1-9]\d*$/).refine(value => Number.isSafeInteger(Number(value)));
const integer = z.number().int().positive().refine(Number.isSafeInteger);
const source = { repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), branch: z.literal("main"), sourceSha: z.string().regex(SHA),
  runId: counter, runAttempt: counter, runNumber: counter };
export const AlphaBuildMetadata = z.object({ version: z.literal(1), channel: z.literal("alpha"), ...source,
  releaseVersion: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alpha\.[1-9]\d*$/), cloudEnabled: z.boolean() }).strict();
export const AlphaProducerProof = z.object({ version: z.literal(1), ...source, kind: z.enum(["desktop", "runtime"]),
  producerId: integer, producerAttempt: integer.nullable(), artifactId: integer }).strict();
export type ProducerProof = z.infer<typeof AlphaProducerProof>;
type Kind = ProducerProof["kind"];
const producers = {
  desktop: { name: "Build + sign Alpha (macOS arm64 · NOT notarized)", artifact: "zeros-alpha-arm64-build",
    steps: ["Compute alpha version", "Record the baked cloud capability", "Verify installer + updater signatures", "Write signed Alpha build metadata", "Save signed Alpha artifacts"] },
  runtime: { name: "Build Linux runtime bundle", artifact: "zeros-alpha-runtime-build",
    steps: ["Build and verify the exact-source runtime", "Save runtime bundle outputs"] },
} as const;
export const ALPHA_BUILD_WAIT_MS = 45 * 60_000;

/** Reusable publishers retain the original push/main parent. Counters are
 * authenticated as well as source, path and attempt; no other run can supply
 * a build or a version. */
export async function authenticatedAlphaParent(env: NodeJS.ProcessEnv, read: Read) {
  const candidate = releaseSource(env), run = await read(`/actions/runs/${env.GITHUB_RUN_ID}`);
  requireCheck(await automaticAlpha(candidate, env, async () => run) && run.name === "Release (alpha)" &&
    counter.safeParse(env.GITHUB_RUN_NUMBER).success && run.run_number === Number(env.GITHUB_RUN_NUMBER) &&
    run.status === "in_progress" && run.conclusion === null, "Automatic Alpha parent identity or current attempt is invalid");
  return run as { id: number; run_attempt: number; run_number: number };
}

function producerJob(kind: Kind, jobs: any[], env: NodeJS.ProcessEnv) {
  const matches = jobs.filter(job => job?.name === producers[kind].name ||
    kind === "runtime" && job?.name === "Build Linux runtime bundle / Build Linux runtime bundle");
  requireCheck(matches.length === 1, "Alpha build producer evidence is missing or ambiguous");
  const job = matches[0], attempt = Number(env.GITHUB_RUN_ATTEMPT);
  requireCheck(integer.safeParse(job.id).success && job.run_id === Number(env.GITHUB_RUN_ID) && job.head_sha === env.GITHUB_SHA &&
    job.head_branch === "main" && (job.run_attempt === undefined || integer.safeParse(job.run_attempt).success && job.run_attempt <= attempt),
  "Alpha build producer source, run or attempt is invalid");
  requireCheck(["queued", "in_progress", "completed"].includes(job.status), "Alpha build producer status is invalid");
  if (job.status !== "completed") {
    requireCheck(job.conclusion === null && (job.run_attempt === undefined || job.run_attempt === attempt),
      "Alpha build producer attempt or pending conclusion is invalid");
    return false;
  }
  requireCheck(job.conclusion === "success", "Alpha build producer did not succeed; publication refused");
  requireCheck(Array.isArray(job.steps) && producers[kind].steps.every(name =>
    job.steps.some((step: any) => step?.name === name && step.status === "completed" && step.conclusion === "success")),
  "Alpha build producer lacks successful artifact and verification steps");
  return job;
}

async function buildSnapshot(kind: Kind, env: NodeJS.ProcessEnv, read: Read): Promise<ProducerProof | false> {
  const run = await authenticatedAlphaParent(env, read);
  // This endpoint authenticates carried successes; never search filter=all or
  // another workflow run to replace a failed/latest producer.
  const jobs = await jobPages(read, `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`);
  const job = producerJob(kind, jobs, env);
  if (!job) { await authenticatedAlphaParent(env, read); return false; }
  const list = await read(`/actions/runs/${run.id}/artifacts?per_page=100`);
  requireCheck(list && Number.isSafeInteger(list.total_count) && list.total_count >= 0 && list.total_count <= 100 &&
    Array.isArray(list.artifacts) && list.artifacts.length === list.total_count, "Alpha build artifact history is unavailable or exceeds its bound");
  const matches = list.artifacts.filter((artifact: any) => artifact?.name === `${producers[kind].artifact}-${env.GITHUB_SHA}` &&
    artifact.expired === false && artifact.workflow_run?.id === run.id && artifact.workflow_run?.head_sha === env.GITHUB_SHA && artifact.workflow_run?.head_branch === "main");
  requireCheck(matches.length === 1 && integer.safeParse(matches[0].id).success, "Alpha build artifact is missing, ambiguous or belongs to another source/run");
  await authenticatedAlphaParent(env, read);
  return AlphaProducerProof.parse({ version: 1, repository: env.GITHUB_REPOSITORY, branch: "main",
    sourceSha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, runNumber: env.GITHUB_RUN_NUMBER,
    kind, producerId: job.id, producerAttempt: job.run_attempt ?? null, artifactId: matches[0].id });
}

/** One bounded handoff, not a lock: the reusable call already owns the entire
 * destination transaction while independent parent builds finish. */
export async function waitForAlphaBuild(kind: Kind, env: NodeJS.ProcessEnv, read: Read, options: Parameters<typeof poll>[1] = {}) {
  requireCheck(Object.hasOwn(producers, kind), "Unknown Alpha build producer");
  try {
    return await poll(() => buildSnapshot(kind, env, read), { attempts: 270, timeoutMs: ALPHA_BUILD_WAIT_MS, ...options });
  } catch (error) {
    if (error instanceof PromotionError && error.message === "Release readiness timed out; no downstream publication is authorized")
      throw new PromotionError(`Alpha ${kind} producer readiness timed out after 45 minutes; publication refused`);
    throw error;
  }
}

export function createAlphaBuildMetadata(env: NodeJS.ProcessEnv) {
  const candidate = releaseSource(env);
  requireCheck(candidate.channel === "alpha" && env.GITHUB_JOB === "build" &&
    env.GITHUB_WORKFLOW_REF === `${candidate.repository}/.github/workflows/release-alpha.yml@refs/heads/main` &&
    ["true", "false"].includes(env.BUILD_CLOUD_ENABLED ?? ""), "Alpha build metadata requires its protected signing producer and baked capability");
  const value = AlphaBuildMetadata.safeParse({ version: 1, ...candidate, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    runNumber: env.GITHUB_RUN_NUMBER, releaseVersion: env.VERSION, cloudEnabled: env.BUILD_CLOUD_ENABLED === "true" });
  requireCheck(value.success && value.data.releaseVersion.endsWith(`-alpha.${value.data.runNumber}`) && value.data.releaseVersion === env.ALPHA_PREPARED_VERSION,
    "Alpha build metadata version does not match its immutable prepared version and parent order");
  return value.data;
}

/** Recheck the immutable artifact and producer after download. This also owns
 * runtime handoff, whose descriptor independently verifies exact-source bytes. */
export async function validateAlphaProducerProof(proof: unknown, env: NodeJS.ProcessEnv, read: Read) {
  const parsed = AlphaProducerProof.safeParse(proof);
  requireCheck(parsed.success, "Alpha build producer proof is invalid");
  const recorded = parsed.data;
  requireCheck(recorded.repository === env.GITHUB_REPOSITORY && recorded.branch === "main" && recorded.sourceSha === env.GITHUB_SHA &&
    recorded.runId === env.GITHUB_RUN_ID && recorded.runAttempt === env.GITHUB_RUN_ATTEMPT && recorded.runNumber === env.GITHUB_RUN_NUMBER,
  "Alpha build producer proof belongs to another source, run or attempt");
  const current = await buildSnapshot(recorded.kind, env, read);
  requireCheck(current && current.producerId === recorded.producerId && current.producerAttempt === recorded.producerAttempt &&
    current.artifactId === recorded.artifactId, "Alpha build producer or artifact changed after download");
  return recorded;
}

export async function validateAlphaBuildMetadata(metadata: unknown, proof: unknown, env: NodeJS.ProcessEnv, read: Read) {
  const parsed = AlphaBuildMetadata.safeParse(metadata), evidence = AlphaProducerProof.safeParse(proof);
  requireCheck(parsed.success && evidence.success, "Alpha signed-build metadata or producer proof is invalid");
  const value = parsed.data, recorded = evidence.data;
  requireCheck(recorded.kind === "desktop" && value.repository === env.GITHUB_REPOSITORY && value.branch === "main" && value.sourceSha === env.GITHUB_SHA &&
    value.runId === env.GITHUB_RUN_ID && value.runNumber === env.GITHUB_RUN_NUMBER && Number(value.runAttempt) <= Number(env.GITHUB_RUN_ATTEMPT) &&
    value.releaseVersion.endsWith(`-alpha.${env.GITHUB_RUN_NUMBER}`) && value.releaseVersion === env.ALPHA_PREPARED_VERSION &&
    ["repository", "branch", "sourceSha", "runId", "runNumber"].every(key => value[key as keyof typeof value] === recorded[key as keyof ProducerProof]) &&
    recorded.runAttempt === env.GITHUB_RUN_ATTEMPT && (recorded.producerAttempt === null || recorded.producerAttempt === Number(value.runAttempt)),
  "Alpha signed-build metadata belongs to another source, run, producing attempt or version");
  await validateAlphaProducerProof(recorded, env, read);
  const jobs = await jobPages(read, `/actions/runs/${value.runId}/attempts/${value.runAttempt}/jobs`);
  const producer = producerJob("desktop", jobs, { ...env, GITHUB_RUN_ATTEMPT: value.runAttempt });
  requireCheck(producer && producer.id === recorded.producerId, "Alpha metadata's recorded attempt has no matching successful producer");
  await authenticatedAlphaParent(env, read);
  return value;
}
