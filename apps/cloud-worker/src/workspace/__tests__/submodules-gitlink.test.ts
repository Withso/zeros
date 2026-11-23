// workspace-submodules-v1, run for real (git): after a restore, a missing planned submodule is checked out at the gitlink
// its restored superproject records (the person may have moved it), not the create-time plan's commit. The primary's
// review test (C4B), with a nested child and the fallbacks beside it. github.com is a local origin for the test only.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { fetchPlannedSubmodules, type WorkerSubmodule } from "../submodules";

const run = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
const digest = (name: string) => createHash("sha256").update(name).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "worker-submodules-")); directories.push(root);
  const gitconfig = join(root, "gitconfig");
  const environment = { GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1" };
  const git = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd, timeout: 10_000,
    env: { ...process.env, ...environment, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@example.test", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@example.test" } })).stdout.trim();
  // acme/lib's origin, published at https://github.com/acme/lib.git for this test.
  const origin = join(root, "lib.git"), seed = join(root, "seed");
  await git(root, "init", "-q", "--bare", "-b", "main", origin);
  await git(root, "clone", "-q", origin, seed);
  await writeFile(join(seed, "lib.txt"), "one\n"); await git(seed, "add", "-A"); await git(seed, "commit", "-q", "-m", "one");
  const first = await git(seed, "rev-parse", "HEAD");
  await writeFile(join(seed, "lib.txt"), "two\n"); await git(seed, "commit", "-qam", "two"); await git(seed, "push", "-q", "origin", "main");
  const second = await git(seed, "rev-parse", "HEAD");
  await writeFile(gitconfig, `[url "file://${origin}"]\n\tinsteadOf = https://github.com/acme/lib.git\n\tinsteadOf = https://github.com/oss/vendor.git\n[protocol "file"]\n\tallow = always\n`);
  // The workspace's checkout, with the gitlink folder its clone left empty.
  const checkout = join(root, "home", "zeros", "app");
  await mkdir(join(checkout, "vendor", "lib"), { recursive: true });
  await git(checkout, "init", "-q", "-b", "main");
  const entry: WorkerSubmodule = { position: 0, path: "vendor/lib", repository: "acme/lib", commit: first, gitDir: `modules/${digest("vendor/lib")}` };
  const commitGitlink = async (sha: string) => {
    await git(checkout, "update-index", "--add", "--cacheinfo", `160000,${sha},vendor/lib`);
    await git(checkout, "commit", "-qm", "move lib");
  };
  return { root, git, checkout, environment, entry, first, second, commitGitlink };
}

describe("review: a restore after the person moved the submodule's gitlink", () => {
  it("checks out the gitlink the restored superproject records, not the create-time plan", async () => {
    const f = await fixture();
    // The person moved vendor/lib to the second commit and committed that gitlink in the superproject before the stop.
    await f.commitGitlink(f.second);
    // The restore leaves the gitlink's folder empty; the plan still names the create-time commit (first).
    expect(await fetchPlannedSubmodules(f.checkout, [f.entry], f.environment, { onlyMissing: true })).toEqual([{ path: "vendor/lib", fetched: true }]);
    const target = join(f.checkout, "vendor/lib");
    expect(await f.git(target, "rev-parse", "HEAD")).toBe(f.second);
    expect(await f.git(f.checkout, "status", "--porcelain=v1")).toBe("");
  });

  it("falls back to the planned commit, and says so, when the recorded gitlink cannot be fetched", async () => {
    const f = await fixture();
    // A commit the person made in the submodule and never pushed: nothing holds it after the machine is gone.
    await f.commitGitlink("c".repeat(40));
    expect(await fetchPlannedSubmodules(f.checkout, [f.entry], f.environment, { onlyMissing: true }))
      .toEqual([{ path: "vendor/lib", fetched: true, atPlan: true }]);
    expect(await f.git(join(f.checkout, "vendor/lib"), "rev-parse", "HEAD")).toBe(f.first);
  });

  it("leaves the folder alone when the superproject no longer records a submodule there", async () => {
    const f = await fixture();
    await writeFile(join(f.checkout, "README"), "x\n"); await f.git(f.checkout, "add", "README"); await f.git(f.checkout, "commit", "-qm", "no lib");
    expect(await fetchPlannedSubmodules(f.checkout, [f.entry], f.environment, { onlyMissing: true }))
      .toEqual([{ path: "vendor/lib", fetched: false, kept: true }]);
    expect(await readdir(join(f.checkout, "vendor/lib"))).toEqual([]);
  });

  it("without onlyMissing (a new checkout) still checks out the plan's commit", async () => {
    const f = await fixture();
    await f.commitGitlink(f.second);
    expect(await fetchPlannedSubmodules(f.checkout, [f.entry], f.environment)).toEqual([{ path: "vendor/lib", fetched: true }]);
    expect(await f.git(join(f.checkout, "vendor/lib"), "rev-parse", "HEAD")).toBe(f.first);
  });
});
