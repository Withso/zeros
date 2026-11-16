// release.yml: `candidate-cli.ts --write` records the candidate receipt beside the
// notarized files. release-promote.yml: `candidate-cli.ts --verify` checks the
// downloaded candidate before any vX.Y.Z publication (see candidate.ts).
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CANDIDATE_RECEIPT, verifyCandidate, writeCandidateReceipt } from "./candidate";
import { PromotionError, releaseSource, requireCheck } from "./contracts";
import { jsonClient } from "./io";
import { runtimeOrigin } from "./runtime-contracts";

export async function candidateMain(args = process.argv.slice(2), env = process.env, fetcher: typeof fetch = fetch, directory = "release") {
  requireCheck(args.length === 1 && ["--write", "--verify"].includes(args[0]!), "Usage: candidate-cli.ts --write | --verify");
  const source = releaseSource(env);
  requireCheck(source.channel === "production", "Release candidates are Production builds");
  if (args[0] === "--write") {
    requireCheck(env.GITHUB_WORKFLOW_REF === `${source.repository}/.github/workflows/release.yml@refs/heads/${source.branch}`,
      "Only release.yml publishes release candidates");
    const receipt = await writeCandidateReceipt({ releaseVersion: env.VERSION ?? "", repository: source.repository, branch: source.branch,
      sourceSha: source.sourceSha, runId: env.GITHUB_RUN_ID ?? "", runAttempt: Number(env.GITHUB_RUN_ATTEMPT) }, directory);
    await writeFile(`${directory}/${CANDIDATE_RECEIPT}`, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(`Release candidate ${receipt.releaseVersion} recorded at ${receipt.sourceSha}.`);
    return receipt;
  }
  requireCheck(env.GITHUB_WORKFLOW_REF === `${source.repository}/.github/workflows/release-promote.yml@refs/heads/${source.branch}`,
    "Only release-promote.yml promotes release candidates");
  const json = jsonClient(fetcher);
  const receipt = await verifyCandidate(JSON.parse(await readFile(`${directory}/${CANDIDATE_RECEIPT}`, "utf8")), { ...source, directory }, {
    read: path => json(`https://api.github.com/repos/${source.repository}${path}`, {
      headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } }),
    identity: () => json(`${runtimeOrigin("production")}/v1/release-identity`, { cache: "no-store" }),
  });
  console.log(`Release candidate ${receipt.releaseVersion} verified at ${receipt.sourceSha}; promoting the same files.`);
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void candidateMain().catch(error => {
  console.error(error instanceof PromotionError ? error.message : "Release candidate check failed; nothing was published");
  process.exitCode = 1;
});
