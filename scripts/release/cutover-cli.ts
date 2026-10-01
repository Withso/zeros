import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PromotionError, promotionConfig, requireCheck } from "./contracts";
import { CutoverReceipt, controlledCutover, parseApprovals } from "./cutover";
import { createProviders } from "./providers";
import { githubClient } from "./github";
import { assertCheckout, migrationManifest } from "./source";
import { command } from "./io";

async function main() {
  const approvals = parseApprovals(process.env.CUTOVER_APPROVALS);
  const config = promotionConfig(process.env);
  // A typed database name keeps a mistaken dispatch from mutating any channel.
  requireCheck(process.env.CUTOVER_CONFIRM === config.database, `Type ${config.database} to confirm this cutover`);
  await assertCheckout(config.sourceSha);
  const providers = createProviders(config, process.env), github = githubClient(config, process.env);
  const manifest = await migrationManifest();
  const receipt = await controlledCutover(config, {
    ...providers,
    assertCurrent: async () => { await github.assertRequiredChecks(); await github.assertCurrent(); },
    // Only the execute step receives approvals; the strict migrator applies
    // exactly those controlled boundaries and nothing a plan did not list.
    migration: async execute => JSON.parse(await command("pnpm", ["exec", "tsx", "scripts/release/migration-cli.ts", execute ? "--execute" : "--plan"], {
      env: { ...process.env, NODE_ENV: "production", CONTROL_PLANE_MIGRATION_APPROVALS: execute ? approvals.join(",") : "" }, timeout: 50 * 60_000,
    })),
    waitIdentity: () => providers.waitIdentity(manifest, undefined, false),
  }, approvals);
  await mkdir(".context/release", { recursive: true, mode: 0o700 });
  await writeFile(".context/release/cutover-receipt.json", `${JSON.stringify(CutoverReceipt.parse(receipt), null, 2)}\n`, { mode: 0o600 });
  console.log(`Controlled cutover complete for ${config.channel} at ${config.sourceSha}. Rerun the failed desktop release for this SHA.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => {
  console.error(error instanceof PromotionError ? error.message : "Controlled cutover stopped; private diagnostics withheld. Reconcile the current stage before retrying.");
  process.exitCode = 1;
});
