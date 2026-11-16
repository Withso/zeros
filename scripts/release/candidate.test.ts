import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { candidateAssets, verifyCandidate, writeCandidateReceipt, PUBLISH_JOB, PUBLISH_STEP } from "./candidate";
import { candidateMain } from "./candidate-cli";

const sha = "a".repeat(40), repository = "example/project", branch = "release/0.1.31";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function candidate() {
  const directory = await mkdtemp(join(tmpdir(), "zeros-candidate-")); directories.push(directory);
  for (const name of candidateAssets("0.1.31")) await writeFile(join(directory, name), `bytes of ${name}\n`);
  const receipt = await writeCandidateReceipt({ releaseVersion: "0.1.31", repository, branch, sourceSha: sha, runId: "42", runAttempt: 2 }, directory);
  const state = { tag: sha, path: ".github/workflows/release.yml", event: "workflow_dispatch", status: "completed", job: PUBLISH_JOB, step: PUBLISH_STEP,
    conclusion: "success", identity: { channel: "production", sourceSha: sha, ready: true } as Record<string, unknown> };
  const deps = {
    read: vi.fn(async (path: string) => {
      if (path === "/git/ref/tags/rc") return { object: { sha: state.tag } };
      if (path === "/actions/runs/42/attempts/2") return { id: 42, run_attempt: 2, path: state.path, event: state.event, head_sha: sha, head_branch: branch,
        status: state.status, repository: { full_name: repository }, head_repository: { full_name: repository } };
      if (path === "/actions/runs/42/attempts/2/jobs?per_page=100") return { total_count: 1, jobs: [{ name: state.job, run_id: 42, head_sha: sha,
        status: "completed", conclusion: state.conclusion, steps: [{ name: state.step, status: "completed", conclusion: "success" }] }] };
      throw new Error(`unexpected ${path}`);
    }),
    identity: vi.fn(async () => state.identity),
  };
  return { directory, receipt, state, deps, input: { repository, branch, sourceSha: sha, directory } };
}

describe("release candidate receipt", () => {
  it("records every shipped file's digest for its version, branch, commit and run", async () => {
    const { receipt } = await candidate();
    expect(Object.keys(receipt.files)).toEqual(["Zeros-0.1.31-arm64.dmg", "Zeros-0.1.31-arm64-mac.zip", "Zeros-0.1.31-arm64-mac.zip.blockmap", "rc-mac.yml"]);
    expect(receipt).toMatchObject({ version: 1, releaseVersion: "0.1.31", branch, sourceSha: sha, runId: "42", runAttempt: 2 });
  });

  it("refuses a branch that does not name the version, or a pre-release version", async () => {
    const { directory } = await candidate();
    await expect(writeCandidateReceipt({ releaseVersion: "0.1.31", repository, branch: "release/0.1.30", sourceSha: sha, runId: "1", runAttempt: 1 }, directory))
      .rejects.toThrow(/name its version/);
    expect(() => candidateAssets("0.1.31-beta.2")).toThrow(/X\.Y\.Z/);
  });
});

describe("promoting a release candidate", () => {
  it("accepts the published bytes of this commit while Production serves its backend", async () => {
    const f = await candidate();
    await expect(verifyCandidate(f.receipt, f.input, f.deps)).resolves.toEqual(f.receipt);
  });

  it("refuses changed bytes", async () => {
    const f = await candidate();
    await writeFile(join(f.directory, "Zeros-0.1.31-arm64-mac.zip"), "tampered\n");
    await expect(verifyCandidate(f.receipt, f.input, f.deps)).rejects.toThrow(/differs from the candidate/);
  });

  it.each([["another branch", { branch: "release/0.1.32" }], ["another commit", { sourceSha: "b".repeat(40) }]])("refuses %s", async (_name, patch) => {
    const f = await candidate();
    await expect(verifyCandidate(f.receipt, { ...f.input, ...patch }, f.deps)).rejects.toThrow(/not this branch's commit/);
  });

  it.each([
    ["a moved rc tag", { tag: "b".repeat(40) }, /rc tag has moved/],
    ["a run of another workflow", { path: ".github/workflows/release-beta.yml" }, /completed release\.yml run/],
    ["a pushed run", { event: "push" }, /completed release\.yml run/],
    ["a run still in progress", { status: "in_progress" }, /completed release\.yml run/],
    ["a failed publication job", { conclusion: "failure" }, /publication job/],
    ["a renamed publication step", { step: "Publish GitHub release" }, /publication job/],
  ])("refuses %s", async (_name, patch, error) => {
    const f = await candidate(); Object.assign(f.state, patch);
    await expect(verifyCandidate(f.receipt, f.input, f.deps)).rejects.toThrow(error);
  });

  it.each([{ sourceSha: "b".repeat(40) }, { ready: false }, { channel: "beta" }])("refuses while Production serves %j", async patch => {
    const f = await candidate(); Object.assign(f.state.identity, patch);
    await expect(verifyCandidate(f.receipt, f.input, f.deps)).rejects.toThrow(/not serving this candidate/);
  });

  it("refuses a receipt listing different files", async () => {
    const f = await candidate();
    await expect(verifyCandidate({ ...f.receipt, files: { ...f.receipt.files, "extra.bin": "c".repeat(64) } }, f.input, f.deps)).rejects.toThrow(/different files/);
  });
});

describe("candidate cli", () => {
  const env = { RELEASE_CHANNEL: "production", RELEASE_SHA: sha, GITHUB_SHA: sha, RELEASE_BRANCH: branch, GITHUB_REPOSITORY: repository,
    VERSION: "0.1.31", GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "2" };
  it("writes the receipt only from release.yml", async () => {
    const f = await candidate();
    await expect(candidateMain(["--write"], { ...env, GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/release.yml@refs/heads/${branch}` }, fetch, f.directory))
      .resolves.toEqual(f.receipt);
    await expect(candidateMain(["--write"], { ...env, GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/release-promote.yml@refs/heads/${branch}` }, fetch, f.directory))
      .rejects.toThrow(/Only release\.yml/);
  });
  it("verifies only from release-promote.yml, and only Production", async () => {
    const f = await candidate();
    await expect(candidateMain(["--verify"], { ...env, GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/release.yml@refs/heads/${branch}` }, fetch, f.directory))
      .rejects.toThrow(/Only release-promote\.yml/);
    await expect(candidateMain(["--write"], { ...env, RELEASE_CHANNEL: "beta" }, fetch, f.directory)).rejects.toThrow(/Production builds/);
  });
});
