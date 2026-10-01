import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PromotionError, promotionConfig, requireCheck } from "./contracts";
import { CutoverReceipt, controlledCutover, newCutoverJournal, parseApprovals, type CutoverJournal } from "./cutover";
import { z } from "zod";
import { createProviders } from "./providers";
import { githubClient } from "./github";
import { assertCheckout, migrationManifest } from "./source";
import { command } from "./io";

const FailedMigration = z.object({ backup: z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), state: z.string().max(32) }).nullable(),
  applied: z.array(z.string().regex(/^\d{4}_[a-z0-9_]+\.sql$/)).nullable(), roleDeleted: z.boolean() });

async function main() {
  const approvals = parseApprovals(process.env.CUTOVER_APPROVALS);
  const config = promotionConfig(process.env);
  // A typed database name keeps a mistaken dispatch from mutating any channel.
  requireCheck(process.env.CUTOVER_CONFIRM === config.database, `Type ${config.database} to confirm this cutover`);
  await assertCheckout(config.sourceSha);
  const providers = createProviders(config, process.env), github = githubClient(config, process.env);
  if (config.channel === "production") {
    // The reviewer's approval is not qualification: Beta must have published
    // this exact source first.
    const beta = await github.lastPublication("beta");
    requireCheck(beta?.sourceSha === config.sourceSha, "Production cutover requires a successful Beta publication of this exact SHA first");
  }
  const manifest = await migrationManifest();
  const journal = newCutoverJournal();
  await mkdir(".context/release", { recursive: true, mode: 0o700 });
  const failureFile = path.resolve(".context/release/migration-failure.json");
  await rm(failureFile, { force: true });
  // Atomic replacement: a killed runner leaves the previous complete journal.
  const writeJournal = async (value: CutoverJournal) => {
    const temporary = ".context/release/cutover-journal.json.tmp";
    await writeFile(temporary, `${JSON.stringify({ channel: config.channel, sourceSha: config.sourceSha, runId: config.runId,
      runAttempt: config.runAttempt, approvals, ...value, recordedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, ".context/release/cutover-journal.json");
  };
  try {
    const receipt = await controlledCutover(config, {
      ...providers,
      assertCurrent: async () => { await github.assertRequiredChecks(); await github.assertCurrent(); },
      // Only the execute step receives approvals; the strict migrator applies
      // exactly those controlled boundaries and nothing a plan did not list.
      migration: async execute => JSON.parse(await command("pnpm", ["exec", "tsx", "scripts/release/migration-cli.ts", execute ? "--execute" : "--plan"], {
        env: { ...process.env, NODE_ENV: "production", CONTROL_PLANE_MIGRATION_APPROVALS: execute ? approvals.join(",") : "",
          MIGRATION_FAILURE_FILE: execute ? failureFile : "" }, timeout: 50 * 60_000,
      })),
      migrationFailure: async () => {
        const parsed = FailedMigration.safeParse(JSON.parse(await readFile(failureFile, "utf8")));
        return parsed.success ? parsed.data : undefined;
      },
      waitIdentity: () => providers.waitIdentity(manifest, undefined, false),
    }, approvals, journal, writeJournal);
    await writeFile(".context/release/cutover-receipt.json", `${JSON.stringify(CutoverReceipt.parse(receipt), null, 2)}\n`, { mode: 0o600 });
    console.log(`Controlled cutover complete for ${config.channel} at ${config.sourceSha}. Rerun this SHA's failed desktop release.`);
  } finally {
    // Uploaded on failure too: the allowlisted journal is the recovery record.
    await writeJournal(journal).catch(() => {});
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => {
  console.error(error instanceof PromotionError ? error.message : "Controlled cutover stopped; private diagnostics withheld. Reconcile the current stage before retrying.");
  process.exitCode = 1;
});
