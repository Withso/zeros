import { mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { HostedReceipt, PromotionError, promotionConfig, requireCheck, WorkerIdentity } from "./contracts";
import { promote } from "./promotion";
import { createProviders } from "./providers";
import { githubClient } from "./github";
import { assertCheckout, migrationManifest, workerInputsSha256 } from "./source";
import { command, jsonClient } from "./io";
import { WorkerReceipt } from "./worker";
import { reusableWorker } from "./worker-reuse";
import type { z } from "zod";

async function main() {
  const mode = process.argv[2];
  requireCheck(mode === "--plan" || mode === "--execute", "Usage: cli.ts --plan|--execute");
  const config = promotionConfig(process.env);
  await assertCheckout(config.sourceSha);
  const providers = createProviders(config, process.env), github = githubClient(config, process.env);
  const manifest = await migrationManifest();
  let worker: z.infer<typeof WorkerIdentity> | undefined;
  const checkWorker = async () => {
    const inputsSha256 = await workerInputsSha256(config.sourceSha);
    if (process.env.WORKER_RECEIPT_PATH) {
      // Only a receipt downloaded from the current run's callable worker job
      // can enter this path. The workflow never accepts an arbitrary filename.
      const result = WorkerReceipt.safeParse(JSON.parse(await readFile(process.env.WORKER_RECEIPT_PATH, "utf8")));
      requireCheck(result.success && result.data.channel === config.channel && result.data.sourceSha === config.sourceSha && result.data.inputsSha256 === inputsSha256,
        "Worker receipt does not qualify this exact channel and source");
      worker = result.data.worker;
      return;
    }
    // Reuse requires an identical committed input tree, not a protocol number
    // or a manually copied snapshot ID. An old API without identity fails shut.
    const identity = await jsonClient()(`${config.api}/v1/release-identity`);
    worker = await reusableWorker(config, identity);
  };
  if (mode === "--plan") {
    await github.assertCurrent(); await providers.inspect();
    if (config.channel === "production") await github.betaReceipt();
    await checkWorker();
    console.log(JSON.stringify({ mode: "read-only-plan", channel: config.channel, sourceSha: config.sourceSha, migrationManifest: manifest,
      stages: ["migration-role-plan", "backup-and-strict-migration", "exact-sha-railway", "identity-readiness", "pages-upload", "receipt"] }));
    return;
  }
  const receipt = await promote(config, { ...providers, assertCurrent: github.assertCurrent, betaReceipt: async () => { await github.betaReceipt(); }, checkWorker,
    migration: async execute => JSON.parse(await command("pnpm", ["exec", "tsx", "scripts/release/migration-cli.ts", execute ? "--execute" : "--plan"], {
      env: { ...process.env, NODE_ENV: "production", CONTROL_PLANE_MIGRATION_APPROVALS: "" }, timeout: 50 * 60_000,
    })),
    waitIdentity: () => providers.waitIdentity(manifest, worker),
  });
  await mkdir(".context/release", { recursive: true, mode: 0o700 });
  await writeFile(".context/release/hosted-receipt.json", `${JSON.stringify(HostedReceipt.parse(receipt), null, 2)}\n`, { mode: 0o600 });
  console.log(`Hosted promotion succeeded for ${config.channel} at ${config.sourceSha}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => {
  console.error(error instanceof PromotionError ? error.message : "Hosted promotion stopped; private diagnostics withheld. Reconcile the current stage before retrying.");
  process.exitCode = 1;
});
