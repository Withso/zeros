import { refuseRetiredWorkerPromotion } from "./worker-retirement";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { HostedReceipt, HostedServicesReceipt, PromotionError, promotionConfig, ReleaseIdentity, requireCheck, WorkerIdentity } from "./contracts";
import { finalizePromotion, promote, promoteServices } from "./promotion";
import { createProviders } from "./providers";
import { githubClient } from "./github";
import { assertCheckout, migrationManifest, workerInputsSha256 } from "./source";
import { command, jsonClient } from "./io";
import { WorkerReceipt, validateWorkerReceipt } from "./worker";
import { reusableWorker } from "./worker-reuse";
import { alphaFrontierIdentity } from "./alpha-frontier";
import type { z } from "zod";

export async function main() {
  if (process.env.ZEROS_WORKER_PROMOTION === "enabled") refuseRetiredWorkerPromotion();
  const mode = process.argv[2];
  requireCheck(["--plan", "--execute", "--services", "--finalize"].includes(mode), "Usage: cli.ts --plan|--execute|--services|--finalize");
  const config = promotionConfig(process.env, { migrations: mode !== "--finalize" });
  await assertCheckout(config.sourceSha);
  const providers = createProviders(config, process.env), github = githubClient(config, process.env);
  const assertCurrent = async () => { await github.assertRequiredChecks(); await github.assertCurrent(); };
  const manifest = await migrationManifest();
  const workerPending = process.env.WORKER_PROMOTION_REQUIRED === "true" || process.env.WORKER_PROMOTION_REQUIRED === undefined && process.env.ZEROS_WORKER_PROMOTION === "enabled";
  requireCheck(mode !== "--execute" || !workerPending, "Worker-changing releases require the callable services/worker/finalize handoff");
  let worker: z.infer<typeof WorkerIdentity> | undefined;
  const reuseWorker = async () => {
    // Reuse requires an identical committed input tree, not a protocol number
    // or a manually copied snapshot ID. An old API without identity fails shut.
    const identity = await jsonClient()(`${config.api}/v1/release-identity`);
    worker = await reusableWorker(config, identity);
  };
  const prepareWorker = async () => {
    // The old Alpha API may be unready because of the bug this candidate repairs.
    // Read its identity without making old readiness a prerequisite for deployment.
    if (config.channel === "alpha") {
      const identity = await alphaFrontierIdentity();
      requireCheck(identity && (!identity.cloud.enabled || identity.worker), "Pre-worker Alpha API identity is unavailable or invalid");
      if (workerPending && config.cloudRequired) {
        requireCheck(identity.worker && identity.worker.provider === config.provider, "Pre-worker API must keep its existing cloud provider available");
        worker = identity.worker;
      } else if (!workerPending && config.requireQualifiedWorker) {
        requireCheck(identity.cloud.enabled && identity.worker && identity.worker.provider === config.provider && identity.workerQualified === true,
          "Cloud worker qualification or identity is unavailable");
        requireCheck(await workerInputsSha256(identity.worker.sourceSha) === await workerInputsSha256(config.sourceSha),
          "Worker inputs changed; complete cloud-worker-promotion before hosted promotion");
        worker = identity.worker;
      } else worker = undefined;
      return;
    }
    if (!workerPending) return reuseWorker();
    const identity = ReleaseIdentity.parse(await jsonClient()(`${config.api}/v1/release-identity`));
    requireCheck(identity.channel === config.channel, "Pre-worker API identity does not belong to this channel");
    if (config.cloudRequired) {
      requireCheck(identity.worker?.provider === config.provider, "Pre-worker API must keep its existing cloud provider available");
      worker = WorkerIdentity.parse(identity.worker);
    }
  };
  if (mode === "--plan") {
    await assertCurrent(); await providers.inspect();
    if (config.channel === "production") await github.betaReceipt();
    await prepareWorker();
    console.log(JSON.stringify({ mode: "read-only-plan", channel: config.channel, sourceSha: config.sourceSha, migrationManifest: manifest,
      stages: ["migration-role-plan", "backup-and-expand-migration", "exact-sha-railway", "identity-readiness", "pages-upload", "workos-handshake",
        ...(workerPending ? ["worker-build-native-canaries", "qualified-tuple-api-redeploy"] : []), "final-receipt"] }));
    return;
  }
  let receipt;
  if (mode === "--finalize") {
    const services = HostedServicesReceipt.parse(await github.ownServicesReceipt(config.channel, config.runId));
    receipt = await finalizePromotion(config, services, { ...providers, assertCurrent, workerPromoted: workerPending,
      checkWorker: async () => {
        if (!workerPending) return reuseWorker();
        const parsed = WorkerReceipt.parse(await github.ownWorkerReceipt(config.channel, config.runId));
        const qualified = validateWorkerReceipt(parsed, { ...config, inputsSha256: await workerInputsSha256(config.sourceSha), runAttempt: parsed.runAttempt });
        requireCheck(Date.parse(qualified.completedAt) >= Date.parse(services.completedAt), "Worker qualification predates the new API/Pages/WorkOS services handoff");
        worker = qualified.worker;
        await providers.verifyWorkerIdentity(worker);
      },
      waitIdentity: () => providers.waitIdentity(manifest, worker),
    });
  } else receipt = await (mode === "--services" ? promoteServices : promote)(config, { ...providers, assertCurrent,
    betaReceipt: async () => { await github.betaReceipt(); }, checkWorker: prepareWorker,
    migration: async execute => JSON.parse(await command("pnpm", ["exec", "tsx", "scripts/release/migration-cli.ts", execute ? "--execute" : "--plan"], {
      env: { ...process.env, NODE_ENV: "production", CONTROL_PLANE_MIGRATION_APPROVALS: "" }, timeout: 50 * 60_000,
    })),
    waitIdentity: () => providers.waitIdentity(manifest, worker, !workerPending),
  });
  await mkdir(".context/release", { recursive: true, mode: 0o700 });
  const servicesOnly = mode === "--services";
  await writeFile(`.context/release/${servicesOnly ? "hosted-services" : "hosted-receipt"}.json`,
    `${JSON.stringify((servicesOnly ? HostedServicesReceipt : HostedReceipt).parse(receipt), null, 2)}\n`, { mode: 0o600 });
  console.log(`${servicesOnly ? "Services ready; worker/final publication authority remains pending" : "Hosted promotion succeeded"} for ${config.channel} at ${config.sourceSha}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => {
  console.error(error instanceof PromotionError ? error.message : "Hosted promotion stopped; private diagnostics withheld. Reconcile the current stage before retrying.");
  process.exitCode = 1;
});
