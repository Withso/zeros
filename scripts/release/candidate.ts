// Production release candidates (docs/release-candidates-roadmap.md).
//
// release.yml publishes each notarized Production build to the rolling `rc`
// prerelease with a receipt of its exact files; release-promote.yml promotes
// those same bytes to vX.Y.Z Latest without rebuilding. The receipt binds the
// version, release branch, source SHA and the release.yml run that built,
// notarized and published it. Promotion refuses anything that no longer matches:
// another candidate, different bytes, a moved branch or `rc` tag, or a live
// Production backend serving a different source.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { DIGEST, requireCheck, SHA } from "./contracts";

export const CANDIDATE_TAG = "rc";
export const CANDIDATE_RECEIPT = "rc-candidate.json";
export const CANDIDATE_FEED = "rc-mac.yml";
export const PUBLISH_JOB = "Publish Production feed";
export const PUBLISH_STEP = "Publish release candidate";
/** The receipt is also saved as an artifact of the run that wrote it: release
 * assets are editable by any `contents: write` token, run artifacts are not. */
export const receiptArtifact = (runId: string, attempt: number) => `release-candidate-${runId}-${attempt}`;
const VERSION = /^\d+\.\d+\.\d+$/;

/** The files a candidate ships, in upload order. `rc-mac.yml` is a byte copy of
 * electron-builder's latest-mac.yml, so promotion can publish it back as-is. */
export function candidateAssets(version: string): string[] {
  requireCheck(VERSION.test(version), "Candidate version must be X.Y.Z");
  return [`Zeros-${version}-arm64.dmg`, `Zeros-${version}-arm64-mac.zip`, `Zeros-${version}-arm64-mac.zip.blockmap`, CANDIDATE_FEED];
}

export const CandidateReceipt = z.object({
  version: z.literal(1),
  releaseVersion: z.string().regex(VERSION),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  branch: z.string().regex(/^release\/\d+\.\d+\.\d+$/),
  sourceSha: z.string().regex(SHA),
  runId: z.string().regex(/^[1-9]\d{0,19}$/),
  runAttempt: z.number().int().min(1).max(10_000),
  files: z.record(z.string(), z.string().regex(DIGEST)),
}).strict();
export type CandidateReceipt = z.infer<typeof CandidateReceipt>;

export async function fileDigest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function writeCandidateReceipt(input: Omit<CandidateReceipt, "version" | "files">, directory: string): Promise<CandidateReceipt> {
  const files: Record<string, string> = {};
  for (const name of candidateAssets(input.releaseVersion)) files[name] = await fileDigest(`${directory}/${name}`);
  requireCheck(input.branch === `release/${input.releaseVersion}`, "Candidate branch must name its version");
  return CandidateReceipt.parse({ version: 1, ...input, files });
}

export type PromotionInput = { repository: string; branch: string; sourceSha: string; directory: string };
export type PromotionDependencies = {
  /** Authenticated GitHub REST read of a repository path, e.g. `/actions/runs/1`. */
  read(path: string): Promise<any>;
  /** The live Production control plane's `/v1/release-identity`. */
  identity(): Promise<any>;
  /** The receipt text release.yml saved as `receiptArtifact(runId, attempt)` of that run, or null. */
  attested(runId: string, attempt: number): Promise<string | null>;
};

/** Everything promotion checks before it may publish vX.Y.Z Latest. */
export async function verifyCandidate(raw: string, input: PromotionInput, deps: PromotionDependencies): Promise<CandidateReceipt> {
  let value: unknown = null;
  try { value = JSON.parse(raw); } catch { /* refused below */ }
  const parsed = CandidateReceipt.safeParse(value);
  requireCheck(parsed.success, "Release candidate receipt is invalid");
  const receipt = parsed.data, version = input.branch.slice("release/".length);
  requireCheck(receipt.repository === input.repository && receipt.branch === input.branch && receipt.releaseVersion === version &&
    receipt.sourceSha === input.sourceSha, "The current release candidate is not this branch's commit; publish it with release.yml first");
  const expected = candidateAssets(version);
  requireCheck(Object.keys(receipt.files).sort().join("\n") === [...expected].sort().join("\n"), "Release candidate receipt lists different files");
  for (const name of expected)
    requireCheck(await fileDigest(`${input.directory}/${name}`) === receipt.files[name], `Downloaded ${name} differs from the candidate that was published`);

  const tag = await deps.read(`/git/ref/tags/${CANDIDATE_TAG}`);
  requireCheck(tag?.object?.sha === input.sourceSha, "The rc tag has moved to another commit");
  const run = await deps.read(`/actions/runs/${receipt.runId}/attempts/${receipt.runAttempt}`);
  requireCheck(String(run?.id) === receipt.runId && run.run_attempt === receipt.runAttempt && run.path === ".github/workflows/release.yml" &&
    run.event === "workflow_dispatch" && run.head_sha === input.sourceSha && run.head_branch === input.branch && run.status === "completed" &&
    run.repository?.full_name === input.repository && run.head_repository?.full_name === input.repository,
    "Release candidate was not published by a completed release.yml run of this commit");
  const jobs = await deps.read(`/actions/runs/${receipt.runId}/attempts/${receipt.runAttempt}/jobs?per_page=100`);
  requireCheck(Array.isArray(jobs?.jobs) && jobs.jobs.length === jobs.total_count && jobs.jobs.some((job: any) =>
    job.name === PUBLISH_JOB && String(job.run_id) === receipt.runId && job.head_sha === input.sourceSha && job.status === "completed" &&
    job.conclusion === "success" && job.steps?.some((step: any) => step.name === PUBLISH_STEP && step.status === "completed" && step.conclusion === "success")),
  "Release candidate publication job did not succeed");
  // The digests above are only as good as the receipt: require the run's own copy.
  requireCheck(await deps.attested(receipt.runId, receipt.runAttempt) === raw,
    "Release candidate receipt differs from the one its release.yml run recorded");

  const identity = await deps.identity();
  requireCheck(identity?.channel === "production" && identity.sourceSha === input.sourceSha && identity.ready === true,
    "Production is not serving this candidate's backend; publish the candidate again before promoting it");
  return receipt;
}
