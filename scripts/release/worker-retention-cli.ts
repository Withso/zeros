import { constants } from "node:fs";
import { appendFile, mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { r2Registry } from "../dev-environment/hosted-state.mjs";
import { devBoatClient } from "../dev-environment/hosted-image.mjs";
import { CHANNELS, PromotionError, ReleaseIdentity, SHA, requireCheck } from "./contracts";
import { assertCheckout, workerInputsSha256 } from "./source";
import { jsonClient } from "./io";
import { workerOwner } from "./worker-admission";
import { RETENTION_WORKFLOW, retentionGithubClient } from "./worker-retention-github";
import { readRetentionCompletion } from "./worker-retention-proof";
import { prepareRetentionResume, requestRetentionResume, RetentionIntentSchema, RetentionProducerSchema, RetentionSubjectSchema,
  retentionIntentKey, type RetentionSubject } from "./worker-retention-resume";

type Options = { directory?: string; client?: ReturnType<typeof retentionGithubClient>; assertCheckout?: typeof assertCheckout;
  completion?: (subject: RetentionSubject, failedAt: number) => Promise<{ sha256: string; completedAt: string }>; log?: (message: string) => void };
const selectors = { channel: "RETENTION_CHANNEL", source_sha: "RETENTION_SOURCE_SHA", parent_run_id: "RETENTION_PARENT_RUN_ID",
  failed_attempt: "RETENTION_FAILED_ATTEMPT", worker_job_id: "RETENTION_WORKER_JOB_ID" } as const;

async function trigger(env: NodeJS.ProcessEnv, scheduled: boolean) {
  requireCheck(env.GITHUB_ACTIONS === "true" && env.CI === "true" && !env.GITHUB_HEAD_REF && env.GITHUB_EVENT_PATH &&
    env.GITHUB_EVENT_NAME === (scheduled ? "schedule" : "workflow_dispatch") && SHA.test(env.GITHUB_SHA ?? "") &&
    env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA && env.GITHUB_WORKFLOW_REF === `${env.GITHUB_REPOSITORY}/.github/workflows/${RETENTION_WORKFLOW}@${env.GITHUB_REF}`,
    "Retention observer requires its own immutable trusted CI workflow source");
  const bytes = await readFile(env.GITHUB_EVENT_PATH);
  requireCheck(bytes.length <= 1024 * 1024, "Retention event exceeds its bound");
  const event = JSON.parse(bytes.toString("utf8"));
  requireCheck(event.repository?.fork === false && event.repository?.full_name === env.GITHUB_REPOSITORY && event.repository.default_branch === "main",
    "Retention event repository is unconfirmed");
  if (scheduled) {
    requireCheck(env.GITHUB_REF === "refs/heads/main", "Discovery is restricted to the default branch without channel secrets");
    return null;
  }
  requireCheck(Object.entries(selectors).every(([field, variable]) => event.inputs?.[field] === env[variable]), "Retention event selectors changed");
  const subject = RetentionSubjectSchema.parse({ repository: env.GITHUB_REPOSITORY, channel: env.RETENTION_CHANNEL,
    sourceSha: env.RETENTION_SOURCE_SHA, branch: env.GITHUB_REF?.replace(/^refs\/heads\//, ""),
    runId: env.RETENTION_PARENT_RUN_ID, failedAttempt: env.RETENTION_FAILED_ATTEMPT, jobId: env.RETENTION_WORKER_JOB_ID });
  requireCheck(env.GITHUB_REF === `refs/heads/${subject.branch}` && subject.sourceSha === env.GITHUB_SHA,
    "Observer dispatch must use the original current protected channel ref/SHA");
  return subject;
}

async function protectedCompletion(subject: RetentionSubject, failedAt: number, env: NodeJS.ProcessEnv, github: ReturnType<typeof retentionGithubClient>) {
  requireCheck(env.ZEROS_HOSTED_PROMOTION === "enabled" && env.ZEROS_WORKER_PROMOTION === "enabled" &&
    env.ZEROS_CLOUD_WORKSPACES_ENABLED === "true" && env.CLOUD_WORKSPACE_PROVIDER === "boat" && env.BOAT_API_KEY?.trim(),
    "Own-channel hosted/cloud/worker observation is disabled or authority is missing");
  const { workerAdmissionConfiguration } = await import("./worker-run");
  const configuration = workerAdmissionConfiguration(env), profile = configuration.profile;
  requireCheck(z.string().uuid().safeParse(env.RUNTIME_QUALIFICATION_ACTOR_USER_ID).success && z.string().uuid().safeParse(env.WORKER_CANARY_ORGANIZATION_ID).success &&
    profile.railway.projectId === env.RAILWAY_PROJECT_ID && z.string().uuid().safeParse(profile.railway.projectId).success &&
    profile.planetscale.organization === env.PLANETSCALE_ORG && profile.planetscale.database === `zeros-control-plane-${subject.channel}` &&
    profile.planetscale.database === env.PLANETSCALE_DATABASE && env.PLANETSCALE_BRANCH === "main" &&
    profile.cloudflare.accountId === env.CLOUDFLARE_ACCOUNT_ID && /^[a-f0-9]{32}$/.test(profile.cloudflare.accountId),
    "Protected observer account/organization/database containers do not match this channel");
  const api = ReleaseIdentity.safeParse(await jsonClient()(`${CHANNELS[subject.channel].api}/v1/release-identity`));
  requireCheck(api.success && api.data.channel === subject.channel && api.data.sourceSha === subject.sourceSha && api.data.migrations.head === api.data.migrations.expectedHead,
    "Observer API source/schema is not the original current release");
  const inputsSha256 = await workerInputsSha256(subject.sourceSha), registry = r2Registry(configuration.registry);
  const signal = AbortSignal.timeout(120_000), provider = devBoatClient({ apiKey: env.BOAT_API_KEY }, signal);
  const request = (method: string, route: string) => {
    requireCheck(method === "GET" && (/^\/deletion-operations\/bdop_[a-f0-9]{32}$/.test(route) || /^\/sandboxes\/bx_[a-z0-9]+$/.test(route) ||
      /^\/named-snapshots\/[a-z0-9][a-z0-9-]{0,62}$/.test(route) || route === `/limits?org=${encodeURIComponent(profile.boat.billingOrg)}`),
      "Observer provider route is outside its GET-only allowlist");
    return provider(method, route);
  };
  try {
    return await readRetentionCompletion(subject, { env, profile, inputsSha256, failedAt,
      documents: async () => ({ registry: await registry.readDocument(`release-workers/v1/${subject.channel}.json`, workerOwner(subject.channel), (state: any) => state),
        admission: await registry.readAdmission() }), originalWorker: attempt => github.originalWorker(subject, attempt), request });
  } finally { registry.close(); }
}

async function intentFile(filename: string) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat(); requireCheck(stat.isFile() && stat.size <= 8192, "Local rerun intent is unavailable or oversized");
    return RetentionIntentSchema.parse(JSON.parse(await file.readFile("utf8")));
  } finally { await file.close(); }
}

export async function workerRetentionMain(mode: string | undefined, env: NodeJS.ProcessEnv, options: Options = {}) {
  requireCheck(["--discover", "--validate", "--observe", "--request"].includes(mode ?? ""), "Retention lane requires an explicit bounded mode");
  const subject = await trigger(env, mode === "--discover");
  await (options.assertCheckout ?? assertCheckout)(env.GITHUB_SHA!);
  const client = options.client ?? retentionGithubClient(env.GITHUB_REPOSITORY!, env), log = options.log ?? console.log;
  if (mode === "--discover") {
    for (const channel of ["alpha", "beta", "production"] as const) {
      try { const candidate = await client.discover(channel); if (candidate) await client.dispatch(candidate); }
      catch (error) { log(`${channel}: ${error instanceof PromotionError ? error.message : "Metadata observation unavailable; original run preserved"}`); }
    }
    return;
  }
  requireCheck(subject, "Retention parent is missing");
  if (mode === "--validate") {
    await client.inspect(subject);
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `channel=${subject.channel}\nsource_sha=${subject.sourceSha}\n`);
    return;
  }
  const directory = options.directory ?? ".context/release"; await mkdir(directory, { recursive: true, mode: 0o700 });
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, "eligible=false\n");
  const producer = RetentionProducerSchema.parse({ runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT });
  const deps = { inspect: client.inspect, assertIntentAvailable: client.assertIntentAvailable,
    completion: options.completion ?? ((target: RetentionSubject, failedAt: number) => protectedCompletion(target, failedAt, env, client)),
    verifyOwnIntent: (intent: any) => client.verifyOwnIntent(intent, { id: env.RETENTION_INTENT_ARTIFACT_ID ?? "", digest: env.RETENTION_INTENT_ARTIFACT_DIGEST ?? "" }),
    markRequested: (intent: any) => writeFile(path.join(directory, "retention-requested.json"), `${JSON.stringify({ version: 1, key: retentionIntentKey(intent.subject), producer })}\n`, { mode: 0o600, flag: "wx" }),
    rerun: client.rerun };
  let result: string;
  try {
    if (mode === "--observe") {
      const intent = await prepareRetentionResume(subject, producer, deps);
      await writeFile(path.join(directory, "retention-intent.json"), `${JSON.stringify(intent)}\n`, { mode: 0o600, flag: "wx" });
      if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `eligible=true\nintent_artifact=${retentionIntentKey(subject)}\n`);
      result = "New original native physical completion observed; immutable rerun intent awaits upload, no worker action or success claimed";
    } else {
      const intent = await intentFile(path.join(directory, "retention-intent.json"));
      requireCheck(retentionIntentKey(intent.subject) === retentionIntentKey(subject), "Local intent differs from the immutable dispatch selectors");
      const decision = await requestRetentionResume(intent, producer, deps);
      result = `Original failed worker rerun decision: ${decision}; intent consumed, no worker qualification/publication claim`;
    }
  } catch (error) {
    result = error instanceof PromotionError ? error.message : "Retention observation/request unconfirmed; original failed worker and any armed intent preserved";
  }
  log(result);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${result}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void workerRetentionMain(process.argv[2], process.env).catch(error => {
  console.error(error instanceof PromotionError ? error.message : "Retention metadata gate stopped; original run preserved and private response withheld");
  process.exitCode = 1;
});
