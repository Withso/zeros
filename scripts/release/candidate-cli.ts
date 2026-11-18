// release.yml: `candidate-cli.ts --write` records the candidate receipt beside the
// notarized files. release-promote.yml: `candidate-cli.ts --verify` checks the
// downloaded candidate before any vX.Y.Z publication (see candidate.ts).
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CANDIDATE_RECEIPT, receiptArtifact, verifyCandidate, writeCandidateReceipt } from "./candidate";
import { CHANNELS, PromotionError, releaseSource, requireCheck } from "./contracts";
import { jsonClient } from "./io";

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
  const read = (path: string) => json(`https://api.github.com/repos/${source.repository}${path}`, {
    headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
  const receipt = await verifyCandidate(await readFile(`${directory}/${CANDIDATE_RECEIPT}`, "utf8"), { ...source, directory }, {
    read,
    identity: () => json(`${CHANNELS.production.api}/v1/release-identity`, { cache: "no-store" }),
    attested: (runId, attempt) => download(source.repository, runId, attempt, read, env),
  });
  console.log(`Release candidate ${receipt.releaseVersion} verified at ${receipt.sourceSha}; promoting the same files.`);
  return receipt;
}

/** The run's own receipt artifact, or null when it is missing, expired or ambiguous. */
async function download(repository: string, runId: string, attempt: number, read: (path: string) => Promise<any>, env: NodeJS.ProcessEnv) {
  const name = receiptArtifact(runId, attempt);
  const list = await read(`/actions/runs/${runId}/artifacts?per_page=100`);
  if (!Array.isArray(list?.artifacts) || list.artifacts.filter((a: any) => a.name === name && a.expired === false).length !== 1) return null;
  const directory = await mkdtemp(join(tmpdir(), "zeros-candidate-receipt-"));
  try {
    await promisify(execFile)("gh", ["run", "download", runId, "--repo", repository, "--name", name, "--dir", directory],
      { env: { PATH: env.PATH, HOME: env.HOME, GH_TOKEN: env.GH_TOKEN }, timeout: 60_000 });
    // One handle for the check and the read, so the file cannot change between them.
    const file = await open(join(directory, CANDIDATE_RECEIPT), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 64 * 1024) return null;
      const bytes = await file.readFile();
      return bytes.length <= 64 * 1024 ? bytes.toString("utf8") : null;
    } finally { await file.close(); }
  } catch {
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void candidateMain().catch(error => {
  console.error(error instanceof PromotionError ? error.message : "Release candidate check failed; nothing was published");
  process.exitCode = 1;
});
