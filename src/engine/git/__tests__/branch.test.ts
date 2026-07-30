import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  checkoutBranch,
  closeState,
  continueOnNewBranch,
  createBranchFrom,
  createWorkspace,
  getWorkspace,
  listBranches,
  listRemoteBranches,
  renameBranch,
  setStateRootForTesting,
  updateWorkspace,
} from "..";

const execFileAsync = promisify(execFile);

async function initRepo(repoRoot: string, remoteRoot: string): Promise<void> {
  await mkdir(repoRoot, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });
  await execFileAsync("git", ["init", "-q", "--bare"], { cwd: remoteRoot });
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
  await execFileAsync("git", ["remote", "add", "origin", remoteRoot], {
    cwd: repoRoot,
  });
  await execFileAsync("git", ["config", "user.email", "t@t"], {
    cwd: repoRoot,
  });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "README.md"), "# init\n");
  await execFileAsync("git", ["add", "."], { cwd: repoRoot });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
  await execFileAsync("git", ["push", "-q", "-u", "origin", "main"], {
    cwd: repoRoot,
  });
}

describe("branch ops", () => {
  let workdir: string;
  let repoRoot: string;
  let stateRoot: string;
  let workspaceId: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-branch-test-"));
    repoRoot = path.join(workdir, "repo");
    const remoteRoot = path.join(workdir, "remote.git");
    stateRoot = path.join(workdir, "state");
    setStateRootForTesting(stateRoot);
    await initRepo(repoRoot, remoteRoot);
    const created = await createWorkspace({ repoRoot });
    workspaceId = created.workspaceId;
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

  it("listBranches surfaces the workspace's branch", async () => {
    const ws = getWorkspace(workspaceId);
    const branches = await listBranches(workspaceId);
    const ours = branches.find((b) => b.name === ws.branch);
    expect(ours).toBeDefined();
    expect(ours?.isCheckedOut).toBe(true);
    expect(ours?.origin).toBe("zeros");
  });

  it("listBranches reports lastCommitDate", async () => {
    const branches = await listBranches(workspaceId);
    for (const b of branches) {
      expect(b.lastCommitDate).toBeGreaterThan(0);
    }
  });

  it("listRemoteBranches lists origin/* by plain name, skipping HEAD + local branches", async () => {
    // The fixture has an 'origin' remote but nothing fetched — synthesize the
    // remote-tracking refs the target picker reads (refs/remotes/origin/*).
    const { stdout: headSha } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      {
        cwd: repoRoot,
      },
    );
    const sha = headSha.trim();
    await execFileAsync(
      "git",
      ["update-ref", "refs/remotes/origin/main", sha],
      {
        cwd: repoRoot,
      },
    );
    await execFileAsync(
      "git",
      ["update-ref", "refs/remotes/origin/feature-x", sha],
      { cwd: repoRoot },
    );
    // origin/HEAD is a symbolic pointer, not a branch — it must be excluded.
    await execFileAsync(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
      { cwd: repoRoot },
    );

    const branches = await listRemoteBranches(workspaceId);
    expect(branches.map((b) => b.name).sort()).toEqual(["feature-x", "main"]);
    // Names are unqualified (no "origin/" prefix) so they match baseBranch.
    expect(branches.every((b) => !b.name.startsWith("origin/"))).toBe(true);
    // The workspace's own LOCAL branch is not a remote branch → absent.
    const ws = getWorkspace(workspaceId);
    expect(branches.find((b) => b.name === ws.branch)).toBeUndefined();
  });

  it("renameBranch updates both ref and DB row", async () => {
    await renameBranch({
      workspaceId,
      newName: "add-canvas-zoom",
    });
    const refreshed = getWorkspace(workspaceId);
    expect(refreshed.branch).toBe("zeros/add-canvas-zoom");
    // Listed branches should now include the new name and NOT the old.
    const branches = await listBranches(workspaceId);
    expect(
      branches.find((b) => b.name === "zeros/add-canvas-zoom"),
    ).toBeDefined();
  });

  it("renameBranch rejects invalid names", async () => {
    await expect(
      renameBranch({ workspaceId, newName: "main" }),
    ).rejects.toThrow();
    await expect(
      renameBranch({ workspaceId, newName: "1-bad" }),
    ).rejects.toThrow();
    // Uppercase became legal on 2026-07-29 (colour names) — underscores did not.
    await expect(
      renameBranch({ workspaceId, newName: "has_underscore" }),
    ).rejects.toThrow();
  });

  it("renameBranch accepts the same name as no-op", async () => {
    const ws = getWorkspace(workspaceId);
    await renameBranch({ workspaceId, newName: ws.branch });
    expect(getWorkspace(workspaceId).branch).toBe(ws.branch);
  });

  it("renameBranch keeps the workspace's OWN prefix, not the default", async () => {
    // Settings → Git (2026-07-29) made the branch prefix a choice, so a
    // workspace can live under any namespace. A rename must move the branch
    // WITHIN that namespace: re-prefixing with the hardcoded `zeros/` silently
    // re-homed the branch and orphaned it from whatever the user configured.
    const ws = getWorkspace(workspaceId);
    await execFileAsync("git", ["branch", "-m", ws.branch, "jordan/Cream"], {
      cwd: ws.path,
    });
    updateWorkspace(workspaceId, { branch: "jordan/Cream" });

    await renameBranch({ workspaceId, newName: "add-canvas-zoom" });

    expect(getWorkspace(workspaceId).branch).toBe("jordan/add-canvas-zoom");
    const branches = await listBranches(workspaceId);
    expect(
      branches.find((b) => b.name === "jordan/add-canvas-zoom"),
    ).toBeDefined();
    expect(branches.find((b) => b.name === "zeros/add-canvas-zoom")).toBe(
      undefined,
    );
  });

  it("renameBranch drops the prefix entirely for an unprefixed workspace", async () => {
    // branch_prefix_type = "none" — the branch IS the bare name, and a rename
    // must not reintroduce a namespace the user turned off.
    const ws = getWorkspace(workspaceId);
    await execFileAsync("git", ["branch", "-m", ws.branch, "Cream"], {
      cwd: ws.path,
    });
    updateWorkspace(workspaceId, { branch: "Cream" });

    await renameBranch({ workspaceId, newName: "add-canvas-zoom" });

    expect(getWorkspace(workspaceId).branch).toBe("add-canvas-zoom");
  });

  it("renameBranch keeps the prefix on a SECOND rename too", async () => {
    // The tail stops looking like an allocator colour after the first rename,
    // so a boundary rule based on that shape found no prefix the second time
    // and published a bare `login-fix` — silently dropping the namespace on
    // every rename after the first.
    const ws = getWorkspace(workspaceId);
    await execFileAsync("git", ["branch", "-m", ws.branch, "jordan/Cream"], {
      cwd: ws.path,
    });
    updateWorkspace(workspaceId, { branch: "jordan/Cream" });

    await renameBranch({ workspaceId, newName: "add-canvas-zoom" });
    await renameBranch({ workspaceId, newName: "login-fix" });

    expect(getWorkspace(workspaceId).branch).toBe("jordan/login-fix");
  });

  it("renameBranch keeps an adopted branch's namespace", async () => {
    // `cursor/foo` was never named by the allocator, so no shape rule can find
    // its boundary — but `<namespace>/<name>` is still the shape of the ref,
    // and a rename replaces only the name half.
    const ws = getWorkspace(workspaceId);
    await execFileAsync("git", ["branch", "-m", ws.branch, "cursor/foo"], {
      cwd: ws.path,
    });
    updateWorkspace(workspaceId, { branch: "cursor/foo" });

    await renameBranch({ workspaceId, newName: "login-fix" });

    expect(getWorkspace(workspaceId).branch).toBe("cursor/login-fix");
  });

  it("renameBranch does not invent a namespace from a substring match", async () => {
    // A namespace is a slash-delimited thing. resolveExistingBranchPrefix
    // briefly fell back to the CONFIGURED prefix when the branch had no slash,
    // guarded only by `startsWith` — so with the default setting an adopted
    // branch named `zeros-experiment` "matched" `zeros` and the rename emitted
    // the run-together `zerosadd-canvas-zoom`.
    const ws = getWorkspace(workspaceId);
    await execFileAsync(
      "git",
      ["branch", "-m", ws.branch, "zeros-experiment"],
      { cwd: ws.path },
    );
    updateWorkspace(workspaceId, { branch: "zeros-experiment" });

    await renameBranch({ workspaceId, newName: "add-canvas-zoom" });

    expect(getWorkspace(workspaceId).branch).toBe("add-canvas-zoom");
  });

  it("renameBranch never adopts a caller-supplied prefix", async () => {
    // `newName` is untrusted (git.renameBranch is remote-reachable) and lands
    // as a `git branch -m` argument. Whatever prefix the caller sends is
    // discarded; the ref is rebuilt from the workspace's own.
    const ws = getWorkspace(workspaceId);
    await execFileAsync("git", ["branch", "-m", ws.branch, "jordan/Cream"], {
      cwd: ws.path,
    });
    updateWorkspace(workspaceId, { branch: "jordan/Cream" });

    await renameBranch({ workspaceId, newName: "--force/Login" });
    expect(getWorkspace(workspaceId).branch).toBe("jordan/Login");

    await expect(
      renameBranch({ workspaceId, newName: "jordan/--force" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("renameBranch REPORTS the resulting branch, prefix included", async () => {
    // The caller cannot derive this: the prefix comes from the existing
    // branch, which only the engine reads. The renderer's inline rename box
    // used to guess `zeros/<name>` and optimistically announced a branch that
    // does not exist for every workspace on any other prefix.
    const ws = getWorkspace(workspaceId);
    await execFileAsync("git", ["branch", "-m", ws.branch, "jordan/Cream"], {
      cwd: ws.path,
    });
    updateWorkspace(workspaceId, { branch: "jordan/Cream" });

    const renamed = await renameBranch({
      workspaceId,
      newName: "add-canvas-zoom",
    });

    expect(renamed).toBe("jordan/add-canvas-zoom");
    expect(renamed).toBe(getWorkspace(workspaceId).branch);
    // A no-op rename reports the unchanged branch rather than nothing.
    expect(await renameBranch({ workspaceId, newName: renamed })).toBe(renamed);
  });

  it("createBranchFrom + checkoutBranch switch the workspace branch", async () => {
    const ws = getWorkspace(workspaceId);
    await createBranchFrom({
      workspaceId,
      sourceBranch: ws.branch,
      newBranchName: "experiment-1",
    });
    await checkoutBranch({ workspaceId, branchName: "experiment-1" });
    const refreshed = getWorkspace(workspaceId);
    expect(refreshed.branch).toBe("experiment-1");
  });

  it("checkout createIfMissing creates the branch on demand", async () => {
    await checkoutBranch({
      workspaceId,
      branchName: "fresh-branch",
      createIfMissing: true,
    });
    expect(getWorkspace(workspaceId).branch).toBe("fresh-branch");
  });

  it("checkout of a non-existent branch without createIfMissing fails", async () => {
    await expect(
      checkoutBranch({
        workspaceId,
        branchName: "does-not-exist",
        createIfMissing: false,
      }),
    ).rejects.toThrow();
  });

  it("continueOnNewBranch: fresh generated branch, PR fields cleared, worktree kept", async () => {
    const before = getWorkspace(workspaceId);
    // Model a squash merge: the feature and target commits are siblings with
    // the same tree. Branching from the feature HEAD would repeat this change
    // in the next PR even though the file diff looks identical locally.
    await writeFile(path.join(before.path, "feature.txt"), "merged feature\n");
    await execFileAsync("git", ["add", "feature.txt"], { cwd: before.path });
    await execFileAsync("git", ["commit", "-q", "-m", "feature commit"], {
      cwd: before.path,
    });
    const { stdout: featureHeadOut } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: before.path },
    );
    const featureHead = featureHeadOut.trim();

    await writeFile(path.join(repoRoot, "feature.txt"), "merged feature\n");
    await execFileAsync("git", ["add", "feature.txt"], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-q", "-m", "squash merge"], {
      cwd: repoRoot,
    });
    const { stdout: mergedHeadOut } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: repoRoot },
    );
    const mergedHead = mergedHeadOut.trim();
    await execFileAsync("git", ["push", "-q", "origin", "main"], {
      cwd: repoRoot,
    });

    // Simulate the merged-PR workspace the Continue button acts on.
    updateWorkspace(workspaceId, {
      prNumber: 42,
      prState: "merged",
      prUrl: "https://example.com/x/y/pull/42",
      status: "done",
    });
    // Staged and untracked work must survive the branch switch (same worktree).
    await writeFile(path.join(before.path, "README.md"), "# next task\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: before.path });
    await writeFile(path.join(before.path, "wip.txt"), "keep me\n");

    const { branch } = await continueOnNewBranch({
      workspaceId,
      mergedSha: mergedHead,
    });
    expect(branch).toMatch(/^zeros\//);
    expect(branch).not.toBe(before.branch);

    const after = getWorkspace(workspaceId);
    expect(after.branch).toBe(branch);
    expect(after.path).toBe(before.path);
    expect(after.prNumber).toBeNull();
    expect(after.prState).toBeNull();
    expect(after.prUrl).toBeNull();
    expect(after.status).toBe("in-progress");

    // The worktree really is on the new branch, work intact, old ref kept.
    const { stdout: head } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: after.path },
    );
    expect(head.trim()).toBe(branch);
    const { stdout: newHead } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      {
        cwd: after.path,
      },
    );
    expect(newHead.trim()).toBe(mergedHead);
    await expect(
      execFileAsync(
        "git",
        ["merge-base", "--is-ancestor", featureHead, "HEAD"],
        { cwd: after.path },
      ),
    ).rejects.toBeDefined();
    const { stdout: refs } = await execFileAsync(
      "git",
      ["branch", "--list", before.branch],
      { cwd: after.path },
    );
    expect(refs).toContain(before.branch);
    const { stdout: status } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1"],
      { cwd: after.path },
    );
    expect(status).toContain("M  README.md");
    expect(status).toContain("wip.txt");
  });
});
