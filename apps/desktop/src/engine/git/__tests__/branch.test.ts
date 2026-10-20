import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const gitFault = vi.hoisted(() => ({
  checkoutMerge: null as
    | null
    | ((cwd: string, target: string) => Promise<void>),
}));
vi.mock("../git-exec", async (original) => {
  const actual = await original<typeof import("../git-exec")>();
  return {
    ...actual,
    runGit: async (...call: Parameters<typeof actual.runGit>) => {
      const [cwd, args] = call;
      const fault = gitFault.checkoutMerge;
      if (fault && args[0] === "checkout" && args[1] === "-m") {
        gitFault.checkoutMerge = null;
        await fault(cwd, args[args.length - 1]!);
      }
      return actual.runGit(...call);
    },
  };
});

import { GitError } from "../errors";
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
    gitFault.checkoutMerge = null;
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

  it.each(["in-review", "done"] as const)("checkout detaches the previous branch's PR and %s lifecycle", async (status) => {
    updateWorkspace(workspaceId, { prNumber: 42, prState: status === "done" ? "merged" : "ready",
      prUrl: "https://github.com/example/project/pull/42", status });
    await checkoutBranch({ workspaceId, branchName: "next-task", createIfMissing: true });
    expect(getWorkspace(workspaceId)).toMatchObject({ branch: "next-task", prNumber: null,
      prState: null, prUrl: null, status: "in-progress" });
  });

  it("checkout of the same branch preserves its PR and lifecycle", async () => {
    const original = getWorkspace(workspaceId);
    updateWorkspace(workspaceId, { prNumber: 42, prState: "merged",
      prUrl: "https://github.com/example/project/pull/42", status: "done" });
    await checkoutBranch({ workspaceId, branchName: original.branch });
    expect(getWorkspace(workspaceId)).toMatchObject({ branch: original.branch, prNumber: 42,
      prState: "merged", prUrl: "https://github.com/example/project/pull/42", status: "done" });
  });

  it("failed checkout preserves the previous branch's PR", async () => {
    const original = getWorkspace(workspaceId);
    updateWorkspace(workspaceId, { prNumber: 42, prState: "ready", status: "in-review" });
    await expect(checkoutBranch({ workspaceId, branchName: "missing-target" })).rejects.toThrow();
    expect(getWorkspace(workspaceId)).toMatchObject({ branch: original.branch, prNumber: 42,
      prState: "ready", status: "in-review" });
  });

  it("checkout preserves an explicitly cancelled workspace status", async () => {
    updateWorkspace(workspaceId, { prNumber: 42, prState: "closed", status: "cancelled" });
    await checkoutBranch({ workspaceId, branchName: "other-task", createIfMissing: true });
    expect(getWorkspace(workspaceId)).toMatchObject({ prNumber: null, prState: null, status: "cancelled" });
  });

  it("checkout createIfMissing never resets an existing branch", async () => {
    const ws = getWorkspace(workspaceId);
    await execFileAsync("git", ["branch", "existing-target", "main"], {
      cwd: repoRoot,
    });
    const targetBefore = (
      await execFileAsync("git", ["rev-parse", "existing-target"], {
        cwd: repoRoot,
      })
    ).stdout.trim();
    await writeFile(path.join(ws.path, "workspace-only.txt"), "new head\n");
    await execFileAsync("git", ["add", "workspace-only.txt"], {
      cwd: ws.path,
    });
    await execFileAsync("git", ["commit", "-q", "-m", "workspace head"], {
      cwd: ws.path,
    });

    await checkoutBranch({
      workspaceId,
      branchName: "existing-target",
      createIfMissing: true,
    });

    const targetAfter = (
      await execFileAsync("git", ["rev-parse", "existing-target"], {
        cwd: ws.path,
      })
    ).stdout.trim();
    expect(targetAfter).toBe(targetBefore);
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

  it("refuses checkout before it can overwrite an ignored live Design draft", async () => {
    const ws = getWorkspace(workspaceId);
    await writeFile(path.join(ws.path, ".gitignore"), "Zeros Design/\n");
    await execFileAsync("git", ["add", ".gitignore"], { cwd: ws.path });
    await execFileAsync("git", ["commit", "-q", "-m", "ignore design"], {
      cwd: ws.path,
    });
    await mkdir(path.join(ws.path, "Zeros Design"), { recursive: true });
    const draft = path.join(ws.path, "Zeros Design", "draft.html");
    await writeFile(draft, "<main>local ignored draft</main>\n");

    await execFileAsync("git", ["checkout", "-q", "-b", "design-target"], {
      cwd: repoRoot,
    });
    await mkdir(path.join(repoRoot, "Zeros Design"), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(repoRoot, "Zeros Design", ".zeros-canvas.json"),
        "{}\n",
      ),
      writeFile(
        path.join(repoRoot, "Zeros Design", "draft.html"),
        "<main>target design</main>\n",
      ),
    ]);
    await execFileAsync("git", ["add", "Zeros Design"], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-q", "-m", "target design"], {
      cwd: repoRoot,
    });
    await execFileAsync("git", ["checkout", "-q", "main"], { cwd: repoRoot });

    await expect(
      checkoutBranch({ workspaceId, branchName: "design-target" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(readFile(draft, "utf8")).resolves.toBe(
      "<main>local ignored draft</main>\n",
    );
    expect(getWorkspace(workspaceId).branch).toBe(ws.branch);
  });

  it("refuses checkout before it can overwrite an ignored live Design pointer", async () => {
    const ws = getWorkspace(workspaceId);
    await mkdir(path.join(ws.path, ".zeros"), { recursive: true });
    await writeFile(path.join(ws.path, ".gitignore"), ".zeros/settings.toml\n");
    await execFileAsync("git", ["add", ".gitignore"], { cwd: ws.path });
    await execFileAsync("git", ["commit", "-q", "-m", "ignore pointer"], {
      cwd: ws.path,
    });

    await execFileAsync(
      "git",
      ["checkout", "-q", "-b", "pointer-target", ws.branch],
      { cwd: repoRoot },
    );
    await mkdir(path.join(repoRoot, ".zeros"), { recursive: true });
    await writeFile(
      path.join(repoRoot, ".zeros", "settings.toml"),
      '[design]\ndirectory = "Target Design"\n',
    );
    await execFileAsync("git", ["add", "-f", ".zeros/settings.toml"], {
      cwd: repoRoot,
    });
    await execFileAsync("git", ["commit", "-q", "-m", "target pointer"], {
      cwd: repoRoot,
    });
    await execFileAsync("git", ["checkout", "-q", "main"], {
      cwd: repoRoot,
    });

    const pointer = path.join(ws.path, ".zeros", "settings.toml");
    const local = '[design]\ndirectory = "Local Draft"\n';
    await writeFile(pointer, local);

    await expect(
      checkoutBranch({ workspaceId, branchName: "pointer-target" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(readFile(pointer, "utf8")).resolves.toBe(local);
    expect(getWorkspace(workspaceId).branch).toBe(ws.branch);
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

  describe("continueOnNewBranch with an uncommitted Design draft", () => {
    const DESIGN = "Zeros - Design";
    const designToml =
      'format = "zeros-design"\nversion = 3\nid = "design_0123456789abcdef0123456789abcdef"\ncanvas = "canvas.json"\n';
    // One page per line, with a block of unchanged lines between `pages` and
    // `foundation`, so separate edits to each merge cleanly.
    const canvas = (opts: { page2?: boolean; theme?: string } = {}) =>
      [
        "{",
        '  "version": 2,',
        '  "id": "main",',
        '  "title": "Design",',
        '  "pages": [',
        opts.page2
          ? '    { "id": "page_1", "title": "Page 1", "frames": ["frame_1"], "folder": "page-1" },\n    { "id": "page_2", "title": "Page 2", "frames": ["frame_2"], "folder": "page-2" }'
          : '    { "id": "page_1", "title": "Page 1", "frames": ["frame_1"], "folder": "page-1" }',
        "  ],",
        '  "frames": {',
        '    "frame_1": { "kind": "html", "source": "page-1/frame.html" }',
        "  },",
        '  "foundation": {',
        `    "theme": "${opts.theme ?? "light"}"`,
        "  }",
        "}",
        "",
      ].join("\n");
    const git = async (cwd: string, ...args: string[]) =>
      (await execFileAsync("git", args, { cwd })).stdout;
    async function writeDesign(root: string, files: Record<string, string>) {
      for (const [relative, body] of Object.entries(files)) {
        const file = path.join(root, DESIGN, ...relative.split("/"));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, body);
      }
    }
    const readDesign = (root: string, relative: string) =>
      readFile(path.join(root, DESIGN, ...relative.split("/")), "utf8");

    /** A squash-merged Design PR, then a teammate's newer Design commit on
     *  main, then local Design work started after the merge. */
    async function mergedDesignWorkspace(mainChange: Record<string, string>) {
      const ws = getWorkspace(workspaceId);
      const feature = {
        "meta/design.toml": designToml,
        "meta/canvas.json": canvas(),
        "page-1/frame.html": "<main>page 1</main>\n",
      };
      await writeDesign(ws.path, feature);
      await git(ws.path, "add", DESIGN);
      await git(ws.path, "commit", "-q", "-m", "design feature");
      await writeDesign(repoRoot, feature);
      await git(repoRoot, "add", DESIGN);
      await git(repoRoot, "commit", "-q", "-m", "squash merge");
      await writeDesign(repoRoot, mainChange);
      await git(repoRoot, "add", DESIGN);
      await git(repoRoot, "commit", "-q", "-m", "teammate design change");
      await git(repoRoot, "push", "-q", "origin", "main");
      const mergedHead = (await git(repoRoot, "rev-parse", "HEAD")).trim();
      updateWorkspace(workspaceId, {
        prNumber: 7,
        prState: "merged",
        prUrl: "https://example.com/x/y/pull/7",
        status: "done",
      });
      return { ws, mergedHead };
    }

    it("carries the draft when main changed other Design files", async () => {
      const { ws, mergedHead } = await mergedDesignWorkspace({
        "page-1/frame.html": "<main>page 1, revised on main</main>\n",
      });
      await writeDesign(ws.path, {
        "meta/canvas.json": canvas({ page2: true }),
        "page-2/frame.html": "<main>page 2 draft</main>\n",
      });

      const result = await continueOnNewBranch({ workspaceId });

      expect(result.conflicts).toEqual([]);
      expect((await git(ws.path, "rev-parse", "HEAD")).trim()).toBe(mergedHead);
      expect(getWorkspace(workspaceId)).toMatchObject({
        branch: result.branch,
        prNumber: null,
        status: "in-progress",
      });
      expect(await readDesign(ws.path, "meta/canvas.json")).toBe(
        canvas({ page2: true }),
      );
      expect(await readDesign(ws.path, "page-2/frame.html")).toBe(
        "<main>page 2 draft</main>\n",
      );
      expect(await readDesign(ws.path, "page-1/frame.html")).toBe(
        "<main>page 1, revised on main</main>\n",
      );
    });

    it("merges a draft edit with main's change to the same canvas", async () => {
      const { ws, mergedHead } = await mergedDesignWorkspace({
        "meta/canvas.json": canvas({ theme: "dark" }),
      });
      await writeDesign(ws.path, {
        "meta/canvas.json": canvas({ page2: true }),
        "page-2/frame.html": "<main>page 2 draft</main>\n",
      });
      // Staged edits are carried too (as unstaged changes).
      await git(ws.path, "add", `${DESIGN}/meta/canvas.json`);

      const result = await continueOnNewBranch({ workspaceId });

      expect(result.conflicts).toEqual([]);
      expect((await git(ws.path, "rev-parse", "HEAD")).trim()).toBe(mergedHead);
      expect(
        (await git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).trim(),
      ).toBe(result.branch);
      expect(await readDesign(ws.path, "meta/canvas.json")).toBe(
        canvas({ page2: true, theme: "dark" }),
      );
      expect(await readDesign(ws.path, "page-2/frame.html")).toBe(
        "<main>page 2 draft</main>\n",
      );
      expect(await git(ws.path, "status", "--porcelain=v1")).toContain(
        ` M "${DESIGN}/meta/canvas.json"`,
      );
      expect(await git(ws.path, "stash", "list")).toBe("");
    });

    it("leaves a genuine overlap as a conflict instead of refusing", async () => {
      const { ws, mergedHead } = await mergedDesignWorkspace({
        "meta/canvas.json": canvas({ theme: "dark" }),
      });
      await writeDesign(ws.path, {
        "meta/canvas.json": canvas({ theme: "sepia" }),
      });

      const result = await continueOnNewBranch({ workspaceId });

      expect(result.conflicts).toEqual([`${DESIGN}/meta/canvas.json`]);
      expect((await git(ws.path, "rev-parse", "HEAD")).trim()).toBe(mergedHead);
      expect(getWorkspace(workspaceId).branch).toBe(result.branch);
      const merged = await readDesign(ws.path, "meta/canvas.json");
      expect(merged).toContain('"theme": "dark"');
      expect(merged).toContain('"theme": "sepia"');
      // Both sides stay in the index for the normal conflict resolution flow.
      expect(
        await git(ws.path, "ls-files", "-u", "--", `${DESIGN}/meta/canvas.json`),
      ).not.toBe("");
      // The exact pre-Continue edits remain recoverable as well.
      const [saved] = (
        await git(ws.path, "stash", "list", "--format=%H %gs")
      ).split("\n");
      expect(saved).toContain(
        `Zeros: changes before continuing on ${result.branch}`,
      );
      expect(
        await git(ws.path, "show", `${saved!.split(" ")[0]}:${DESIGN}/meta/canvas.json`),
      ).toBe(canvas({ theme: "sepia" }));
    });

    it("refuses without changing anything when an untracked file is in the way", async () => {
      const { ws } = await mergedDesignWorkspace({
        "meta/canvas.json": canvas({ theme: "dark" }),
        "page-2/frame.html": "<main>page 2 from main</main>\n",
      });
      const before = getWorkspace(workspaceId);
      await writeDesign(ws.path, {
        "meta/canvas.json": canvas({ page2: true }),
        "page-2/frame.html": "<main>page 2 draft</main>\n",
      });
      await git(ws.path, "add", `${DESIGN}/meta/canvas.json`);
      const headBefore = (await git(ws.path, "rev-parse", "HEAD")).trim();

      await expect(continueOnNewBranch({ workspaceId })).rejects.toThrow();

      expect((await git(ws.path, "rev-parse", "HEAD")).trim()).toBe(headBefore);
      expect(getWorkspace(workspaceId)).toMatchObject({
        branch: before.branch,
        prNumber: 7,
        status: "done",
      });
      expect(await readDesign(ws.path, "meta/canvas.json")).toBe(
        canvas({ page2: true }),
      );
      expect(await readDesign(ws.path, "page-2/frame.html")).toBe(
        "<main>page 2 draft</main>\n",
      );
      // The staged edit is still staged; nothing was left in the stash list.
      expect(await git(ws.path, "status", "--porcelain=v1")).toContain(
        `M  "${DESIGN}/meta/canvas.json"`,
      );
      expect(await git(ws.path, "stash", "list")).toBe("");
    });

    /** Working folders: a sparse checkout holding only the Design folder,
     *  with `other/` excluded. */
    async function sparseDesignWorkspace(mainChange: Record<string, string>) {
      const ws = getWorkspace(workspaceId);
      for (const root of [ws.path, repoRoot]) {
        await mkdir(path.join(root, "other"), { recursive: true });
        await writeFile(path.join(root, "other", "keep.txt"), "outside\n");
        await git(root, "add", "other");
        await git(root, "commit", "-q", "-m", "other folder");
      }
      const merged = await mergedDesignWorkspace(mainChange);
      await git(ws.path, "sparse-checkout", "set", "--cone", DESIGN);
      return merged;
    }

    it("protects an untracked file in a sparse checkout, where Git would overwrite it", async () => {
      const { ws } = await sparseDesignWorkspace({
        "page-2/frame.html": "<main>page 2 from main</main>\n",
      });
      await writeDesign(ws.path, {
        "page-2/frame.html": "<main>page 2 draft</main>\n",
      });

      await expect(continueOnNewBranch({ workspaceId })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        context: { paths: [`${DESIGN}/page-2/frame.html`] },
      });
      expect(await readDesign(ws.path, "page-2/frame.html")).toBe(
        "<main>page 2 draft</main>\n",
      );
    });

    it("restores staging exactly, sparse entries included, when Git refuses the merge", async () => {
      const { ws } = await sparseDesignWorkspace({
        "meta/canvas.json": canvas({ theme: "dark" }),
      });
      await writeDesign(ws.path, { "meta/canvas.json": canvas({ page2: true }) });
      await git(ws.path, "add", `${DESIGN}/meta/canvas.json`);
      const headBefore = (await git(ws.path, "rev-parse", "HEAD")).trim();
      // Git refuses before touching anything (for example, a lost branch race).
      gitFault.checkoutMerge = async () => {
        throw new GitError({
          code: "GIT_COMMAND_FAILED",
          message: "fatal: a branch with that name already exists",
        });
      };

      await expect(continueOnNewBranch({ workspaceId })).rejects.toMatchObject({
        message: "fatal: a branch with that name already exists",
      });

      expect((await git(ws.path, "rev-parse", "HEAD")).trim()).toBe(headBefore);
      expect(await git(ws.path, "ls-files", "-t", "--", "other/keep.txt")).toBe(
        "S other/keep.txt\n",
      );
      const status = await git(ws.path, "status", "--porcelain=v1");
      expect(status).not.toContain("other/keep.txt");
      expect(status).toContain(`M  "${DESIGN}/meta/canvas.json"`);
      expect(await readDesign(ws.path, "meta/canvas.json")).toBe(
        canvas({ page2: true }),
      );
      expect(await git(ws.path, "stash", "list")).toBe("");
    });

    it("keeps the draft in the stash list if Git stops partway through the merge", async () => {
      const { ws } = await mergedDesignWorkspace({
        "meta/canvas.json": canvas({ theme: "dark" }),
      });
      await writeDesign(ws.path, {
        "meta/canvas.json": canvas({ theme: "sepia" }),
      });
      const before = getWorkspace(workspaceId);
      // Git resets the files to the target before its three-way merge; an
      // internal merge error then exits 128 with the edits off disk.
      gitFault.checkoutMerge = async (cwd, target) => {
        await git(cwd, "read-tree", "-u", "--reset", target);
        throw new GitError({
          code: "GIT_COMMAND_FAILED",
          message: "fatal: simulated merge failure",
        });
      };

      await expect(continueOnNewBranch({ workspaceId })).rejects.toMatchObject({
        message: "Continue on a new branch stopped partway through.",
      });
      expect(getWorkspace(workspaceId)).toMatchObject({
        branch: before.branch,
        prNumber: 7,
      });

      const [stash] = (
        await git(ws.path, "stash", "list", "--format=%H %gs")
      ).split("\n");
      expect(stash).toContain("Zeros: changes before continuing on");
      const saved = stash!.split(" ")[0]!;
      expect(await git(ws.path, "show", `${saved}:${DESIGN}/meta/canvas.json`)).toBe(
        canvas({ theme: "sepia" }),
      );
    });

    it("still refuses to overwrite an ignored Design draft", async () => {
      const { ws } = await mergedDesignWorkspace({
        "page-2/frame.html": "<main>page 2 from main</main>\n",
      });
      await writeFile(
        path.join(ws.path, ".gitignore"),
        `${DESIGN}/page-2/\n`,
      );
      await writeDesign(ws.path, {
        "page-2/frame.html": "<main>ignored page 2 draft</main>\n",
      });

      await expect(continueOnNewBranch({ workspaceId })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
      expect(await readDesign(ws.path, "page-2/frame.html")).toBe(
        "<main>ignored page 2 draft</main>\n",
      );
    });
  });
});
