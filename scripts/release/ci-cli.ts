import { appendFile } from "node:fs/promises";
import { PromotionError, releaseSource, requireCheck } from "./contracts";
import { CandidateSupersededError } from "./alpha-ci";
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
  const automaticAlpha = source.channel === "alpha" && await github.automaticAlpha();
  const barrier = automaticAlpha && mode === "--wait" && process.env.GITHUB_JOB === "ci";
  const ready = async (value: boolean) => {
    requireCheck(process.env.GITHUB_OUTPUT, "Automatic Alpha barrier requires a readiness output destination");
    await appendFile(process.env.GITHUB_OUTPUT, `ready=${value}\n`);
  };
  try {
    if (mode === "--wait") await waitForRequiredCI(async () => {
      await github.assertCurrent();
      return github.requiredChecks();
    });
    else await github.assertRequiredChecks();
    await github.assertCurrent();
  } catch (error) {
    if (barrier && error instanceof CandidateSupersededError && await github.alphaBarrierUnmutated()) {
      await ready(false);
      console.log("::notice::Automatic Alpha candidate was superseded before any destination mutation; downstream publication skipped.");
      return;
    }
    throw error;
  }
  if (process.argv[3] === "--beta" && process.env.ZEROS_HOSTED_PROMOTION === "enabled") await github.betaReceipt();
  if (barrier) await ready(true);
  const checks = automaticAlpha && process.env.ZEROS_ALPHA_CI_FAST_PATH === "enabled" ? "Alpha gate and CodeQL" : "Preflight and CodeQL";
  console.log(`${checks} succeeded for the exact ${source.channel} source ${source.sourceSha}.`);
}

void main().catch(error => {
  console.error(error instanceof PromotionError ? error.message : "Required CI proof failed; provider and feed mutation refused.");
  process.exitCode = 1;
});
