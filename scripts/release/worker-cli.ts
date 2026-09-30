import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNELS, PromotionError, ReleaseIdentity, releaseSource, requireCheck } from "./contracts";
import { classifyChanges, changedFiles, assertCheckout, workerInputsSha256 } from "./source";
import { githubClient } from "./github";
import { jsonClient } from "./io";
import { executeWorkerPromotion } from "./worker-run";
import { workerExecutionConfig } from "./worker-config";
import { validateWorkerReceipt } from "./worker";
import { workerQualificationProfile } from "./worker-profile";

export async function assertWorkerTrigger(env: NodeJS.ProcessEnv) {
  const source = releaseSource(env);
  requireCheck(["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME ?? "") && env.GITHUB_EVENT_PATH &&
    env.GITHUB_REF === `refs/heads/${source.branch}` && !env.GITHUB_HEAD_REF, "Worker execution refuses PR, fork and indirect triggers");
  const bytes = await readFile(env.GITHUB_EVENT_PATH);
  requireCheck(bytes.length <= 1024 * 1024, "Worker trigger exceeds its bound");
  const event = JSON.parse(bytes.toString("utf8"));
  requireCheck(event.repository?.fork === false && event.repository?.full_name === source.repository &&
    (env.GITHUB_EVENT_NAME !== "push" || event.after === source.sourceSha), "Worker execution requires a trusted non-fork exact-source trigger");
}
async function assertNoAgentEnv() {
  try { await stat(".env.agent"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new PromotionError("Worker release checkout must not contain .env.agent; release credentials belong only to protected CI and the channel credential store");
}
type ServicesProof = { channel: string; sourceSha: string; repository: string; branch: string; completedAt: string };
type Dependencies = {
  directory: string; assertCheckout: typeof assertCheckout; assertNoAgentEnv: typeof assertNoAgentEnv; assertTrigger: typeof assertWorkerTrigger;
  hash: typeof workerInputsSha256; changes: typeof changedFiles; assertCI(): Promise<void>; assertCurrent(): Promise<void>;
  readIdentity(): Promise<unknown>; services(runId: string): Promise<ServicesProof>; execute: typeof executeWorkerPromotion; log(message: string): void;
};
export async function workerMain(mode: string | undefined, env: NodeJS.ProcessEnv, overrides: Partial<Dependencies> = {}) {
  const source = releaseSource(env), github = githubClient(source, env);
  const deps: Dependencies = { directory: ".context/release", assertCheckout, assertNoAgentEnv, assertTrigger: assertWorkerTrigger, hash: workerInputsSha256,
    changes: changedFiles, assertCI: () => github.assertRequiredChecks(), assertCurrent: () => github.assertCurrent(),
    readIdentity: () => jsonClient()(`${CHANNELS[source.channel].api}/v1/release-identity`), services: runId => github.ownServicesReceipt(source.channel, runId),
    execute: executeWorkerPromotion, log: console.log, ...overrides };
  requireCheck(mode === "--plan" || mode === "--execute", "Worker lane requires --plan or --execute");
  await mkdir(deps.directory, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(deps.directory, "worker-receipt.json");
  await rm(receiptPath, { force: true });
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, "receipt_issued=false\nreceipt_artifact=\n");
  const files = await deps.changes(source.sourceSha, env.RELEASE_BASE), inputsSha256 = await deps.hash(source.sourceSha);
  const requested = env.WORKER_QUALIFICATION_PROFILE ?? "auto";
  const plan = { version: 1, status: "plan", ...source, inputsChanged: classifyChanges(files).worker, inputsSha256,
    enabled: env.ZEROS_WORKER_PROMOTION === "enabled", qualificationProfile: workerQualificationProfile(files, requested),
    stages: ["exact-source-ci-services-workos", "shared-account-slot-admission", "credential-free-boat-image-kit", "owner-designated-native-canaries",
      "physical-cleanup-proof", "same-owner-audited-plan-execute", "owner-role-deletion", "atomic-worker-tuple-skip-deploys", "run-bound-receipt"] };
  await writeFile(path.join(deps.directory, "worker-plan.json"), `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  if (mode === "--plan") { deps.log("Worker plan saved; no provider mutations or qualification receipt issued."); return { receiptIssued: false }; }
  requireCheck(plan.enabled, "Worker promotion is disabled");
  await deps.assertNoAgentEnv(); await deps.assertTrigger(env); await deps.assertCheckout(source.sourceSha);
  workerExecutionConfig(env);
  await deps.assertCI(); await deps.assertCurrent();
  const parsed = ReleaseIdentity.safeParse(await deps.readIdentity());
  requireCheck(parsed.success && parsed.data.channel === source.channel && parsed.data.sourceSha === source.sourceSha && !parsed.data.maintenance &&
    parsed.data.migrations.state === "current" && parsed.data.migrations.head === parsed.data.migrations.expectedHead,
  "Worker execution requires the new exact-SHA API and current schema after hosted services");
  const identity = parsed.data;
  if (env.WORKER_RECEIPT_REQUIRED !== "true" && requested !== "full" && identity.ready && identity.cloud.enabled && identity.cloud.ready && identity.cloud.state === "healthy" &&
    identity.worker?.provider === "boat" && identity.workerQualified === true && await deps.hash(identity.worker.sourceSha) === inputsSha256) {
    deps.log("The selected worker is already qualified for identical committed inputs; reused without issuing a new receipt.");
    return { receiptIssued: false };
  }
  const servicesRunId = env.WORKER_SERVICES_RUN_ID || env.GITHUB_RUN_ID;
  requireCheck(servicesRunId && /^[1-9]\d*$/.test(servicesRunId), "A trusted pre-worker services run is required");
  const services = await deps.services(servicesRunId);
  requireCheck(services.channel === source.channel && services.sourceSha === source.sourceSha && services.repository === source.repository &&
    services.branch === source.branch && Number.isFinite(Date.parse(services.completedAt)) && Date.parse(services.completedAt) <= Date.now() + 5000,
  "The services/WorkOS receipt does not belong to this exact release source");
  const profile = workerQualificationProfile(await deps.changes(source.sourceSha, identity.worker?.sourceSha), requested);
  await deps.assertCI(); await deps.assertCurrent();
  const receipt = validateWorkerReceipt(await deps.execute(env, inputsSha256, profile), { ...source, inputsSha256, runId: env.GITHUB_RUN_ID!, runAttempt: env.GITHUB_RUN_ATTEMPT! });
  requireCheck(receipt.qualificationProfile === profile && Date.parse(receipt.completedAt) >= Date.parse(services.completedAt), "Worker receipt profile or ordered completion is invalid");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  const artifact = `worker-promotion-${source.channel}-${source.sourceSha}`;
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `receipt_issued=true\nreceipt_artifact=${artifact}\n`);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `Worker ${profile} qualification succeeded for ${source.channel} at ${source.sourceSha}; cleanup and audited approval confirmed. API redeploy/final hosted receipt remain pending.\n`);
  deps.log(`Worker qualification succeeded for ${source.channel}; complete tuple selected with API deployment deferred to hosted finalization.`);
  return { receiptIssued: true, artifact };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void workerMain(process.argv[2], process.env).catch(error => {
  console.error(error instanceof PromotionError ? error.message : "Worker qualification stopped; private diagnostics withheld. Reconcile resources and credential admission before retrying; no receipt issued.");
  process.exitCode = 1;
});
