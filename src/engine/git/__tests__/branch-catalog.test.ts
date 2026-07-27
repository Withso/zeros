// Repo branch catalog + `git.remote`/`git.base_branch` honoring across the
// engine: catalog listing (remote / local / missing-remote fallbacks),
// createWorkspace forking from the CONFIGURED remote+branch, push targeting
// the configured remote, listRemoteBranches reading the configured remote's
// refs, and the agent-facing target ref (ZEROS_TARGET_BRANCH source).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  closeState,
  createWorkspace,
  getWorkspace,
  listRemoteBranches,
  push,
  repoBranchCatalog,
  setStateRootForTesting,
} from "..";
import { resolveWorkspaceTargetRef } from "../target-branch";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

/** Working repo on `main` with one commit. No remote unless the test adds one. */
async function initRepo(repoRoot: string): Promise<void> {
  await mkdir(repoRoot, { recursive: true });
  await git(repoRoot, "init", "-q", "-b", "main");
  await git(repoRoot, "config", "user.email", "t@t");
  await git(repoRoot, "config", "user.name", "t");
  await writeFile(path.join(repoRoot, "README.md"), "# init\n");
  await git(repoRoot, "add", ".");
  await git(repoRoot, "commit", "-q", "-m", "init");
}

/** Bare repo the tests use as a live-but-local "remote" (file transport —
 *  fetch/push work with no network). */
async function initBare(barePath: string): Promise<void> {
  await mkdir(barePath, { recursive: true });
  await execFileAsync("git", ["init", "-q", "--bare", barePath]);
}

async function writeRepoLocalSettings(
  repoRoot: string,
  toml: string,
): Promise<void> {
  await mkdir(path.join(repoRoot, ".zeros"), { recursive: true });
  await writeFile(path.join(repoRoot, ".zeros", "settings.local.toml"), toml);
}

describe("repoBranchCatalog + configured-remote honoring", () => {
  let workdir: string;
  let repoRoot: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-catalog-test-"));
    repoRoot = path.join(workdir, "repo");
    setStateRootForTesting(path.join(workdir, "state"));
    await initRepo(repoRoot);
  });

  afterEach(async () => {
    closeState();
    setStateRootForTesting(null);
    try {
      await rm(workdir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("lists LOCAL branches (laptop mode) when the repo has no remotes", async () => {
    await git(repoRoot, "branch", "side");
    const c = await repoBranchCatalog({ repoRoot });
    expect(c.remotes).toEqual([]);
    expect(c.branchSource).toBe("local");
    expect(c.listedRemote).toBeNull();
    expect(c.branches.map((b) => b.name).sort()).toEqual(["main", "side"]);
    expect(c.effectiveRemote).toBe("origin");
    expect(c.effectiveBase).toBe("main");
    expect(c.baseExplicit).toBe(false);
  });

  it("lists the effective remote's branches and flags GitHub URLs", async () => {
    const bare = path.join(workdir, "remote.git");
    await initBare(bare);
    await git(repoRoot, "remote", "add", "origin", bare);
    await git(repoRoot, "remote", "add", "github", "https://github.com/foo/bar.git");
    await git(repoRoot, "push", "-q", "origin", "main");
    await git(repoRoot, "branch", "feature-x");
    await git(repoRoot, "push", "-q", "origin", "feature-x");

    const c = await repoBranchCatalog({ repoRoot });
    expect(c.branchSource).toBe("remote");
    expect(c.listedRemote).toBe("origin");
    expect(c.branches.map((b) => b.name).sort()).toEqual(["feature-x", "main"]);
    const byName = Object.fromEntries(c.remotes.map((r) => [r.name, r]));
    expect(byName.origin.isGitHub).toBe(false); // file-path URL
    expect(byName.github.isGitHub).toBe(true);
  });

  it("falls back to LOCAL branches when the configured remote isn't in the repo", async () => {
    const bare = path.join(workdir, "remote.git");
    await initBare(bare);
    await git(repoRoot, "remote", "add", "origin", bare);
    await git(repoRoot, "push", "-q", "origin", "main");
    await writeRepoLocalSettings(repoRoot, '[git]\nremote = "upstream"\n');

    const c = await repoBranchCatalog({ repoRoot });
    expect(c.effectiveRemote).toBe("upstream");
    expect(c.remoteExists).toBe(false); // upstream doesn't exist
    expect(c.listedRemote).toBeNull();
    expect(c.branchSource).toBe("local");
    expect(c.remotes.map((r) => r.name)).toEqual(["origin"]);
  });

  it("falls back to LOCAL branches when the remote exists but was never fetched", async () => {
    const bare = path.join(workdir, "remote.git");
    await initBare(bare);
    await git(repoRoot, "remote", "add", "origin", bare); // nothing pushed/fetched

    const c = await repoBranchCatalog({ repoRoot });
    expect(c.remoteExists).toBe(true);
    expect(c.listedRemote).toBeNull(); // empty remote-tracking namespace
    expect(c.branchSource).toBe("local");
    expect(c.branches.map((b) => b.name)).toContain("main");
  });

  it("keeps a remote whose URL contains spaces (local path remote)", async () => {
    const bare = path.join(workdir, "space dir", "remote.git");
    await initBare(bare);
    await git(repoRoot, "remote", "add", "origin", bare);
    await git(repoRoot, "push", "-q", "origin", "main");

    const c = await repoBranchCatalog({ repoRoot });
    expect(c.remotes.map((r) => r.name)).toEqual(["origin"]);
    expect(c.remotes[0].url).toBe(bare);
    expect(c.listedRemote).toBe("origin");
    expect(c.branches.map((b) => b.name)).toContain("main");
  });

  it("honors an explicit base_branch setting and a remote override param", async () => {
    const bare = path.join(workdir, "remote.git");
    await initBare(bare);
    await git(repoRoot, "remote", "add", "upstream", bare);
    await git(repoRoot, "push", "-q", "upstream", "main");
    await writeRepoLocalSettings(
      repoRoot,
      '[git]\nremote = "upstream"\nbase_branch = "dev"\n',
    );

    const c = await repoBranchCatalog({ repoRoot });
    expect(c.effectiveRemote).toBe("upstream");
    expect(c.baseExplicit).toBe(true);
    expect(c.effectiveBase).toBe("dev"); // explicit wins even though absent
    expect(c.listedRemote).toBe("upstream");

    // Preview another remote without saving it.
    const preview = await repoBranchCatalog({ repoRoot, remote: "nope" });
    expect(preview.branchSource).toBe("local");
  });

  it("fetch:true freshens remote-tracking refs from the live remote", async () => {
    const bare = path.join(workdir, "remote.git");
    await initBare(bare);
    await git(repoRoot, "remote", "add", "origin", bare);
    await git(repoRoot, "push", "-q", "origin", "main");
    await git(repoRoot, "push", "-q", "origin", "main:only-on-remote");
    // Drop the local remote-tracking ref — as if a teammate pushed it.
    await git(repoRoot, "update-ref", "-d", "refs/remotes/origin/only-on-remote");

    const stale = await repoBranchCatalog({ repoRoot });
    expect(stale.branches.map((b) => b.name)).not.toContain("only-on-remote");
    const fresh = await repoBranchCatalog({ repoRoot, fetch: true });
    expect(fresh.branches.map((b) => b.name)).toContain("only-on-remote");
  });

  it("refuses a flag-injection remote from settings", async () => {
    await writeRepoLocalSettings(repoRoot, '[git]\nremote = "--upload-pack=evil"\n');
    await expect(repoBranchCatalog({ repoRoot })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("createWorkspace forks from the CONFIGURED remote's branch (the headline flow)", async () => {
    // upstream/dev sits one commit AHEAD of local main — if the new workspace
    // starts from the upstream tip, the settings were honored end to end.
    const bare = path.join(workdir, "upstream.git");
    await initBare(bare);
    await git(repoRoot, "remote", "add", "upstream", bare);
    await git(repoRoot, "checkout", "-q", "-b", "dev");
    await writeFile(path.join(repoRoot, "dev.txt"), "ahead\n");
    await git(repoRoot, "add", ".");
    await git(repoRoot, "commit", "-q", "-m", "dev tip");
    const devTip = await git(repoRoot, "rev-parse", "HEAD");
    await git(repoRoot, "push", "-q", "upstream", "dev");
    await git(repoRoot, "checkout", "-q", "main");
    await writeRepoLocalSettings(
      repoRoot,
      '[git]\nremote = "upstream"\nbase_branch = "dev"\n',
    );

    const created = await createWorkspace({ repoRoot, repoSlug: "testrepo" });
    expect(getWorkspace(created.workspaceId).baseBranch).toBe("dev");
    const headSha = await git(created.path, "rev-parse", "HEAD");
    expect(headSha).toBe(devTip);

    // The agent-facing target ref names the same remote + branch.
    await expect(resolveWorkspaceTargetRef(created.workspaceId)).resolves.toBe(
      "upstream/dev",
    );

    // listRemoteBranches (target-branch picker) reads the configured remote.
    const remoteBranches = await listRemoteBranches(created.workspaceId);
    expect(remoteBranches.map((b) => b.name)).toContain("dev");

    // push with no explicit remote lands on the configured remote.
    await push({ workspaceId: created.workspaceId });
    const pushed = await git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads/");
    expect(pushed.split("\n")).toContain(created.branch);
  });

  it("resolveWorkspaceTargetRef falls back to the plain base for a local-only repo", async () => {
    const created = await createWorkspace({ repoRoot, repoSlug: "testrepo" });
    await expect(resolveWorkspaceTargetRef(created.workspaceId)).resolves.toBe(
      "main",
    );
    await expect(resolveWorkspaceTargetRef("ws_nope")).resolves.toBeNull();
  });
});
