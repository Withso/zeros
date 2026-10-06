import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { PromotionError, releaseSource, requireCheck } from "./contracts";
import { CandidateSupersededError } from "./alpha-ci";
import { AlphaAdmissionReceipt, AlphaAdmissionRejectedError, alphaForwardOnlyMode } from "./alpha-frontier";
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
  const expectedAlphaBarrier = source.channel === "alpha" && mode === "--wait" && process.env.GITHUB_JOB === "ci" &&
    process.env.GITHUB_WORKFLOW_REF?.includes("/.github/workflows/release-alpha.yml@");
  requireCheck(!expectedAlphaBarrier || automaticAlpha,
    "Automatic Alpha barrier identity could not be authenticated; verify the release-alpha.yml parent run, run attempt, repository, source SHA and GITHUB_WORKFLOW_REF before retrying.");
  const barrier = automaticAlpha && mode === "--wait" && process.env.GITHUB_JOB === "ci";
  const ready = async (value: boolean) => {
    requireCheck(process.env.GITHUB_OUTPUT, "Automatic Alpha barrier requires a readiness output destination");
    await appendFile(process.env.GITHUB_OUTPUT, `ready=${value}\n`);
  };
  const required = await github.requiredWorkflows();
  try {
    if (mode === "--wait") await waitForRequiredCI(async () => {
      await github.assertCurrent();
      return github.requiredChecks();
    }, {}, required);
    else await github.assertRequiredChecks();
    await github.assertCurrent();
  } catch (error) {
    if (barrier && (error instanceof CandidateSupersededError || error instanceof AlphaAdmissionRejectedError) && await github.alphaBarrierUnmutated()) {
      await ready(false);
      console.log("::notice::Automatic Alpha candidate was superseded before any destination mutation; downstream publication skipped.");
      return;
    }
    throw error;
  }
  if (process.argv[3] === "--beta" && process.env.ZEROS_HOSTED_PROMOTION === "enabled") await github.betaReceipt();
  const admissionMode = alphaForwardOnlyMode(process.env);
  if (barrier && admissionMode !== "off") {
    const receipt = AlphaAdmissionReceipt.parse({ version: 1, ...source, runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT, mode: admissionMode });
    await mkdir(".context/release", { recursive: true, mode: 0o700 });
    await writeFile(".context/release/alpha-admission.json", `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    await appendFile(process.env.GITHUB_OUTPUT!, "admission_issued=true\n");
  }
  if (barrier) await ready(true);
  const checks = required.length === 1 ? "Alpha gate" : "Preflight and CodeQL";
  console.log(`${checks} succeeded for the exact ${source.channel} source ${source.sourceSha}.`);
}

void main().catch(error => {
  console.error(error instanceof PromotionError ? error.message : "Required CI proof failed; provider and feed mutation refused.");
  process.exitCode = 1;
});
