import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { HostedReceipt, HostedServicesReceipt, PromotionError, promotionConfig, requireCheck } from "./contracts";
import { finalizePromotion, promote, promoteServices } from "./promotion";
import { createProviders } from "./providers";
import { githubClient } from "./github";
import { assertCheckout, migrationManifest } from "./source";
import { migrationReceipt } from "./migration-command";

export async function main() {
  const mode = process.argv[2];
  requireCheck(["--plan", "--execute", "--services", "--finalize"].includes(mode), "Usage: cli.ts --plan|--execute|--services|--finalize");
  const config = promotionConfig(process.env, { migrations: mode !== "--finalize" });
  await assertCheckout(config.sourceSha);
  const providers = createProviders(config, process.env), github = githubClient(config, process.env);
  const assertCurrent = async () => { await github.assertRequiredChecks(); await github.assertCurrent(); };
  const manifest = await migrationManifest();
  if (mode === "--plan") {
    await assertCurrent(); await providers.inspect();
    if (config.channel === "production") await github.betaReceipt();
    console.log(JSON.stringify({ mode: "read-only-plan", channel: config.channel, sourceSha: config.sourceSha, migrationManifest: manifest,
      stages: ["migration-role-plan", "backup-and-expand-migration", "exact-sha-railway", "identity-readiness", "pages-upload", "workos-handshake", "final-receipt"] }));
    return;
  }
  const receipt = mode === "--finalize"
    ? await finalizePromotion(config, await github.ownServicesReceipt(config.channel, config.runId), {
        ...providers, assertCurrent, waitIdentity: () => providers.waitIdentity(manifest),
      })
    : await (mode === "--services" ? promoteServices : promote)(config, { ...providers, assertCurrent,
        betaReceipt: async () => { await github.betaReceipt(); },
        migration: execute => migrationReceipt(execute, { ...process.env, NODE_ENV: "production", CONTROL_PLANE_MIGRATION_APPROVALS: "" }),
        waitIdentity: () => providers.waitIdentity(manifest),
      });
  await mkdir(".context/release", { recursive: true, mode: 0o700 });
  const servicesOnly = mode === "--services";
  await writeFile(`.context/release/${servicesOnly ? "hosted-services" : "hosted-receipt"}.json`,
    `${JSON.stringify((servicesOnly ? HostedServicesReceipt : HostedReceipt).parse(receipt), null, 2)}\n`, { mode: 0o600 });
  console.log(`${servicesOnly ? "Services ready; final publication authority remains pending" : "Hosted promotion succeeded"} for ${config.channel} at ${config.sourceSha}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => {
  console.error(error instanceof PromotionError ? error.message : "Hosted promotion stopped; private diagnostics withheld. Reconcile the current stage before retrying.");
  process.exitCode = 1;
});
