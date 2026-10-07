import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNELS, PromotionError, ReleaseIdentity, releaseSource, requireCheck } from "./contracts";
import { classifyChanges, changedFiles, assertCheckout, workerInputsSha256 } from "./source";
import { githubClient } from "./github";
import { jsonClient } from "./io";
import { reconcileWorkerNativeStorage } from "./worker-run";
import { workerExecutionConfig } from "./worker-config";
import { refuseRetiredWorkerPromotion } from "./worker-retirement";
import { RELEASE_WORKER_IMAGES_RETIRED } from "../../apps/control-plane/src/cloud-workspaces/release-worker-retirement";
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
type Dependencies = {
  directory: string; assertCheckout: typeof assertCheckout; assertNoAgentEnv: typeof assertNoAgentEnv; assertTrigger: typeof assertWorkerTrigger;
  hash: typeof workerInputsSha256; changes: typeof changedFiles; assertCI(): Promise<void>; assertCurrent(): Promise<void>;
  readIdentity(): Promise<unknown>; reconcile: typeof reconcileWorkerNativeStorage; log(message: string): void;
};
export async function workerMain(mode: string | undefined, env: NodeJS.ProcessEnv, overrides: Partial<Dependencies> = {}) {
  requireCheck(["--plan", "--execute", "--reconcile-storage"].includes(mode ?? ""), "Worker lane requires --plan, --execute or --reconcile-storage");
  if (mode === "--execute") {
    requireCheck(env.ZEROS_WORKER_PROMOTION === "enabled", "Worker promotion is disabled");
    refuseRetiredWorkerPromotion();
  }
  const source = releaseSource(env), github = githubClient(source, env);
  const deps: Dependencies = { directory: ".context/release", assertCheckout, assertNoAgentEnv, assertTrigger: assertWorkerTrigger, hash: workerInputsSha256,
    changes: changedFiles, assertCI: () => github.assertRequiredChecks(), assertCurrent: () => github.assertCurrent(),
    readIdentity: () => jsonClient()(`${CHANNELS[source.channel].api}/v1/release-identity`),
    reconcile: reconcileWorkerNativeStorage, log: console.log, ...overrides };
  await mkdir(deps.directory, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(deps.directory, "worker-receipt.json");
  await rm(receiptPath, { force: true });
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, "receipt_issued=false\nreceipt_artifact=\n");
  const files = await deps.changes(source.sourceSha, env.RELEASE_BASE), inputsSha256 = await deps.hash(source.sourceSha);
  const requested = env.WORKER_QUALIFICATION_PROFILE ?? "auto";
  const plan = { version: 1, status: "plan", ...source, inputsChanged: classifyChanges(files).worker, inputsSha256,
    enabled: false, retired: true, reason: RELEASE_WORKER_IMAGES_RETIRED,
    requestedEnabled: env.ZEROS_WORKER_PROMOTION === "enabled", qualificationProfile: workerQualificationProfile(files, requested),
    stages: ["guarded-existing-resource-cleanup"] };
  await writeFile(path.join(deps.directory, "worker-plan.json"), `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  if (mode === "--plan") { deps.log(`${RELEASE_WORKER_IMAGES_RETIRED}. Cleanup-only plan saved; no receipt issued.`); return { receiptIssued: false }; }
  requireCheck(mode === "--reconcile-storage" ? env.WORKER_RECONCILE_STORAGE === "true" && env.WORKER_EXECUTE !== "true" : env.WORKER_RECONCILE_STORAGE !== "true",
    "Worker storage reconciliation requires its exclusive protected intent");
  await deps.assertNoAgentEnv(); await deps.assertTrigger(env); await deps.assertCheckout(source.sourceSha);
  workerExecutionConfig(env, { cleanupOnly: true });
  await deps.assertCI(); await deps.assertCurrent();
  const parsed = ReleaseIdentity.safeParse(await deps.readIdentity());
  requireCheck(parsed.success && parsed.data.channel === source.channel && parsed.data.sourceSha === source.sourceSha && !parsed.data.maintenance &&
    parsed.data.migrations.state === "current" && parsed.data.migrations.head === parsed.data.migrations.expectedHead,
  "Worker execution requires the new exact-SHA API and current schema after hosted services");
  const reconciled = await deps.reconcile(env);
  deps.log(`Observed ${reconciled} retained native cleanup records; no allocation, qualification, tuple update or receipt issued.`);
  return { receiptIssued: false, reconciled };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void workerMain(process.argv[2], process.env).catch(error => {
  console.error(error instanceof PromotionError ? error.message : "Worker qualification stopped; private diagnostics withheld. Reconcile resources and credential admission before retrying; no receipt issued.");
  process.exitCode = 1;
});
