import { PromotionError, releaseSource, requireCheck } from "./contracts";
import { waitForRequiredCI } from "./ci";
import { githubClient } from "./github";
import { command } from "./io";

async function main() {
  const mode = process.argv[2];
  requireCheck(mode === "--wait" || mode === "--verify", "Usage: ci-cli.ts --wait|--verify [--beta]");
  const source = releaseSource(process.env);
  requireCheck(process.argv.length <= 4 && (process.argv[3] === undefined || mode === "--verify" && process.argv[3] === "--beta" && source.channel === "production"),
    "Beta proof is available only with Production --verify --beta");
  requireCheck((await command("git", ["rev-parse", "HEAD"])).trim() === source.sourceSha, "CI gate checkout differs from the event SHA");
  const github = githubClient(source, process.env);
  if (mode === "--wait") await waitForRequiredCI(async () => {
    await github.assertCurrent();
    return github.requiredChecks();
  });
  else await github.assertRequiredChecks();
  await github.assertCurrent();
  if (process.argv[3] === "--beta" && process.env.ZEROS_HOSTED_PROMOTION === "enabled") await github.betaReceipt();
  console.log(`Preflight and CodeQL succeeded for the exact ${source.channel} source ${source.sourceSha}.`);
}

void main().catch(error => {
  console.error(error instanceof PromotionError ? error.message : "Required CI proof failed; provider and feed mutation refused.");
  process.exitCode = 1;
});
